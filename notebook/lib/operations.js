/**
 * The Host operation layer shared by the RPC endpoints (CONTRACT.md 搂2) and the
 * `mathematica_notebook` agent tool (CONTRACT.md 搂5).
 *
 * One implementation means the browser and the agent always observe the same
 * store, revisions, path rules and kernel serialization. Methods return
 * `{ value, attachments? }`; failures throw `PluginError` with a contract code
 * and are turned into envelopes by `lib/rpc.js` / `lib/tools.js`.
 */

import { basename } from 'node:path';
import { ErrorCodes, PluginError, invalidPayload, optionalNumber, requireString } from './errors.js';

/** Value reported by the `status` endpoint (CONTRACT.md 搂2). */
export const SERVER_VERSION = '0.2.1';

/** Max output text echoed into agent-tool run results. */
const TOOL_TEXT_LIMIT = 4000;

/**
 * Placeholder `text` used for an evaluate cell whose rich artifact (SVG or PNG)
 * is attached; the full InputForm would be tens of KB of noise on the wire.
 */
export const TYPESET_TEXT_PLACEHOLDER = '[typeset output]';

/** Uniform agent-tool `run` placeholder for 2D SVG and 3D PNG outputs. */
export const TOOL_TYPESET_PLACEHOLDER = '[typeset result rendered in the notebook]';

function truncate(text, limit) {
  if (typeof text !== 'string' || text.length <= limit) return text;
  return `${text.slice(0, limit)}鈥?[truncated]`;
}

/** JSON-safe clone for values crossing the debug probe boundary. */
function jsonSafe(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

/** Summarize a cell's stored outputs for the agent tool. */
export function summarizeOutputText(outputs) {
  if (!Array.isArray(outputs) || outputs.length === 0) return null;
  const text = outputs
    .map((output) => (typeof output?.text === 'string' ? output.text : ''))
    .filter((part) => part.length > 0)
    .join('\n');
  return text.length > 0 ? truncate(text, 1000) : null;
}

/** Turn an internal document into the public `open`/`create` notebook value. */
export function publicNotebook(doc) {
  return {
    id: doc.id,
    path: doc.path,
    origin: doc.origin,
    readOnly: Boolean(doc.readOnly),
    revision: doc.revision,
    dirty: Boolean(doc.dirty),
    title: basename(doc.path, '.nb'),
    cells: doc.cells.map((cell) => ({
      id: cell.id,
      kind: cell.kind,
      code: cell.code,
      outputs: Array.isArray(cell.outputs) ? cell.outputs.map((output) => ({ type: output.type, text: output.text ?? null })) : [],
    })),
  };
}

/**
 * Operation facade over the notebook store, kernel manager and launcher.
 */
export class NotebookOperations {
  /**
   * @param {object} options
   * @param {object} options.store NotebookStore
   * @param {object} options.kernel KernelManager
   * @param {object} options.paths NotebookPaths
   * @param {object|null} [options.launcher] native Mathematica launcher
   * @param {object|null} [options.diagnostics] shared diagnostics state
   * @param {string} [options.serverVersion]
   * @param {(message: string) => void} [options.logger]
   */
  constructor({ store, kernel, paths, launcher = null, diagnostics = null, webNotebook = null, serverVersion = SERVER_VERSION, logger = null }) {
    this.store = store;
    this.kernel = kernel;
    this.paths = paths;
    this.launcher = launcher;
    this.diagnostics = diagnostics;
    this.webNotebook = webNotebook;
    this.serverVersion = serverVersion;
    this.logger = typeof logger === 'function' ? logger : null;
    this._probe = null;
  }

  _log(message) {
    if (this.logger) this.logger(message);
  }

  /** Install the debug probe callback `(endpoint, payload) => envelope result`. */
  setProbe(probe) {
    this._probe = typeof probe === 'function' ? probe : null;
  }

  _diagnosticsSnapshot() {
    if (!this.diagnostics) return { registered: false, helloCount: 0, lastHello: null, lastError: null };
    const helloCount = typeof this.diagnostics.helloCount === 'function' ? this.diagnostics.helloCount() : Number(this.diagnostics.helloCount) || 0;
    const lastHello = typeof this.diagnostics.lastHello === 'function' ? this.diagnostics.lastHello() : (this.diagnostics.lastHello ?? null);
    if (typeof this.diagnostics.snapshot === 'function') return this.diagnostics.snapshot();
    return {
      registered: Boolean(this.diagnostics.registered),
      helloCount,
      lastHello,
      lastError: this.diagnostics.lastError ?? null,
    };
  }

  /** `status` (CONTRACT.md 搂2). */
  async status(request = {}) {
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId : null;
    let notebook = null;
    if (request.path !== undefined && request.path !== null) {
      if (!sessionId) throw invalidPayload('"sessionId" is required when "path" is given', { field: 'sessionId' });
      const path = this.paths.validate(sessionId, requireString(request, 'path'));
      notebook = this.store.summary(sessionId, path);
    }
    return {
      value: {
        ok: true,
        kernel: this.kernel.status(),
        notebook,
        serverVersion: this.serverVersion,
      },
    };
  }

  /** `list` (CONTRACT.md 搂2). */
  async list(request = {}) {
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId : null;
    const listed = this.store.list(sessionId);
    return { value: listed };
  }

  /** `open` (CONTRACT.md 搂2). */
  async open(request = {}) {
    const sessionId = requireString(request, 'sessionId');
    const path = requireString(request, 'path');
    const doc = await this.store.open(sessionId, path);
    return { value: { notebook: publicNotebook(doc) } };
  }

  /** `create` (CONTRACT.md 搂2). */
  async create(request = {}) {
    const sessionId = requireString(request, 'sessionId');
    let cells = null;
    if (request.cells !== undefined && request.cells !== null) {
      if (!Array.isArray(request.cells)) throw invalidPayload('"cells" must be an array', { field: 'cells' });
      cells = request.cells;
    }
    const doc = await this.store.create(sessionId, { cells });
    return { value: { notebook: publicNotebook(doc) } };
  }

  /** `save` (CONTRACT.md 搂2). */
  async save(request = {}) {
    const sessionId = requireString(request, 'sessionId');
    const path = requireString(request, 'path');
    const baseRevision = request.baseRevision;
    if (typeof baseRevision !== 'number' || !Number.isFinite(baseRevision)) {
      throw invalidPayload('"baseRevision" must be a finite number', { field: 'baseRevision' });
    }
    const result = await this.store.save(sessionId, path, request.cells, baseRevision);
    return { value: { path: result.path, revision: result.revision } };
  }

  /** `saveAs` (CONTRACT.md 搂2). */
  async saveAs(request = {}) {
    const sessionId = requireString(request, 'sessionId');
    const path = requireString(request, 'path');
    const name = requireString(request, 'name', { trim: false });
    if (!name.trim()) throw invalidPayload('"name" must not be empty', { field: 'name' });
    const doc = await this.store.saveAs(sessionId, path, name, request.cells);
    return { value: { notebook: publicNotebook(doc) } };
  }

  /**
   * Evaluate cells and, for successful non-trivial results, render typeset SVG
   * bytes as RPC attachments (CONTRACT.md 搂1/搂2).
   *
   * @returns {Promise<{value: object, attachments: Array<object>}>}
   */
  async evaluate(request = {}) {
    const sessionId = requireString(request, 'sessionId');
    const path = requireString(request, 'path');
    if (request.cells !== undefined && request.cells !== null && !Array.isArray(request.cells)) {
      throw invalidPayload('"cells" must be an array', { field: 'cells' });
    }
    if (request.indices !== undefined && request.indices !== null && !Array.isArray(request.indices)) {
      throw invalidPayload('"indices" must be an array', { field: 'indices' });
    }
    const prepared = await this.store.prepareEvaluation(sessionId, path, { cells: request.cells ?? null, indices: request.indices ?? null });
    const { entries, attachments } = await this._runTargets(sessionId, prepared.path, prepared.targets);
    return { value: { ok: true, cells: entries }, attachments };
  }

  async _runTargets(sessionId, path, targets) {
    /** @type {PluginError|null} */
    let kernelFailure = null;
    try {
      await this.kernel.ensure();
    } catch (error) {
      kernelFailure = error instanceof PluginError ? error : new PluginError(ErrorCodes.KERNEL_UNAVAILABLE, String(error?.message ?? error));
    }
    const entries = [];
    const attachments = [];
    for (let position = 0; position < targets.length; position += 1) {
      const target = targets[position];
      /** @type {{id: string, ok: boolean, text: string, messages: string[], durationMs: number, svg: null, svgBytes: null, error?: {code: string, message: string}}} */
      const entry = { id: target.id, ok: false, text: '', messages: [], durationMs: 0, svg: null, svgBytes: null };
      if (kernelFailure) {
        entry.error = { code: kernelFailure.code, message: kernelFailure.message };
      } else {
        try {
          const result = await this.kernel.evaluate(target.code, {
            timeoutSeconds: target.timeoutSeconds ?? 60,
            label: `cell:${target.id}`,
          });
          entry.ok = result.ok === true;
          entry.text = result.text ?? '';
          entry.messages = Array.isArray(result.messages) ? result.messages : [];
          entry.durationMs = Number(result.durationMs) || 0;
          if (!entry.ok) {
            entry.error = result.error ?? { code: ErrorCodes.EVALUATION_FAILED, message: 'evaluation failed' };
          } else if (result.svgBytes instanceof Uint8Array && result.svgBytes.byteLength > 0) {
            entry.svgBytes = result.svgBytes.byteLength;
            // Rich artifact attached (SVG or PNG): the full InputForm adds tens
            // of KB to the payload with no value for the client.
            entry.text = TYPESET_TEXT_PLACEHOLDER;
            attachments.push({ path: ['cells', position, 'svg'], codec: 'bytes', bytes: result.svgBytes });
          }
        } catch (error) {
          const mapped =
            error instanceof PluginError ? error : new PluginError(ErrorCodes.KERNEL_UNAVAILABLE, error instanceof Error ? error.message : String(error));
          entry.error = { code: mapped.code, message: mapped.message };
        }
      }
      entries.push(entry);
    }
    await this.store.finishEvaluation(sessionId, path, targets, entries);
    return { entries, attachments };
  }

  /** `restartKernel` (CONTRACT.md 搂2). */
  async restartKernel() {
    const kernel = await this.kernel.restart();
    return { value: { kernel } };
  }

  /** `openInMathematica` (CONTRACT.md 搂2). */
  async openInMathematica(request = {}) {
    const sessionId = requireString(request, 'sessionId');
    const path = this.paths.validate(sessionId, requireString(request, 'path'), { mustExist: true });
    if (!this.launcher || typeof this.launcher.launch !== 'function') {
      throw new PluginError(ErrorCodes.LAUNCH_FAILED, 'native Mathematica launcher is not available in this environment');
    }
    // Persist pending agent/client edits before opening the native file.
    try {
      await this.store.flushDoc(sessionId, path);
    } catch (error) {
      this._log(`openInMathematica flush failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const launched = await this.launcher.launch(path);
    return { value: { launched: true, executable: launched.executable, ...(launched.pid ? { pid: launched.pid } : {}) } };
  }

  /** `close` (CONTRACT.md 搂2). */
  async close(request = {}) {
    const sessionId = requireString(request, 'sessionId');
    const path = requireString(request, 'path');
    const result = await this.store.close(sessionId, path);
    return { value: { closed: result.closed } };
  }

  /**
   * `debug` diagnostics: plugin/RPC health plus the optional endpoint probe
   * (debug-only verification hook, see the task contract).
   */
  async debug(request = {}) {
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId : null;
    let notebook = null;
    let defaultDir = null;
    try {
      defaultDir = this.paths.defaultDir(sessionId);
      if (sessionId && typeof request.path === 'string' && request.path) {
        const path = this.paths.validate(sessionId, request.path);
        notebook = this.store.summary(sessionId, path);
      }
    } catch {
      /* diagnostics must never fail on a bad hint path */
    }
    const value = {
      ok: true,
      action: 'debug',
      serverVersion: this.serverVersion,
      kernel: this.kernel.diagnostics(),
      store: { notebooks: this.store.count, stats: this.store.stats },
      paths: { defaultDir, allowedRoots: sessionId ? this.paths.allowedRoots(sessionId) : [] },
      rpc: this._diagnosticsSnapshot(),
      webNotebook: await this._webStatusOrNull(),
      notebook,
      probe: null,
    };
    if (typeof request.probeEndpoint === 'string' && request.probeEndpoint.length > 0) {
      if (!this._probe) throw new PluginError(ErrorCodes.INTERNAL_ERROR, 'debug probe is not wired in this environment');
      const probePayload = request.probePayload ?? {};
      const result = await this._probe(request.probeEndpoint, probePayload);
      value.probe = {
        endpoint: request.probeEndpoint,
        result: jsonSafe({
          ok: result?.ok === true,
          ...(result?.ok === true ? { value: result.value } : { error: result?.error }),
          attachments: Array.isArray(result?.attachments)
            ? result.attachments.map((attachment) => ({ path: attachment.path, bytes: attachment.bytes?.byteLength ?? 0 }))
            : [],
        }),
      };
    }
    return { value };
  }

  /* ------------------------- agent-tool operations ------------------------ */

  /** Agent `read`: path + cells (optionally with output summaries). */
  async readForTool(request = {}) {
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId : null;
    const path = requireString(request, 'path');
    if (request.includeOutputs !== undefined && typeof request.includeOutputs !== 'boolean') {
      throw invalidPayload('"includeOutputs" must be a boolean', { field: 'includeOutputs' });
    }
    const doc = await this.store.ensureDoc(sessionId, path);
    const includeOutputs = request.includeOutputs === true;
    return {
      value: {
        path: doc.path,
        readOnly: Boolean(doc.readOnly),
        cells: doc.cells.map((cell) => ({
          id: cell.id,
          kind: cell.kind,
          code: cell.code,
          ...(includeOutputs ? { outputSummary: summarizeOutputText(cell.outputs) } : {}),
        })),
      },
    };
  }

  /** Agent `edit`: apply insert/replace/delete operations and persist them. */
  async editForTool(request = {}) {
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId : null;
    const path = requireString(request, 'path');
    const result = await this.store.editCells(sessionId, path, request.operations);
    // Agent edits are flushed immediately so they are durable and visible to
    // the native launcher / other readers without waiting for the debounce.
    await this.store.flushDoc(sessionId, result.path);
    return { value: { path: result.path, revision: result.revision } };
  }

  /** Agent `run`: evaluate stored cells and return text-only results. */
  async runForTool(request = {}) {
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId : null;
    const path = requireString(request, 'path');
    let indices = null;
    if (request.indices !== undefined && request.indices !== null) {
      if (!Array.isArray(request.indices)) throw invalidPayload('"indices" must be an array', { field: 'indices' });
      indices = request.indices;
    }
    const prepared = await this.store.prepareEvaluation(sessionId, path, { cells: null, indices });
    const { entries } = await this._runTargets(sessionId, prepared.path, prepared.targets);
    return {
      value: {
        path: prepared.path,
        results: entries.map((entry, position) => {
          // Uniform placeholder for every rich result, 2D (SVG) and 3D (PNG).
          const rendered = entry.ok && entry.svgBytes > 0;
          return {
            index: prepared.targets[position].index,
            ok: entry.ok,
            // A typeset result (Plot/graphics) has no useful plain-text form;
            // point the model at the rendered cell instead of echoing a huge
            // InputForm. Text results keep their value.
            text: rendered ? TOOL_TYPESET_PLACEHOLDER : truncate(entry.text ?? '', TOOL_TEXT_LIMIT),
            messages: entry.messages,
            durationMs: entry.durationMs,
            ...(entry.ok ? {} : { error: entry.error }),
          };
        }),
      },
    };
  }

  /* --------------------------- WLJS web notebook -------------------------- */

  _web() {
    if (!this.webNotebook) {
      throw new PluginError(
        ErrorCodes.WEB_NOTEBOOK_UNAVAILABLE,
        'The WLJS web notebook bridge is not wired in this environment (no WLJS installation detected by the Host).',
        {},
      );
    }
    return this.webNotebook;
  }

  /** Diagnostics variant of `webStatus` that never throws. */
  async _webStatusOrNull() {
    if (!this.webNotebook) return { available: false, reason: 'not_wired' };
    try {
      return await this.webNotebook.status();
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** `webStatus`: installation/runtime state plus the embed URL. */
  async webStatus() {
    return { value: await this._web().status() };
  }

  /** `webStart`: start the local WLJS server (idempotent) and report readiness. */
  async webStart() {
    const manager = this._web();
    await manager.ensureRunning();
    return { value: await manager.status() };
  }

  /** `webStop`: stop the local WLJS server this plugin started. */
  async webStop() {
    const manager = this._web();
    const stopped = await manager.stop();
    return { value: { ...stopped, status: await manager.status() } };
  }

  /**
   * `webOpen`: start the server and return the URL the browser tab should show.
   * Reuses the last notebook unless `fresh` is set, so clicking the toolbar
   * button again brings back the same working notebook.
   */
  async webOpen(request = {}) {
    const manager = this._web();
    await manager.ensureRunning();
    if (request.fresh !== true) {
      const status = await manager.status();
      const last = status.lastNotebook;
      if (last && typeof last.url === 'string') {
        return { value: { url: last.url, notebookId: last.id ?? null, created: false } };
      }
    }
    const created = await manager.newNotebook();
    return { value: { url: created.url, notebookId: created.id, created: true } };
  }

  /** `webListNotebooks`: notebooks currently open in the WLJS frontend. */
  async webListNotebooks() {
    const manager = this._web();
    await manager.ensureRunning();
    return { value: { notebooks: await manager.listNotebooks() } };
  }

  /** `webNewNotebook`: create a fresh WLJS notebook (no UI side effect). */
  async webNewNotebook() {
    const manager = this._web();
    await manager.ensureRunning();
    const created = await manager.newNotebook();
    return { value: created };
  }

  /**
   * `webSeed`: fill a freshly created notebook with an intro note and a few
   * sample cells, then evaluate the samples once the frontend has the notebook
   * open (best effort: a sample that fails to render is reported, not thrown).
   */
  async webSeed(request = {}) {
    const manager = this._web();
    if (typeof request.notebook !== 'string' || request.notebook.trim() === '') {
      throw invalidPayload('"notebook" must be a non-empty WLJS notebook id', { field: 'notebook' });
    }
    const notebookId = request.notebook.trim();
    await manager.waitNotebookReady(notebookId, 45_000);
    const seeded = await manager.addCells(notebookId, [
      {
        content: [
          '.md',
          '# WLJS Notebook',
          '',
          'This is a **web-native Wolfram Language notebook** rendered by WLJS and computed by the',
          'local Mathematica kernel. It runs inside the DSH sidebar, so rich and interactive output',
          '(`Plot3D`, `Manipulate`, `Dataset`, 鈥? is rendered by the real notebook frontend.',
          '',
          'Press **Shift + Enter** to evaluate a cell, or use the menu to open/save `.wln` / `.nb` files.',
        ].join('\n'),
      },
      { content: '2 + 2' },
      { content: 'Plot3D[Sin[x y], {x, -3, 3}, {y, -3, 3}, ColorFunction -> "Rainbow", ImageSize -> 380]' },
      { content: 'Manipulate[Plot[Sin[n x], {x, 0, 2 Pi}, ImageSize -> 380], {n, 1, 5, 1}]' },
      { content: 'Dataset[<|"alpha" -> 1, "beta" -> 2.5|>]' },
    ]);
    const cells = Array.isArray(seeded?.Created) ? seeded.Created : [];
    const evaluated = [];
    // `2 + 2`, the two graphics cells and the Dataset sample: indices 1..4.
    for (const cellId of cells.slice(1, 5)) {
      try {
        const output = await manager.evaluateCell(cellId, { timeLimit: 40, maxCharacters: 600 });
        evaluated.push({ cell: cellId, ok: true, output: Array.isArray(output) ? output.map((entry) => entry?.Id ?? null) : null });
      } catch (error) {
        evaluated.push({ cell: cellId, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { value: { notebook: notebookId, cells, evaluated } };
  }

  /** `webListCells`: input/output cells of one WLJS notebook. */
  async webListCells(request = {}) {
    const manager = this._web();
    if (typeof request.notebook !== 'string' || request.notebook.trim() === '') {
      throw invalidPayload('"notebook" must be a non-empty WLJS notebook id', { field: 'notebook' });
    }
    await manager.ensureRunning();
    return { value: { cells: await manager.listCells(request.notebook.trim()) } };
  }

  /** `webAddCells`: append input cells (`.md`, `.html`, `.js`, plain WL, 鈥?. */
  async webAddCells(request = {}) {
    const manager = this._web();
    if (typeof request.notebook !== 'string' || request.notebook.trim() === '') {
      throw invalidPayload('"notebook" must be a non-empty WLJS notebook id', { field: 'notebook' });
    }
    await manager.ensureRunning();
    const added = await manager.addCells(request.notebook.trim(), request.cells);
    return { value: { notebook: request.notebook.trim(), ...added } };
  }

  /** `webEvaluate`: evaluate one WLJS input cell; output cells come back by id. */
  async webEvaluate(request = {}) {
    const manager = this._web();
    if (typeof request.cell !== 'string' || request.cell.trim() === '') {
      throw invalidPayload('"cell" must be a non-empty WLJS cell id', { field: 'cell' });
    }
    await manager.ensureRunning();
    const output = await manager.evaluateCell(request.cell.trim(), {
      timeLimit: optionalNumber(request, 'timeLimit') ?? 40,
      maxCharacters: optionalNumber(request, 'maxCharacters') ?? 2000,
      summarize: request.summarize === true,
    });
    return { value: { cell: request.cell.trim(), output } };
  }

  /** `webKernelEvaluate`: evaluate WL directly in a ready WLJS kernel. */
  async webKernelEvaluate(request = {}) {
    const manager = this._web();
    await manager.ensureRunning();
    const result = await manager.kernelEvaluate(request.expression, {
      kernel: typeof request.kernel === 'string' ? request.kernel : null,
      timeLimit: optionalNumber(request, 'timeLimit') ?? 40,
      maxCharacters: optionalNumber(request, 'maxCharacters') ?? 2500,
    });
    return { value: { result } };
  }
}

export { TOOL_TEXT_LIMIT };
