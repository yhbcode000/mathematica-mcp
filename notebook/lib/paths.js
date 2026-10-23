/**
 * Session -> working directory resolution and the notebook path rules
 * (CONTRACT.md §6).
 *
 * Allowed roots for a Session are:
 *   - the Session working directory (`<cwd>/...`), resolved through the
 *     optional `agents` + `workingDirectory` services, and
 *   - `$DSH_HOME/notebooks` (always allowed; also the fallback default dir).
 *
 * Relative paths resolve against the default notebook dir (`<cwd>/notebooks`,
 * falling back to `$DSH_HOME/notebooks`), must end with `.nb`, and may not
 * escape an allowed root — not even through a symlink.
 *
 * Every filesystem dependency is injectable so the rules are unit-testable.
 */

import {
  existsSync as nodeExistsSync,
  mkdirSync as nodeMkdirSync,
  readdirSync as nodeReaddirSync,
  realpathSync as nodeRealpathSync,
  statSync as nodeStatSync,
} from 'node:fs';
import { homedir as nodeHomedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { ErrorCodes, PluginError, invalidPayload } from './errors.js';

const NB_EXTENSION = '.nb';

/** Default filesystem surface (overridable in tests). */
function defaultFs() {
  return {
    existsSync: nodeExistsSync,
    mkdirSync: nodeMkdirSync,
    readdirSync: nodeReaddirSync,
    realpathSync: nodeRealpathSync,
    statSync: nodeStatSync,
  };
}

/** Portable comparison form: Windows paths are case-insensitive. */
function comparable(path, platform) {
  const normalized = normalize(path);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** True when `target` is `root` or lexically inside it. */
function isInside(root, target, platform = process.platform) {
  const rootPath = comparable(root, platform);
  const targetPath = comparable(target, platform);
  if (rootPath === targetPath) return true;
  const prefix = rootPath.endsWith(sep) ? rootPath : `${rootPath}${sep}`;
  return targetPath.startsWith(prefix);
}

/**
 * Directory name / file name safety for saveAs. Rejects path separators so a
 * "name" can never smuggle a directory escape.
 */
export function sanitizeBaseName(name, platform = process.platform) {
  if (typeof name !== 'string') throw invalidPayload('"name" must be a string', { field: 'name' });
  const trimmed = name.trim();
  if (!trimmed) throw invalidPayload('"name" must not be empty', { field: 'name' });
  if (trimmed.includes('\0')) throw invalidPayload('"name" must not contain NUL', { field: 'name' });
  const separators = platform === 'win32' ? /[\\/]/ : /\//;
  if (separators.test(trimmed) || trimmed === '.' || trimmed === '..') {
    throw invalidPayload('"name" must be a bare file name without path separators', { field: 'name' });
  }
  return trimmed;
}

/**
 * Resolve the session working directory from the optional Host services.
 *
 * @param {object|null} ctx plugin context (Cordis); may be absent in tests
 * @param {string} sessionId
 * @returns {{session: object|null, agent: object|null, cwd: string|null}}
 */
export function resolveSessionContext(ctx, sessionId) {
  const result = { session: null, agent: null, cwd: null };
  const service = (name) => {
    try {
      return typeof ctx?.get === 'function' ? ctx.get(name) : undefined;
    } catch {
      return undefined;
    }
  };
  const agents = service('agents');
  if (agents && typeof agents.get === 'function' && typeof sessionId === 'string') {
    try {
      result.agent = agents.get(sessionId) ?? null;
      result.session = result.agent?.session ?? null;
    } catch {
      result.agent = null;
      result.session = null;
    }
  }
  const workingDirectory = service('workingDirectory');
  if (workingDirectory && typeof workingDirectory.get === 'function' && result.session) {
    try {
      const cwd = workingDirectory.get(result.session);
      if (typeof cwd === 'string' && cwd.trim()) result.cwd = cwd;
    } catch {
      /* no session directory available */
    }
  }
  // No Session -> no per-session working directory. CONTRACT.md §6: the default
  // notebook dir then falls back to `$DSH_HOME/notebooks`.
  return result;
}

/** Path rules for one plugin instance. */
export class NotebookPaths {
  /**
   * @param {object} [options]
   * @param {object|null} [options.ctx] Cordis plugin context for optional services
   * @param {object} [options.env] environment (reads DSH_HOME)
   * @param {string} [options.homeDir] user home fallback
   * @param {string} [options.platform]
   * @param {object} [options.fs] injectable filesystem
   */
  constructor({ ctx = null, env = process.env, homeDir = nodeHomedir(), platform = process.platform, fs = defaultFs() } = {}) {
    this.ctx = ctx;
    this.env = env;
    this.homeDir = homeDir;
    this.platform = platform;
    this.fs = fs;
    this._sessionCache = new Map();
  }

  /** Absolute `$DSH_HOME` (default `~/.dsh`). A blank env value counts as unset. */
  dshHome() {
    const configured = typeof this.env?.DSH_HOME === 'string' ? this.env.DSH_HOME.trim() : '';
    return configured ? configured : join(this.homeDir || nodeHomedir(), '.dsh');
  }

  /** `$DSH_HOME/notebooks` — always-allowed notebook root. */
  notebookRoot() {
    return join(this.dshHome(), 'notebooks');
  }

  /** Resolve (and cache) the Session working directory; `null` when unavailable. */
  sessionCwd(sessionId) {
    const key = typeof sessionId === 'string' ? sessionId : '';
    if (this._sessionCache.has(key)) return this._sessionCache.get(key);
    const { session, agent, cwd } = resolveSessionContext(this.ctx, key);
    const record = { session, agent, cwd };
    this._sessionCache.set(key, record);
    return record;
  }

  /** Default notebook directory for a Session (created on demand elsewhere). */
  defaultDir(sessionId) {
    const { cwd } = this.sessionCwd(sessionId);
    return cwd ? join(cwd, 'notebooks') : this.notebookRoot();
  }

  /** Ordered, de-duplicated allowed roots for a Session. */
  allowedRoots(sessionId) {
    const roots = [];
    const { cwd } = this.sessionCwd(sessionId);
    if (cwd) roots.push(cwd);
    roots.push(this.notebookRoot());
    const seen = new Set();
    return roots.filter((root) => {
      const key = comparable(root, this.platform);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** Create the default notebook dir if needed and return it. */
  ensureDefaultDir(sessionId) {
    const dir = this.defaultDir(sessionId);
    try {
      this.fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      throw new PluginError(ErrorCodes.PATH_DENIED, `could not create the notebook directory: ${error?.message ?? error}`, { dir });
    }
    return dir;
  }

  /** Best-effort real path of a (possibly not yet existing) target. */
  _realTarget(path) {
    let current = normalize(path);
    const tail = [];
    for (;;) {
      if (this.fs.existsSync(current)) {
        try {
          return join(this.fs.realpathSync(current), ...tail);
        } catch {
          return normalize(path);
        }
      }
      const parent = dirname(current);
      if (parent === current) return normalize(path);
      tail.unshift(basename(current));
      current = parent;
    }
  }

  /** The allowed root containing `resolved`, or `null`. */
  containedRoot(sessionId, resolved) {
    const roots = this.allowedRoots(sessionId);
    const lexical = roots.find((root) => isInside(root, resolved, this.platform));
    const real = this._realTarget(resolved);
    const realRoots = roots.map((root) => {
      try {
        return this.fs.existsSync(root) ? this.fs.realpathSync(root) : normalize(root);
      } catch {
        return normalize(root);
      }
    });
    const realContained = realRoots.some((root) => isInside(root, real, this.platform));
    if (!lexical || !realContained) return null;
    return lexical;
  }

  /**
   * Validate and normalize a notebook path for a Session.
   *
   * @param {string|null} sessionId
   * @param {string} input absolute or default-dir-relative path
   * @param {{mustExist?: boolean}} [options]
   * @returns {string} normalized absolute path
   * @throws {PluginError} `invalid_payload` / `path_denied` / `not_found`
   */
  validate(sessionId, input, { mustExist = false } = {}) {
    if (typeof input !== 'string' || input.trim().length === 0) {
      throw invalidPayload('"path" must be a non-empty string', { field: 'path' });
    }
    const raw = input.trim();
    if (raw.includes('\0')) {
      throw new PluginError(ErrorCodes.PATH_DENIED, 'path must not contain NUL characters', { path: input });
    }
    const resolved = isAbsolute(raw) ? normalize(raw) : resolve(this.defaultDir(sessionId), raw);
    if (extname(resolved).toLowerCase() !== NB_EXTENSION) {
      throw new PluginError(ErrorCodes.PATH_DENIED, 'notebook path must end with ".nb"', { path: input });
    }
    if (!this.containedRoot(sessionId, resolved)) {
      throw new PluginError(ErrorCodes.PATH_DENIED, 'notebook path is outside the allowed roots', { path: input });
    }
    if (mustExist && !this.fs.existsSync(resolved)) {
      throw new PluginError(ErrorCodes.NOT_FOUND, `notebook not found: ${resolved}`, { path: resolved });
    }
    return resolved;
  }

  /** Allocate `<defaultDir>/Untitled-<n>.nb` not yet existing. */
  allocateNotebookPath(sessionId, baseName = 'Untitled') {
    const dir = this.ensureDefaultDir(sessionId);
    for (let index = 1; index <= 10000; index += 1) {
      const candidate = join(dir, `${baseName}-${index}${NB_EXTENSION}`);
      if (!this.fs.existsSync(candidate)) return candidate;
    }
    throw new PluginError(ErrorCodes.INTERNAL_ERROR, `could not allocate a unique notebook name in ${dir}`, { dir });
  }

  /**
   * Resolve the target file for saveAs: a `.nb` next to the source notebook
   * (when that directory is allowed) or in the default notebook dir. Existing
   * files are never overwritten — a `-2`, `-3`, ... suffix is allocated.
   *
   * @param {string|null} sessionId
   * @param {string} sourcePath validated absolute source path
   * @param {string} name user supplied file name
   * @returns {string} new absolute `.nb` path
   */
  saveAsTarget(sessionId, sourcePath, name) {
    const safeName = sanitizeBaseName(name, this.platform);
    const withExtension = extname(safeName).toLowerCase() === NB_EXTENSION ? safeName : `${safeName}${NB_EXTENSION}`;
    const sourceDir = dirname(sourcePath);
    const dir = this.containedRoot(sessionId, join(sourceDir, withExtension)) ? sourceDir : this.ensureDefaultDir(sessionId);
    try {
      this.fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      throw new PluginError(ErrorCodes.PATH_DENIED, `could not create the notebook directory: ${error?.message ?? error}`, { dir });
    }
    const stem = basename(withExtension, extname(withExtension));
    for (let index = 1; index <= 10000; index += 1) {
      const candidate = join(dir, index === 1 ? withExtension : `${stem}-${index}${NB_EXTENSION}`);
      if (!this.fs.existsSync(candidate)) {
        const root = this.containedRoot(sessionId, candidate);
        if (!root) throw new PluginError(ErrorCodes.PATH_DENIED, 'notebook path is outside the allowed roots', { path: candidate });
        return candidate;
      }
    }
    throw new PluginError(ErrorCodes.INTERNAL_ERROR, `could not allocate a unique saveAs name in ${dir}`, { dir });
  }

  /** List `*.nb` files in the default notebook dir (CONTRACT.md §2 `list`). */
  list(sessionId) {
    const dir = this.ensureDefaultDir(sessionId);
    let entries = [];
    try {
      entries = this.fs.readdirSync(dir);
    } catch {
      entries = [];
    }
    const files = [];
    for (const entry of entries) {
      const name = typeof entry === 'string' ? entry : entry?.name;
      if (typeof name !== 'string' || extname(name).toLowerCase() !== NB_EXTENSION) continue;
      const path = join(dir, name);
      try {
        const stat = this.fs.statSync(path);
        if (typeof stat?.isFile === 'function' && !stat.isFile()) continue;
        files.push({ path, name, size: Number(stat.size) || 0, mtimeMs: Number(stat.mtimeMs) || 0 });
      } catch {
        /* file vanished between readdir and stat */
      }
    }
    files.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    return { dir, files };
  }
}

export { isInside, comparable };
