/**
 * Per-(Session, path) notebook documents: revisions, dirty tracking, debounced
 * auto-save, serialized mutations and conflict detection (CONTRACT.md §3).
 *
 * Every Host-side mutation goes through this store. Mutations on one document
 * are serialized through a single promise chain, so a client save, an agent
 * edit and an evaluation result update can never interleave halfway.
 *
 * `revision` increases on every mutation (cell edits, evaluation results,
 * saveAs/open refreshes) and is the only change signal the browser polls.
 * `dirty` means the in-memory cells are not on disk yet; a 1.5 s debounce
 * writes them through the kernel-backed codec. Evaluation outputs live only in
 * memory (real `.nb` files store code/text cells in v1).
 */

import { statSync } from 'node:fs';
import { ErrorCodes, PluginError, invalidPayload } from './errors.js';

/** Auto-save debounce from CONTRACT.md §3. */
export const AUTO_SAVE_MS = 1500;

/** Hard cap on cells handed to the store by one request. */
const MAX_CELLS = 5000;

/** Truncate a stored output text so the in-memory document stays small. */
function truncateOutput(text, limit = 2000) {
  if (typeof text !== 'string') return '';
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/** Validate client-supplied cells `[{id, kind, code}]`. */
export function normalizeDocumentCells(cells) {
  if (!Array.isArray(cells)) throw invalidPayload('"cells" must be an array', { field: 'cells' });
  if (cells.length > MAX_CELLS) throw invalidPayload(`"cells" must contain at most ${MAX_CELLS} cells`, { field: 'cells' });
  const ids = new Set();
  return cells.map((cell, index) => {
    if (!cell || typeof cell !== 'object') throw invalidPayload(`cells[${index}] must be an object`, { field: `cells[${index}]` });
    if (typeof cell.id !== 'string' || cell.id.length === 0) {
      throw invalidPayload(`cells[${index}].id must be a non-empty string`, { field: `cells[${index}].id` });
    }
    if (ids.has(cell.id)) throw invalidPayload(`cells[${index}].id is duplicated: ${JSON.stringify(cell.id)}`, { field: `cells[${index}].id` });
    ids.add(cell.id);
    const kind = cell.kind === undefined ? 'code' : cell.kind;
    if (kind !== 'code' && kind !== 'text') {
      throw invalidPayload(`cells[${index}].kind must be "code" or "text"`, { field: `cells[${index}].kind` });
    }
    if (typeof cell.code !== 'string') throw invalidPayload(`cells[${index}].code must be a string`, { field: `cells[${index}].code` });
    return { id: cell.id, kind, code: cell.code };
  });
}

/** Summarize one evaluate result into the document's in-memory outputs. */
export function summarizeResultOutputs(result) {
  const outputs = [];
  if (!result || result.ok !== true) {
    const code = result?.error?.code ?? 'evaluation_failed';
    const message = result?.error?.message ?? 'evaluation failed';
    outputs.push({ type: 'msg', text: truncateOutput(`${code}: ${message}`) });
    return outputs;
  }
  if (typeof result.text === 'string' && result.text.length > 0) {
    outputs.push({ type: 'text', text: truncateOutput(result.text) });
  }
  if (Array.isArray(result.messages) && result.messages.length > 0) {
    outputs.push({ type: 'msg', text: truncateOutput(result.messages.join(', ')) });
  }
  return outputs;
}

/**
 * In-memory notebook document store.
 */
export class NotebookStore {
  /**
   * @param {object} options
   * @param {object} options.codec NotebookCodec-like (`readNotebook`, `writeNotebook`)
   * @param {object} options.paths NotebookPaths-like (`validate`, `allocateNotebookPath`, `saveAsTarget`, `list`)
   * @param {(message: string) => void} [options.logger]
   * @param {number} [options.autoSaveMs]
   * @param {() => number} [options.now]
   * @param {Function} [options.setTimeoutFn]
   * @param {Function} [options.clearTimeoutFn]
   */
  constructor({
    codec,
    paths,
    logger = null,
    autoSaveMs = AUTO_SAVE_MS,
    now = () => Date.now(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  }) {
    if (!codec || typeof codec.writeNotebook !== 'function' || typeof codec.readNotebook !== 'function') {
      throw new TypeError('NotebookStore requires a notebook codec');
    }
    if (!paths || typeof paths.validate !== 'function') throw new TypeError('NotebookStore requires repository paths');
    this.codec = codec;
    this.paths = paths;
    this.logger = typeof logger === 'function' ? logger : null;
    this.autoSaveMs = autoSaveMs;
    this.now = now;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    /** @type {Map<string, object>} key -> document */
    this.docs = new Map();
    this._chain = Promise.resolve();
    this._docSeq = 0;
    this._closed = false;
    /**
     * Explicitly closed (session, path) keys. A closed document must not be
     * resurrected by a late auto-save / in-flight evaluation: implicit loads
     * report `not_found` until `open` is called again on purpose.
     * @type {Set<string>}
     */
    this._closedKeys = new Set();
    this.stats = { saves: 0, saveFailures: 0, opens: 0, creates: 0 };
  }

  _log(message) {
    if (this.logger) this.logger(message);
  }

  _key(sessionId, path) {
    const session = typeof sessionId === 'string' ? sessionId : '';
    const normalized = process.platform === 'win32' ? String(path).toLowerCase() : String(path);
    return `${session}\u0000${normalized}`;
  }

  /** Normalized path-only comparison (Session-independent). */
  _pathKey(path) {
    return process.platform === 'win32' ? String(path).toLowerCase() : String(path);
  }

  /** Run `task` after every previously queued store mutation. */
  _enqueue(task) {
    const run = this._chain.then(task, task);
    this._chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Number of documents currently held in memory. */
  get count() {
    return this.docs.size;
  }

  /** The cached document for (session, path), or `null`. */
  getCached(sessionId, path) {
    return this.docs.get(this._key(sessionId, path)) ?? null;
  }

  /** Snapshot for `status`: `{path, revision, dirty, readOnly}` or `null`. */
  summary(sessionId, path) {
    const doc = this.getCached(sessionId, path);
    if (!doc) return null;
    return { path: doc.path, revision: doc.revision, dirty: doc.dirty, readOnly: doc.readOnly };
  }

  /** List `*.nb` files in the Session's default notebook directory. */
  list(sessionId) {
    return this.paths.list(sessionId);
  }

  _fileStat(path) {
    try {
      return statSync(path);
    } catch {
      return null;
    }
  }

  _allocateCellId(doc) {
    const used = new Set(doc.cells.map((cell) => cell.id));
    for (;;) {
      const id = `c${doc.nextCellId}`;
      doc.nextCellId += 1;
      if (!used.has(id)) return id;
    }
  }

  _newDoc({ sessionId, path, origin, readOnly, cells, revision, mtimeMs }) {
    const doc = {
      id: `n${++this._docSeq}`,
      sessionId: typeof sessionId === 'string' ? sessionId : null,
      path,
      origin,
      readOnly: Boolean(readOnly),
      cells,
      revision,
      savedRevision: revision,
      dirty: false,
      createdAt: this.now(),
      mtimeMs: Number(mtimeMs) || 0,
      nextCellId: cells.length + 1,
      timer: null,
      saveRetries: 0,
      lastSaveError: null,
    };
    return doc;
  }

  /**
   * Import a `.nb` from disk into a fresh document (caller holds the chain).
   *
   * @param {string} sessionId
   * @param {string} path validated absolute path
   * @param {object} [existing] previous document for the same key
   * @returns {Promise<object>} document
   */
  async _importDoc(sessionId, path, existing = null) {
    const imported = await this.codec.readNotebook(path);
    if (imported.notANotebook) {
      throw new PluginError(ErrorCodes.EVALUATION_FAILED, `not a valid Mathematica notebook: ${path}`, { path });
    }
    const cells = imported.cells.map((cell, index) => ({ id: `c${index + 1}`, kind: cell.kind, code: cell.code }));
    const readOnly = imported.foreignStyles.length > 0 || imported.cells.some((cell) => cell.exact !== true);
    const stat = this._fileStat(path);
    const doc = this._newDoc({
      sessionId,
      path,
      origin: existing?.origin === 'created' ? 'created' : 'imported',
      readOnly,
      cells,
      revision: existing ? existing.revision + 1 : 1,
      mtimeMs: stat?.mtimeMs ?? this.now(),
    });
    this.docs.set(this._key(sessionId, path), doc);
    this.stats.opens += 1;
    return doc;
  }

  /**
   * Load a document from disk, reusing the cached copy when it is current.
   * A cached dirty document wins over the disk (in-memory changes are newer);
   * a changed file mtime triggers a re-import and a revision bump.
   */
  async open(sessionId, rawPath) {
    const path = this.paths.validate(sessionId, rawPath, { mustExist: true });
    // An explicit open is the only way back into a closed document.
    return this._enqueue(() => this._openUnlocked(sessionId, path, { explicit: true }));
  }

  async _openUnlocked(sessionId, path, { explicit = false } = {}) {
    const key = this._key(sessionId, path);
    if (this._closedKeys.has(key)) {
      if (!explicit) {
        throw new PluginError(ErrorCodes.NOT_FOUND, 'this notebook was closed; open it again before using it', { path });
      }
      this._closedKeys.delete(key);
    }
    const existing = this.docs.get(key);
    const stat = this._fileStat(path);
    const mtimeMs = stat?.mtimeMs ?? 0;
    if (existing) {
      if (existing.dirty) return existing;
      if (Math.abs(mtimeMs - existing.mtimeMs) < 1) return existing;
    }
    return this._importDoc(sessionId, path, existing);
  }

  /**
   * Create a new notebook in the default notebook dir
   * (`Untitled-<n>.nb`, written immediately).
   *
   * @param {string|null} sessionId
   * @param {{cells?: Array<{kind?: string, code: string, id?: string}>}} [options]
   */
  async create(sessionId, { cells = null } = {}) {
    return this._enqueue(async () => {
      const path = this.paths.allocateNotebookPath(sessionId);
      let docCells;
      if (Array.isArray(cells) && cells.length > 0) {
        docCells = cells.map((cell, index) => {
          if (!cell || typeof cell !== 'object' || typeof cell.code !== 'string') {
            throw invalidPayload(`cells[${index}].code must be a string`, { field: `cells[${index}].code` });
          }
          const kind = cell.kind === 'text' ? 'text' : 'code';
          return { id: typeof cell.id === 'string' && cell.id ? cell.id : `c${index + 1}`, kind, code: cell.code };
        });
      } else {
        docCells = [{ id: 'c1', kind: 'code', code: '' }];
      }
      await this.codec.writeNotebook(path, docCells);
      const stat = this._fileStat(path);
      const doc = this._newDoc({
        sessionId,
        path,
        origin: 'created',
        readOnly: false,
        cells: docCells,
        revision: 1,
        mtimeMs: stat?.mtimeMs ?? this.now(),
      });
      this.docs.set(this._key(sessionId, path), doc);
      this.stats.creates += 1;
      return doc;
    });
  }

  /**
   * Replace the document's cells and bump the revision.
   *
   * @param {string|null} sessionId
   * @param {string} rawPath
   * @param {Array<{id: string, kind?: string, code: string}>} cells
   * @param {number} baseRevision
   * @returns {Promise<{path: string, revision: number, doc: object}>}
   */
  async save(sessionId, rawPath, cells, baseRevision) {
    const path = this.paths.validate(sessionId, rawPath);
    if (typeof baseRevision !== 'number' || !Number.isFinite(baseRevision)) {
      throw invalidPayload('"baseRevision" must be a finite number', { field: 'baseRevision' });
    }
    const normalized = normalizeDocumentCells(cells);
    return this._enqueue(async () => {
      const doc = await this._openUnlocked(sessionId, path);
      if (doc.revision !== baseRevision) {
        throw new PluginError(ErrorCodes.CONFLICT, 'the notebook changed on the Host since the client loaded it', {
          revision: doc.revision,
          baseRevision,
        });
      }
      doc.cells = normalized;
      doc.revision += 1;
      doc.dirty = true;
      doc.saveRetries = 0;
      this._scheduleSave(doc);
      return { path: doc.path, revision: doc.revision, doc };
    });
  }

  /**
   * Write a new editable `.nb` next to the source (or in the default dir).
   *
   * @param {string|null} sessionId
   * @param {string} sourcePath
   * @param {string} name
   * @param {Array<{id: string, kind?: string, code: string}>} cells
   * @returns {Promise<object>} the new document
   */
  async saveAs(sessionId, sourcePath, name, cells) {
    const source = this.paths.validate(sessionId, sourcePath);
    const normalized = normalizeDocumentCells(cells);
    return this._enqueue(async () => {
      const target = this.paths.saveAsTarget(sessionId, source, name);
      await this.codec.writeNotebook(target, normalized);
      const stat = this._fileStat(target);
      const doc = this._newDoc({
        sessionId,
        path: target,
        origin: 'created',
        readOnly: false,
        cells: normalized,
        revision: 1,
        mtimeMs: stat?.mtimeMs ?? this.now(),
      });
      this.docs.set(this._key(sessionId, target), doc);
      return doc;
    });
  }

  /** Cached document or an import from disk (caller may need `path` validated). */
  async ensureDoc(sessionId, rawPath) {
    const path = this.paths.validate(sessionId, rawPath);
    return this._enqueue(() => this._openUnlocked(sessionId, path));
  }

  /**
   * First evaluation phase: sync client-supplied cell code into the document and
   * collect the targets to evaluate (CONTRACT.md §2 evaluate request).
   *
   * @param {string|null} sessionId
   * @param {string} rawPath
   * @param {{cells?: Array<{id: string, code: string, timeoutSeconds?: number}>, indices?: number[]}} [request]
   * @returns {Promise<{path: string, revision: number, targets: Array<{id: string, code: string, timeoutSeconds: (number|undefined), index: number}>}>}
   */
  async prepareEvaluation(sessionId, rawPath, { cells = null, indices = null } = {}) {
    const path = this.paths.validate(sessionId, rawPath);
    return this._enqueue(async () => {
      const doc = await this._openUnlocked(sessionId, path);
      let targets;
      if (Array.isArray(cells)) {
        if (cells.length > MAX_CELLS) throw invalidPayload(`"cells" must contain at most ${MAX_CELLS} cells`, { field: 'cells' });
        let codeChanged = false;
        const resolved = cells.map((cell, position) => {
          if (!cell || typeof cell !== 'object' || typeof cell.id !== 'string' || cell.id.length === 0) {
            throw invalidPayload(`cells[${position}].id must be a non-empty string`, { field: `cells[${position}].id` });
          }
          if (typeof cell.code !== 'string') {
            throw invalidPayload(`cells[${position}].code must be a string`, { field: `cells[${position}].code` });
          }
          let timeoutSeconds;
          if (cell.timeoutSeconds !== undefined && cell.timeoutSeconds !== null) {
            if (typeof cell.timeoutSeconds !== 'number' || !Number.isFinite(cell.timeoutSeconds) || cell.timeoutSeconds <= 0) {
              throw invalidPayload(`cells[${position}].timeoutSeconds must be a positive number`, { field: `cells[${position}].timeoutSeconds` });
            }
            timeoutSeconds = cell.timeoutSeconds;
          }
          let index = doc.cells.findIndex((existing) => existing.id === cell.id);
          if (index === -1) {
            doc.cells.push({ id: cell.id, kind: 'code', code: cell.code, outputs: [] });
            codeChanged = true;
            index = doc.cells.length - 1;
          } else if (doc.cells[index].code !== cell.code) {
            doc.cells[index].code = cell.code;
            codeChanged = true;
          }
          return { id: cell.id, code: cell.code, timeoutSeconds, index };
        });
        targets = resolved;
        if (codeChanged) {
          doc.revision += 1;
          doc.dirty = true;
          this._scheduleSave(doc);
        }
      } else if (Array.isArray(indices)) {
        if (indices.length === 0) throw invalidPayload('"indices" must not be empty', { field: 'indices' });
        targets = indices.map((index) => {
          if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= doc.cells.length) {
            throw invalidPayload(`"indices" contains an invalid cell index: ${String(index)}`, { field: 'indices' });
          }
          const cell = doc.cells[index];
          if (cell.kind !== 'code') {
            throw invalidPayload(`cell ${index} is not a code cell`, { field: 'indices' });
          }
          return { id: cell.id, code: cell.code, timeoutSeconds: undefined, index };
        });
      } else {
        targets = doc.cells
          .map((cell, index) => ({ cell, index }))
          .filter(({ cell }) => cell.kind === 'code')
          .map(({ cell, index }) => ({ id: cell.id, code: cell.code, timeoutSeconds: undefined, index }));
      }
      return { path: doc.path, revision: doc.revision, targets };
    });
  }

  /**
   * Second evaluation phase: record outputs and bump the revision.
   *
   * @param {string|null} sessionId
   * @param {string} path validated absolute path
   * @param {Array<{id: string}>} targets
   * @param {Array<object>} results evaluate result entries (same order)
   * @returns {Promise<number>} new revision
   */
  async finishEvaluation(sessionId, path, targets, results) {
    return this._enqueue(() => {
      const doc = this.docs.get(this._key(sessionId, path));
      if (!doc) return 0;
      for (let position = 0; position < targets.length; position += 1) {
        const target = targets[position];
        const result = results[position];
        const cell = doc.cells.find((existing) => existing.id === target.id);
        if (!cell) continue;
        cell.outputs = summarizeResultOutputs(result);
      }
      doc.revision += 1;
      return doc.revision;
    });
  }

  /** Apply agent-tool edit operations to a document (CONTRACT.md §5 edit). */
  async editCells(sessionId, rawPath, operations) {
    if (!Array.isArray(operations) || operations.length === 0) {
      throw invalidPayload('"operations" must be a non-empty array', { field: 'operations' });
    }
    const path = this.paths.validate(sessionId, rawPath);
    return this._enqueue(async () => {
      const doc = await this._openUnlocked(sessionId, path);
      if (doc.readOnly) {
        throw new PluginError(ErrorCodes.PATH_DENIED, 'this notebook was imported read-only; use saveAs to create an editable copy', {
          path: doc.path,
        });
      }
      for (let position = 0; position < operations.length; position += 1) {
        const operation = operations[position];
        if (!operation || typeof operation !== 'object' || typeof operation.op !== 'string') {
          throw invalidPayload(`operations[${position}] must be an object with an "op"`, { field: `operations[${position}]` });
        }
        const op = operation.op;
        if (op === 'insert') {
          const code = typeof operation.code === 'string' ? operation.code : '';
          const index = operation.index === undefined ? doc.cells.length : operation.index;
          if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > doc.cells.length) {
            throw invalidPayload(`operations[${position}].index is out of range`, { field: `operations[${position}].index` });
          }
          doc.cells.splice(index, 0, { id: this._allocateCellId(doc), kind: 'code', code, outputs: [] });
          continue;
        }
        if (typeof operation.index !== 'number' || !Number.isInteger(operation.index) || operation.index < 0 || operation.index >= doc.cells.length) {
          throw invalidPayload(`operations[${position}].index is required and must be a valid cell index`, { field: `operations[${position}].index` });
        }
        const index = operation.index;
        if (op === 'replace') {
          if (typeof operation.code !== 'string') {
            throw invalidPayload(`operations[${position}].code must be a string for "replace"`, { field: `operations[${position}].code` });
          }
          doc.cells[index] = { ...doc.cells[index], code: operation.code, outputs: [] };
          continue;
        }
        if (op === 'delete') {
          doc.cells.splice(index, 1);
          continue;
        }
        throw invalidPayload(`operations[${position}].op must be "insert", "replace" or "delete"`, { field: `operations[${position}].op` });
      }
      doc.revision += 1;
      doc.dirty = true;
      this._scheduleSave(doc);
      return { path: doc.path, revision: doc.revision, doc };
    });
  }

  /** Flush a document's pending auto-save immediately (agent edits are durable). */
  async flushDoc(sessionId, rawPath) {
    const path = this.paths.validate(sessionId, rawPath);
    return this._enqueue(async () => {
      const doc = this.docs.get(this._key(sessionId, path));
      if (!doc) return false;
      if (doc.dirty) await this._flush(doc);
      return true;
    });
  }

  /**
   * Close a document: flush a pending save, dispose its timer and release the
   * store entry. The (session, path) key is tombstoned so an in-flight
   * auto-save/evaluation cannot silently resurrect the document; a later explicit
   * `open` re-imports it from disk.
   *
   * When the requested session no longer owns the document (session drift between
   * the browser tab and the tool/probe that opened it) the matching path is
   * released anyway so `close` always removes the store entry the caller sees.
   *
   * @returns {Promise<{closed: boolean}>}
   */
  async close(sessionId, rawPath) {
    const path = this.paths.validate(sessionId, rawPath);
    return this._enqueue(async () => {
      const requestedKey = this._key(sessionId, path);
      /** @type {Array<[string, object]>} */
      const matches = [];
      const exact = this.docs.get(requestedKey);
      if (exact) {
        matches.push([requestedKey, exact]);
      } else {
        const wanted = this._pathKey(path);
        for (const [key, doc] of this.docs) {
          if (this._pathKey(doc.path) === wanted) matches.push([key, doc]);
        }
      }
      for (const [key, doc] of matches) {
        this._clearTimer(doc);
        if (doc.dirty) {
          try {
            await this._flush(doc);
          } catch (error) {
            this._log(`notebook close flush failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        this.docs.delete(key);
        this._closedKeys.add(key);
      }
      // Always tombstone the requested key, even when no entry was loaded: a
      // later implicit save/evaluate must not re-create the closed document.
      this._closedKeys.add(requestedKey);
      return { closed: true };
    });
  }

  _clearTimer(doc) {
    if (doc.timer) {
      this.clearTimeoutFn(doc.timer);
      doc.timer = null;
    }
  }

  _scheduleSave(doc) {
    this._clearTimer(doc);
    doc.timer = this.setTimeoutFn(() => {
      doc.timer = null;
      this._enqueue(() => this._flush(doc)).catch((error) => {
        this._log(`notebook auto-save failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, this.autoSaveMs);
    if (typeof doc.timer?.unref === 'function') doc.timer.unref();
  }

  async _flush(doc) {
    this._clearTimer(doc);
    try {
      await this.codec.writeNotebook(
        doc.path,
        doc.cells.map((cell) => ({ kind: cell.kind, code: cell.code })),
      );
      const stat = this._fileStat(doc.path);
      doc.mtimeMs = stat?.mtimeMs ?? this.now();
      doc.savedRevision = doc.revision;
      doc.dirty = false;
      doc.saveRetries = 0;
      doc.lastSaveError = null;
      this.stats.saves += 1;
    } catch (error) {
      this.stats.saveFailures += 1;
      doc.lastSaveError = error instanceof Error ? error.message : String(error);
      doc.saveRetries += 1;
      if (doc.saveRetries <= 3) this._scheduleSave(doc);
      throw error;
    }
  }

  /** Flush every dirty document (best effort) and dispose all state. */
  async dispose() {
    this._closed = true;
    for (const doc of this.docs.values()) this._clearTimer(doc);
    const dirty = [...this.docs.values()].filter((doc) => doc.dirty);
    for (const doc of dirty) {
      try {
        await this.codec.writeNotebook(
          doc.path,
          doc.cells.map((cell) => ({ kind: cell.kind, code: cell.code })),
        );
        doc.dirty = false;
      } catch (error) {
        this._log(`notebook dispose flush failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.docs.clear();
    this._closedKeys.clear();
  }
}

export { MAX_CELLS };
