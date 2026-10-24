/**
 * The Host operation layer shared by the RPC endpoints (CONTRACT.md §2) and the
 * `mathematica_notebook` agent tool (CONTRACT.md §5).
 *
 * One implementation means the browser and the agent always observe the same
 * store, revisions, path rules and kernel serialization. Methods return
 * `{ value, attachments? }`; failures throw `PluginError` with a contract code
 * and are turned into envelopes by `lib/rpc.js` / `lib/tools.js`.
 */

import { basename } from 'node:path';
import { ErrorCodes, PluginError, invalidPayload, optionalNumber, requireString } from './errors.js';

/** Value reported by the `status` endpoint (CONTRACT.md §2). */
export const SERVER_VERSION = '0.3.0';

/** Max output text echoed into agent-tool run results. */
const TOOL_TEXT_LIMIT = 4000;

/**
 * Placeholder `text` used for an evaluate cell whose rich artifact (SVG or PNG)
 * is attached; the full InputForm would be tens of KB of noise on the wire.
 */
export const TYPESET_TEXT_PLACEHOLDER = '[typeset output]';

/** Placeholder text for an animated GIF output (played by the notebook). */
export const ANIMATION_TEXT_PLACEHOLDER = '[animation]';

/** Uniform agent-tool `run` placeholder for 2D SVG and 3D PNG outputs. */
export const TOOL_TYPESET_PLACEHOLDER = '[typeset result rendered in the notebook]';

/** Agent-tool placeholder for an animated GIF result (it plays in the tab). */
export const TOOL_ANIMATION_PLACEHOLDER = '[animation rendered in the notebook]';

function truncate(text, limit) {
  if (typeof text !== 'string' || text.length <= limit) return text;
  return `${text.slice(0, limit)}… [truncated]`;
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
  constructor({ store, kernel, paths, launcher = null, diagnostics = null, serverVersion = SERVER_VERSION, logger = null }) {
    this.store = store;
    this.kernel = kernel;
    this.paths = paths;
    this.launcher = launcher;
    this.diagnostics = diagnostics;
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

  /** `status` (CONTRACT.md §2). */
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

  /** `list` (CONTRACT.md §2). */
  async list(request = {}) {
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId : null;
    const listed = this.store.list(sessionId);
    return { value: listed };
  }

  /** `open` (CONTRACT.md §2). */
  async open(request = {}) {
    const sessionId = requireString(request, 'sessionId');
    const path = requireString(request, 'path');
    const doc = await this.store.open(sessionId, path);
    return { value: { notebook: publicNotebook(doc) } };
  }

  /** `create` (CONTRACT.md §2). */
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

  /** `save` (CONTRACT.md §2). */
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

  /** `saveAs` (CONTRACT.md §2). */
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
   * bytes as RPC attachments (CONTRACT.md §1/§2).
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
            // Rich artifact attached (SVG, PNG or an animated GIF): the full
            // InputForm adds tens of KB to the payload with no value for the
            // client.
            entry.text = result.artifactFormat === 'gif' ? ANIMATION_TEXT_PLACEHOLDER : TYPESET_TEXT_PLACEHOLDER;
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

  /** `restartKernel` (CONTRACT.md §2). */
  async restartKernel() {
    const kernel = await this.kernel.restart();
    return { value: { kernel } };
  }

  /** `openInMathematica` (CONTRACT.md §2). */
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

  /** `close` (CONTRACT.md §2). */
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
          // Uniform placeholder for every rich result: 2D (SVG), 3D (PNG) and
          // animated GIF. Text results keep their value.
          const rendered = entry.ok && entry.svgBytes > 0;
          const placeholder = entry.text === ANIMATION_TEXT_PLACEHOLDER ? TOOL_ANIMATION_PLACEHOLDER : TOOL_TYPESET_PLACEHOLDER;
          return {
            index: prepared.targets[position].index,
            ok: entry.ok,
            // A typeset result (Plot/graphics/animation) has no useful plain-text
            // form; point the model at the rendered cell instead of echoing a
            // huge InputForm.
            text: rendered ? placeholder : truncate(entry.text ?? '', TOOL_TEXT_LIMIT),
            messages: entry.messages,
            durationMs: entry.durationMs,
            ...(entry.ok ? {} : { error: entry.error }),
          };
        }),
      },
    };
  }
}

export { TOOL_TEXT_LIMIT };
