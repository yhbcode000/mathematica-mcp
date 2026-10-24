/**
 * Integration tests that use the real Wolfram kernel through the vendored
 * bridge: the real `.nb` codec (single, multi-statement, text, empty,
 * unparseable cells), SVG/PNG artifact rendering, evaluate error mapping and the
 * store/operations end-to-end flow.
 *
 * These tests skip gracefully when no licensed kernel is detected, and honour
 * `MATHEMATICA_MCP_TEST_SKIP_KERNEL=1` (CI / machines without Mathematica).
 *
 *   node --test
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { resolveKernel } from '../kernel/detect.js';
import { KernelManager } from '../lib/kernel-manager.js';
import { NotebookCodec } from '../lib/nb-codec.js';
import { NotebookOperations, TYPESET_TEXT_PLACEHOLDER, TOOL_TYPESET_PLACEHOLDER } from '../lib/operations.js';
import { NotebookPaths } from '../lib/paths.js';
import { NotebookStore } from '../lib/store.js';

const skipRequested = process.env.MATHEMATICA_MCP_TEST_SKIP_KERNEL === '1';
const state = {
  reason: skipRequested ? 'MATHEMATICA_MCP_TEST_SKIP_KERNEL=1' : null,
  kernelPath: null,
  workdir: null,
  manager: null,
  codec: null,
  store: null,
  paths: null,
  operations: null,
};

function kernelTest(name, fn) {
  test(name, async (t) => {
    if (!state.kernelPath) {
      t.skip(state.reason ?? 'no working kernel detected');
      return;
    }
    await fn(t);
  });
}

before(async () => {
  state.workdir = mkdtempSync(join(tmpdir(), 'dsh-nb-kernel-'));
  if (skipRequested) return;
  const resolved = await resolveKernel({ limit: 3, timeoutMs: 20000 });
  if (!resolved?.ok || !resolved.path) {
    state.reason = 'no working Mathematica kernel detected on this machine';
    return;
  }
  state.kernelPath = resolved.path;
  const cwd = join(state.workdir, 'project');
  mkdirSync(cwd, { recursive: true });
  const dshHome = join(state.workdir, 'dsh-home');
  const ctx = {
    get(name) {
      if (name === 'agents') return { get: (id) => (id === 'session-1' ? { session: { id: 'session-1' } } : undefined) };
      if (name === 'workingDirectory') return { get: () => cwd, defaultDirectory: cwd };
      return undefined;
    },
  };
  state.paths = new NotebookPaths({ ctx, env: { DSH_HOME: dshHome }, homeDir: state.workdir, platform: process.platform });
  state.manager = new KernelManager({
    probeTimeoutMs: 20000,
    resolveKernelFn: async () => ({ ok: true, path: state.kernelPath }),
  });
  state.codec = new NotebookCodec({ kernel: state.manager });
  state.store = new NotebookStore({ codec: state.codec, paths: state.paths, autoSaveMs: 80 });
  state.operations = new NotebookOperations({
    store: state.store,
    kernel: state.manager,
    paths: state.paths,
    launcher: null,
  });
});

after(async () => {
  try {
    if (state.store) await state.store.dispose();
  } finally {
    try {
      if (state.manager) await state.manager.dispose();
    } finally {
      if (state.workdir) {
        try {
          rmSync(state.workdir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }
  }
});

const sleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  if (typeof timer.unref === 'function') timer.unref();
});

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function assertPng(bytes, label = 'PNG') {
  assert.ok(bytes instanceof Uint8Array, `${label}: Uint8Array expected`);
  assert.ok(bytes.byteLength > 100, `${label}: expected a non-trivial artifact`);
  assert.deepEqual([...bytes.subarray(0, 8)], PNG_SIGNATURE, `${label}: PNG signature expected`);
}

function assertSvg(bytes, label = 'SVG') {
  assert.ok(bytes instanceof Uint8Array, `${label}: Uint8Array expected`);
  assert.ok(bytes.byteLength > 100, `${label}: expected a non-trivial artifact`);
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString('utf8'), '<?xml', `${label}: SVG signature expected`);
}

function assertGif(bytes, label = 'GIF') {
  assert.ok(bytes instanceof Uint8Array, `${label}: Uint8Array expected`);
  assert.ok(bytes.byteLength > 300, `${label}: expected a multi-frame artifact`);
  assert.equal(Buffer.from(bytes.subarray(0, 6)).toString('latin1'), 'GIF89a', `${label}: GIF89a signature expected`);
}

/* ------------------------------- kernel basics -------------------------- */

kernelTest('kernel: evaluates, normalizes text and reports timing', async () => {
  const result = await state.manager.evaluate('2 + 2', { label: 'test-2+2' });
  assert.equal(result.ok, true);
  assert.equal(result.text, '4');
  assert.deepEqual(result.messages, []);
  assert.equal(result.svgBytes, null);
  assert.equal(typeof result.durationMs, 'number');
  assert.ok(state.manager.status().state === 'running');
  assert.match(String(state.manager.status().version), /^\d+\./);
});

kernelTest('kernel: syntax errors map to syntax_error and the kernel stays usable', async () => {
  const broken = await state.manager.evaluate('Plot[{{', { label: 'test-syntax' });
  assert.equal(broken.ok, false);
  assert.equal(broken.error.code, 'syntax_error');
  const after = await state.manager.evaluate('1 + 1');
  assert.equal(after.ok, true);
  assert.equal(after.text, '2');
});

kernelTest('kernel: TimeConstrained timeout maps to kernel_timeout and stays usable', async () => {
  const timedOut = await state.manager.evaluate('Pause[5]', { timeoutSeconds: 0.5, label: 'test-timeout' });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error.code, 'kernel_timeout');
  const after = await state.manager.evaluate('3 + 4');
  assert.equal(after.ok, true);
  assert.equal(after.text, '7');
});

kernelTest('kernel: non-trivial results render an SVG artifact attachment', async () => {
  await state.manager.ensure();
  const bridge = state.manager._bridge;
  assert.ok(bridge, 'bridge should exist after ensure');
  const original = bridge.evaluate.bind(bridge);
  let requestedArtifact = null;
  bridge.evaluate = async (code, options = {}) => {
    if (typeof options.artifactPath === 'string') requestedArtifact = options.artifactPath;
    return original(code, options);
  };
  try {
    const result = await state.manager.evaluate('Plot[Sin[x], {x, 0, 2 Pi}, ImageSize -> 200]', { label: 'test-svg' });
    assert.equal(result.ok, true);
    assert.ok(requestedArtifact && requestedArtifact.endsWith('.svg'), 'artifactPath option must be passed to the bridge');
    assert.ok(result.svgBytes instanceof Uint8Array, 'SVG bytes expected');
    assert.ok(result.svgBytes.byteLength > 100);
    assert.equal(Buffer.from(result.svgBytes.subarray(0, 5)).toString('utf8'), '<?xml');
    const trivial = await state.manager.evaluate('2 + 2');
    assert.equal(trivial.svgBytes, null, 'numeric results stay text-only');
  } finally {
    bridge.evaluate = original;
  }
});

kernelTest('kernel: 3D results use PNG artifacts; truncated Graphics3D still attaches', async () => {
  await state.manager.ensure();
  const bridge = state.manager._bridge;
  assert.ok(bridge, 'bridge should exist after ensure');
  const original = bridge.evaluate.bind(bridge);
  const requestedArtifacts = [];
  bridge.evaluate = async (code, options = {}) => {
    if (typeof options.artifactPath === 'string') requestedArtifacts.push(options.artifactPath);
    return original(code, options);
  };
  try {
    // A held 3D value: the code carries no 3D keyword, so the up-front SVG guess
    // is corrected from the result InputForm (re-render as PNG).
    await state.manager.evaluate('sph = Graphics3D[Table[Sphere[{i, j, 0}, 0.25], {i, 3}, {j, 3}]]');
    requestedArtifacts.length = 0;
    const held = await state.manager.evaluate('sph', { label: 'test-held-3d' });
    assert.equal(held.ok, true);
    assert.equal(held.artifactFormat, 'png');
    assertPng(held.svgBytes, 'held Graphics3D');

    // Plot3D InputForm exceeds the bridge's 100 k truncation cap; the artifact
    // must still be attached (regression: it used to be dropped as "truncated").
    requestedArtifacts.length = 0;
    const plot3d = await state.manager.evaluate('Plot3D[Sin[x] Cos[y], {x, 0, 3}, {y, 0, 3}, ImageSize -> 200]', {
      label: 'test-plot3d',
    });
    assert.equal(plot3d.ok, true);
    assert.equal(plot3d.truncated, true, 'Plot3D InputForm is expected to exceed the truncation cap');
    assert.equal(plot3d.artifactFormat, 'png');
    assertPng(plot3d.svgBytes, 'Plot3D');
    assert.ok(
      requestedArtifacts.some((path) => path.endsWith('.png')),
      'the up-front artifact request must use a .png path for 3D code',
    );

    // 2D graphics keep the vector SVG path.
    const plot2d = await state.manager.evaluate('Plot[Sin[x], {x, 0, 1}, ImageSize -> 180]', { label: 'test-plot2d' });
    assert.equal(plot2d.ok, true);
    assert.equal(plot2d.truncated, false);
    assert.equal(plot2d.artifactFormat, 'svg');
    assertSvg(plot2d.svgBytes, '2D Plot');
    assert.ok(
      requestedArtifacts.some((path) => path.endsWith('.svg')),
      'the up-front artifact request must use a .svg path for 2D code',
    );
  } finally {
    bridge.evaluate = original;
  }
});

/* ------------------------------ animation GIF --------------------------- */

kernelTest('kernel: Animate cells render a clean looping GIF attachment', async () => {
  const result = await state.manager.evaluate('Animate[Plot[Sin[x t], {x, 0, 2 Pi}, ImageSize -> 160], {t, 1, 3}]', {
    label: 'test-gif-animate',
    timeoutSeconds: 120,
  });
  assert.equal(result.ok, true);
  assert.equal(result.artifactFormat, 'gif');
  assertGif(result.svgBytes, 'Animate');
  // The rebuilt frame list is an ordinary animation, not the Manipulate player:
  // a 48-frame 160 px GIF stays far below the 12 MiB attachment cap.
  assert.ok(result.svgBytes.byteLength < 12 * 1024 * 1024);
});

kernelTest('kernel: ListAnimate and Table frame lists render as GIF attachments', async () => {
  const listAnimate = await state.manager.evaluate(
    'ListAnimate[Table[Plot[Sin[x t], {x, 0, 2 Pi}, ImageSize -> 160], {t, 1, 3, 0.5}]]',
    { label: 'test-gif-listanimate', timeoutSeconds: 90 },
  );
  assert.equal(listAnimate.ok, true);
  assert.equal(listAnimate.artifactFormat, 'gif');
  assertGif(listAnimate.svgBytes, 'ListAnimate');

  const table = await state.manager.evaluate(
    'Table[Plot[Sin[x t], {x, 0, 2 Pi}, ImageSize -> 160], {t, 1, 3, 0.5}]',
    { label: 'test-gif-table', timeoutSeconds: 90 },
  );
  assert.equal(table.ok, true);
  assert.equal(table.artifactFormat, 'gif');
  assertGif(table.svgBytes, 'Table');
});

/* -------------------------------- nb codec ------------------------------ */

kernelTest('nb-codec: real .nb round-trip keeps single/multi statement code and text cells', async () => {
  const target = join(state.paths.ensureDefaultDir('session-1'), 'roundtrip.nb');
  const cells = [
    { kind: 'code', code: 'Table[i^2, {i, 1, 3}]' },
    { kind: 'code', code: 'a = 1;\nb = a + 1' },
    { kind: 'text', code: 'hello 你好 "quoted" \\ backslash' },
    { kind: 'code', code: 'Plot[Sin[x], {x, 0, 1}, ImageSize -> 120]' },
  ];
  await state.codec.writeNotebook(target, cells);
  assert.ok(existsSync(target));
  const imported = await state.codec.readNotebook(target);
  assert.equal(imported.notANotebook, false);
  assert.equal(imported.cells.length, 4);
  assert.equal(imported.cells[0].kind, 'code');
  assert.equal(imported.cells[0].exact, true);
  assert.equal(imported.cells[0].code, 'Table[i^2, {i, 1, 3}]');
  assert.equal(imported.cells[1].exact, true, 'multi-statement cells stay editable');
  assert.match(imported.cells[1].code, /a = 1/);
  assert.match(imported.cells[1].code, /b = a \+ 1/);
  assert.equal(imported.cells[2].kind, 'text');
  assert.equal(imported.cells[2].code, 'hello 你好 "quoted" \\ backslash');
  assert.equal(imported.cells[3].exact, true);
  assert.match(imported.cells[3].code, /Plot\[Sin\[x\]/);

  // second write/read generation is stable (no box/evaluation drift)
  await state.codec.writeNotebook(target, imported.cells);
  const again = await state.codec.readNotebook(target);
  assert.equal(again.cells.length, 4);
  assert.equal(again.cells[0].code, imported.cells[0].code);
  assert.match(again.cells[1].code, /b = a \+ 1/);
  assert.equal(again.cells[2].code, imported.cells[2].code);
});

kernelTest('nb-codec: empty notebooks and empty code cells round-trip', async () => {
  const dir = state.paths.ensureDefaultDir('session-1');
  const emptyPath = join(dir, 'empty.nb');
  await state.codec.writeNotebook(emptyPath, []);
  const empty = await state.codec.readNotebook(emptyPath);
  assert.equal(empty.notANotebook, false);
  assert.deepEqual(empty.cells, []);

  const blankPath = join(dir, 'blank.nb');
  await state.codec.writeNotebook(blankPath, [
    { kind: 'code', code: '' },
    { kind: 'text', code: 'note' },
  ]);
  const blank = await state.codec.readNotebook(blankPath);
  assert.equal(blank.cells.length, 2);
  assert.equal(blank.cells[0].kind, 'code');
  assert.equal(blank.cells[0].code, '');
  assert.equal(blank.cells[0].exact, true);
  assert.equal(blank.cells[1].code, 'note');
});

kernelTest('nb-codec: unparseable code falls back to a read-only string cell', async () => {
  const target = join(state.paths.ensureDefaultDir('session-1'), 'broken.nb');
  await state.codec.writeNotebook(target, [{ kind: 'code', code: 'Plot[{{' }]);
  const imported = await state.codec.readNotebook(target);
  assert.equal(imported.cells.length, 1);
  assert.equal(imported.cells[0].kind, 'code');
  assert.equal(imported.cells[0].exact, false);
  assert.equal(imported.cells[0].code, 'Plot[{{');
});

/* -------------------------- store + operations -------------------------- */

kernelTest('operations: create → evaluate → autosave → saveAs with real .nb files', async () => {
  const sessionId = 'session-1';
  const created = await state.operations.create({ sessionId });
  const notebook = created.value.notebook;
  assert.ok(notebook.path.endsWith('.nb'));
  assert.equal(notebook.revision, 1);
  assert.ok(existsSync(notebook.path));

  const evaluated = await state.operations.evaluate({
    sessionId,
    path: notebook.path,
    cells: [
      { id: notebook.cells[0].id, code: '2 + 2' },
      { id: 'extra-plot', code: 'Plot[Sin[x], {x, 0, 1}, ImageSize -> 200]' },
    ],
  });
  assert.equal(evaluated.value.ok, true);
  assert.equal(evaluated.value.cells.length, 2);
  assert.equal(evaluated.value.cells[0].ok, true);
  assert.equal(evaluated.value.cells[0].text, '4');
  assert.equal(evaluated.value.cells[1].ok, true);
  assert.equal(evaluated.value.cells[1].svg, null, 'attachment placeholders stay null in the value');
  assert.equal(evaluated.value.cells[1].text, TYPESET_TEXT_PLACEHOLDER, 'attached artifacts replace the huge InputForm text');
  assert.ok(evaluated.value.cells[1].svgBytes > 100);
  assert.equal(evaluated.attachments.length, 1);
  assert.deepEqual(evaluated.attachments[0].path, ['cells', 1, 'svg']);
  assert.equal(evaluated.attachments[0].codec, 'bytes');
  assert.equal(Buffer.from(evaluated.attachments[0].bytes.subarray(0, 5)).toString('utf8'), '<?xml');

  // Debounced auto-save persists the evaluated cells to the real .nb file.
  await sleep(300);
  const persisted = await state.codec.readNotebook(notebook.path);
  assert.equal(persisted.cells.length, 2);
  assert.equal(persisted.cells[0].code, '2 + 2');
  assert.match(persisted.cells[1].code, /Plot\[Sin\[x\]/);

  const status = await state.operations.status({ sessionId, path: notebook.path });
  assert.equal(status.value.notebook.path, notebook.path);
  assert.ok(status.value.notebook.revision > notebook.revision);
  assert.equal(status.value.notebook.dirty, false);

  const savedAs = await state.operations.saveAs({
    sessionId,
    path: notebook.path,
    name: 'copy',
    cells: persisted.cells.map((cell, index) => ({ id: `c${index + 1}`, kind: cell.kind, code: cell.code })),
  });
  assert.ok(savedAs.value.notebook.path.endsWith('copy.nb'));
  assert.equal(savedAs.value.notebook.readOnly, false);
  const reopened = await state.operations.open({ sessionId, path: savedAs.value.notebook.path });
  assert.equal(reopened.value.notebook.cells.length, 2);
  // saveAs created the copy in this session, so it keeps its created origin.
  assert.equal(reopened.value.notebook.origin, 'created');
});

kernelTest('operations: conflicted save reports the live revision', async () => {
  const sessionId = 'session-1';
  const created = await state.operations.create({ sessionId });
  const notebook = created.value.notebook;
  const firstSave = await state.operations.save({
    sessionId,
    path: notebook.path,
    cells: [{ id: 'c1', kind: 'code', code: 'x = 1' }],
    baseRevision: notebook.revision,
  });
  assert.equal(firstSave.value.revision, notebook.revision + 1);
  await assert.rejects(
    state.operations.save({
      sessionId,
      path: notebook.path,
      cells: [{ id: 'c1', kind: 'code', code: 'x = 2' }],
      baseRevision: notebook.revision,
    }),
    (error) => error.code === 'conflict' && error.details.revision === notebook.revision + 1,
  );
});

kernelTest('tools: agent read/edit/run work against a real notebook', async () => {
  const sessionId = 'session-1';
  const created = await state.operations.create({ sessionId, cells: [{ code: 'x = 10' }, { code: 'x * 2' }] });
  const path = created.value.notebook.path;
  const read = await state.operations.readForTool({ sessionId, path, includeOutputs: true });
  assert.equal(read.value.path, path);
  assert.equal(read.value.readOnly, false);
  assert.equal(read.value.cells.length, 2);

  const edited = await state.operations.editForTool({
    sessionId,
    path,
    operations: [{ op: 'insert', code: 'x + 1' }, { op: 'replace', index: 0, code: 'x = 21' }],
  });
  assert.ok(edited.value.revision > created.value.notebook.revision);
  const persisted = await state.codec.readNotebook(path);
  // InputForm canonicalizes whitespace (`x * 2` -> `x*2`); compare normalized.
  assert.deepEqual(
    persisted.cells.map((cell) => cell.code.replace(/\s+/g, '')),
    ['x=21', 'x*2', 'x+1'],
  );

  const run = await state.operations.runForTool({ sessionId, path });
  assert.equal(run.value.results.length, 3);
  assert.equal(run.value.results[0].ok, true);
  assert.equal(run.value.results[0].text, '21');
  assert.equal(run.value.results[2].text, '22');
  assert.deepEqual(run.value.results.map((entry) => entry.index), [0, 1, 2]);
});

/* --------------------- rich output: PNG + payload hygiene ----------------- */

kernelTest('operations: 3D/2D rich results attach PNG/SVG and use the short text placeholder', async () => {
  const sessionId = 'session-1';
  const created = await state.operations.create({ sessionId });
  const notebook = created.value.notebook;
  const evaluated = await state.operations.evaluate({
    sessionId,
    path: notebook.path,
    cells: [
      { id: notebook.cells[0].id, code: 'Plot3D[Sin[x] Cos[y], {x, 0, 3}, {y, 0, 3}, ImageSize -> 180]' },
      { id: 'cell-plot2d', code: 'Plot[Sin[x], {x, 0, 1}, ImageSize -> 180]' },
      { id: 'cell-scalar', code: '6 * 7' },
    ],
  });
  const cells = evaluated.value.cells;
  assert.equal(cells.length, 3);
  assert.equal(cells[0].ok, true);
  assert.equal(cells[0].text, TYPESET_TEXT_PLACEHOLDER);
  assert.ok(cells[0].svgBytes > 100);
  assert.equal(typeof cells[0].durationMs, 'number');
  assert.ok(Array.isArray(cells[0].messages));

  assert.equal(cells[1].ok, true);
  assert.equal(cells[1].text, TYPESET_TEXT_PLACEHOLDER);
  assert.ok(cells[1].svgBytes > 100);

  // Scalars keep their real text and never trigger an artifact.
  assert.equal(cells[2].ok, true);
  assert.equal(cells[2].text, '42');
  assert.equal(cells[2].svgBytes, null);

  assert.equal(evaluated.attachments.length, 2);
  assert.deepEqual(evaluated.attachments.map((attachment) => attachment.path), [
    ['cells', 0, 'svg'],
    ['cells', 1, 'svg'],
  ]);
  assertPng(evaluated.attachments[0].bytes, '3D attachment');
  assertSvg(evaluated.attachments[1].bytes, '2D attachment');
  assert.ok(evaluated.attachments[0].bytes.byteLength <= 2 * 1024 * 1024);
});

kernelTest('tools: run placeholder is uniform for 2D SVG and 3D PNG results', async () => {
  const sessionId = 'session-1';
  const created = await state.operations.create({
    sessionId,
    cells: [
      { code: 'Plot[Sin[x], {x, 0, 1}, ImageSize -> 160]' },
      { code: 'Plot3D[Sin[x] Cos[y], {x, 0, 3}, {y, 0, 3}, ImageSize -> 160]' },
      { code: '2 + 3' },
    ],
  });
  const path = created.value.notebook.path;
  const run = await state.operations.runForTool({ sessionId, path });
  assert.equal(run.value.results.length, 3);
  for (const entry of run.value.results) assert.equal(entry.ok, true);
  assert.equal(run.value.results[0].text, TOOL_TYPESET_PLACEHOLDER);
  assert.equal(run.value.results[1].text, TOOL_TYPESET_PLACEHOLDER);
  assert.equal(run.value.results[2].text, '5');
});

/* ------------------------------- close ---------------------------------- */

kernelTest('store: close flushes dirty cells, drops the entry and disposes the autosave timer', async () => {
  const sessionId = 'session-1';
  const doc = await state.store.create(sessionId);
  const path = doc.path;
  await state.store.save(sessionId, path, [{ id: 'c1', kind: 'code', code: 'x = 5' }], doc.revision);
  assert.equal(state.store.summary(sessionId, path).dirty, true);
  assert.equal(state.store.getCached(sessionId, path).timer !== null, true);

  const closed = await state.store.close(sessionId, path);
  assert.equal(closed.closed, true);
  assert.equal(state.store.getCached(sessionId, path), null);
  assert.equal(state.store.summary(sessionId, path), null);

  // The close flush persisted the pending edit before the timer was disposed.
  const persisted = await state.codec.readNotebook(path);
  assert.equal(persisted.cells[0].code.replace(/\s+/g, ''), 'x=5');

  // Past the 80 ms autosave debounce: the closed document must not resurface.
  await sleep(250);
  assert.equal(state.store.getCached(sessionId, path), null);
});

kernelTest('store: close endpoint removes the entry seen by debug; save is refused, open reloads', async () => {
  const sessionId = 'session-1';
  const created = await state.operations.create({ sessionId });
  const path = created.value.notebook.path;
  const before = (await state.operations.debug({ sessionId })).value.store.notebooks;
  assert.ok(before >= 1);

  const closed = await state.operations.close({ sessionId, path });
  assert.deepEqual(closed.value, { closed: true });
  const afterClose = (await state.operations.debug({ sessionId })).value.store.notebooks;
  assert.equal(afterClose, before - 1, 'close must release the store entry');
  assert.equal(state.store.summary(sessionId, path), null);

  // A late auto-save / evaluate must not silently resurrect the closed entry.
  await sleep(250);
  assert.equal((await state.operations.debug({ sessionId })).value.store.notebooks, afterClose);
  await assert.rejects(
    state.operations.save({
      sessionId,
      path,
      cells: [{ id: 'c1', kind: 'code', code: '1 + 1' }],
      baseRevision: created.value.notebook.revision,
    }),
    (error) => error.code === 'not_found',
  );
  await assert.rejects(
    state.operations.evaluate({ sessionId, path, cells: [{ id: 'c1', code: '2 + 2' }] }),
    (error) => error.code === 'not_found',
  );

  // An explicit open re-imports the flushed .nb from disk.
  const reopened = await state.operations.open({ sessionId, path });
  assert.equal(reopened.value.notebook.path, path);
  assert.equal(reopened.value.notebook.revision, 1);
  assert.equal((await state.operations.debug({ sessionId })).value.store.notebooks, afterClose + 1);
  await state.operations.close({ sessionId, path });
});

kernelTest('store: close falls back to the path when the session id drifted', async () => {
  const driftedSession = 'session-drifted';
  const doc = await state.store.create(driftedSession);
  const path = doc.path;
  const before = state.store.count;
  // The browser tab/probe closes with a different session id than the one used
  // to create the document; the matching path is still released.
  const closed = await state.store.close('session-1', path);
  assert.equal(closed.closed, true);
  assert.equal(state.store.count, before - 1);
  assert.equal(state.store.getCached(driftedSession, path), null);

  const reopened = await state.store.open(driftedSession, path);
  assert.equal(reopened.path, path);
  await state.store.close(driftedSession, path);
});
