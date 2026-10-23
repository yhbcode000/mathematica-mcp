/**
 * Unit / wiring tests for the dsh-mathematica-notebook Host half that do not
 * need a Wolfram kernel: paths, store state machine (fake codec), RPC envelope +
 * multipart encoding, native launcher (fake fs/spawn), tool mapping and plugin
 * wiring (fake Cordis context).
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

import { ErrorCodes, PluginError, toRpcError } from '../lib/errors.js';
import { KernelManager, classifyPayloadError, isTrivialInputform, mapKernelError, normalizePayload } from '../lib/kernel-manager.js';
import { locateMathematica, launchMathematica } from '../lib/launcher.js';
import { NotebookPaths } from '../lib/paths.js';
import { createDispatcher, handleRpcRequest, listEndpoints, writeRpcResult } from '../lib/rpc.js';
import { NotebookStore, summarizeResultOutputs } from '../lib/store.js';
import { createNotebookTool } from '../lib/tools.js';
import { apply as applyPlugin } from '../index.js';

const tempRoots = [];
function tempRoot(prefix = 'dsh-nb-unit-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}
test.after(() => {
  for (const root of tempRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/** A paths instance backed by temp dirs and a fake session service. */
function makePaths() {
  const root = tempRoot();
  const cwd = join(root, 'project');
  const dshHome = join(root, 'dsh-home');
  mkdirSync(cwd, { recursive: true });
  const ctx = {
    get(name) {
      if (name === 'agents') return { get: (id) => (id === 'session-1' ? { session: { id: 'session-1' } } : undefined) };
      if (name === 'workingDirectory') return { get: () => cwd, defaultDirectory: cwd };
      return undefined;
    },
  };
  return { paths: new NotebookPaths({ ctx, env: { DSH_HOME: dshHome }, homeDir: root, platform: process.platform }), root, cwd, dshHome };
}

/* --------------------------------- paths -------------------------------- */

test('paths: resolves the session working directory and default notebook dir', () => {
  const { paths, cwd, dshHome } = makePaths();
  assert.equal(paths.defaultDir('session-1'), join(cwd, 'notebooks'));
  // No resolvable Session -> CONTRACT.md 搂6 fallback: $DSH_HOME/notebooks.
  assert.equal(paths.defaultDir('anonymous'), join(dshHome, 'notebooks'));
  assert.deepEqual(paths.allowedRoots('session-1'), [cwd, join(dshHome, 'notebooks')]);
  assert.deepEqual(paths.allowedRoots('anonymous'), [join(dshHome, 'notebooks')]);
});

test('paths: relative paths resolve against the default notebook dir', () => {
  const { paths, cwd } = makePaths();
  assert.equal(paths.validate('session-1', 'plot.nb'), join(cwd, 'notebooks', 'plot.nb'));
  assert.equal(paths.validate('session-1', join(cwd, 'deep', 'x.nb')), join(cwd, 'deep', 'x.nb'));
  assert.equal(paths.validate('anonymous', 'plot.nb'), join(paths.notebookRoot(), 'plot.nb'));
});

test('paths: .nb-only rule and allowed-root containment', () => {
  const { paths, root, cwd } = makePaths();
  assert.throws(() => paths.validate('session-1', 'notes.txt'), (error) => error.code === ErrorCodes.PATH_DENIED);
  assert.throws(() => paths.validate('session-1', join(root, 'outside.nb')), (error) => error.code === ErrorCodes.PATH_DENIED);
  assert.throws(() => paths.validate('session-1', join(cwd, '..', 'escape.nb')), (error) => error.code === ErrorCodes.PATH_DENIED);
  assert.throws(() => paths.validate('session-1', ''), (error) => error.code === ErrorCodes.INVALID_PAYLOAD);
  assert.throws(() => paths.validate('session-1', join(cwd, 'missing.nb'), { mustExist: true }), (error) => error.code === ErrorCodes.NOT_FOUND);
});

test('paths: symlinked escapes are denied', (t) => {
  const { paths, root, cwd } = makePaths();
  const outside = join(root, 'elsewhere');
  mkdirSync(outside, { recursive: true });
  const link = join(cwd, 'link');
  try {
    symlinkSync(outside, link, 'junction');
  } catch {
    t.skip('symlink creation is not permitted on this system');
    return;
  }
  assert.throws(() => paths.validate('session-1', join(link, 'escaped.nb')), (error) => error.code === ErrorCodes.PATH_DENIED);
});

test('paths: list returns only .nb files sorted, allocate and saveAs pick unique names', () => {
  const { paths, cwd } = makePaths();
  const dir = paths.ensureDefaultDir('session-1');
  writeFileSync(join(dir, 'b.nb'), 'x');
  writeFileSync(join(dir, 'a.nb'), 'x');
  writeFileSync(join(dir, 'ignore.txt'), 'x');
  mkdirSync(join(dir, 'folder.nb'));
  const listed = paths.list('session-1');
  assert.equal(listed.dir, dir);
  assert.deepEqual(listed.files.map((file) => file.name), ['a.nb', 'b.nb']);

  const first = paths.allocateNotebookPath('session-1');
  assert.equal(first, join(dir, 'Untitled-1.nb'));
  writeFileSync(first, 'x');
  assert.equal(paths.allocateNotebookPath('session-1'), join(dir, 'Untitled-2.nb'));

  const source = join(cwd, 'notes.nb');
  writeFileSync(source, 'x');
  const target = paths.saveAsTarget('session-1', source, 'copy');
  assert.equal(target, join(cwd, 'copy.nb'));
  writeFileSync(target, 'x');
  assert.equal(paths.saveAsTarget('session-1', source, 'copy'), join(cwd, 'copy-2.nb'));
  assert.throws(() => paths.saveAsTarget('session-1', source, '../evil.nb'), (error) => error.code === ErrorCodes.INVALID_PAYLOAD);
});

/* --------------------------------- store -------------------------------- */

function fakeCodec() {
  const files = new Map();
  const readonly = new Set();
  return {
    files,
    readonly,
    async writeNotebook(path, cells) {
      files.set(path, cells.map((cell) => ({ kind: cell.kind, code: cell.code })));
      // Mirror the real codec: the .nb now exists on disk (mtime/list/realpath).
      writeFileSync(path, JSON.stringify(cells));
    },
    async readNotebook(path) {
      if (!files.has(path)) throw new PluginError(ErrorCodes.NOT_FOUND, `notebook not found: ${path}`);
      const cells = files.get(path).map((cell) => ({ ...cell, style: cell.kind === 'code' ? 'Input' : 'Text', exact: !readonly.has(path) }));
      return { cells, outputCount: 0, foreignStyles: [], notANotebook: false };
    },
  };
}

function makeStore(options = {}) {
  const { paths } = makePaths();
  const codec = fakeCodec();
  const store = new NotebookStore({ codec, paths, autoSaveMs: 40, ...options });
  return { store, codec, paths };
}

const sleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  if (typeof timer.unref === 'function') timer.unref();
});

test('store: create writes an immediately valid document', async () => {
  const { store, codec, paths } = makeStore();
  const doc = await store.create('session-1');
  assert.equal(doc.origin, 'created');
  assert.equal(doc.revision, 1);
  assert.equal(doc.dirty, false);
  assert.equal(doc.cells.length, 1);
  assert.equal(doc.cells[0].kind, 'code');
  assert.equal(doc.cells[0].code, '');
  assert.ok(codec.files.has(doc.path));
  assert.ok(doc.path.startsWith(paths.ensureDefaultDir('session-1')));
  const listed = store.list('session-1');
  assert.ok(listed.files.some((file) => file.path === doc.path));
  await store.dispose();
});

test('store: save bumps revision, conflict is reported with the live revision', async () => {
  const { store } = makeStore();
  const doc = await store.create('session-1');
  const baseRevision = doc.revision;
  const saved = await store.save('session-1', doc.path, [{ id: 'c1', kind: 'code', code: '1 + 1' }], baseRevision);
  assert.equal(saved.revision, baseRevision + 1);
  await assert.rejects(
    store.save('session-1', doc.path, [{ id: 'c1', kind: 'code', code: '2 + 2' }], baseRevision),
    (error) => error.code === ErrorCodes.CONFLICT && error.details.revision === saved.revision,
  );
  await store.dispose();
});

test('store: auto-save debounce persists dirty cells', async () => {
  const { store, codec } = makeStore({ autoSaveMs: 30 });
  const doc = await store.create('session-1');
  await store.save('session-1', doc.path, [{ id: 'c1', kind: 'code', code: 'Table[i, {i, 3}]' }], doc.revision);
  assert.equal(store.summary('session-1', doc.path).dirty, true);
  await sleep(150);
  assert.equal(store.summary('session-1', doc.path).dirty, false);
  assert.deepEqual(codec.files.get(doc.path), [{ kind: 'code', code: 'Table[i, {i, 3}]' }]);
  await store.dispose();
});

test('store: close flushes a pending save and releases the document', async () => {
  const { store, codec } = makeStore({ autoSaveMs: 5000 });
  const doc = await store.create('session-1');
  await store.save('session-1', doc.path, [{ id: 'c1', kind: 'code', code: 'x = 42' }], doc.revision);
  const closed = await store.close('session-1', doc.path);
  assert.deepEqual(closed, { closed: true });
  assert.equal(store.count, 0);
  assert.deepEqual(codec.files.get(doc.path), [{ kind: 'code', code: 'x = 42' }]);
  await store.dispose();
});

test('store: edit operations insert/replace/delete and flush immediately', async () => {
  const { store, codec } = makeStore({ autoSaveMs: 5000 });
  const doc = await store.create('session-1');
  await store.save('session-1', doc.path, [{ id: 'c1', kind: 'code', code: 'a = 1' }], doc.revision);
  const edited = await store.editCells('session-1', doc.path, [
    { op: 'insert', index: 1, code: 'b = 2' },
    { op: 'replace', index: 0, code: 'a = 10' },
    { op: 'delete', index: 1 },
    { op: 'insert', code: 'c = 3' },
  ]);
  assert.equal(edited.revision, 3);
  assert.deepEqual(
    edited.doc.cells.map((cell) => cell.code),
    ['a = 10', 'c = 3'],
  );
  await store.flushDoc('session-1', doc.path);
  assert.deepEqual(codec.files.get(doc.path), [
    { kind: 'code', code: 'a = 10' },
    { kind: 'code', code: 'c = 3' },
  ]);
  await store.dispose();
});

test('store: imported notebooks become readOnly when mapping is inexact', async () => {
  const { store, codec, paths } = makeStore();
  const dir = paths.ensureDefaultDir('session-1');
  const path = join(dir, 'foreign.nb');
  codec.files.set(path, [{ kind: 'code', code: '1 + 1' }]);
  codec.readonly.add(path);
  writeFileSync(path, '(* imported notebook *)');
  const doc = await store.open('session-1', path);
  assert.equal(doc.origin, 'imported');
  assert.equal(doc.readOnly, true);
  await assert.rejects(store.editCells('session-1', path, [{ op: 'insert', code: 'x' }]), (error) => error.code === ErrorCodes.PATH_DENIED);
  await store.dispose();
});

test('store: saveAs creates an editable copy next to the source', async () => {
  const { store, codec, paths } = makeStore();
  const dir = paths.ensureDefaultDir('session-1');
  const path = join(dir, 'source.nb');
  codec.files.set(path, [{ kind: 'code', code: 'Plot[x, {x, 0, 1}]' }]);
  const copy = await store.saveAs('session-1', path, 'copy', [{ id: 'c1', kind: 'code', code: 'Plot[x, {x, 0, 1}]' }]);
  assert.equal(copy.path, join(dir, 'copy.nb'));
  assert.equal(copy.readOnly, false);
  assert.equal(copy.origin, 'created');
  assert.ok(codec.files.has(copy.path));
  await store.dispose();
});

test('store: prepare/finish evaluation records outputs and bumps the revision', async () => {
  const { store } = makeStore({ autoSaveMs: 5000 });
  const doc = await store.create('session-1');
  await store.save('session-1', doc.path, [{ id: 'c1', kind: 'code', code: '2 + 2' }], doc.revision);
  const prepared = await store.prepareEvaluation('session-1', doc.path, { cells: [{ id: 'c1', code: '2 + 3' }] });
  assert.deepEqual(prepared.targets.map((target) => target.code), ['2 + 3']);
  const revision = await store.finishEvaluation('session-1', doc.path, prepared.targets, [
    { id: 'c1', ok: true, text: '5', messages: [], durationMs: 1 },
  ]);
  assert.equal(revision, 4);
  const cached = store.getCached('session-1', doc.path);
  assert.deepEqual(cached.cells[0].outputs, [{ type: 'text', text: '5' }]);
  await store.dispose();
});

test('store: summarizeResultOutputs covers text, messages and failures', () => {
  assert.deepEqual(summarizeResultOutputs({ ok: true, text: '42', messages: [] }), [{ type: 'text', text: '42' }]);
  assert.deepEqual(summarizeResultOutputs({ ok: true, text: '', messages: ['Power::infy'] }), [{ type: 'msg', text: 'Power::infy' }]);
  const failed = summarizeResultOutputs({ ok: false, error: { code: 'syntax_error', message: 'bad syntax' } });
  assert.equal(failed[0].type, 'msg');
  assert.match(failed[0].text, /syntax_error/);
});

/* --------------------------- kernel normalize ---------------------------- */

test('kernel-manager: payload normalization and error classification', () => {
  const ok = normalizePayload({ ok: true, result: 4, result_inputform: '4', output: '', duration_ms: 3 }, 5);
  assert.deepEqual(
    { ok: ok.ok, text: ok.text, renderable: ok.renderable, durationMs: ok.durationMs },
    { ok: true, text: '4', renderable: false, durationMs: 5 },
  );
  const graphics = normalizePayload({ ok: true, result_inputform: 'Graphics[{}]' }, 9);
  assert.equal(graphics.ok, true);
  assert.equal(graphics.renderable, true);
  const nullResult = normalizePayload({ ok: true, result_inputform: 'Null', output: 'printed' }, 1);
  assert.equal(nullResult.text, 'printed');
  assert.equal(nullResult.renderable, false);
  const truncated = normalizePayload({ ok: true, result_inputform: 'Graphics[big]', truncated: true }, 1);
  assert.equal(truncated.renderable, false);

  assert.equal(classifyPayloadError({ ok: false, error: 'timeout' }).code, ErrorCodes.KERNEL_TIMEOUT);
  assert.equal(classifyPayloadError({ ok: false, error: 'evaluation_failed', messages: ['Syntax::sntx'] }).code, ErrorCodes.SYNTAX_ERROR);
  assert.equal(classifyPayloadError({ ok: false, error: 'evaluation_failed', messages: ['Power::infy'] }).code, ErrorCodes.EVALUATION_FAILED);
  assert.equal(mapKernelError({ code: 'kernel_timeout', message: 'slow' }).code, ErrorCodes.KERNEL_TIMEOUT);
  assert.equal(mapKernelError(new Error('boom')).code, ErrorCodes.KERNEL_UNAVAILABLE);
  assert.equal(isTrivialInputform({ result_inputform: '2.5' }), true);
  assert.equal(isTrivialInputform({ result_inputform: '"hello"' }), true);
  assert.equal(isTrivialInputform({ result_inputform: 'Plot[x,{x,0,1}]' }), false);
});

test('kernel-manager: status is cheap before the kernel is started', async () => {
  const manager = new KernelManager({ resolveKernelFn: async () => ({ ok: false, error: 'no kernel' }) });
  assert.deepEqual(manager.status(), { state: 'stopped', path: null, version: null });
  await assert.rejects(manager.ensure(), (error) => error.code === ErrorCodes.KERNEL_UNAVAILABLE);
  assert.equal(manager.status().state, 'unavailable');
  await manager.dispose();
});

/* -------------------------------- launcher ------------------------------- */

function memoryFs(files) {
  const set = new Set(files);
  const dirs = new Set();
  for (const file of set) {
    let current = file;
    for (;;) {
      const slash = current.lastIndexOf('\\');
      if (slash <= 0) break;
      current = current.slice(0, slash);
      dirs.add(current);
    }
  }
  return {
    existsSync: (path) => set.has(path) || dirs.has(path),
    readdirSync: (dir) => {
      const prefix = dir.endsWith('\\') ? dir : `${dir}\\`;
      const names = new Set();
      for (const file of set) {
        if (file.startsWith(prefix)) {
          const rest = file.slice(prefix.length);
          const name = rest.split('\\')[0];
          if (name) names.add(name);
        }
      }
      return [...names].map((name) => ({ name, isDirectory: () => true }));
    },
  };
}

test('launcher: locates the newest Wolfram desktop notebook front end', () => {
  const root = 'C:\\Program Files\\Wolfram Research\\Wolfram';
  const fs = memoryFs([
    `${root}\\15.0\\WolframNB.exe`,
    `${root}\\14.3\\WolframNB.exe`,
    `${root}\\15.0\\math.exe`,
  ]);
  const located = locateMathematica({ platform: 'win32', env: {}, fs });
  assert.deepEqual(located, { path: `${root}\\15.0\\WolframNB.exe`, kind: 'wolfram-notebook' });
  assert.equal(locateMathematica({ platform: 'win32', env: {}, fs: memoryFs([]) }), null);
});

test('launcher: detached spawn success, spawn error and immediate bad exit', async () => {
  const located = { path: 'C:\\Wolfram\\WolframNB.exe', kind: 'wolfram-notebook' };
  const locate = () => located;

  const goodChild = new EventEmitter();
  goodChild.pid = 4242;
  goodChild.unref = () => {};
  const good = await launchMathematica('C:\\nb\\x.nb', { locate, spawnFn: () => goodChild, livenessMs: 20 });
  assert.deepEqual(good, { launched: true, executable: located.path, pid: 4242 });

  const badChild = new EventEmitter();
  badChild.pid = 1;
  badChild.unref = () => {};
  const failing = launchMathematica('C:\\nb\\x.nb', {
    locate,
    spawnFn: () => {
      setTimeout(() => badChild.emit('error', new Error('EPERM')), 1);
      return badChild;
    },
    livenessMs: 50,
  });
  await assert.rejects(failing, (error) => error.code === ErrorCodes.LAUNCH_FAILED && /EPERM/.test(error.message));

  const exitChild = new EventEmitter();
  exitChild.pid = 2;
  exitChild.unref = () => {};
  const earlyExit = launchMathematica('C:\\nb\\x.nb', {
    locate,
    spawnFn: () => {
      setTimeout(() => exitChild.emit('exit', 3, null), 1);
      return exitChild;
    },
    livenessMs: 50,
  });
  await assert.rejects(earlyExit, (error) => error.code === ErrorCodes.LAUNCH_FAILED && /exited immediately/.test(error.message));

  assert.throws(
    () => launchMathematica('C:\\nb\\x.nb', { locate: () => null, spawnFn: () => goodChild, livenessMs: 10 }),
    (error) => error.code === ErrorCodes.LAUNCH_FAILED && /not found/.test(error.message),
  );
});

/* ---------------------------------- RPC --------------------------------- */

function stubOperations(overrides = {}) {
  return {
    status: async () => ({
      value: { ok: true, kernel: { state: 'stopped', path: null, version: null }, notebook: null, serverVersion: '0.1.0' },
    }),
    list: async () => ({ value: { dir: 'C:\\np', files: [] } }),
    open: async () => {
      throw new PluginError(ErrorCodes.PATH_DENIED, 'outside the allowed roots', { path: 'C:\\x.nb' });
    },
    create: async () => ({ value: { notebook: { id: 'n1', path: 'C:\\np\\Untitled-1.nb', cells: [] } } }),
    save: async () => ({ value: { path: 'C:\\np\\a.nb', revision: 2 } }),
    saveAs: async () => ({ value: { notebook: { id: 'n2', path: 'C:\\np\\copy.nb', cells: [] } } }),
    evaluate: async () => ({
      value: { ok: true, cells: [{ id: 'c1', ok: true, text: '2', messages: [], durationMs: 1, svg: null, svgBytes: 5 }] },
      attachments: [{ path: ['cells', 0, 'svg'], codec: 'bytes', bytes: Uint8Array.from([60, 63, 120, 109, 108]) }],
    }),
    restartKernel: async () => ({ value: { kernel: { state: 'running', path: 'C:\\math.exe', version: '15.0' } } }),
    openInMathematica: async () => ({ value: { launched: true, executable: 'C:\\WolframNB.exe', pid: 7 } }),
    close: async () => ({ value: { closed: true } }),
    debug: async () => ({ value: { ok: true, action: 'debug', kernel: { state: 'stopped' }, rpc: { helloCount: 2 } } }),
    ...overrides,
  };
}

function fakeDiagnostics() {
  const state = { hellos: [], lastError: null };
  return {
    state,
    recordHello(payload) {
      state.hellos.push(payload);
    },
    helloCount() {
      return state.hellos.length;
    },
    setLastError(error) {
      state.lastError = error;
    },
  };
}

test('rpc: dispatcher validates envelopes and enforces the owner peer', async () => {
  const diagnostics = fakeDiagnostics();
  const dispatch = createDispatcher({ operations: stubOperations(), diagnostics });
  const status = await dispatch('status', {});
  assert.equal(status.ok, true);
  assert.equal(status.value.serverVersion, '0.1.0');

  const hello = await dispatch('hello', { probe: 1 });
  assert.deepEqual(hello.value, { ok: true, hello: true, count: 1 });
  assert.deepEqual(diagnostics.state.hellos, [{ probe: 1 }]);

  const unknown = await dispatch('nope', {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, ErrorCodes.UNKNOWN_ENDPOINT);

  const missingSession = await dispatch('list', {});
  assert.equal(missingSession.error.code, ErrorCodes.INVALID_PAYLOAD);

  const forbidden = await dispatch('status', {}, { peer: { principal: { kind: 'api' } } });
  assert.equal(forbidden.error.code, ErrorCodes.FORBIDDEN);

  const denied = await dispatch('open', { sessionId: 's', path: 'C:\\x.nb' });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, ErrorCodes.PATH_DENIED);
  assert.deepEqual(denied.error.details, { path: 'C:\\x.nb' });
  assert.equal(diagnostics.state.lastError.code, ErrorCodes.PATH_DENIED);

  assert.ok(listEndpoints().includes('restartKernel'));
  assert.ok(listEndpoints().includes('hello'));
});

function mockRequest({ method = 'POST', url = '/mathematica-notebook/status', body = '', headers = { 'content-type': 'application/json' } } = {}) {
  const req = new Readable({
    read() {
      /* pushed up front */
    },
  });
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.push(body);
  req.push(null);
  return req;
}

function mockResponse() {
  return {
    statusCode: 0,
    headers: null,
    body: Buffer.alloc(0),
    writableEnded: false,
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
    },
    end(chunk) {
      this.body = chunk === undefined ? Buffer.alloc(0) : Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      this.writableEnded = true;
    },
    on() {},
    off() {},
    removeListener() {},
  };
}

function ownerConnection(principal = { kind: 'owner' }) {
  return { admit: () => ({ peer: { principal } }) };
}

async function rpcRoundTrip({ connection = ownerConnection(), dispatch, url, method = 'POST', body = '' } = {}) {
  const req = mockRequest({ method, url, body });
  const res = mockResponse();
  await handleRpcRequest(req, res, { connection, dispatch });
  return res;
}

const statusBody = (rpcId = 'r1', method = 'status', payload = {}) =>
  JSON.stringify({ type: 'client-request', rpcId, method, payload });

test('rpc: HTTP route returns the JSON server-response envelope', async () => {
  const dispatch = createDispatcher({ operations: stubOperations() });
  const res = await rpcRoundTrip({ dispatch, body: statusBody() });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  const envelope = JSON.parse(res.body.toString('utf8'));
  assert.equal(envelope.type, 'server-response');
  assert.equal(envelope.rpcId, 'r1');
  assert.equal(envelope.result.ok, true);
  assert.equal(envelope.result.value.kernel.state, 'stopped');
});

test('rpc: HTTP route rejects bad methods, peers and envelopes', async () => {
  const dispatch = createDispatcher({ operations: stubOperations() });
  const wrongMethod = await rpcRoundTrip({ dispatch, method: 'GET' });
  assert.equal(wrongMethod.statusCode, 405);

  const rejected = await rpcRoundTrip({
    dispatch,
    connection: { admit: () => ({ rejection: 401 }) },
    body: statusBody(),
  });
  assert.equal(rejected.statusCode, 401);

  const apiPeer = await rpcRoundTrip({ dispatch, connection: ownerConnection({ kind: 'api' }), body: statusBody() });
  assert.equal(apiPeer.statusCode, 403);

  const badJson = await rpcRoundTrip({ dispatch, body: 'not json' });
  assert.equal(badJson.statusCode, 200);
  assert.equal(JSON.parse(badJson.body.toString('utf8')).result.error.code, ErrorCodes.INVALID_PAYLOAD);

  const mismatch = await rpcRoundTrip({ dispatch, body: statusBody('r2', 'list') });
  assert.equal(JSON.parse(mismatch.body.toString('utf8')).result.error.code, ErrorCodes.INVALID_PAYLOAD);
});

test('rpc: binary evaluate results are multipart with metadata placeholders', async () => {
  const dispatch = createDispatcher({ operations: stubOperations() });
  const res = await rpcRoundTrip({
    dispatch,
    url: '/mathematica-notebook/evaluate',
    body: JSON.stringify({ type: 'client-request', rpcId: 'r3', method: 'evaluate', payload: { sessionId: 's', path: 'C:\\x.nb' } }),
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /^multipart\/form-data; boundary=/);
  const boundary = /boundary=(.+)$/.exec(res.headers['content-type'])[1];
  const raw = res.body;
  const text = raw.toString('latin1');
  const metadataStart = text.indexOf('name="metadata"');
  assert.ok(metadataStart > 0);
  const metadataJsonStart = text.indexOf('\r\n\r\n', metadataStart) + 4;
  const metadataJsonEnd = text.indexOf(`\r\n--${boundary}--`, metadataJsonStart);
  const envelope = JSON.parse(raw.subarray(metadataJsonStart, metadataJsonEnd).toString('utf8'));
  assert.equal(envelope.type, 'server-response');
  assert.equal(envelope.rpcId, 'r3');
  assert.equal(envelope.result.ok, true);
  assert.equal(envelope.result.value.cells[0].svg, null);
  assert.deepEqual(envelope.attachments, [{ path: ['cells', 0, 'svg'], codec: 'bytes', part: 'bytes-0' }]);
  const partStart = text.indexOf('name="bytes-0"');
  const bytesStart = text.indexOf('\r\n\r\n', partStart) + 4;
  assert.deepEqual([...raw.subarray(bytesStart, bytesStart + 5)], [60, 63, 120, 109, 108]);
});

test('rpc: writeRpcResult keeps failures JSON (never multipart)', () => {
  const res = mockResponse();
  writeRpcResult(res, 'r9', { ok: false, error: { code: 'conflict', message: 'stale', details: { revision: 3 } } });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  const envelope = JSON.parse(res.body.toString('utf8'));
  assert.equal(envelope.result.error.code, 'conflict');
  assert.deepEqual(envelope.result.error.details, { revision: 3 });
});

/* --------------------------------- tools -------------------------------- */

function captureOperations() {
  const calls = [];
  const value = (name) => async (payload) => {
    calls.push([name, payload]);
    return { value: { action: name, payload } };
  };
  return {
    calls,
    operations: {
      list: value('list'),
      create: value('create'),
      readForTool: value('read'),
      editForTool: value('edit'),
      runForTool: value('run'),
      webStatus: value('webStatus'),
      webOpen: value('webOpen'),
      webAddCells: value('webAddCells'),
      webEvaluate: value('webEvaluate'),
      debug: async (payload) => {
        calls.push(['debug', payload]);
        return { value: { ok: true, action: 'debug', kernel: { state: 'stopped' }, rpc: { helloCount: 3, lastHello: { at: 'now' } } } };
      },
    },
  };
}

test('tools: definition shape and action mapping onto the operation layer', async () => {
  const { operations, calls } = captureOperations();
  const tool = createNotebookTool({ operations, serverVersion: '0.1.0' });
  assert.equal(tool.name, 'mathematica_notebook');
  assert.equal(tool.parameters.required[0], 'action');
  const actions = tool.parameters.properties.action.enum;
  // The `.nb` actions stay first (compatible order); web-notebook actions extend them.
  assert.deepEqual(actions.slice(0, 6), ['list', 'create', 'read', 'edit', 'run', 'debug']);
  for (const action of ['webStatus', 'webStart', 'webStop', 'webOpen', 'webSeed', 'webAddCells', 'webEvaluate']) {
    assert.ok(actions.includes(action), `missing action ${action}`);
  }
  assert.equal(tool.parameters.additionalProperties, false);
  assert.equal(tool.output.schema.type, 'string');
  assert.equal(tool.output.render(null, 'x')[0].type, 'text');

  const exec = { agent: { session: { id: 'agent-session' } } };
  let result = JSON.parse(await tool.execute({ action: 'list' }, exec));
  assert.equal(result.action, 'list');
  assert.equal(calls.at(-1)[1].sessionId, 'agent-session');

  await tool.execute({ action: 'create', cells: [{ code: '1 + 1' }] }, exec);
  assert.deepEqual(calls.at(-1)[1].cells, [{ code: '1 + 1' }]);

  await tool.execute({ action: 'read', path: 'a.nb', includeOutputs: true }, exec);
  assert.deepEqual(calls.at(-1), ['read', { sessionId: 'agent-session', path: 'a.nb', includeOutputs: true }]);

  await tool.execute({ action: 'edit', path: 'a.nb', operations: [{ op: 'insert', code: 'x' }] }, exec);
  assert.equal(calls.at(-1)[1].operations[0].op, 'insert');

  await tool.execute({ action: 'run', path: 'a.nb', indices: [0, 2] }, exec);
  assert.deepEqual(calls.at(-1)[1].indices, [0, 2]);

  result = JSON.parse(await tool.execute({ action: 'debug', probeEndpoint: 'status', probePayload: { path: 'x' } }, exec));
  assert.equal(result.ok, true);
  assert.equal(result.rpc.helloCount, 3);
  assert.equal(calls.at(-1)[0], 'debug');
});

test('tools: failures become readable tool results and validation is strict', async () => {
  const failing = {
    ...captureOperations().operations,
    readForTool: async () => {
      throw new PluginError(ErrorCodes.PATH_DENIED, 'outside the allowed roots', { path: 'C:\\evil.nb' });
    },
  };
  const tool = createNotebookTool({ operations: failing });
  const denied = JSON.parse(await tool.execute({ action: 'read', path: 'C:\\evil.nb' }, {}));
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, ErrorCodes.PATH_DENIED);
  assert.deepEqual(denied.error.details, { path: 'C:\\evil.nb' });

  const badAction = JSON.parse(await tool.execute({ action: 'explode' }, {}));
  assert.equal(badAction.ok, false);
  assert.equal(badAction.error.code, ErrorCodes.INVALID_PAYLOAD);
  assert.equal(toRpcError(new Error('plain')).error.code, ErrorCodes.INTERNAL_ERROR);
});

/* ------------------------------ plugin wiring ---------------------------- */

function makeFakeCtx() {
  const tools = [];
  const routes = [];
  const disposers = [];
  const connection = { admit: () => ({ peer: { principal: { kind: 'owner' } } }) };
  const webServer = {
    register(route) {
      routes.push(route);
      return () => {};
    },
  };
  const ctx = {
    logger: { debug() {} },
    services: { connection, webServer },
    // Injected Cordis contexts expose services as direct properties.
    connection,
    webServer,
    get(name) {
      return this.services[name];
    },
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === 'function') disposers.push(disposer);
      return () => {};
    },
    inject(names, callback) {
      if (names.every((name) => ctx.services[name])) callback(ctx);
    },
    tools: {
      register(definition) {
        tools.push(definition);
        return () => {};
      },
    },
  };
  return { ctx, tools, routes, disposers };
}

test('index: apply registers the tool and the RPC route, debug reports health', async (t) => {
  delete globalThis[Symbol.for('dsh-mathematica-notebook.rpc-state')];
  delete globalThis[Symbol.for('dsh-mathematica-notebook.rpc-dispatch')];
  const { ctx, tools, routes, disposers } = makeFakeCtx();
  applyPlugin(ctx);
  t.after(() => {
    for (const disposer of disposers) {
      try {
        disposer();
      } catch {
        /* ignore */
      }
    }
    delete globalThis[Symbol.for('dsh-mathematica-notebook.rpc-state')];
    delete globalThis[Symbol.for('dsh-mathematica-notebook.rpc-dispatch')];
  });

  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'mathematica_notebook');
  assert.equal(routes.length, 1);
  assert.deepEqual({ kind: routes[0].kind, path: routes[0].path }, { kind: 'prefix', path: '/mathematica-notebook' });

  // hello through the real mounted route (owner peer via fake connection.admit)
  const helloResponse = await (async () => {
    const req = mockRequest({
      url: '/mathematica-notebook/hello',
      body: JSON.stringify({ type: 'client-request', rpcId: 'h1', method: 'hello', payload: { attempt: 1 } }),
    });
    const res = mockResponse();
    await routes[0].handler(req, res);
    return JSON.parse(res.body.toString('utf8'));
  })();
  assert.equal(helloResponse.result.value.hello, true);
  assert.equal(helloResponse.result.value.count, 1);

  const debugResult = JSON.parse(await tools[0].execute({ action: 'debug' }, {}));
  assert.equal(debugResult.ok, true);
  assert.equal(debugResult.rpc.registered, true);
  assert.equal(debugResult.rpc.helloCount, 1);
  assert.equal(debugResult.rpc.lastHello.payload.attempt, 1);
  assert.equal(debugResult.kernel.state, 'stopped');
  assert.equal(debugResult.serverVersion, '0.2.1');

  const statusResponse = await (async () => {
    const req = mockRequest({ body: statusBody('s1') });
    const res = mockResponse();
    await routes[0].handler(req, res);
    return JSON.parse(res.body.toString('utf8'));
  })();
  assert.equal(statusResponse.result.value.serverVersion, '0.2.1');
  assert.equal(statusResponse.result.value.kernel.state, 'stopped');

  assert.ok(disposers.length >= 2);
});

test('index: debug probe runs a real endpoint through the dispatch table', async (t) => {
  delete globalThis[Symbol.for('dsh-mathematica-notebook.rpc-state')];
  delete globalThis[Symbol.for('dsh-mathematica-notebook.rpc-dispatch')];
  const { ctx, tools, disposers } = makeFakeCtx();
  applyPlugin(ctx);
  t.after(() => {
    for (const disposer of disposers) {
      try {
        disposer();
      } catch {
        /* ignore */
      }
    }
    delete globalThis[Symbol.for('dsh-mathematica-notebook.rpc-state')];
    delete globalThis[Symbol.for('dsh-mathematica-notebook.rpc-dispatch')];
  });
  const result = JSON.parse(
    await tools[0].execute(
      { action: 'debug', probeEndpoint: 'status', probePayload: {} },
      { agent: { session: { id: 'probe-session' } } },
    ),
  );
  assert.equal(result.ok, true);
  assert.equal(result.probe.endpoint, 'status');
  assert.equal(result.probe.result.ok, true);
  assert.equal(result.probe.result.value.serverVersion, '0.2.1');

  const unknown = JSON.parse(await tools[0].execute({ action: 'debug', probeEndpoint: 'nope' }, {}));
  assert.equal(unknown.probe.result.ok, false);
  assert.equal(unknown.probe.result.error.code, ErrorCodes.UNKNOWN_ENDPOINT);
});
