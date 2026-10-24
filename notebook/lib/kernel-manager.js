/**
 * Lazy manager around the vendored Wolfram kernel bridge
 * (`../kernel/kernel.js`, byte-identical to `../src/kernel.js`).
 *
 * Responsibilities (CONTRACT.md §8):
 *   - resolve a working kernel only when one is actually needed,
 *   - serialize evaluation through the bridge's own queue,
 *   - map bridge payloads onto the contract's evaluate entries
 *     (`kernel_unavailable` / `kernel_timeout` / `syntax_error` /
 *     `evaluation_failed`),
 *   - render non-trivial results to a real artifact through the bridge's frozen
 *     `artifactPath` option (typeset SVG for 2D/symbolic results, PNG for 3D
 *     graphics and raster images) and return the bytes for the RPC attachment,
 *   - restart / status / dispose.
 *
 * When the vendored bridge predates artifact support
 * (`payload.artifactPath === undefined`) evaluation still works, it simply
 * returns no SVG (text-only fallback).
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveKernel as defaultResolveKernel } from '../kernel/detect.js';
import {
  DEFAULT_TIMEOUT_SECONDS,
  KernelBridge,
  decodeResultValue,
  isSyntaxMessage,
  wlStringLiteral,
} from '../kernel/kernel.js';
import { ErrorCodes, PluginError } from './errors.js';

/** Contract cap for a rendered artifact attachment (CONTRACT.md §1/§2). */
export const SVG_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Cap for an animated GIF attachment. Multi-frame output is necessarily bigger
 * than a single SVG/PNG; 8 MiB keeps a 60-frame, ~400 px animation well inside
 * the attachment budget while still bounding the wire payload.
 */
export const GIF_MAX_BYTES = 12 * 1024 * 1024;

/** Timeout for the extra artifact export performed inside the bridge wrapper. */
const ARTIFACT_EXPORT_SECONDS = 15;

/** Longest result text echoed into an evaluate entry before truncation. */
const MAX_ENTRY_TEXT = 4000;

/** Longest InputForm the manager will re-render in the PNG/SVG/GIF fallback. */
const MAX_RENDER_INPUTFORM = 120_000;

/** 3D / raster result markers (rendered as PNG). */
const THREED_RESULT_PATTERN = /(?:Graphics3D|GraphicsComplex|Image3D|Raster3D)\s*\[/;
const IMAGE_RESULT_PATTERN = /(?:^|[^A-Za-z0-9$])Image\s*\[/;

/**
 * Wolfram constructs whose results are 3D graphics or raster images; those are
 * exported as PNG (fast + reliable) instead of SVG.
 */
const THREED_CODE_PATTERN =
  /\b(?:Plot3D|ParametricPlot3D|SphericalPlot3D|RevolutionPlot3D|ListPlot3D|ListSurfacePlot3D|ContourPlot3D|RegionPlot3D|DensityPlot3D|Histogram3D|StreamPlot3D|VectorPlot3D|SliceContourPlot3D|SliceDensityPlot3D|SliceVectorPlot3D|Image3D|Raster3D|Graphics3D|GraphicsComplex)\b/;
const IMAGE_CODE_PATTERN = /(?:^|[^A-Za-z0-9$])Image\s*\[/;

/**
 * Animation constructs (`Animate`, `ListAnimate`) are exported as an animated
 * GIF so the notebook cell actually plays instead of showing one frame.
 */
const ANIMATION_CODE_PATTERN = /\b(?:Animate|ListAnimate)\s*\[/;

/**
 * A `Table` of plots/graphics is a frame list, which Mathematica's `Export`
 * turns into a multi-frame GIF; treat it as an animation as well.
 */
const TABLE_FRAME_CODE_PATTERN = /\b(?:Table|ParallelTable)\s*\[/;
const GRAPHICS_CODE_PATTERN =
  /\b(?:Plot|Plot3D|ParametricPlot|ParametricPlot3D|PolarPlot|ContourPlot|DensityPlot|RegionPlot|ListPlot|ListLinePlot|ListPlot3D|Graphics|Graphics3D|Show|Manipulate)\s*\[/;

/** Result-head markers for animation (used to correct a wrong format guess). */
const ANIMATION_RESULT_PATTERN = /^\s*(?:Animate|ListAnimate|Animation)\s*\[/;
const GRAPHICS_RESULT_PATTERN = /(?:^|[^A-Za-z0-9$])(?:Graphics|Graphics3D|Image)\s*\[/;

function truncateValue(text, limit) {
  if (typeof text !== 'string' || text.length <= limit) return text;
  return `${text.slice(0, limit)}… [truncated: ${text.length - limit} characters omitted]`;
}

/**
 * Guess the artifact format from the evaluated code, before the result exists.
 *
 * The bridge exports the artifact inside the same evaluation, so the extension
 * (and therefore the format) must be chosen up front. Animations (`Animate`,
 * `ListAnimate`, or a `Table` of plots) use an animated GIF; 3D graphics and
 * raster images use PNG; 2D graphics / symbolic results keep vector SVG. A
 * mismatch with the final result is corrected by `_renderResultArtifact`.
 *
 * @param {string} code Wolfram Language source
 * @returns {'png'|'svg'|'gif'}
 */
export function guessArtifactFormat(code) {
  if (typeof code !== 'string') return 'svg';
  if (ANIMATION_CODE_PATTERN.test(code)) return 'gif';
  if (TABLE_FRAME_CODE_PATTERN.test(code) && GRAPHICS_CODE_PATTERN.test(code)) return 'gif';
  if (THREED_CODE_PATTERN.test(code) || IMAGE_CODE_PATTERN.test(code)) return 'png';
  return 'svg';
}

/**
 * Infer the artifact format from a non-truncated result InputForm.
 *
 * @param {string} inputform
 * @returns {'png'|'svg'|'gif'}
 */
export function inferResultArtifactFormat(inputform) {
  const text = String(inputform ?? '');
  if (text.length === 0) return 'svg';
  if (ANIMATION_RESULT_PATTERN.test(text)) return 'gif';
  // A list of graphics/plots is a frame list: Mathematica's Export writes it as
  // a multi-frame GIF, which the notebook can then play in place.
  if (/^\s*\{/.test(text) && GRAPHICS_RESULT_PATTERN.test(text) && !THREED_RESULT_PATTERN.test(text)) return 'gif';
  if (THREED_RESULT_PATTERN.test(text) || IMAGE_RESULT_PATTERN.test(text)) return 'png';
  return 'svg';
}

/* -------------------- animation → explicit frame list -------------------- */

/** Number of frames rendered for an `Animate`/`ListAnimate` cell. */
export const ANIMATION_FRAME_COUNT = 48;

/**
 * Split a Wolfram Language argument list at top-level commas.
 *
 * Tracks `[]`, `{}`, `()` and double-quoted strings so commas inside braces,
 * function calls or string literals do not split an argument.
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitTopLevelCommas(text) {
  const parts = [];
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === '[' || char === '{' || char === '(') depth += 1;
    else if (char === ']' || char === '}' || char === ')') depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

/**
 * Index of the bracket that closes the opening bracket at `openIndex`, ignoring
 * brackets inside string literals.
 *
 * @param {string} text
 * @param {number} openIndex
 * @returns {number}
 */
function matchingBracket(text, openIndex) {
  const pairs = { '[': ']', '{': '}', '(': ')' };
  const open = text[openIndex];
  const close = pairs[open];
  if (!close) return -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * Translate one `Animate[body, {var, min, max[, step]}]` or
 * `ListAnimate[frames]` expression into an explicit frame list.
 *
 * `Export` of an evaluated `Animate`/`ListAnimate` captures the Manipulate
 * player chrome (slider, step buttons, dark frame), which is not what a notebook
 * cell should animate. Building the frame list instead produces a clean looping
 * GIF: `Animate[body, iterator]` becomes `Table[body, iterator]`, and
 * `ListAnimate[frames]` returns its frame expression unchanged.
 *
 * Returns `null` when the code is not a single, simply-shaped animation call; the
 * caller then keeps whatever the normal artifact path produced.
 *
 * @param {string} code Wolfram Language source
 * @returns {string|null} an expression evaluating to a list of frames
 */
export function animationFramesCode(code) {
  if (typeof code !== 'string') return null;
  const text = code.trim().replace(/;\s*$/, '');
  if (text === '') return null;
  const match = /^(Animate|ListAnimate)\s*\[/.exec(text);
  if (!match) return null;
  const openIndex = match[0].length - 1;
  const closeIndex = matchingBracket(text, openIndex);
  if (closeIndex !== text.length - 1) return null;
  const args = splitTopLevelCommas(text.slice(openIndex + 1, closeIndex));
  if (args.length === 0 || args[0] === '') return null;

  if (match[1] === 'ListAnimate') {
    const frames = args[0];
    // Only a frame expression we can hand straight to Export; a bare symbol or a
    // function call returning an Image list stays on the normal artifact path.
    if (/^(?:\{|Table\s*\[|ParallelTable\s*\[)/.test(frames)) return frames;
    return null;
  }

  const body = args[0];
  const iterator = args[1];
  if (typeof iterator !== 'string' || !iterator.startsWith('{') || iterator.endsWith('}') !== true) return null;
  const parts = splitTopLevelCommas(iterator.slice(1, -1));
  if (parts.length < 3 || parts.length > 4) return null;
  const variable = parts[0];
  if (!/^[A-Za-z$][A-Za-z0-9$]*$/.test(variable)) return null;
  const min = parts[1];
  const max = parts[2];
  if (!min || !max) return null;
  const step = parts.length === 4 && parts[3] !== '' ? parts[3] : `((${max}) - (${min}))/${ANIMATION_FRAME_COUNT - 1}`;
  return `Table[${body}, {${variable}, ${min}, ${max}, ${step}}]`;
}

/**
 * True when the result is an atom the UI shows as text only (numbers, strings,
 * Null / $Failed / $Aborted). Truncation does NOT make a result trivial: a
 * truncated Graphics3D still deserves its rich artifact.
 */
export function isTrivialResult(payload) {
  const inputform = String(payload?.result_inputform ?? '');
  if (!inputform) return true;
  if (inputform === 'Null' || inputform === '$Failed' || inputform === '$Aborted') return true;
  // decodeResultValue covers plain strings, integers and reals; those are
  // better shown as text than as an image of the same value.
  return decodeResultValue(inputform) !== undefined;
}

/**
 * True when an evaluate result is shown as text only. Kept for
 * `normalizePayload` compatibility; artifact eligibility uses
 * `isTrivialResult` (a truncated graphics result keeps its artifact).
 */
export function isTrivialInputform(payload) {
  return isTrivialResult(payload) || payload?.truncated === true;
}

/**
 * Map a failed bridge payload onto one of the contract's evaluate error codes.
 *
 * @param {object} payload bridge payload (`{ok:false, error, message, messages}`)
 * @returns {{code: string, message: string}}
 */
export function classifyPayloadError(payload) {
  if (payload?.error === 'timeout') {
    return {
      code: ErrorCodes.KERNEL_TIMEOUT,
      message: payload.message || 'the evaluation timed out and was aborted; the kernel is still usable',
    };
  }
  if (payload?.error === 'evaluation_failed') {
    const syntax = Array.isArray(payload.messages) && payload.messages.some((name) => isSyntaxMessage(name));
    return {
      code: syntax ? ErrorCodes.SYNTAX_ERROR : ErrorCodes.EVALUATION_FAILED,
      message: payload.message || 'evaluation returned $Failed',
    };
  }
  return {
    code: ErrorCodes.EVALUATION_FAILED,
    message: payload?.message || 'evaluation failed',
  };
}

/** Map a bridge/startup error onto the contract's kernel error codes. */
export function mapKernelError(error) {
  if (error instanceof PluginError) return error;
  const bridgeCode = typeof error?.code === 'string' ? error.code : '';
  const message = error instanceof Error ? error.message : String(error);
  if (bridgeCode === 'kernel_timeout' || bridgeCode === 'kernel_stalled') {
    return new PluginError(ErrorCodes.KERNEL_TIMEOUT, message, { kernelCode: bridgeCode });
  }
  if (bridgeCode === 'invalid_code') {
    return new PluginError(ErrorCodes.INVALID_PAYLOAD, message, { kernelCode: bridgeCode });
  }
  return new PluginError(ErrorCodes.KERNEL_UNAVAILABLE, message, { kernelCode: bridgeCode || 'unknown' });
}

/**
 * Normalize one bridge payload into the contract's evaluate result entry data.
 *
 * @param {object} payload
 * @param {number} durationMs
 * @returns {{ok: boolean, text: string, messages: string[], durationMs: number,
 *            resultInputform: string, truncated: boolean, renderable: boolean,
 *            error: ({code: string, message: string}|null)}}
 */
export function normalizePayload(payload, durationMs) {
  const messages = Array.isArray(payload?.messages) ? payload.messages.map(String) : [];
  const resultInputform = String(payload?.result_inputform ?? '');
  const ok = payload?.ok !== false;
  const decoded = ok ? decodeResultValue(resultInputform) : undefined;
  const output = typeof payload?.output === 'string' ? payload.output : '';

  let text = '';
  if (ok) {
    const display =
      decoded !== undefined
        ? String(decoded)
        : resultInputform === 'Null' || resultInputform === '$Failed' || resultInputform === '$Aborted'
          ? ''
          : truncateValue(resultInputform, MAX_ENTRY_TEXT);
    text = [output, display].filter((part) => part.length > 0).join('\n');
  } else {
    text = output;
  }

  const error = ok ? null : classifyPayloadError(payload);
  const renderable = ok && !isTrivialInputform(payload);
  return {
    ok,
    text,
    messages,
    durationMs,
    resultInputform,
    truncated: payload?.truncated === true,
    renderable,
    error,
  };
}

/**
 * Read a rendered SVG artifact, enforcing the 2 MiB attachment cap.
 *
 * @param {string} path
 * @param {number} [maxBytes]
 * @returns {Uint8Array|null}
 */
export function readSvgArtifact(path, maxBytes = SVG_MAX_BYTES) {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes) return null;
    const buffer = readFileSync(path);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  }
}

/** A persistent, lazily started Wolfram kernel with notebook-facing helpers. */
export class KernelManager {
  /**
   * @param {object} [options]
   * @param {(message: string) => void} [options.logger]
   * @param {object} [options.env]
   * @param {(options: object) => Promise<{ok: boolean, path?: string, error?: string}>} [options.resolveKernelFn]
   * @param {(path: string, options: object) => object} [options.createBridgeFn]
   * @param {string} [options.tempDir] directory for temporary .svg/.png/.gif artifacts
   * @param {number} [options.svgMaxBytes]
   * @param {number} [options.gifMaxBytes]
   * @param {number} [options.probeTimeoutMs]
   */
  constructor({
    logger = null,
    env = process.env,
    resolveKernelFn = defaultResolveKernel,
    createBridgeFn = null,
    tempDir = null,
    svgMaxBytes = SVG_MAX_BYTES,
    gifMaxBytes = GIF_MAX_BYTES,
    probeTimeoutMs = 20000,
  } = {}) {
    this.env = env;
    this.logger = typeof logger === 'function' ? logger : null;
    this._resolveKernel = resolveKernelFn;
    this._createBridge = createBridgeFn ?? ((kernelPath) => new KernelBridge({ kernelPath, logger: this.logger, env: this.env }));
    this.tempDir = tempDir ?? tmpdir();
    this.svgMaxBytes = svgMaxBytes;
    this.gifMaxBytes = gifMaxBytes;
    this.probeTimeoutMs = probeTimeoutMs;
    this._bridge = null;
    this._kernelPath = null;
    this._version = null;
    this._state = 'stopped';
    this._starting = null;
    this._lastError = null;
  }

  _log(message) {
    if (this.logger) this.logger(message);
  }

  /** Current contract kernel state snapshot (never spawns a process). */
  status() {
    const bridgeStatus = this._bridge ? this._bridge.status() : null;
    let state = this._state;
    if (this._bridge?.ready) state = bridgeStatus?.pending_call ? 'busy' : 'running';
    return {
      state: state === 'starting' || state === 'unavailable' || state === 'busy' || state === 'running' || state === 'stopped' ? state : 'stopped',
      path: this._kernelPath,
      version: this._version,
    };
  }

  /** True when the current kernel is known to be running. */
  get running() {
    return Boolean(this._bridge?.ready);
  }

  /** Full bridge diagnostics (used by the `debug` action only). */
  diagnostics() {
    return {
      ...this.status(),
      bridge: this._bridge ? this._bridge.status() : null,
      lastError: this._lastError,
    };
  }

  /**
   * Resolve + start the kernel if needed. Concurrent callers share one start.
   *
   * @returns {Promise<string>} resolved kernel path
   * @throws {PluginError} `kernel_unavailable`
   */
  async ensure() {
    if (this._bridge?.ready) {
      this._state = 'running';
      return this._kernelPath;
    }
    if (!this._starting) {
      this._starting = this._start().finally(() => {
        this._starting = null;
      });
    }
    return this._starting;
  }

  async _start() {
    this._state = 'starting';
    if (!this._kernelPath) {
      const resolved = await this._resolveKernel({ env: this.env, timeoutMs: this.probeTimeoutMs, limit: 5 });
      if (!resolved?.ok || typeof resolved.path !== 'string') {
        this._state = 'unavailable';
        const message =
          resolved?.error ||
          'No working Wolfram Language kernel was found. Install Mathematica / Wolfram Engine or set MATHEMATICA_EXE.';
        this._lastError = message;
        throw new PluginError(ErrorCodes.KERNEL_UNAVAILABLE, message);
      }
      this._kernelPath = resolved.path;
    }
    try {
      if (!this._bridge) this._bridge = this._createBridge(this._kernelPath);
      await this._bridge.ensureReady();
      this._state = 'running';
      this._lastError = null;
      this._log(`kernel ready: ${this._kernelPath}`);
      await this._loadVersion();
      return this._kernelPath;
    } catch (error) {
      this._state = 'unavailable';
      const mapped = mapKernelError(error);
      this._lastError = mapped.message;
      throw mapped;
    }
  }

  async _loadVersion() {
    try {
      const { payload } = await this._bridge.evaluate('$Version', { timeoutSeconds: 15, label: 'version' });
      const decoded = decodeResultValue(String(payload?.result_inputform ?? ''));
      if (typeof decoded === 'string') this._version = decoded;
    } catch {
      /* version is cosmetic */
    }
  }

  /**
   * Evaluate one cell of Wolfram Language code.
   *
   * The artifact format is chosen up front from the code (GIF for animations,
   * PNG for 3D/raster constructs, SVG otherwise); the bridge exports the
   * artifact inside the same evaluation. The artifact is read for successful,
   * non-trivial results within the format's cap (2 MiB SVG/PNG, 8 MiB GIF).
   * When the final InputForm contradicts the up-front guess (for example a
   * variable holding a `Graphics3D`), the manager re-renders once in the correct
   * format. Export failures never fail the evaluation: `svgBytes` stays `null`
   * and the caller keeps the text fallback.
   *
   * @param {string} code
   * @param {{timeoutSeconds?: number, label?: string}} [options]
   * @returns {Promise<{ok: boolean, text: string, messages: string[], durationMs: number,
   *   resultInputform: string, truncated: boolean, renderable: boolean,
   *   artifactFormat: ('png'|'svg'|'gif'|null), error: (object|null), svgBytes: (Uint8Array|null)}>}
   */
  async evaluate(code, { timeoutSeconds = DEFAULT_TIMEOUT_SECONDS, label = 'evaluate' } = {}) {
    await this.ensure();
    const format = guessArtifactFormat(code);
    // A simple `Animate`/`ListAnimate` cell is rendered from an explicit frame
    // list below. Its bridge-side artifact export is skipped: rasterizing the
    // Manipulate object is slow and captures the player chrome (slider, buttons).
    const framesCode = format === 'gif' ? animationFramesCode(code) : null;
    const bridgeArtifactPath =
      framesCode === null ? join(this.tempDir, `dsh-notebook-${randomBytes(8).toString('hex')}.${format}`) : null;
    this._state = 'busy';
    const started = Date.now();
    try {
      const { payload } = await this._bridge.evaluate(code, {
        timeoutSeconds,
        label,
        ...(bridgeArtifactPath === null ? {} : { artifactPath: bridgeArtifactPath }),
      });
      const normalized = normalizePayload(payload, Math.max(0, Number(payload?.duration_ms) || Date.now() - started));
      let artifactBytes = null;
      let artifactFormat = null;
      const maxBytes = format === 'gif' ? this.gifMaxBytes : this.svgMaxBytes;
      if (normalized.ok && !isTrivialResult(payload)) {
        if (bridgeArtifactPath !== null && typeof payload?.artifactPath === 'string' && payload.artifactPath === bridgeArtifactPath) {
          artifactBytes = readSvgArtifact(bridgeArtifactPath, maxBytes);
          artifactFormat = artifactBytes ? format : null;
        }
        // Correct a wrong up-front guess when the result is unambiguous. Only
        // possible for non-truncated InputForm (truncated results keep the
        // artifact produced by the guessed format). An animation keeps its GIF:
        // its result InputForm is a `Manipulate[...]`, and replacing the
        // animation with a static SVG/PNG first frame would lose the feature.
        if (artifactBytes && payload.truncated !== true && format !== 'gif') {
          const wanted = inferResultArtifactFormat(String(payload.result_inputform ?? ''));
          if (wanted !== format) {
            const rendered = await this._renderResultArtifact(String(payload.result_inputform ?? ''), wanted);
            if (rendered) {
              artifactBytes = rendered;
              artifactFormat = wanted;
            }
          }
        }
        // Clean looping GIF from an explicit frame list (no player chrome). The
        // frame list is rebuilt from the cell source, so a truncated result
        // InputForm does not matter here.
        if (framesCode !== null) {
          const clean = await this._renderCleanAnimation(framesCode);
          if (clean && clean.byteLength > 0) {
            artifactBytes = clean;
            artifactFormat = 'gif';
          }
        }
        // A non-animation GIF guess (a Table that turned out not to be a frame
        // list) degrades to a still frame rather than losing the output.
        if (!artifactBytes && format === 'gif' && framesCode === null && payload.truncated !== true) {
          const still = await this._renderResultArtifact(String(payload.result_inputform ?? ''), 'png');
          if (still) {
            artifactBytes = still;
            artifactFormat = 'png';
          }
        }
      }
      return {
        ...normalized,
        renderable: artifactBytes !== null,
        artifactFormat,
        svgBytes: artifactBytes,
      };
    } catch (error) {
      this._lastError = error instanceof Error ? error.message : String(error);
      throw mapKernelError(error);
    } finally {
      this._state = this._bridge?.ready ? 'running' : 'stopped';
      // The bridge already removes failed artifacts; make sure nothing lingers.
      try {
        if (existsSync(artifactPath)) unlinkSync(artifactPath);
      } catch {
        /* best effort */
      }
    }
  }

  /**
   * Re-render an already-evaluated result as a PNG/SVG/GIF artifact (fallback
   * for a wrong up-front format guess). The result expression is re-evaluated
   * from its InputForm — exhibition-only expressions are safe; this path is only
   * used for non-truncated results whose final form differs from the heuristic.
   *
   * @param {string} resultInputform
   * @param {'png'|'svg'|'gif'} format
   * @returns {Promise<Uint8Array|null>}
   */
  async _renderResultArtifact(resultInputform, format) {
    if (typeof resultInputform !== 'string' || resultInputform.length === 0 || resultInputform.length > MAX_RENDER_INPUTFORM) return null;
    if (!this._bridge?.ready) return null;
    const extension = format === 'png' ? '.png' : format === 'gif' ? '.gif' : '.svg';
    const artifactPath = join(this.tempDir, `dsh-notebook-render-${randomBytes(8).toString('hex')}${extension}`);
    const exportFormat = format === 'png' ? 'PNG' : format === 'gif' ? 'GIF' : 'SVG';
    const maxBytes = format === 'gif' ? this.gifMaxBytes : this.svgMaxBytes;
    const program = [
      `Module[{mathematica$nb$value = ToExpression[${wlStringLiteral(resultInputform)}, InputForm]},`,
      `  Quiet[Check[Export[${wlStringLiteral(artifactPath)}, mathematica$nb$value, "${exportFormat}"]; True, False]]]`,
    ].join('\n');
    try {
      const { payload } = await this._bridge.evaluate(program, { timeoutSeconds: 30, label: 'render-artifact' });
      if (String(payload?.result_inputform ?? '').trim() !== 'True') return null;
      return readSvgArtifact(artifactPath, maxBytes);
    } catch {
      return null;
    } finally {
      try {
        if (existsSync(artifactPath)) unlinkSync(artifactPath);
      } catch {
        /* best effort */
      }
    }
  }

  /**
   * Render a frame-list expression as a clean looping GIF.
   *
   * @param {string} framesCode an expression evaluating to a list of frames
   *   (already translated by `animationFramesCode`)
   * @returns {Promise<Uint8Array|null>}
   */
  async _renderCleanAnimation(framesCode) {
    if (typeof framesCode !== 'string' || framesCode === '') return null;
    if (!this._bridge?.ready) return null;
    const artifactPath = join(this.tempDir, `dsh-notebook-anim-${randomBytes(8).toString('hex')}.gif`);
    const program = [
      `Module[{mathematica$nb$frames = ToExpression[${wlStringLiteral(framesCode)}, InputForm]},`,
      `  Quiet[Check[Export[${wlStringLiteral(artifactPath)}, mathematica$nb$frames, "GIF", "AnimationRepetitions" -> Infinity]; True, False]]]`,
    ].join('\n');
    try {
      const { payload } = await this._bridge.evaluate(program, { timeoutSeconds: 60, label: 'render-animation' });
      if (String(payload?.result_inputform ?? '').trim() !== 'True') return null;
      return readSvgArtifact(artifactPath, this.gifMaxBytes);
    } catch {
      return null;
    } finally {
      try {
        if (existsSync(artifactPath)) unlinkSync(artifactPath);
      } catch {
        /* best effort */
      }
    }
  }

  /**
   * Restart the kernel, dropping all in-memory Wolfram state.
   *
   * @returns {Promise<{state: string, path: string|null, version: string|null}>}
   */
  async restart() {
    if (!this._bridge) await this.ensure();
    this._state = 'starting';
    try {
      await this._bridge.restart();
      this._state = 'running';
      this._lastError = null;
      await this._loadVersion();
    } catch (error) {
      this._state = 'unavailable';
      const mapped = mapKernelError(error);
      this._lastError = mapped.message;
      throw mapped;
    }
    return this.status();
  }

  /** Stop the kernel and release its process (idempotent). */
  async dispose() {
    const bridge = this._bridge;
    this._bridge = null;
    this._state = 'stopped';
    if (!bridge) return;
    try {
      await bridge.shutdown();
    } catch (error) {
      this._log(`kernel shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export { ARTIFACT_EXPORT_SECONDS };
