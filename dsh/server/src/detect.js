/**
 * Locate and validate a Wolfram Language kernel executable on the local machine.
 *
 * Detection has two layers:
 *
 *  1. `kernelCandidates()` builds an ordered list of candidate executables:
 *       a. explicit `--kernel <path>` (highest priority)
 *       b. MATHEMATICA_EXE / MATHEMATICA_KERNEL environment variables
 *       c. `~/.mathematica-mcp.json` with {"kernelPath": "..."} (or "kernel"/"path")
 *       d. platform specific well-known locations. Licensed desktop installs
 *          (`...\Wolfram\*\math.exe`, `...\Mathematica\*\math.exe`) come first,
 *          then Wolfram Engine installs, newest version first. `math.exe` is
 *          preferred over MathKernel.exe/WolframKernel.exe because those are
 *          not reliable stdio REPL launchers on Windows.
 *
 *  2. `resolveKernel()` probes candidates in order: it starts the executable
 *     with `-noprompt`, sends a trivial `Print[...]; 2+2` program and waits for
 *     the marker. This skips unlicensed installs ("No valid password found.",
 *     exit code 69), broken binaries and hung processes. The winning kernel is
 *     cached by the caller for the lifetime of the process.
 *
 * The module never throws for a missing kernel: callers get an actionable error
 * with per-candidate reasons. All filesystem access is injectable so the
 * detection logic can be unit tested without a real Mathematica installation.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export const CONFIG_FILENAME = '.mathematica-mcp.json';

/** Environment variables checked, in priority order. */
export const ENV_KERNEL_VARS = ['MATHEMATICA_EXE', 'MATHEMATICA_KERNEL'];

/** Printed by the health probe once the kernel is alive and evaluating. */
export const PROBE_MARKER = '@@MATHEMATICA_MCP_PROBE_OK@@';

/** Default per-candidate probe budget. */
export const DEFAULT_PROBE_TIMEOUT_MS = 20_000;

/**
 * Windows install roots, highest priority first. Desktop Mathematica installs
 * (usually licensed) are preferred over Wolfram Engine installs (which are
 * unlicensed on machines without a valid password/entitlement).
 */
const WINDOWS_ROOTS = [
  { path: 'C:\\Program Files\\Wolfram Research\\Wolfram', rank: 0 },
  { path: 'C:\\Program Files\\Wolfram Research\\Mathematica', rank: 1 },
  { path: 'C:\\Program Files\\Wolfram Research\\Wolfram Engine', rank: 2 },
  { path: 'C:\\Program Files (x86)\\Wolfram Research\\Wolfram', rank: 3 },
  { path: 'C:\\Program Files (x86)\\Wolfram Research\\Mathematica', rank: 4 },
  { path: 'C:\\Program Files (x86)\\Wolfram Research\\Wolfram Engine', rank: 5 },
];

/** Well-known kernel locations on macOS, highest priority first. */
const MACOS_KERNEL_PATHS = [
  '/Applications/Mathematica.app/Contents/MacOS/WolframKernel',
  '/Applications/Mathematica.app/Contents/MacOS/MathKernel',
  '/Applications/Wolfram Engine.app/Contents/MacOS/WolframKernel',
];

/** Roots that contain version-numbered Wolfram installations on Linux. */
const LINUX_ROOTS = ['/usr/local/Wolfram', '/opt/Wolfram', '/opt/wolfram'];

const VERSION_RE = /(\d+)\.(\d+)(?:\.(\d+))?/g;

/**
 * Extract the highest version number embedded in a path, e.g.
 * `C:\Program Files\Wolfram Research\Wolfram\15.0\math.exe` -> [15, 0, 0].
 */
export function versionOfPath(path) {
  let best = [0, 0, 0];
  VERSION_RE.lastIndex = 0;
  let match;
  while ((match = VERSION_RE.exec(String(path))) !== null) {
    const candidate = [Number(match[1]) || 0, Number(match[2]) || 0, Number(match[3]) || 0];
    if (compareVersions(candidate, best) > 0) best = candidate;
  }
  return best;
}

/** Compare version arrays; returns negative/zero/positive like a sort comparator. */
export function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] || 0;
    const right = b[i] || 0;
    if (left !== right) return left - right;
  }
  return 0;
}

/** Newest version first; ties broken lexicographically for determinism. */
export function sortByVersionDesc(paths) {
  return [...new Set(paths)].sort((left, right) => {
    const byVersion = compareVersions(versionOfPath(right), versionOfPath(left));
    if (byVersion !== 0) return byVersion;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function defaultFs() {
  return { existsSync, readFileSync, readdirSync };
}

/** List subdirectory names, tolerating injected filesystem shims. */
function listSubdirectories(dir, fs) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(entries)) return [];
  const names = [];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      names.push(entry);
    } else if (entry && typeof entry.name === 'string') {
      if (typeof entry.isDirectory !== 'function' || entry.isDirectory()) names.push(entry.name);
    }
  }
  return names;
}

function sortRecords(records) {
  return [...records].sort((left, right) => {
    if (left.rank !== right.rank) return left.rank - right.rank;
    const byVersion = compareVersions(right.version, left.version);
    if (byVersion !== 0) return byVersion;
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });
}

/** Ordered platform candidate records `{path, rank, version}`. */
function platformCandidateRecords({ platform = process.platform, fs = defaultFs(), env = process.env } = {}) {
  const records = [];

  if (platform === 'win32') {
    for (const root of WINDOWS_ROOTS) {
      if (!fs.existsSync(root.path)) continue;
      const versions = listSubdirectories(root.path, fs)
        .filter((name) => /\d+\.\d+/.test(name))
        .sort((left, right) => compareVersions(versionOfPath(right), versionOfPath(left)));
      for (const versionDir of versions) {
        // math.exe is the documented stdio REPL launcher. MathKernel.exe is not
        // usable for piping on Windows and is deliberately not considered.
        records.push({ path: join(root.path, versionDir, 'math.exe'), rank: root.rank, version: versionOfPath(versionDir) });
      }
      records.push({ path: join(root.path, 'math.exe'), rank: root.rank + 0.5, version: [0, 0, 0] });
    }
  } else if (platform === 'darwin') {
    MACOS_KERNEL_PATHS.forEach((path, index) => {
      records.push({ path, rank: index, version: versionOfPath(path) });
    });
    for (const root of LINUX_ROOTS) {
      if (!fs.existsSync(root)) continue;
      for (const entry of listSubdirectories(root, fs)) {
        for (const relative of [join('Executables', 'math'), join('Executables', 'WolframKernel')]) {
          records.push({ path: join(root, entry, relative), rank: 10, version: versionOfPath(entry) });
        }
      }
    }
  } else {
    // Linux and other Unix-like platforms: PATH first, then install roots.
    for (const dir of String(env.PATH || '').split(delimiter)) {
      if (!dir) continue;
      records.push({ path: join(dir, 'math'), rank: 0, version: [0, 0, 0] });
      records.push({ path: join(dir, 'WolframKernel'), rank: 1, version: [0, 0, 0] });
    }
    let rootRank = 10;
    for (const root of LINUX_ROOTS) {
      if (!fs.existsSync(root)) continue;
      for (const entry of listSubdirectories(root, fs)) {
        const entryPath = join(root, entry);
        const entryVersion = versionOfPath(entry);
        for (const relative of [join('Executables', 'math'), join('Executables', 'WolframKernel'), 'math']) {
          records.push({ path: join(entryPath, relative), rank: rootRank, version: entryVersion });
        }
        for (const versionDir of listSubdirectories(entryPath, fs)) {
          for (const relative of [join('Executables', 'math'), join('Executables', 'WolframKernel'), 'math']) {
            records.push({ path: join(entryPath, versionDir, relative), rank: rootRank + 0.1, version: versionOfPath(versionDir) });
          }
        }
      }
      rootRank += 1;
    }
  }

  return sortRecords(records.filter((record) => fs.existsSync(record.path)));
}

/** Ordered candidate kernel executables for the current platform. */
export function platformCandidates(options = {}) {
  return platformCandidateRecords(options).map((record) => record.path);
}

function readConfig(configPath, fs) {
  if (!configPath || !fs.existsSync(configPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    for (const key of ['kernelPath', 'kernel', 'path']) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Ordered list of candidate kernel executables, with their detection source.
 *
 * @returns {Array<{path: string, source: string}>}
 */
export function kernelCandidates({
  cliPath = null,
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
  fs = defaultFs(),
} = {}) {
  const candidates = [];
  const seen = new Set();
  const add = (path, source) => {
    if (!path) return;
    const key = String(path).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ path, source });
  };

  const explicit = typeof cliPath === 'string' ? cliPath.trim() : '';
  if (explicit && fs.existsSync(explicit)) add(explicit, 'cli:--kernel');

  for (const variable of ENV_KERNEL_VARS) {
    const value = typeof env[variable] === 'string' ? env[variable].trim() : '';
    if (value && fs.existsSync(value)) add(value, `env:${variable}`);
  }

  const configPath = join(homeDir || '', CONFIG_FILENAME);
  const configured = readConfig(configPath, fs);
  if (configured && fs.existsSync(configured)) add(configured, `config:${configPath}`);

  for (const path of platformCandidates({ platform, fs, env })) add(path, 'platform-default');

  return candidates;
}

/**
 * Backwards-compatible synchronous detection: returns the first existing
 * candidate without starting it. Prefer `resolveKernel()` when correctness
 * matters (unlicensed installs are skipped only by the probe).
 */
export function detectKernel(options = {}) {
  const candidates = kernelCandidates(options);
  return candidates.length > 0 ? candidates[0] : null;
}

/** Human readable hint appended to kernel-not-found errors. */
export function kernelNotFoundHint() {
  return [
    'No working Wolfram Language kernel was found.',
    'Install Mathematica (or the free Wolfram Engine with a valid license/password) and make sure its kernel is available, then either:',
    '  - set the MATHEMATICA_EXE environment variable to the full path of the kernel, e.g.',
    '      Windows: set MATHEMATICA_EXE=C:\\Program Files\\Wolfram Research\\Wolfram\\15.0\\math.exe',
    '      macOS:   export MATHEMATICA_EXE="/Applications/Mathematica.app/Contents/MacOS/WolframKernel"',
    '      Linux:   export MATHEMATICA_EXE=/usr/local/Wolfram/Mathematica/15.0/Executables/math',
    '  - pass --kernel <path> on the command line, or',
    `  - write {"kernelPath": "<path>"} to ~/${CONFIG_FILENAME}.`,
  ].join('\n');
}

/**
 * Start a candidate kernel and check that it is licensed and responsive.
 *
 * @returns {Promise<{ok: boolean, reason?: string, detail?: string}>}
 */
export function probeKernel(kernelPath, { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let child = null;
    let stdout = '';
    let stderr = '';
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        if (child && child.exitCode === null) child.kill();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    try {
      child = spawnFn(kernelPath, ['-noprompt'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      resolve({ ok: false, reason: 'spawn-error', detail: error && error.message ? error.message : String(error) });
      return;
    }

    timer = setTimeout(() => {
      finish({ ok: false, reason: 'timeout', detail: `no output within ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    if (timer.unref) timer.unref();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes(PROBE_MARKER)) finish({ ok: true, detail: 'kernel is licensed and responsive' });
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (/no valid password/i.test(stderr)) {
        finish({ ok: false, reason: 'unlicensed', detail: 'kernel reports "No valid password found" (no activated license)' });
      }
    });
    child.on('error', (error) => {
      finish({ ok: false, reason: 'spawn-error', detail: error && error.message ? error.message : String(error) });
    });
    child.on('exit', (code, signal) => {
      const combined = `${stdout}\n${stderr}`;
      if (/no valid password/i.test(combined) || code === 69) {
        finish({ ok: false, reason: 'unlicensed', detail: `kernel exited with code ${code} (no valid license/password)` });
        return;
      }
      finish({
        ok: false,
        reason: 'exited',
        detail: `kernel exited with code ${code}${signal ? ` (signal ${signal})` : ''}${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ''}`,
      });
    });

    try {
      child.stdin.write(`$CharacterEncoding = "UTF-8";\nPrint["${PROBE_MARKER}"]; 2+2\n`);
    } catch (error) {
      finish({ ok: false, reason: 'spawn-error', detail: error && error.message ? error.message : String(error) });
    }
  });
}

function formatProbeReason(entry) {
  const source = entry.source ? ` (${entry.source})` : '';
  if (entry.ok) return 'OK';
  const reason = entry.reason || 'failed';
  const detail = entry.detail ? `: ${entry.detail}` : '';
  return `${reason}${detail}`;
}

/**
 * Probe candidates in order and return the first working kernel.
 *
 * @returns {Promise<{ok: boolean, path?: string, source?: string, tried: Array<object>, error?: string}>}
 */
export async function resolveKernel({
  cliPath = null,
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
  fs = defaultFs(),
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  limit = 10,
  spawnFn = spawn,
} = {}) {
  const candidates = kernelCandidates({ cliPath, env, platform, homeDir, fs }).slice(0, limit);
  const tried = [];
  for (const candidate of candidates) {
    const result = await probeKernel(candidate.path, { timeoutMs, spawnFn });
    const entry = {
      path: candidate.path,
      source: candidate.source,
      ok: result.ok,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.detail ? { detail: result.detail } : {}),
    };
    tried.push(entry);
    if (result.ok) {
      return { ok: true, path: candidate.path, source: candidate.source, tried };
    }
  }

  const lines = [];
  if (tried.length === 0) {
    lines.push('No Mathematica kernel executable was found on this machine (no candidate paths exist).');
  } else {
    lines.push(`No working Mathematica kernel was found. Tried ${tried.length} candidate(s):`);
    for (const entry of tried) {
      lines.push(`  - ${entry.path} [${entry.source}]: ${formatProbeReason(entry)}`);
    }
  }
  const unlicensed = tried.some((entry) => entry.reason === 'unlicensed');
  if (unlicensed) {
    lines.push(
      'At least one candidate exists but is not licensed (Wolfram Engine requires an activated/entitled license; ' +
        'a desktop Mathematica installation is normally the licensed kernel). Activate Mathematica/Wolfram Engine, ' +
        'or point MATHEMATICA_EXE / --kernel at a licensed kernel executable such as ...\\Wolfram\\15.0\\math.exe.',
    );
  }
  lines.push(kernelNotFoundHint());
  return { ok: false, tried, error: lines.join('\n') };
}
