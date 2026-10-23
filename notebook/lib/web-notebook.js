/**
 * Local WLJS Notebook bridge (CONTRACT.md §9).
 *
 * WLJS Notebook (https://github.com/WLJSTeam/wljs-notebook, AGPLv3) is a
 * web-native Wolfram Language notebook frontend that runs against the *local*
 * Wolfram Engine — the "web notebook on this computer" the DSH sidebar embeds.
 * This module owns exactly two things:
 *
 *  - the lifetime of that server process (`wolframscript -f Scripts/start.wls`,
 *    HTTP on 127.0.0.1:20560), and
 *  - the small JSON API the plugin uses to create notebooks and cells
 *    (`POST /api/notebook/...`, promise envelopes polled through `/api/promise/`).
 *
 * It intentionally has no Harness imports: a headless profile can start the
 * server and drive it from the agent tool without any browser.
 *
 * The browser half opens the returned URL in a right-sidebar Browser tab; the
 * plugin never renders WLJS itself, so rich/interactive output (3D graphics,
 * `Manipulate`, `Dataset`, …) is produced by the real notebook frontend.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { ErrorCodes, PluginError, invalidPayload } from './errors.js';

/** Default WLJS web server port (`$Env["http"]` in Scripts/start.wls). */
export const DEFAULT_HTTP_PORT = 20560;

/** How long `start()` waits for the HTTP frontend to answer. */
export const DEFAULT_START_TIMEOUT_MS = 180_000;

/** How long one WLJS API call may wait for its promise envelope. */
export const DEFAULT_API_TIMEOUT_MS = 120_000;

/** Retained server log lines (diagnostics for the toolbar error path). */
const LOG_LIMIT = 200;

/** WLJS API path used to confirm the JSON API (not just the HTML shell) works. */
const API_LIST_NOTEBOOKS = '/api/notebook/list/';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Candidate WLJS roots, in priority order. */
export function candidateRoots({ configured = null, env = process.env, dshHome = null } = {}) {
  const home = dshHome || env.DSH_HOME || path.join(homedir(), '.dsh');
  const list = [];
  if (typeof configured === 'string' && configured.trim() !== '') list.push(configured.trim());
  if (typeof env.WLJS_NOTEBOOK_DIR === 'string' && env.WLJS_NOTEBOOK_DIR.trim() !== '') list.push(env.WLJS_NOTEBOOK_DIR.trim());
  list.push(
    path.join(home, 'wljs-notebook'),
    path.join(home, 'wljs-notebook-3.1.4'),
    path.join(home, 'apps', 'wljs-notebook-3.1.4'),
    path.join(home, 'artifacts', 'wljs-notebook', 'app', 'wljs-notebook-3.1.4'),
    path.join(home, 'artifacts', 'wljs-notebook', 'app'),
    // Desktop installs bundle the same tree under resources/app.
    path.join(env.LOCALAPPDATA || '', 'Programs', 'WLJS Notebook', 'resources', 'app'),
  );
  return [...new Set(list.filter((entry) => typeof entry === 'string' && entry.length > 0))];
}

/** True when `root` looks like an extracted WLJS Notebook tree. */
export function isWljsRoot(root) {
  if (typeof root !== 'string' || root === '') return false;
  return existsSync(path.join(root, 'Scripts', 'start.wls')) && existsSync(path.join(root, 'package.json'));
}

/** First existing WLJS tree, with the version its package.json declares. */
export function detectRoot({ configured = null, env = process.env, dshHome = null } = {}) {
  for (const root of candidateRoots({ configured, env, dshHome })) {
    if (!isWljsRoot(root)) continue;
    const manifest = readJson(path.join(root, 'package.json'));
    return { root, version: typeof manifest?.version === 'string' ? manifest.version : null };
  }
  return null;
}

/**
 * Locate `wolframscript`: configured path, `WOLFRAMSCRIPT`, the standard
 * Mathematica install, then PATH.
 */
export function detectWolframscript({ configured = null, env = process.env } = {}) {
  const explicit = [configured, env.WOLFRAMSCRIPT, env.WLJS_WOLFRAMSCRIPT].filter((value) => typeof value === 'string' && value.trim() !== '');
  for (const candidate of explicit) {
    const value = candidate.trim();
    if (!path.isAbsolute(value)) return value;
    if (existsSync(value)) return value;
  }
  const roots = [env.ProgramFiles || 'C:\\Program Files', env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'];
  for (const base of roots) {
    const wolfram = path.join(base, 'Wolfram Research', 'Wolfram');
    if (existsSync(wolfram)) {
      try {
        const versions = readdirSync(wolfram, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        for (const version of versions) {
          const exe = path.join(wolfram, version, 'wolframscript.exe');
          if (existsSync(exe)) return exe;
        }
      } catch {
        /* fall through to the next candidate */
      }
    }
    const standalone = path.join(base, 'Wolfram Research', 'WolframScript', 'wolframscript.exe');
    if (existsSync(standalone)) return standalone;
  }
  return 'wolframscript';
}

/**
 * One HTTP JSON request against the WLJS server.
 *
 * @returns {Promise<{status: number, ok: boolean, body: any, text: string}>}
 */
export function wljsRequest({ port = DEFAULT_HTTP_PORT, method = 'POST', pathname = '/', body = null, timeoutMs = 15_000, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    let payload = null;
    const headers = { accept: 'application/json, text/html;q=0.9' };
    if (body !== null) {
      payload = Buffer.from(JSON.stringify(body), 'utf8');
      headers['content-type'] = 'application/json; charset=utf-8';
      headers['content-length'] = String(payload.length);
    }
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      finish(reject, new Error(`WLJS ${method} ${pathname} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    const req = httpRequest({ host, port, method, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode ?? 0;
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        finish(resolve, { status, ok: status >= 200 && status < 300, body: parsed, text });
      });
      res.on('error', (error) => finish(reject, error));
    });
    req.on('error', (error) => finish(reject, error));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** Thin indirection so tests can replace the transport without bundling. */
function httpRequest(options, onResponse) {
  return http.request(options, onResponse);
}

/**
 * Owns the WLJS server process and the local notebook API.
 */
export class WebNotebook {
  /**
   * @param {object} [options]
   * @param {object} [options.config] plugin config (`webNotebook` section)
   * @param {object} [options.env] environment defaults to process.env
   * @param {string|null} [options.dshHome]
   * @param {(message: string) => void} [options.logger]
   * @param {(args: any) => any} [options.spawn] child_process.spawn override (tests)
   */
  constructor({ config = {}, env = process.env, dshHome = null, logger = null, spawn: spawnImpl = null } = {}) {
    this.config = config && typeof config === 'object' ? config : {};
    this.env = env;
    this.dshHome = dshHome || env.DSH_HOME || path.join(homedir(), '.dsh');
    this.logger = typeof logger === 'function' ? logger : null;
    this.spawn = typeof spawnImpl === 'function' ? spawnImpl : spawn;
    this.child = null;
    this.logs = [];
    this.startedAt = null;
    this.lastError = null;
    this._startPromise = null;
    this._detected = null;
    this._lastNotebook = null;
  }

  _log(message) {
    this.logs.push({ at: new Date().toISOString(), message: String(message) });
    if (this.logs.length > LOG_LIMIT) this.logs.splice(0, this.logs.length - LOG_LIMIT);
    if (this.logger) this.logger(`wljs: ${message}`);
  }

  get enabled() {
    return this.config.enabled !== false;
  }

  get httpPort() {
    const value = Number(this.config.httpPort);
    return Number.isInteger(value) && value > 0 && value < 65536 ? value : DEFAULT_HTTP_PORT;
  }

  get url() {
    return `http://127.0.0.1:${this.httpPort}/`;
  }

  get startTimeoutMs() {
    const value = Number(this.config.startTimeoutMs);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_START_TIMEOUT_MS;
  }

  get apiTimeoutMs() {
    const value = Number(this.config.apiTimeoutMs);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_API_TIMEOUT_MS;
  }

  /** Resolved installation (memoized): `{root, version, wolframscript}` or null. */
  detect() {
    if (this._detected !== null) return this._detected;
    const found = this.enabled ? detectRoot({ configured: this.config.root, env: this.env, dshHome: this.dshHome }) : null;
    if (!found) {
      this._detected = null;
      return null;
    }
    this._detected = {
      ...found,
      wolframscript: detectWolframscript({ configured: this.config.wolframscript, env: this.env }),
    };
    return this._detected;
  }

  /** True when the HTTP frontend answers. */
  async isReady() {
    try {
      const response = await wljsRequest({ port: this.httpPort, method: 'GET', pathname: '/', timeoutMs: 3000 });
      return response.ok && typeof response.text === 'string' && response.text.includes('WLJS');
    } catch {
      return false;
    }
  }

  /** `status` shape shared by the RPC endpoint and the agent tool. */
  async status() {
    const detected = this.detect();
    const running = this.child !== null && this.child.exitCode === null;
    const ready = await this.isReady().catch(() => false);
    return {
      enabled: this.enabled,
      available: detected !== null,
      root: detected?.root ?? null,
      version: detected?.version ?? null,
      wolframscript: detected?.wolframscript ?? null,
      running,
      ready,
      pid: running ? this.child.pid ?? null : null,
      url: this.url,
      startedAt: this.startedAt,
      lastNotebook: this._lastNotebook,
      lastError: this.lastError,
      logTail: this.logs.slice(-20),
    };
  }

  _notAvailable() {
    const roots = candidateRoots({ configured: this.config.root, env: this.env, dshHome: this.dshHome });
    return new PluginError(
      ErrorCodes.WEB_NOTEBOOK_UNAVAILABLE,
      'WLJS Notebook was not found on this computer. Install it (AGPLv3, https://github.com/WLJSTeam/wljs-notebook) and set webNotebook.root to the extracted directory, or put it in $DSH_HOME/wljs-notebook.',
      { searched: roots, configured: this.config.root ?? null },
    );
  }

  /**
   * Ensure the server is running, starting it when needed.
   * Concurrent calls share one start attempt.
   */
  async ensureRunning() {
    if (!this.enabled) {
      throw new PluginError(ErrorCodes.WEB_NOTEBOOK_UNAVAILABLE, 'The WLJS web notebook is disabled in this plugin configuration.', {});
    }
    const detected = this.detect();
    if (!detected) throw this._notAvailable();
    // A server may already be running from an earlier plugin instance, a manual
    // `wolframscript -f Scripts/start.wls`, or the WLJS desktop app. Reuse it
    // instead of starting a second process that cannot bind the port.
    if (await this.isReady()) {
      if (this.child === null || this.child.exitCode !== null) {
        this._log('reusing an already running WLJS server on ' + this.url);
      }
      return this.status();
    }
    if ((this.child === null || this.child.exitCode !== null) && this._startPromise === null) {
      this._startPromise = this._start(detected).finally(() => {
        this._startPromise = null;
      });
    }
    await this._startPromise;
    const deadline = Date.now() + this.startTimeoutMs;
    for (;;) {
      if (await this.isReady()) return this.status();
      if (this.child !== null && this.child.exitCode !== null) {
        throw new PluginError(ErrorCodes.WEB_NOTEBOOK_FAILED, `WLJS Notebook exited during startup (code ${this.child.exitCode}).`, {
          logTail: this.logs.slice(-20),
        });
      }
      if (Date.now() > deadline) {
        throw new PluginError(ErrorCodes.WEB_NOTEBOOK_FAILED, `WLJS Notebook did not answer on ${this.url} within ${this.startTimeoutMs} ms.`, {
          url: this.url,
          logTail: this.logs.slice(-20),
        });
      }
      await sleep(500);
    }
  }

  _start(detected) {
    return new Promise((resolve, reject) => {
      const args = ['-f', path.join('Scripts', 'start.wls')];
      let child;
      try {
        child = this.spawn(detected.wolframscript, args, {
          cwd: detected.root,
          env: { ...this.env, ...(this.config.env && typeof this.config.env === 'object' ? this.config.env : {}) },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        this.lastError = `spawn failed: ${error instanceof Error ? error.message : String(error)}`;
        reject(new PluginError(ErrorCodes.WEB_NOTEBOOK_FAILED, `Could not start WLJS Notebook: ${this.lastError}`, { root: detected.root }));
        return;
      }
      this.child = child;
      this.startedAt = new Date().toISOString();
      this.lastError = null;
      this._log(`starting ${detected.wolframscript} -f Scripts/start.wls in ${detected.root}`);
      const pump = (stream, prefix) => {
        if (!stream || typeof stream.setEncoding !== 'function') return;
        stream.setEncoding('utf8');
        let buffer = '';
        stream.on('data', (chunk) => {
          buffer += chunk;
          let index = buffer.indexOf('\n');
          while (index !== -1) {
            const line = buffer.slice(0, index).replace(/\r$/, '');
            buffer = buffer.slice(index + 1);
            if (line.trim() !== '') this._log(`${prefix}${line}`);
            index = buffer.indexOf('\n');
          }
        });
      };
      pump(child.stdout, '');
      pump(child.stderr, 'stderr: ');
      child.on('error', (error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        this._log(`child error: ${this.lastError}`);
      });
      child.on('exit', (code, signal) => {
        this._log(`exited code=${code} signal=${signal ?? ''}`);
        if (code !== 0 && code !== null) this.lastError = `exited with code ${code}`;
        this.child = null;
      });
      // `start.wls` prints its banner immediately; the caller polls the port.
      resolve();
    });
  }

  /** Stop the server process tree (no-op when nothing is running). */
  async stop() {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return { stopped: false };
    this._log(`stopping pid ${child.pid}`);
    try {
      if (process.platform === 'win32' && child.pid) {
        await new Promise((resolve) => {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.on('exit', resolve);
          killer.on('error', resolve);
        });
      } else {
        child.kill('SIGTERM');
        await sleep(1500);
        if (child.exitCode === null) child.kill('SIGKILL');
      }
    } catch (error) {
      this._log(`stop failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.startedAt = null;
    return { stopped: true };
  }

  /** Plugin unload: stop a server this plugin started. */
  async dispose() {
    await this.stop();
  }

  /* ------------------------------ WLJS API ------------------------------ */

  /**
   * Call one WLJS JSON API endpoint, resolving promise envelopes.
   *
   * @param {string} pathname endpoint such as `/api/notebook/new/`
   * @param {object} [body]
   * @param {{timeoutMs?: number, wait?: boolean}} [options]
   */
  async api(pathname, body = {}, { timeoutMs = this.apiTimeoutMs, wait = true } = {}) {
    if (typeof pathname !== 'string' || !pathname.startsWith('/api/')) {
      throw invalidPayload('"pathname" must be a WLJS /api/ path', { field: 'pathname' });
    }
    await this.ensureRunning();
    const first = await wljsRequest({ port: this.httpPort, method: 'POST', pathname, body: body ?? {}, timeoutMs: Math.min(timeoutMs, 30_000) });
    if (!first.ok) {
      throw new PluginError(ErrorCodes.WEB_NOTEBOOK_FAILED, `WLJS ${pathname} failed with HTTP ${first.status}.`, {
        status: first.status,
        response: first.text.slice(0, 500),
      });
    }
    return wait ? this._resolvePromise(first.body, timeoutMs) : first.body;
  }

  async _resolvePromise(envelope, timeoutMs) {
    if (!envelope || typeof envelope !== 'object' || typeof envelope.Promise !== 'string') return envelope;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await wljsRequest({
        port: this.httpPort,
        method: 'POST',
        pathname: '/api/promise/',
        body: { Promise: envelope.Promise },
        timeoutMs: 15_000,
      });
      const value = status.body;
      if (value && typeof value === 'object' && value.ReadyQ === true) {
        return Object.prototype.hasOwnProperty.call(value, 'Result') ? value.Result : value;
      }
      if (Date.now() > deadline) {
        throw new PluginError(ErrorCodes.WEB_NOTEBOOK_FAILED, `WLJS operation ${envelope.Promise} did not finish within ${timeoutMs} ms.`, {
          promise: envelope.Promise,
        });
      }
      await sleep(250);
    }
  }

  /** Confirm that the JSON API (not only the HTML shell) is ready. */
  async apiReady() {
    try {
      await this.api(API_LIST_NOTEBOOKS, {}, { timeoutMs: 10_000 });
      return true;
    } catch {
      return false;
    }
  }

  /** URL of one notebook file, as the browser tab should open it. */
  notebookUrl(pathEncoded) {
    if (typeof pathEncoded !== 'string' || pathEncoded === '') throw invalidPayload('"pathEncoded" must be a non-empty string', {});
    return `${this.url}${pathEncoded.replace(/^\/+/, '')}`;
  }

  /** List open notebooks (`[{Id, PathEncoded, ...}]`). */
  async listNotebooks() {
    const value = await this.api('/api/notebook/list/');
    return Array.isArray(value) ? value : value?.Notebooks ?? [];
  }

  /** Currently focused notebook metadata, if any. */
  async focusedNotebook() {
    try {
      return await this.api('/api/notebook/focused/');
    } catch {
      return null;
    }
  }

  /**
   * Create a new empty notebook and wait until it is ready.
   * @returns {Promise<{id: string, pathEncoded: string, url: string}>}
   */
  async newNotebook({ noCells = true } = {}) {
    const created = await this.api('/api/notebook/new/', { NoCells: noCells });
    const id = created?.Id;
    const pathEncoded = created?.PathEncoded;
    if (!id || !pathEncoded) {
      throw new PluginError(ErrorCodes.WEB_NOTEBOOK_FAILED, 'WLJS did not return a notebook id.', { response: created ?? null });
    }
    this._lastNotebook = { id, pathEncoded, url: this.notebookUrl(pathEncoded) };
    return { id, pathEncoded, ...this._lastNotebook };
  }

  /** Wait until a notebook is ready for cell operations. */
  async waitNotebookReady(id, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await this.api('/api/notebook/readyQ/', { Id: id }, { timeoutMs: 15_000 });
      if (value === true || value?.ReadyQ === true || value?.Result === true) return true;
      if (Date.now() > deadline) {
        throw new PluginError(ErrorCodes.WEB_NOTEBOOK_FAILED, `WLJS notebook ${id} did not become ready within ${timeoutMs} ms.`, { notebook: id });
      }
      await sleep(400);
    }
  }

  /** Add input cells; each entry uses WLJS first-line markers (`.md`, `.html`, …). */
  async addCells(notebookId, cells) {
    if (!Array.isArray(cells) || cells.length === 0) throw invalidPayload('"cells" must be a non-empty array', { field: 'cells' });
    const payload = {
      Notebook: notebookId,
      Cells: cells.map((cell) => {
        const content = typeof cell === 'string' ? cell : cell?.content ?? cell?.code;
        if (typeof content !== 'string') throw invalidPayload('each cell needs a string "content"', { field: 'cells' });
        return { Content: content };
      }),
    };
    return this.api('/api/notebook/cells/add/batch/', payload);
  }

  /** List cells of one notebook. */
  async listCells(notebookId) {
    const value = await this.api('/api/notebook/cells/list/', { Notebook: notebookId });
    return Array.isArray(value) ? value : value?.Cells ?? [];
  }

  /** Evaluate one input cell; output cells are created by the frontend. */
  async evaluateCell(cellId, { timeLimit = 40, maxCharacters = 2000, summarize = false } = {}) {
    const payload = { Cell: cellId, TimeLimit: timeLimit, MaxCharacters: maxCharacters };
    if (summarize === true) payload.Summarize = true;
    return this.api('/api/notebook/cells/evaluate/', payload, { timeoutMs: this.apiTimeoutMs });
  }

  /** Evaluate a Wolfram Language expression directly in a ready kernel. */
  async kernelEvaluate(expression, { kernel = null, timeLimit = 40, maxCharacters = 2500 } = {}) {
    if (typeof expression !== 'string' || expression.trim() === '') throw invalidPayload('"expression" must be a non-empty string', {});
    const payload = { Expression: expression, TimeLimit: timeLimit, MaxCharacters: maxCharacters };
    if (typeof kernel === 'string' && kernel !== '') payload.Kernel = kernel;
    return this.api('/api/kernel/evaluate/', payload, { timeoutMs: this.apiTimeoutMs });
  }
}
