import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import {
  compareVersions,
  detectKernel,
  kernelCandidates,
  kernelNotFoundHint,
  platformCandidates,
  probeKernel,
  resolveKernel,
  sortByVersionDesc,
  versionOfPath,
} from '../src/detect.js';

const WIN_WOLFRAM_140 = 'C:\\Program Files\\Wolfram Research\\Wolfram\\14.0\\math.exe';
const WIN_WOLFRAM_150 = 'C:\\Program Files\\Wolfram Research\\Wolfram\\15.0\\math.exe';
const WIN_MATHEMATICA_132 = 'C:\\Program Files\\Wolfram Research\\Mathematica\\13.2\\math.exe';
const WIN_ENGINE_150 = 'C:\\Program Files\\Wolfram Research\\Wolfram Engine\\15.0\\math.exe';
const WIN_CLI = 'C:\\custom\\math.exe';
const WIN_ENV = 'C:\\env\\math.exe';
const WIN_CONFIG = 'C:\\config\\math.exe';
const TEST_HOME = 'C:\\Users\\mcp-test';
const CONFIG_PATH = join(TEST_HOME, '.mathematica-mcp.json');

function norm(value) {
  // Compare paths independently of the host OS path separator so the unit
  // tests produce the same results on Windows/macOS/Linux CI runners.
  return String(value).toLowerCase().replace(/\\/g, '/');
}

/** In-memory filesystem shim for the injectable detect.js filesystem API. */
function makeFakeFs({ files = [], dirs = {}, contents = {} } = {}) {
  const fileSet = new Set(files.map(norm));
  const dirMap = new Map(Object.entries(dirs).map(([key, value]) => [norm(key), value]));
  const contentMap = new Map(Object.entries(contents).map(([key, value]) => [norm(key), value]));
  return {
    existsSync(path) {
      return fileSet.has(norm(path)) || dirMap.has(norm(path)) || contentMap.has(norm(path));
    },
    readFileSync(path) {
      const value = contentMap.get(norm(path));
      if (value === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return value;
    },
    readdirSync(path) {
      const children = dirMap.get(norm(path));
      if (!children) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return children.map((name) => ({ name, isDirectory: () => true }));
    },
  };
}

test('versionOfPath extracts the newest version embedded in a path', () => {
  assert.deepEqual(versionOfPath(WIN_WOLFRAM_150), [15, 0, 0]);
  assert.deepEqual(versionOfPath(WIN_MATHEMATICA_132), [13, 2, 0]);
  assert.deepEqual(versionOfPath('/usr/local/Wolfram/Mathematica/14.3/Executables/math'), [14, 3, 0]);
  assert.deepEqual(versionOfPath('/usr/bin/math'), [0, 0, 0]);
  assert.ok(compareVersions([15, 0, 0], [14, 3, 2]) > 0);
  assert.ok(compareVersions([13, 2, 0], [13, 2, 0]) === 0);
});

test('sortByVersionDesc orders kernels newest first and deduplicates', () => {
  const sorted = sortByVersionDesc([WIN_WOLFRAM_140, WIN_WOLFRAM_150, WIN_WOLFRAM_150]);
  assert.deepEqual(sorted, [WIN_WOLFRAM_150, WIN_WOLFRAM_140]);
});

test('Windows candidate order prefers desktop Wolfram math.exe before Wolfram Engine', () => {
  const fs = makeFakeFs({
    files: [WIN_WOLFRAM_140, WIN_WOLFRAM_150, WIN_MATHEMATICA_132, WIN_ENGINE_150],
    dirs: {
      'C:\\Program Files\\Wolfram Research\\Wolfram': ['14.0', '15.0'],
      'C:\\Program Files\\Wolfram Research\\Mathematica': ['13.2'],
      'C:\\Program Files\\Wolfram Research\\Wolfram Engine': ['15.0'],
    },
  });
  const candidates = platformCandidates({ platform: 'win32', fs, env: {} });
  const normalized = candidates.map(norm);
  assert.equal(normalized[0], norm(WIN_WOLFRAM_150));
  assert.equal(normalized[1], norm(WIN_WOLFRAM_140));
  assert.ok(normalized.indexOf(norm(WIN_MATHEMATICA_132)) < normalized.indexOf(norm(WIN_ENGINE_150)));
  // MathKernel.exe is not a usable stdio launcher and must never be a candidate.
  assert.ok(candidates.every((path) => !/MathKernel\.exe$/i.test(path)));
  assert.ok(candidates.every((path) => /math\.exe$/i.test(path)));
});

test('kernelCandidates priority is cli > env > config > platform defaults', () => {
  const fs = makeFakeFs({
    files: [WIN_CLI, WIN_ENV, WIN_CONFIG, WIN_WOLFRAM_150],
    dirs: { 'C:\\Program Files\\Wolfram Research\\Wolfram': ['15.0'] },
    contents: { [CONFIG_PATH]: JSON.stringify({ kernelPath: WIN_CONFIG }) },
  });
  const candidates = kernelCandidates({
    cliPath: WIN_CLI,
    env: { MATHEMATICA_EXE: WIN_ENV },
    platform: 'win32',
    homeDir: TEST_HOME,
    fs,
  });
  assert.deepEqual(
    candidates.map((candidate) => candidate.source),
    ['cli:--kernel', 'env:MATHEMATICA_EXE', `config:${CONFIG_PATH}`, 'platform-default'],
  );
  assert.equal(norm(detectKernel({ cliPath: WIN_CLI, env: { MATHEMATICA_EXE: WIN_ENV }, platform: 'win32', homeDir: TEST_HOME, fs }).path), norm(WIN_CLI));
});

test('MATHEMATICA_KERNEL is read when MATHEMATICA_EXE is not set', () => {
  const fs = makeFakeFs({ files: [WIN_ENV] });
  const candidates = kernelCandidates({ env: { MATHEMATICA_KERNEL: WIN_ENV }, platform: 'win32', homeDir: TEST_HOME, fs });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].path, WIN_ENV);
  assert.equal(candidates[0].source, 'env:MATHEMATICA_KERNEL');
});

test('config file is used, and invalid JSON is ignored', () => {
  const goodFs = makeFakeFs({ files: [WIN_CONFIG], contents: { [CONFIG_PATH]: JSON.stringify({ kernelPath: WIN_CONFIG }) } });
  const good = kernelCandidates({ env: {}, platform: 'win32', homeDir: TEST_HOME, fs: goodFs });
  assert.equal(norm(good[0].path), norm(WIN_CONFIG));
  assert.match(good[0].source, /^config:/);

  const badFs = makeFakeFs({ files: [WIN_CONFIG], contents: { [CONFIG_PATH]: '{ this is not json' } });
  const bad = kernelCandidates({ env: {}, platform: 'win32', homeDir: TEST_HOME, fs: badFs });
  assert.equal(bad.length, 0);

  const aliasFs = makeFakeFs({ files: [WIN_CONFIG], contents: { [CONFIG_PATH]: JSON.stringify({ kernel: WIN_CONFIG }) } });
  assert.equal(norm(kernelCandidates({ env: {}, platform: 'win32', homeDir: TEST_HOME, fs: aliasFs })[0].path), norm(WIN_CONFIG));
});

test('nothing installed produces null and an actionable hint', async () => {
  const fs = makeFakeFs();
  assert.equal(detectKernel({ env: {}, platform: 'win32', homeDir: TEST_HOME, fs }), null);
  assert.match(kernelNotFoundHint(), /MATHEMATICA_EXE/);
  assert.match(kernelNotFoundHint(), /--kernel/);

  const resolution = await resolveKernel({ env: {}, platform: 'win32', homeDir: TEST_HOME, fs });
  assert.equal(resolution.ok, false);
  assert.equal(resolution.tried.length, 0);
  assert.match(resolution.error, /MATHEMATICA_EXE/);
});

test('probeKernel reports a spawn error for a missing executable', async () => {
  const result = await probeKernel(join(tmpdir(), 'mathematica-mcp-definitely-missing-kernel.exe'), { timeoutMs: 5000 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'spawn-error');
  assert.equal(typeof result.detail, 'string');
});

test('Linux candidates include PATH math first and versioned Wolfram installs', () => {
  const linuxRoot = '/usr/local/Wolfram';
  const versioned = `${linuxRoot}/Mathematica/14.1/Executables/math`;
  const fs = makeFakeFs({
    files: ['/usr/bin/math', versioned],
    dirs: {
      [linuxRoot]: ['Mathematica'],
      [`${linuxRoot}/Mathematica`]: ['14.1'],
    },
  });
  const candidates = platformCandidates({
    platform: 'linux',
    fs,
    env: { PATH: ['/usr/bin', '/bin'].join(delimiter) },
  });
  const normalized = candidates.map(norm);
  assert.equal(normalized[0], '/usr/bin/math');
  assert.ok(normalized.includes(norm(versioned)));
});

test('real machine: desktop kernel is preferred and a working kernel is probed (skips when unavailable)', async (t) => {
  const cleanEnv = {};
  const candidates = platformCandidates({ env: cleanEnv });
  if (candidates.length === 0) {
    t.skip('No Mathematica / Wolfram Engine installation found on this machine.');
    return;
  }
  // Only assert a working kernel when the candidates actually look like a
  // Wolfram installation. A stray non-Wolfram `math` binary on PATH (some CI
  // images have one) must not fail the suite.
  const looksLikeWolfram = candidates.some((path) => /wolfram|mathematica/i.test(path));
  if (!looksLikeWolfram) {
    t.skip('No Wolfram-looking kernel candidate found on this machine.');
    return;
  }
  if (process.platform === 'win32') {
    const desktop = candidates.find((path) => /\\Wolfram\\\d+\.\d+\\math\.exe$/i.test(path));
    const engine = candidates.find((path) => /Wolfram Engine\\\d+\.\d+\\math\.exe$/i.test(path));
    if (desktop && engine) {
      assert.ok(candidates.indexOf(desktop) < candidates.indexOf(engine), 'desktop Wolfram kernel must be probed before Wolfram Engine');
    }
  }
  const resolution = await resolveKernel({
    env: cleanEnv,
    homeDir: join(tmpdir(), 'mathematica-mcp-test-home'),
    timeoutMs: 30_000,
  });
  assert.equal(resolution.ok, true, `expected a working kernel, got:\n${resolution.error}`);
  assert.ok(existsSync(resolution.path));
  assert.match(resolution.path, /math(\.exe)?$|WolframKernel$/i);
});
