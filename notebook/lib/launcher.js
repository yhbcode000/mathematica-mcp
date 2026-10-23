/**
 * Native Mathematica / Wolfram notebook front-end locator + detached launcher
 * (CONTRACT.md §2 openInMathematica, §8 launcher).
 *
 * Only well-known installation roots are scanned (mirroring the kernel
 * detector); no shell interpolation is used — the executable is spawned with
 * an argument vector and no shell.
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { ErrorCodes, PluginError } from './errors.js';

/** Desktop install roots on Windows, highest priority first. */
const WINDOWS_ROOTS = [
  'C:\\Program Files\\Wolfram Research\\Wolfram',
  'C:\\Program Files\\Wolfram Research\\Mathematica',
  'C:\\Program Files (x86)\\Wolfram Research\\Wolfram',
  'C:\\Program Files (x86)\\Wolfram Research\\Mathematica',
];

/** Notebook front-end binary names inside a Windows version directory. */
const WINDOWS_BINARIES = ['WolframNB.exe', 'Mathematica.exe', 'Wolfram.exe'];

/** macOS application bundles (Mathematica and the standalone Wolfram app). */
const MACOS_CANDIDATES = [
  '/Applications/Mathematica.app/Contents/MacOS/Mathematica',
  '/Applications/Mathematica.app/Contents/MacOS/WolframNB',
  '/Applications/Wolfram.app/Contents/MacOS/Wolfram',
  '/Applications/Wolfram Desktop.app/Contents/MacOS/Wolfram Desktop',
];

/** Linux install roots that contain version-numbered Wolfram trees. */
const LINUX_ROOTS = ['/usr/local/Wolfram', '/opt/Wolfram', '/opt/wolfram'];

/** Linux executable names resolved on PATH. */
const LINUX_PATH_BINARIES = ['mathematica', 'WolframNB', 'wolframnb', 'wolfram'];

function defaultFs() {
  return { existsSync, readdirSync };
}

/** Version-ish directory names first, newest (highest number) first. */
function listVersionDirs(root, fs) {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    try {
      entries = fs.readdirSync(root);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => (typeof entry === 'string' ? entry : entry?.name))
    .filter((name) => typeof name === 'string' && /^\d+\.\d+/.test(name))
    .sort((left, right) => {
      const a = left.split('.').map(Number);
      const b = right.split('.').map(Number);
      for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        const diff = (b[index] || 0) - (a[index] || 0);
        if (diff !== 0) return diff;
      }
      return 0;
    });
}

/**
 * Locate the native Wolfram notebook front end.
 *
 * @param {object} [options]
 * @param {string} [options.platform]
 * @param {object} [options.env]
 * @param {string} [options.homeDir]
 * @param {{existsSync: Function, readdirSync: Function}} [options.fs]
 * @returns {{path: string, kind: string}|null}
 */
export function locateMathematica({ platform = process.platform, env = process.env, homeDir = homedir(), fs = defaultFs() } = {}) {
  if (platform === 'win32') {
    for (const root of WINDOWS_ROOTS) {
      if (!fs.existsSync(root)) continue;
      for (const versionDir of listVersionDirs(root, fs)) {
        for (const binary of WINDOWS_BINARIES) {
          const candidate = join(root, versionDir, binary);
          if (fs.existsSync(candidate)) return { path: candidate, kind: 'wolfram-notebook' };
        }
      }
      for (const binary of WINDOWS_BINARIES) {
        const candidate = join(root, binary);
        if (fs.existsSync(candidate)) return { path: candidate, kind: 'wolfram-notebook' };
      }
    }
    return null;
  }

  if (platform === 'darwin') {
    for (const candidate of MACOS_CANDIDATES) {
      if (fs.existsSync(candidate)) return { path: candidate, kind: 'mathematica' };
    }
    return null;
  }

  for (const dir of String(env?.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const binary of LINUX_PATH_BINARIES) {
      const candidate = join(dir, binary);
      if (fs.existsSync(candidate)) return { path: candidate, kind: 'mathematica' };
    }
  }
  for (const root of LINUX_ROOTS) {
    if (!fs.existsSync(root)) continue;
    for (const versionDir of listVersionDirs(root, fs)) {
      for (const relative of ['Executables/Mathematica', 'Executables/mathematica', 'Executables/WolframNB', 'Mathematica']) {
        const candidate = join(root, versionDir, ...relative.split('/'));
        if (fs.existsSync(candidate)) return { path: candidate, kind: 'mathematica' };
      }
    }
  }
  return null;
}

/**
 * Spawn the native front end detached and check liveness for a moment.
 *
 * @param {string} notebookPath absolute `.nb` path
 * @param {object} [options]
 * @param {Function} [options.locate] injectable locator
 * @param {Function} [options.spawnFn] injectable spawn (tests)
 * @param {number} [options.livenessMs]
 * @returns {Promise<{launched: true, executable: string, pid: number|undefined}>}
 * @throws {PluginError} `launch_failed`
 */
export function launchMathematica(
  notebookPath,
  { locate = () => locateMathematica(), spawnFn = spawn, livenessMs = 2000 } = {},
) {
  const located = locate();
  if (!located || typeof located.path !== 'string') {
    throw new PluginError(
      ErrorCodes.LAUNCH_FAILED,
      'Mathematica was not found on this machine. Install Mathematica / Wolfram Desktop, or open the .nb file manually.',
    );
  }
  const executable = located.path;
  let child;
  try {
    child = spawnFn(executable, [notebookPath], { detached: true, stdio: 'ignore', windowsHide: false });
  } catch (error) {
    throw new PluginError(ErrorCodes.LAUNCH_FAILED, `could not launch Mathematica: ${error?.message ?? error}`, { executable });
  }
  try {
    if (typeof child.unref === 'function') child.unref();
  } catch {
    /* ignore */
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        child.removeListener?.('error', onError);
        child.removeListener?.('exit', onExit);
      } catch {
        /* ignore */
      }
      if (error) reject(error);
      else resolve({ launched: true, executable, pid: typeof child.pid === 'number' ? child.pid : undefined });
    };
    const onError = (error) => {
      finish(new PluginError(ErrorCodes.LAUNCH_FAILED, `could not launch Mathematica: ${error?.message ?? error}`, { executable }));
    };
    const onExit = (code, signal) => {
      if (code === 0 && !signal) {
        // A delegating launcher (script / `open`-style wrapper) exited cleanly
        // after handing the file to the desktop app.
        finish(null);
        return;
      }
      finish(
        new PluginError(ErrorCodes.LAUNCH_FAILED, `Mathematica exited immediately (code ${code}${signal ? `, signal ${signal}` : ''})`, {
          executable,
          code,
        }),
      );
    };
    child.once?.('error', onError);
    child.once?.('exit', onExit);
    timer = setTimeout(() => finish(null), livenessMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/** Convenience launcher object used by the operations layer. */
export function createLauncher(options = {}) {
  return {
    locate: () => locateMathematica(options),
    launch: (notebookPath) => launchMathematica(notebookPath, { locate: () => locateMathematica(options) }),
  };
}
