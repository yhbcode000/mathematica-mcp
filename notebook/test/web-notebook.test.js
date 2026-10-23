/**
 * Unit tests for the WLJS web-notebook bridge (lib/web-notebook.js).
 *
 * No real WLJS installation or Wolfram process is involved: the tests use a
 * temporary fixture tree for discovery and a local HTTP stub for the WLJS JSON
 * API, plus an injected `spawn` so no child process is ever started.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import {
  DEFAULT_HTTP_PORT,
  WebNotebook,
  candidateRoots,
  detectRoot,
  detectWolframscript,
  isWljsRoot,
  wljsRequest,
} from '../lib/web-notebook.js';
import { ErrorCodes } from '../lib/errors.js';

function makeWljsTree(root, { version = '3.1.4' } = {}) {
  mkdirSync(path.join(root, 'Scripts'), { recursive: true });
  writeFileSync(path.join(root, 'Scripts', 'start.wls'), '#!wolframscript\n');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'wljs-notebook', version }));
  return root;
}

function fakeChild() {
  const stream = () => ({
    setEncoding() {},
    on() {},
  });
  return {
    pid: 4242,
    exitCode: null,
    stdout: stream(),
    stderr: stream(),
    on() {},
    kill() {},
  };
}

/** WLJS JSON API stub: HTML shell on `/`, JSON endpoints under `/api/`. */
function startStubServer() {
  const state = { polls: 0, calls: [], pages: [] };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      state.calls.push({ method: req.method, url: req.url, body });
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><title>WLJS Notebooks</title></html>');
        return;
      }
      if (req.url === '/api/notebook/list/') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([{ Id: '001', PathEncoded: 'C%3A%5Cx.wln' }]));
        return;
      }
      if (req.url === '/api/notebook/new/') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ Id: '002', PathEncoded: 'C%3A%5Cy.wln' }));
        return;
      }
      if (req.url === '/api/notebook/readyQ/') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ReadyQ: true }));
        return;
      }
      if (req.url === '/api/notebook/cells/add/batch/') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ Promise: 'p-add' }));
        return;
      }
      if (req.url === '/api/notebook/cells/evaluate/') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ Promise: 'p-eval' }));
        return;
      }
      if (req.url === '/api/promise/') {
        state.polls += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        if (body.Promise === 'p-add') {
          res.end(JSON.stringify({ ReadyQ: true, Result: { Created: ['002', '003'], Count: 2 } }));
          return;
        }
        if (state.polls < 2) {
          res.end(JSON.stringify({ ReadyQ: false }));
          return;
        }
        res.end(JSON.stringify({ ReadyQ: true, Result: [{ Id: '010', Type: 'Output' }] }));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

let stub = null;

before(async () => {
  stub = await startStubServer();
});

after(async () => {
  if (stub !== null) await new Promise((resolve) => stub.server.close(resolve));
});

test('detectRoot finds an extracted WLJS tree and reads its version', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'wljs-detect-'));
  const root = makeWljsTree(path.join(base, 'wljs-notebook-3.1.4'), { version: '3.1.4' });
  assert.equal(isWljsRoot(root), true);
  assert.equal(isWljsRoot(base), false);
  const found = detectRoot({ configured: root, dshHome: path.join(base, 'home') });
  assert.deepEqual(found, { root, version: '3.1.4' });
  assert.equal(detectRoot({ configured: path.join(base, 'missing'), dshHome: path.join(base, 'home') }), null);
});

test('detectRoot falls back to $DSH_HOME/wljs-notebook', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'wljs-home-'));
  const home = path.join(base, '.dsh');
  makeWljsTree(path.join(home, 'wljs-notebook'));
  const found = detectRoot({ env: { DSH_HOME: home }, dshHome: home });
  assert.ok(found !== null);
  assert.equal(found.version, '3.1.4');
});

test('candidateRoots prioritises the configured path and the environment override', () => {
  const configured = 'D:\\tools\\wljs';
  const envRoot = 'E:\\wljs';
  const roots = candidateRoots({ configured, env: { WLJS_NOTEBOOK_DIR: envRoot, DSH_HOME: 'C:\\h' }, dshHome: 'C:\\h' });
  assert.equal(roots[0], configured);
  assert.equal(roots[1], envRoot);
  assert.ok(roots.includes(path.join('C:\\h', 'wljs-notebook')));
});

test('detectWolframscript honours a configured executable', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'wljs-ws-'));
  const exe = path.join(base, 'wolframscript.exe');
  writeFileSync(exe, '');
  assert.equal(detectWolframscript({ configured: exe }), exe);
  // A configured path that does not exist falls back to discovery, never to the
  // bogus value; discovery resolves an absolute install path when present.
  const fallback = detectWolframscript({ configured: path.join(base, 'missing.exe'), env: {} });
  assert.notEqual(fallback, path.join(base, 'missing.exe'));
  assert.equal(typeof fallback, 'string');
  assert.ok(fallback.length > 0);
});

test('status reports a missing installation without throwing', async () => {
  const manager = new WebNotebook({ config: { root: 'C:\\definitely-not-here' }, env: {}, dshHome: 'C:\\definitely-not-here' });
  const status = await manager.status();
  assert.equal(status.available, false);
  assert.equal(status.running, false);
  assert.equal(status.url, `http://127.0.0.1:${DEFAULT_HTTP_PORT}/`);
  assert.equal(manager.detect(), null);
});

test('ensureRunning surfaces a typed unavailable error when WLJS is absent', async () => {
  const manager = new WebNotebook({ config: { root: 'C:\\definitely-not-here' }, env: {}, dshHome: 'C:\\definitely-not-here' });
  await assert.rejects(() => manager.ensureRunning(), (error) => error.code === ErrorCodes.WEB_NOTEBOOK_UNAVAILABLE);
  // Disabled explicitly is also a typed failure, not a crash.
  const disabled = new WebNotebook({ config: { enabled: false }, env: {}, dshHome: 'C:\\definitely-not-here' });
  await assert.rejects(() => disabled.ensureRunning(), (error) => error.code === ErrorCodes.WEB_NOTEBOOK_UNAVAILABLE);
});

test('api calls resolve promise envelopes and read JSON endpoints', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'wljs-api-'));
  const root = makeWljsTree(path.join(base, 'wljs'));
  const manager = new WebNotebook({
    config: { root, httpPort: stub.port },
    env: {},
    dshHome: path.join(base, '.dsh'),
    spawn: fakeChild,
  });
  const ready = await manager.ensureRunning();
  assert.equal(ready.ready, true);
  assert.equal(ready.available, true);
  // The stub server is already listening, so ensureRunning reuses it instead of
  // spawning a duplicate process that could not bind the port.
  assert.equal(ready.running, false);
  assert.equal(manager.child, null);

  const notebooks = await manager.listNotebooks();
  assert.deepEqual(notebooks, [{ Id: '001', PathEncoded: 'C%3A%5Cx.wln' }]);

  const created = await manager.newNotebook();
  assert.equal(created.id, '002');
  assert.equal(created.url, `http://127.0.0.1:${stub.port}/C%3A%5Cy.wln`);

  const added = await manager.addCells('002', [{ content: '2 + 2' }, { content: 'Plot[Sin[x], {x, 0, 6}]' }]);
  assert.deepEqual(added, { Created: ['002', '003'], Count: 2 });

  const output = await manager.evaluateCell('003');
  assert.equal(Array.isArray(output), true);
  assert.equal(output[0].Id, '010');
  await manager.dispose();
});

test('addCells rejects an empty batch and non-string content', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'wljs-bad-'));
  const root = makeWljsTree(path.join(base, 'wljs'));
  const manager = new WebNotebook({
    config: { root, httpPort: stub.port },
    env: {},
    dshHome: path.join(base, '.dsh'),
    spawn: fakeChild,
  });
  await assert.rejects(() => manager.addCells('002', []), (error) => error.code === ErrorCodes.INVALID_PAYLOAD);
  await assert.rejects(() => manager.addCells('002', [{ nope: true }]), (error) => error.code === ErrorCodes.INVALID_PAYLOAD);
});

test('wljsRequest reports HTTP failures without throwing on non-JSON bodies', async () => {
  const ok = await wljsRequest({ port: stub.port, method: 'GET', pathname: '/' });
  assert.equal(ok.ok, true);
  assert.equal(ok.body, null);
  const missing = await wljsRequest({ port: stub.port, method: 'POST', pathname: '/api/not-an-endpoint/' });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 404);
});
