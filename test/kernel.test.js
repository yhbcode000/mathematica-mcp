/**
 * Kernel integration tests: these spawn the real MCP server with a real local
 * Mathematica / Wolfram Engine kernel and exercise the tool contract end to end.
 *
 * They are skipped automatically when no working kernel can be found (for
 * example on CI machines without Mathematica). Set MATHEMATICA_MCP_TEST_SKIP_KERNEL=1
 * to force skipping, or MATHEMATICA_EXE / MATHEMATICA_MCP_TEST_KERNEL to choose
 * the kernel executable explicitly.
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { McpTestClient, kernelSkipReason, resolveTestKernel, toolPayload } from './mcp-client.mjs';
import { KernelBridge, buildWrapper, parseFrame } from '../src/kernel.js';

const kernelPath = await resolveTestKernel();
const ARTIFACT_DIR = join(tmpdir(), 'mathematica-mcp-artifact-tests');

/**
 * Register a kernel test, or a skipped placeholder when no kernel is available
 * (so `node --test test/` stays green on machines without Mathematica).
 */
function kernelTest(name, options, fn) {
  if (!kernelPath) {
    test(name, { ...options, skip: kernelSkipReason() }, fn);
    return;
  }
  test(name, options, fn);
}

let client = null;
const createdFiles = [];

/** Lazily started direct KernelBridge instance used by the artifact tests. */
let artifactBridge = null;

async function getArtifactBridge() {
  if (!artifactBridge) {
    artifactBridge = new KernelBridge({
      kernelPath,
      logger: (message) => process.stderr.write(`[kernel-bridge-test] ${message}\n`),
    });
    await artifactBridge.ensureReady();
  }
  return artifactBridge;
}

async function artifactTarget(extension) {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const target = join(ARTIFACT_DIR, `artifact-${Date.now()}-${Math.random().toString(16).slice(2)}.${extension}`);
  createdFiles.push(target);
  return target;
}

async function call(name, args, options) {
  const response = await client.callTool(name, args, options);
  return {
    response,
    payload: toolPayload(response),
    isError: Boolean(response && response.result && response.result.isError),
  };
}

before(async () => {
  if (!kernelPath) return;
  client = new McpTestClient({ kernelPath }).start();
  const init = await client.initialize({ protocolVersion: '2025-06-18' });
  assert.equal(init.result.protocolVersion, '2025-06-18');
});

after(async () => {
  if (artifactBridge) {
    try {
      await artifactBridge.shutdown();
    } catch {
      /* ignore cleanup errors */
    }
  }
  if (client) await client.close();
  for (const file of createdFiles) {
    try {
      await rm(file, { force: true });
    } catch {
      /* ignore cleanup errors */
    }
  }
  try {
    await rm(ARTIFACT_DIR, { recursive: true, force: true });
  } catch {
    /* ignore cleanup errors */
  }
});

kernelTest('kernel_status reports a detected kernel before the first start', { timeout: 120_000 }, async () => {
  const { payload, isError } = await call('mathematica_kernel_status', { action: 'status' });
  assert.equal(isError, false);
  assert.equal(payload.ok, true);
  assert.equal(payload.resolution_attempted, false);
  assert.equal(payload.kernel_found, null);
  assert.ok(Array.isArray(payload.candidates) && payload.candidates.length >= 1);
  assert.equal(payload.kernel.running, false);
  assert.equal(payload.kernel.ready, false);
});

kernelTest('mathematica_evaluate computes 2+2 in the real kernel', { timeout: 180_000 }, async () => {
  const { payload, isError } = await call('mathematica_evaluate', { code: '2+2' });
  assert.equal(isError, false);
  assert.equal(payload.ok, true);
  assert.equal(payload.result, 4);
  assert.equal(payload.result_inputform, '4');
  assert.equal(typeof payload.duration_ms, 'number');
});

kernelTest('round-trips Unicode (Chinese, Greek, math symbols, emoji) through the kernel', { timeout: 120_000 }, async () => {
  const text = '中文测试 αβγ ∑ → 😀';
  const { payload, isError } = await call('mathematica_evaluate', { code: JSON.stringify(text) });
  assert.equal(isError, false);
  assert.equal(payload.result, text);
  assert.match(payload.result_inputform, /中文测试/);
});

kernelTest('persists variables and definitions across calls', { timeout: 120_000 }, async () => {
  const set = await call('mathematica_evaluate', { code: 'a = 17' });
  assert.equal(set.isError, false);
  assert.equal(set.payload.result, 17);
  const get = await call('mathematica_evaluate', { code: 'a' });
  assert.equal(get.isError, false);
  assert.equal(get.payload.result, 17);

  const multi = await call('mathematica_evaluate', { code: 'b = 5;\nh[x_] := x^2 + b;\nh[3]' });
  assert.equal(multi.isError, false);
  assert.equal(multi.payload.result, 14);
  const reuse = await call('mathematica_evaluate', { code: 'h[4] + a' });
  assert.equal(reuse.payload.result, 38);
});

kernelTest('captures output printed by Print[]', { timeout: 120_000 }, async () => {
  const { payload, isError } = await call('mathematica_evaluate', { code: 'Print["hello from Print"]; 42' });
  assert.equal(isError, false);
  assert.match(payload.output, /hello from Print/);
  assert.equal(payload.result, 42);
});

kernelTest('syntax error returns isError and leaves the kernel usable', { timeout: 120_000 }, async () => {
  const broken = await call('mathematica_evaluate', { code: '1 +' });
  assert.equal(broken.isError, true);
  assert.equal(broken.payload.ok, false);
  assert.equal(broken.payload.error, 'evaluation_failed');
  assert.equal(broken.payload.result_inputform, '$Failed');
  assert.ok(broken.payload.messages.some((name) => /sntx/.test(name)), `messages: ${JSON.stringify(broken.payload.messages)}`);

  const stillUsable = await call('mathematica_evaluate', { code: '2+2' });
  assert.equal(stillUsable.isError, false);
  assert.equal(stillUsable.payload.result, 4);
});

kernelTest('unbalanced code returns isError and leaves the kernel usable', { timeout: 120_000 }, async () => {
  const broken = await call('mathematica_evaluate', { code: '(1+2' });
  assert.equal(broken.isError, true);
  assert.equal(broken.payload.error, 'evaluation_failed');

  const stillUsable = await call('mathematica_evaluate', { code: '3*3' });
  assert.equal(stillUsable.isError, false);
  assert.equal(stillUsable.payload.result, 9);
});

kernelTest('timeout aborts the evaluation and leaves the kernel usable', { timeout: 180_000 }, async () => {
  const started = Date.now();
  const timedOut = await call('mathematica_evaluate', { code: 'While[True, 1]', timeout_seconds: 2 });
  const elapsed = Date.now() - started;
  assert.equal(timedOut.isError, true);
  assert.equal(timedOut.payload.ok, false);
  assert.equal(timedOut.payload.error, 'timeout');
  assert.equal(timedOut.payload.result_inputform, '$Aborted');
  assert.match(timedOut.payload.message, /timeout/i);
  assert.ok(elapsed >= 1500, `expected the evaluation to be aborted after ~2s, took ${elapsed}ms`);

  const stillUsable = await call('mathematica_evaluate', { code: '7*6' });
  assert.equal(stillUsable.isError, false);
  assert.equal(stillUsable.payload.result, 42);
});

kernelTest('mathematica_export writes a real PNG (default artifact path)', { timeout: 300_000 }, async () => {
  const { payload, isError } = await call(
    'mathematica_export',
    { code: 'Plot[Sin[x], {x, 0, 6.28}]', format: 'png' },
    { timeoutMs: 280_000 },
  );
  assert.equal(isError, false);
  assert.equal(payload.ok, true);
  assert.equal(payload.format, 'png');
  assert.ok(Number(payload.bytes) > 1000, `expected PNG > 1000 bytes, got ${payload.bytes}`);
  assert.ok(existsSync(payload.path), `expected exported file to exist: ${payload.path}`);
  createdFiles.push(payload.path);
  const file = await readFile(payload.path);
  assert.equal(file.length, payload.bytes);
  assert.deepEqual(Buffer.from(file.subarray(0, 8)), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  assert.match(payload.path, /mathematica-mcp/, 'default artifacts path should be under mathematica-mcp temp folder');
});

kernelTest('mathematica_export honours an explicit file_path and image dimensions', { timeout: 300_000 }, async () => {
  const target = join(tmpdir(), 'mathematica-mcp-tests', `explicit-${Date.now()}.png`);
  const { payload, isError } = await call(
    'mathematica_export',
    { code: 'Plot[Cos[x], {x, 0, 6.28}]', format: 'png', file_path: target, width: 400, height: 300 },
    { timeoutMs: 280_000 },
  );
  assert.equal(isError, false);
  assert.equal(payload.path, target);
  assert.equal(payload.width, 400);
  assert.equal(payload.height, 300);
  assert.ok(Number(payload.bytes) > 1000);
  createdFiles.push(target);
  assert.ok(existsSync(target));
});

kernelTest('mathematica_export writes CSV data and SVG/PDF vector files', { timeout: 300_000 }, async () => {
  const csv = await call('mathematica_export', { code: 'Table[{i, i^2}, {i, 1, 3}]', format: 'csv' }, { timeoutMs: 280_000 });
  assert.equal(csv.isError, false);
  assert.ok(Number(csv.payload.bytes) > 0);
  createdFiles.push(csv.payload.path);
  const csvText = await readFile(csv.payload.path, 'utf8');
  assert.match(csvText, /1,\s*1/);
  assert.match(csvText, /3,\s*9/);

  const json = await call('mathematica_export', { code: '<|"name" -> "test", "value" -> 42|>', format: 'json' }, { timeoutMs: 280_000 });
  assert.equal(json.isError, false);
  createdFiles.push(json.payload.path);
  const parsed = JSON.parse(await readFile(json.payload.path, 'utf8'));
  assert.equal(parsed.name, 'test');
  assert.equal(parsed.value, 42);

  for (const format of ['svg', 'pdf']) {
    const result = await call('mathematica_export', { code: 'Plot[Sin[x], {x, 0, 6.28}]', format }, { timeoutMs: 280_000 });
    assert.equal(result.isError, false, `${format} export failed: ${JSON.stringify(result.payload)}`);
    assert.ok(Number(result.payload.bytes) > 1000, `expected a non-trivial ${format} file`);
    createdFiles.push(result.payload.path);
  }
});

kernelTest('mathematica_information returns symbol attributes for Plot', { timeout: 120_000 }, async () => {
  const { payload, isError } = await call('mathematica_information', { symbols: ['Plot'] });
  assert.equal(isError, false);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.symbols, ['Plot']);
  assert.match(payload.result_inputform, /"Attributes" -> "\{[^"]*Protected[^"]*\}"/);
  assert.match(payload.result_inputform, /"Context" -> "System`"/);
  assert.match(payload.result_inputform, /"OptionsCount" -> \d+/);
});

kernelTest('mathematica_kernel_status reports a running kernel', { timeout: 120_000 }, async () => {
  const { payload, isError } = await call('mathematica_kernel_status', { action: 'status' });
  assert.equal(isError, false);
  assert.equal(payload.kernel_found, true);
  assert.equal(payload.resolution_attempted, true);
  assert.equal(typeof payload.kernel_path, 'string');
  assert.equal(payload.kernel.running, true);
  assert.equal(payload.kernel.ready, true);
  assert.equal(typeof payload.kernel.pid, 'number');
  assert.ok(payload.kernel.calls >= 1);
  assert.ok(Array.isArray(payload.tried) && payload.tried[0].ok === true);
});

kernelTest('restart restarts the kernel and clears in-memory state', { timeout: 180_000 }, async () => {
  const restarted = await call('mathematica_kernel_status', { action: 'restart' });
  assert.equal(restarted.isError, false);
  assert.equal(restarted.payload.action, 'restart');
  assert.equal(restarted.payload.restarted, true);
  assert.equal(restarted.payload.kernel.running, true);
  assert.match(restarted.payload.note, /state/i);

  const cleared = await call('mathematica_evaluate', { code: 'a' });
  assert.equal(cleared.isError, false);
  assert.equal(cleared.payload.result_inputform, 'a', 'symbol a should be undefined after restart');

  const usable = await call('mathematica_evaluate', { code: '2+2' });
  assert.equal(usable.isError, false);
  assert.equal(usable.payload.result, 4);
});

kernelTest('server stdout stayed protocol-clean during the whole kernel session', { timeout: 30_000 }, async () => {
  assert.deepEqual(client.invalidStdoutLines, []);
  for (const line of client.stdoutLines) {
    assert.doesNotThrow(() => JSON.parse(line));
  }
});

// ---------------------------------------------------------------------------
// KernelBridge artifact export (optional `artifactPath` option). Used by the
// dsh-mathematica-notebook Host to render rich results as SVG/PNG.
// ---------------------------------------------------------------------------

test('buildWrapper only emits the artifact frame when artifactPath is requested', () => {
  const plain = buildWrapper('plain-id', '2+2', 60);
  assert.ok(!plain.includes('@@MM:ARTIFACT:'));
  assert.ok(!plain.includes('mathematica$mcp$art'));
  assert.ok(plain.includes('@@MM:MSGS:plain-id@@'));
  assert.ok(plain.indexOf('@@MM:MSGS:plain-id@@') < plain.indexOf('@@MM:END:plain-id@@'));

  const withArtifact = buildWrapper('art-id', '2+2', 60, { artifactPath: 'C:/tmp/artifact.svg' });
  assert.ok(withArtifact.includes('mathematica$mcp$art'));
  assert.ok(withArtifact.includes('C:/tmp/artifact.svg'));
  assert.ok(withArtifact.indexOf('@@MM:MSGS:art-id@@') < withArtifact.indexOf('@@MM:ARTIFACT:art-id@@'));
  assert.ok(withArtifact.indexOf('@@MM:ARTIFACT:art-id@@') < withArtifact.indexOf('@@MM:END:art-id@@'));
});

test('parseFrame reads optional artifact frames and stays compatible without one', () => {
  const makeFrame = (id, artifactLine) =>
    `@@MM:BEGIN:${id}@@\r\n\r\n@@MM:RESULT:${id}@@1:4\r\n@@MM:MSGS:${id}@@2:{}\r\n${artifactLine}@@MM:END:${id}@@\r\n`;

  const plain = parseFrame(makeFrame('f1', ''), 'f1');
  assert.equal(plain.resultInputform, '4');
  assert.equal(plain.artifactRaw, null);

  const withArtifact = parseFrame(makeFrame('f2', '@@MM:ARTIFACT:f2@@C:\\tmp\\out.svg\r\n'), 'f2');
  assert.equal(withArtifact.resultInputform, '4');
  assert.equal(withArtifact.artifactRaw, 'C:\\tmp\\out.svg');

  const missing = parseFrame(makeFrame('f3', '@@MM:ARTIFACT:f3@@-\r\n'), 'f3');
  assert.equal(missing.artifactRaw, '-');
});

kernelTest('artifact export: Plot[...] to .svg is reported and the file starts with <?xml', { timeout: 300_000 }, async () => {
  const bridge = await getArtifactBridge();
  const target = await artifactTarget('svg');
  const outcome = await bridge.evaluate('Plot[Sin[x], {x, 0, 6.28}]', { artifactPath: target });
  assert.equal(outcome.isError, false);
  assert.equal(outcome.payload.ok, true);
  assert.equal(outcome.payload.artifactPath, target);
  assert.ok(existsSync(target), 'expected the SVG artifact to exist');
  const content = await readFile(target, 'utf8');
  assert.ok(content.startsWith('<?xml'), `expected SVG XML, got: ${content.slice(0, 80)}`);
  assert.match(content, /<svg/);
});

kernelTest('artifact export: symbolic Integrate[x^2, x] to .svg works', { timeout: 180_000 }, async () => {
  const bridge = await getArtifactBridge();
  const target = await artifactTarget('svg');
  const outcome = await bridge.evaluate('Integrate[x^2, x]', { artifactPath: target });
  assert.equal(outcome.isError, false);
  assert.equal(outcome.payload.artifactPath, target);
  const content = await readFile(target, 'utf8');
  assert.ok(content.startsWith('<?xml'), `expected SVG XML, got: ${content.slice(0, 80)}`);
  assert.match(content, /<svg/);
});

kernelTest('artifact export: Plot[...] to .png writes a real PNG', { timeout: 180_000 }, async () => {
  const bridge = await getArtifactBridge();
  const target = await artifactTarget('png');
  const outcome = await bridge.evaluate('Plot[Cos[x], {x, 0, 6.28}]', { artifactPath: target });
  assert.equal(outcome.isError, false);
  assert.equal(outcome.payload.artifactPath, target);
  const bytes = await readFile(target);
  assert.ok(bytes.length > 1000, `expected PNG > 1000 bytes, got ${bytes.length}`);
  assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

kernelTest('artifact export: timeout produces no artifact and the kernel stays usable', { timeout: 180_000 }, async () => {
  const bridge = await getArtifactBridge();
  const target = await artifactTarget('svg');
  const outcome = await bridge.evaluate('While[True, 1]', { timeoutSeconds: 2, artifactPath: target });
  assert.equal(outcome.isError, true);
  assert.equal(outcome.payload.error, 'timeout');
  assert.equal(outcome.payload.artifactPath, null);
  assert.equal(existsSync(target), false, 'timed-out evaluation must not produce an artifact');

  const usable = await bridge.evaluate('2+2');
  assert.equal(usable.isError, false);
  assert.equal(usable.payload.result, 4);
});

kernelTest('artifact export: syntax failure produces no artifact', { timeout: 180_000 }, async () => {
  const bridge = await getArtifactBridge();
  const target = await artifactTarget('svg');
  const outcome = await bridge.evaluate('1 +', { artifactPath: target });
  assert.equal(outcome.isError, true);
  assert.equal(outcome.payload.error, 'evaluation_failed');
  assert.equal(outcome.payload.artifactPath, null);
  assert.equal(existsSync(target), false);
});

kernelTest('artifact export failure does not fail the evaluation', { timeout: 180_000 }, async () => {
  const bridge = await getArtifactBridge();
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const blocker = join(ARTIFACT_DIR, `blocker-${Date.now()}.txt`);
  await writeFile(blocker, 'not a directory');
  createdFiles.push(blocker);
  // A path below a regular file cannot be written: Export fails, Check/Quiet
  // degrade to "-" and the evaluation result must still be returned.
  const unwritable = join(blocker, 'nested', 'out.svg');
  const outcome = await bridge.evaluate('6*7', { artifactPath: unwritable });
  assert.equal(outcome.isError, false);
  assert.equal(outcome.payload.ok, true);
  assert.equal(outcome.payload.result, 42);
  assert.equal(outcome.payload.artifactPath, null);
});

kernelTest('evaluate without artifactPath keeps the payload shape unchanged', { timeout: 180_000 }, async () => {
  const bridge = await getArtifactBridge();
  const outcome = await bridge.evaluate('2+2');
  assert.equal(outcome.isError, false);
  assert.equal(outcome.payload.result, 4);
  assert.equal(Object.prototype.hasOwnProperty.call(outcome.payload, 'artifactPath'), false);
});
