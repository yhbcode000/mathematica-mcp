/**
 * Robust bridge between Node.js and a persistent Wolfram Language kernel
 * (`math.exe -noprompt` / `WolframKernel`) speaking over stdin/stdout pipes.
 *
 * Design notes
 * ------------
 * - The kernel is single threaded, so every evaluation is serialized through an
 *   internal promise queue.
 * - Every call is wrapped in one WL `Block[...]` expression that captures
 *   `$MessageList`, evaluates the user program with `ToExpression` (so syntax
 *   errors become ordinary `$Failed` results instead of wedging the parser),
 *   and then emits length-prefixed marker frames via `WriteString[$Output, ...]`
 *   (raw text; `Print` would be InputForm-quoted in batch mode).
 * - A hard watchdog kills and respawns the kernel if it stops responding, so the
 *   MCP server can never be blocked forever by a runaway evaluation.
 * - All diagnostics go through the `logger` callback (the server writes them to
 *   stderr); stdout is reserved for the MCP protocol.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const DEFAULT_TIMEOUT_SECONDS = 60;
export const MIN_TIMEOUT_SECONDS = 0.1;
export const MAX_TIMEOUT_SECONDS = 3600;
export const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
export const DEFAULT_CALL_GRACE_MS = 20_000;
const BEGIN_WATCHDOG_MS = 30_000;
const MAX_BUFFER_CHARS = 16 * 1024 * 1024;
const MAX_RESULT_CHARS = 100_000;
const MAX_OUTPUT_CHARS = 64_000;
const MAX_STDERR_CHARS = 8_000;

/** Error type used for all kernel/bridge level failures. */
export class KernelError extends Error {
  constructor(message, { code = 'kernel_error', details = null, cause = undefined } = {}) {
    super(message);
    this.name = 'KernelError';
    this.code = code;
    this.details = details;
    if (cause !== undefined) this.cause = cause;
  }
}

export function normalizeTimeoutSeconds(value, fallback = DEFAULT_TIMEOUT_SECONDS) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(MAX_TIMEOUT_SECONDS, Math.max(MIN_TIMEOUT_SECONDS, number));
}

/**
 * Encode arbitrary JavaScript text as a Wolfram Language string literal.
 *
 * Quotes, backslashes and line terminators are escaped; other control
 * characters become `\:XXXX`; printable Unicode is kept literal (the kernel is
 * started with `$CharacterEncoding = "UTF-8"` before any user code is sent).
 */
export function wlStringLiteral(value) {
  let out = '"';
  for (const character of String(value)) {
    const codePoint = character.codePointAt(0);
    if (character === '\\') out += '\\\\';
    else if (character === '"') out += '\\"';
    else if (character === '\n') out += '\\n';
    else if (character === '\t') out += '\\t';
    else if (character === '\r') out += '\\r';
    else if (codePoint < 0x20 || codePoint === 0x7f) out += `\\:${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
    else out += character;
  }
  return `${out}"`;
}

/**
 * Build the single WL expression evaluated for one call.
 *
 * The user program is embedded as a string and evaluated with
 * `ToExpression[code, InputForm]`, which parses it exactly like a .m file
 * (newline separated statements are evaluated in order, incomplete expressions
 * continue on the next line) and reports syntax errors as messages + `$Failed`
 * instead of blocking on an unterminated top level expression.
 * `Last[{...}]` normalises a top-level `Sequence` result and guarantees that the
 * frame writer always receives a single expression to stringify.
 */
export function buildWrapper(id, code, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
  const timeout = normalizeTimeoutSeconds(timeoutSeconds);
  const literal = wlStringLiteral(code);
  const resultPrefix = `\\n@@MM:RESULT:${id}@@`;
  const messagesPrefix = `@@MM:MSGS:${id}@@`;
  return [
    `Block[{$MessageList = {}, mathematica$mcp$res, mathematica$mcp$msgs, mathematica$mcp$out = $Output, mathematica$mcp$code = ${literal}, mathematica$mcp$str},`,
    `WriteString[mathematica$mcp$out, "@@MM:BEGIN:${id}@@\\n"];`,
    `mathematica$mcp$res = TimeConstrained[Last[{ToExpression[mathematica$mcp$code, InputForm]}], ${formatWlNumber(timeout)}, $Aborted];`,
    `mathematica$mcp$msgs = $MessageList;`,
    `mathematica$mcp$str = ToString[mathematica$mcp$res, InputForm];`,
    `WriteString[mathematica$mcp$out, "${resultPrefix}" <> ToString[StringLength[mathematica$mcp$str]] <> ":" <> mathematica$mcp$str <> "\\n"];`,
    `mathematica$mcp$str = ToString[mathematica$mcp$msgs, InputForm];`,
    `WriteString[mathematica$mcp$out, "${messagesPrefix}" <> ToString[StringLength[mathematica$mcp$str]] <> ":" <> mathematica$mcp$str <> "\\n"];`,
    `WriteString[mathematica$mcp$out, "@@MM:END:${id}@@\\n"]`,
    ']',
  ].join('\n');
}

function formatWlNumber(value) {
  // Wolfram Language reals use `*^` for scientific notation; all values we pass
  // are inside [0.1, 3600] so plain decimal formatting is always valid WL.
  const text = String(value);
  if (/e/i.test(text)) return value.toFixed(6);
  return text;
}

function takeCodePoints(buffer, position, count) {
  let index = position;
  let taken = 0;
  while (index < buffer.length && taken < count) {
    const codePoint = buffer.codePointAt(index);
    index += codePoint > 0xffff ? 2 : 1;
    taken += 1;
  }
  if (taken < count) {
    throw new KernelError(`Protocol error: incomplete length-prefixed value (wanted ${count} characters, got ${taken}).`, {
      code: 'protocol_error',
    });
  }
  return { text: buffer.slice(position, index), endIndex: index };
}

/**
 * Parse one complete marker frame from the kernel output buffer.
 * Returns `null` while the frame is still incomplete.
 */
export function parseFrame(buffer, id) {
  const beginToken = `@@MM:BEGIN:${id}@@`;
  const resultToken = `@@MM:RESULT:${id}@@`;
  const messagesToken = `@@MM:MSGS:${id}@@`;
  const endToken = `@@MM:END:${id}@@`;

  const endIndex = buffer.indexOf(endToken);
  if (endIndex === -1) return null;

  const resultIndex = buffer.indexOf(resultToken);
  if (resultIndex === -1 || resultIndex > endIndex) {
    throw new KernelError('Protocol error: the kernel response is missing its result frame.', { code: 'protocol_error' });
  }

  let outputRaw = buffer.slice(0, resultIndex);
  const beginIndex = outputRaw.lastIndexOf(beginToken);
  if (beginIndex !== -1) outputRaw = outputRaw.slice(beginIndex + beginToken.length);
  outputRaw = outputRaw.replace(/^\s+/, '').replace(/\s+$/, '');

  let position = resultIndex + resultToken.length;
  const resultLength = /^(\d+):/.exec(buffer.slice(position, position + 32));
  if (!resultLength) {
    throw new KernelError('Protocol error: malformed result length prefix.', { code: 'protocol_error' });
  }
  position += resultLength[0].length;
  const result = takeCodePoints(buffer, position, Number(resultLength[1]));
  position = result.endIndex;
  if (buffer.startsWith('\r\n', position)) position += 2;
  else if (buffer[position] === '\n') position += 1;

  if (!buffer.startsWith(messagesToken, position)) {
    throw new KernelError('Protocol error: the kernel response is missing its messages frame.', { code: 'protocol_error' });
  }
  position += messagesToken.length;
  const messagesLength = /^(\d+):/.exec(buffer.slice(position, position + 32));
  if (!messagesLength) {
    throw new KernelError('Protocol error: malformed messages length prefix.', { code: 'protocol_error' });
  }
  position += messagesLength[0].length;
  const messages = takeCodePoints(buffer, position, Number(messagesLength[1]));
  position = messages.endIndex;

  let consumed = endIndex + endToken.length;
  if (buffer[consumed] === '\r') consumed += 1;
  if (buffer[consumed] === '\n') consumed += 1;

  return {
    outputRaw,
    resultInputform: result.text,
    messagesInputform: messages.text,
    consumed,
  };
}

/** True when `inner` forms exactly one complete Wolfram string body. */
function isCompleteQuotedBody(inner) {
  let escaped = false;
  for (const character of inner) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') return false;
  }
  return !escaped;
}

/** Decode the body of a Wolfram Language string literal (without outer quotes). */
export function decodeWlString(inner) {
  let out = '';
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if (character !== '\\') {
      out += character;
      continue;
    }
    const next = inner[index + 1];
    if (next === undefined) {
      out += '\\';
      break;
    }
    switch (next) {
      case 'n':
        out += '\n';
        index += 1;
        break;
      case 't':
        out += '\t';
        index += 1;
        break;
      case 'r':
        out += '\r';
        index += 1;
        break;
      case 'b':
        out += '\b';
        index += 1;
        break;
      case 'f':
        out += '\f';
        index += 1;
        break;
      case '"':
        out += '"';
        index += 1;
        break;
      case '\\':
        out += '\\';
        index += 1;
        break;
      case ':': {
        const hex = inner.slice(index + 2, index + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          index += 5;
        } else {
          out += '\\:';
          index += 1;
        }
        break;
      }
      case '|': {
        const hex = inner.slice(index + 2, index + 8);
        if (/^[0-9a-fA-F]{6}$/.test(hex)) {
          out += String.fromCodePoint(parseInt(hex, 16));
          index += 7;
        } else {
          out += '\\|';
          index += 1;
        }
        break;
      }
      default:
        // Keep unknown escapes (`\[Alpha]`, `\.XX`, ...) verbatim.
        out += `\\${next}`;
        index += 1;
        break;
    }
  }
  return out;
}

/**
 * Decode a plain Wolfram InputForm string/number result. Returns `undefined`
 * when the value is not a plain string or number (the raw InputForm is always
 * available in `result_inputform`).
 */
export function decodeResultValue(inputform) {
  if (typeof inputform !== 'string' || inputform.length === 0) return undefined;
  if (inputform.length >= 2 && inputform.startsWith('"') && inputform.endsWith('"')) {
    const inner = inputform.slice(1, -1);
    if (isCompleteQuotedBody(inner)) return decodeWlString(inner);
    return undefined;
  }
  if (/^-?\d+$/.test(inputform)) {
    const integer = Number(inputform);
    if (Number.isSafeInteger(integer)) return integer;
    return inputform; // huge integers are kept exact as a string
  }
  if (/^-?(?:\d+\.\d*|\.\d+|\d+\.)(?:[eE][+-]?\d+)?$/.test(inputform)) {
    const real = Number(inputform);
    return Number.isFinite(real) ? real : undefined;
  }
  if (/^-?(?:\d+\.\d*|\.\d+)(?:\*\^\d+)?$/.test(inputform)) return undefined;
  return undefined;
}

/** Extract `Context::tag` message names from a `$MessageList` InputForm string. */
export function extractMessageNames(messagesInputform) {
  const names = [];
  if (!messagesInputform) return names;
  const pattern = /\b([A-Za-z$][A-Za-z0-9$]*)::([A-Za-z0-9$]+)\b/g;
  let match;
  while ((match = pattern.exec(String(messagesInputform))) !== null) {
    const name = `${match[1]}::${match[2]}`;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** True for message names that indicate the program could not be parsed. */
export function isSyntaxMessage(name) {
  return typeof name === 'string' && (/::sntx/.test(name) || name.startsWith('Syntax::') || name.startsWith('ToExpression::sntx'));
}

/**
 * Batch-mode `Print` renders string arguments in InputForm, so user printed
 * output looks like `"hello"`. Decode standalone quoted lines for readability.
 */
export function decodeBatchOutput(text) {
  if (!text) return '';
  return String(text)
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
        const inner = trimmed.slice(1, -1);
        if (isCompleteQuotedBody(inner)) return decodeWlString(inner);
      }
      return line;
    })
    .join('\n');
}

export function truncateText(text, limit) {
  if (typeof text !== 'string' || text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [truncated: ${text.length - limit} of ${text.length} characters omitted]`;
}

/** A persistent, lazily started Wolfram kernel process. */
export class KernelBridge {
  constructor({
    kernelPath,
    startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
    callGraceMs = DEFAULT_CALL_GRACE_MS,
    logger = null,
    env = process.env,
  } = {}) {
    if (!kernelPath || typeof kernelPath !== 'string') {
      throw new KernelError('kernelPath is required', { code: 'invalid_argument' });
    }
    this.kernelPath = kernelPath;
    this.startupTimeoutMs = startupTimeoutMs;
    this.callGraceMs = callGraceMs;
    this.env = env;
    this._logger = typeof logger === 'function' ? logger : null;
    this._child = null;
    this._ready = false;
    this._buffer = '';
    this._stderr = '';
    this._pending = null;
    this._startPromise = null;
    this._queue = Promise.resolve();
    this._startedAt = null;
    this._calls = 0;
    this._lastError = null;
    this._lastExit = null;
  }

  _log(message) {
    if (this._logger) this._logger(message);
  }

  /** Snapshot of kernel state, safe to call at any time (never spawns). */
  status() {
    return {
      kernel_path: this.kernelPath,
      running: Boolean(this._ready && this._child && !this._child.killed),
      ready: this._ready,
      pid: this._child && this._child.pid ? this._child.pid : null,
      uptime_seconds: this._startedAt ? Math.round((Date.now() - this._startedAt) / 1000) : null,
      calls: this._calls,
      pending_call: this._pending ? { label: this._pending.label, started_at_ms: this._pending.startedAt } : null,
      last_error: this._lastError,
    };
  }

  get ready() {
    return Boolean(this._ready && this._child && !this._child.killed);
  }

  /** Lazily spawn the kernel and warm it up. Concurrent callers share one start. */
  async ensureReady() {
    if (this.ready) return;
    if (!this._startPromise) {
      this._startPromise = this._start().finally(() => {
        this._startPromise = null;
      });
    }
    await this._startPromise;
  }

  async _start() {
    await this._stopChild('starting');
    this._buffer = '';
    this._stderr = '';
    this._spawnError = null;
    const child = spawn(this.kernelPath, ['-noprompt'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: this.env,
    });
    this._child = child;
    this._ready = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._onStdout(String(chunk)));
    child.stderr.on('data', (chunk) => this._onStderr(String(chunk)));
    child.on('error', (error) => this._onChildError(error));
    child.on('exit', (code, signal) => this._onChildExit(child, code, signal));
    this._log(`spawning kernel: ${this.kernelPath}`);

    try {
      await this._write('$CharacterEncoding = "UTF-8";\n');
      const warmupId = `warm${randomBytes(6).toString('hex')}`;
      const frame = await this._call(
        'warmup',
        buildWrapper(warmupId, '2+2', DEFAULT_TIMEOUT_SECONDS),
        warmupId,
        DEFAULT_TIMEOUT_SECONDS,
        { hardTimeoutMs: this.startupTimeoutMs },
      );
      if (frame.resultInputform !== '4') {
        throw new KernelError(`warm-up evaluation returned an unexpected result: ${truncateText(frame.resultInputform, 200)}`, {
          code: 'kernel_start_failed',
        });
      }
      this._ready = true;
      this._startedAt = Date.now();
      this._lastExit = null;
      this._log(`kernel ready (pid ${child.pid})`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const stderrTail = this._stderrTail();
      await this._stopChild('start failure');
      const detail = stderrTail ? `${reason} Kernel stderr: ${stderrTail}` : reason;
      this._lastError = detail;
      throw new KernelError(
        `Failed to start the Mathematica kernel "${this.kernelPath}": ${detail}\n` +
          'Check that the path is correct, that your Mathematica / Wolfram Engine license is activated (try running the kernel manually with -noprompt), ' +
          'and that the installation is complete. Set MATHEMATICA_EXE or pass --kernel to use a different executable.',
        { code: 'kernel_start_failed', cause: error instanceof Error ? error : undefined },
      );
    }
  }

  _stderrTail() {
    const text = this._stderr.trim();
    return text.length > MAX_STDERR_CHARS ? text.slice(-MAX_STDERR_CHARS) : text;
  }

  _write(text) {
    const child = this._child;
    if (!child || !child.stdin || child.stdin.destroyed || !child.stdin.writable) {
      return Promise.reject(new KernelError('The Mathematica kernel process is not available.', { code: 'kernel_unavailable' }));
    }
    return new Promise((resolve, reject) => {
      try {
        child.stdin.write(text, 'utf8', (error) => (error ? reject(error) : resolve()));
      } catch (error) {
        reject(error);
      }
    });
  }

  _onStdout(chunk) {
    this._buffer += chunk;
    if (this._buffer.length > MAX_BUFFER_CHARS) {
      this._failPending(
        new KernelError('The Mathematica kernel produced an unexpectedly large amount of output; the kernel was restarted.', {
          code: 'protocol_overflow',
        }),
        { kill: true, reason: 'output overflow' },
      );
      return;
    }
    const pending = this._pending;
    if (!pending) return;
    if (!pending.beginSeen && this._buffer.includes(pending.beginToken)) {
      pending.beginSeen = true;
      clearTimeout(pending.beginTimer);
    }
    if (!this._buffer.includes(pending.endToken)) return;
    try {
      const frame = parseFrame(this._buffer, pending.id);
      if (!frame) return;
      this._buffer = this._buffer.slice(frame.consumed);
      this._finishPending(pending, frame);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._failPending(
        new KernelError(`Lost sync with the Mathematica kernel output stream (${message}); the kernel was restarted. Kernel state was lost.`, {
          code: 'protocol_error',
          cause: error instanceof Error ? error : undefined,
        }),
        { kill: true, reason: 'protocol error' },
      );
    }
  }

  _onStderr(chunk) {
    this._stderr += chunk;
    if (this._stderr.length > MAX_STDERR_CHARS * 2) this._stderr = this._stderr.slice(-MAX_STDERR_CHARS);
    const text = chunk.trim();
    if (text) this._log(`kernel stderr: ${text.length > 2000 ? text.slice(0, 2000) : text}`);
  }

  _onChildError(error) {
    this._spawnError = error;
    this._lastError = `kernel process error: ${error.message}`;
    this._log(`kernel process error: ${error.message}`);
    if (this._pending) {
      this._failPending(
        new KernelError(`Failed to communicate with the Mathematica kernel: ${error.message}`, {
          code: 'kernel_unavailable',
          cause: error,
        }),
        { kill: false, reason: 'spawn error' },
      );
    }
  }

  _onChildExit(child, code, signal) {
    if (child !== this._child) return;
    this._child = null;
    this._ready = false;
    this._lastExit = { code, signal, at: Date.now() };
    this._log(`kernel exited (code=${code}, signal=${signal})`);
    if (this._pending) {
      const stderrTail = this._stderrTail();
      this._failPending(
        new KernelError(
          `The Mathematica kernel exited unexpectedly (code ${code}${signal ? `, signal ${signal}` : ''})` +
            (stderrTail ? `. Kernel stderr: ${stderrTail}` : '') +
            '. The kernel will be restarted automatically on the next call; any in-memory state from this session was lost.',
          { code: 'kernel_exited' },
        ),
        { kill: false, reason: 'kernel exited' },
      );
    }
  }

  _finishPending(pending, frame) {
    if (this._pending !== pending) return;
    this._pending = null;
    clearTimeout(pending.beginTimer);
    clearTimeout(pending.hardTimer);
    pending.resolve(frame);
  }

  _failPending(error, { kill = false, reason = 'failure' } = {}) {
    const pending = this._pending;
    if (!pending) return;
    this._pending = null;
    clearTimeout(pending.beginTimer);
    clearTimeout(pending.hardTimer);
    this._lastError = error.message;
    if (kill) {
      this._ready = false;
      void this._stopChild(reason);
    }
    pending.reject(error);
  }

  _call(label, wrapperText, id, timeoutSeconds, { hardTimeoutMs = null } = {}) {
    if (this._pending) {
      return Promise.reject(new KernelError('Internal error: a kernel call was started while another call is pending.', { code: 'internal' }));
    }
    return new Promise((resolve, reject) => {
      const pending = {
        id,
        label,
        resolve,
        reject,
        beginToken: `@@MM:BEGIN:${id}@@`,
        endToken: `@@MM:END:${id}@@`,
        beginSeen: false,
        startedAt: Date.now(),
        beginTimer: null,
        hardTimer: null,
      };
      this._pending = pending;
      pending.beginTimer = setTimeout(() => {
        this._failPending(
          new KernelError(
            `The Mathematica kernel did not begin evaluating within ${Math.round(BEGIN_WATCHDOG_MS / 1000)} seconds and was restarted. ` +
              'Kernel state was lost; retry the evaluation.',
            { code: 'kernel_stalled' },
          ),
          { kill: true, reason: 'begin watchdog' },
        );
      }, BEGIN_WATCHDOG_MS);
      if (pending.beginTimer.unref) pending.beginTimer.unref();
      pending.hardTimer = setTimeout(() => {
        this._failPending(
          new KernelError(
            `The Mathematica kernel did not respond within ${timeoutSeconds} seconds (plus a ${Math.round(this.callGraceMs / 1000)} second grace period) ` +
              'and was restarted. This usually means the evaluation could not be aborted; kernel state (variables) was lost and the call should be retried.',
            { code: 'kernel_timeout' },
          ),
          { kill: true, reason: 'hard timeout' },
        );
      }, hardTimeoutMs === null ? timeoutSeconds * 1000 + this.callGraceMs : hardTimeoutMs);
      if (pending.hardTimer.unref) pending.hardTimer.unref();
      this._write(`${wrapperText}\n`).catch((error) => {
        this._failPending(
          new KernelError(`Failed to send the evaluation to the Mathematica kernel: ${error.message}`, {
            code: 'kernel_write_failed',
            cause: error,
          }),
          { kill: false, reason: 'write failure' },
        );
      });
    });
  }

  _enqueue(task) {
    const run = this._queue.then(task, task);
    this._queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Evaluate Wolfram Language code and return a structured payload.
   *
   * @returns {Promise<{isError: boolean, payload: object}>}
   */
  evaluate(code, { timeoutSeconds = DEFAULT_TIMEOUT_SECONDS, label = 'evaluate' } = {}) {
    if (typeof code !== 'string') {
      return Promise.reject(new KernelError('"code" must be a string of Wolfram Language code.', { code: 'invalid_code' }));
    }
    return this._enqueue(async () => {
      await this.ensureReady();
      const timeout = normalizeTimeoutSeconds(timeoutSeconds);
      const id = `c${randomBytes(8).toString('hex')}`;
      const started = Date.now();
      const frame = await this._call(label, buildWrapper(id, code, timeout), id, timeout);
      this._calls += 1;
      return this._buildResultPayload(frame, { timeoutSeconds: timeout, durationMs: Date.now() - started });
    });
  }

  _buildResultPayload(frame, { timeoutSeconds, durationMs }) {
    const outputRaw = truncateText(frame.outputRaw || '', MAX_OUTPUT_CHARS);
    const output = decodeBatchOutput(outputRaw);
    const messagesInputformRaw = frame.messagesInputform || '';
    const messages = extractMessageNames(messagesInputformRaw);
    const resultInputformRaw = frame.resultInputform || '';
    const resultInputform = truncateText(resultInputformRaw, MAX_RESULT_CHARS);
    const decoded = decodeResultValue(resultInputformRaw);
    const truncated = resultInputform !== resultInputformRaw || output !== (frame.outputRaw || '').slice(0, MAX_OUTPUT_CHARS);

    const payload = {
      ok: true,
      ...(decoded !== undefined ? { result: decoded } : {}),
      result_inputform: resultInputform,
      output,
    };
    if (messages.length) payload.messages = messages;
    if (messagesInputformRaw.trim() && messagesInputformRaw.trim() !== '{}') {
      payload.messages_inputform = truncateText(messagesInputformRaw, 16_000);
    }
    if (output !== frame.outputRaw) payload.output_raw = outputRaw;
    if (truncated) payload.truncated = true;
    payload.duration_ms = durationMs;

    if (resultInputformRaw.trim() === '$Aborted') {
      payload.ok = false;
      payload.error = 'timeout';
      payload.message =
        `The evaluation exceeded the ${timeoutSeconds} second timeout and was aborted (TimeConstrained returned $Aborted). ` +
        'The kernel is still running and usable; retry with a larger timeout_seconds if the computation is long.';
      return { isError: true, payload };
    }

    if (resultInputformRaw.trim() === '$Failed') {
      payload.ok = false;
      payload.error = 'evaluation_failed';
      const syntax = messages.some((name) => isSyntaxMessage(name));
      payload.message = syntax
        ? `The Wolfram Language program could not be parsed (${messages.filter((name) => isSyntaxMessage(name)).join(', ')}). ` +
          'The kernel is still running and usable; fix the program and retry.'
        : 'Evaluation returned $Failed.' +
          (messages.length ? ` Messages: ${messages.join(', ')}.` : ' See "output" for details.') +
          ' The kernel is still running and usable.';
      return { isError: true, payload };
    }

    return { isError: false, payload };
  }

  /** Restart the kernel (drops all in-memory state). Serialized behind pending calls. */
  async restart() {
    return this._enqueue(async () => {
      this._log('restarting kernel');
      await this._stopChild('restart');
      await this.ensureReady();
      return this.status();
    });
  }

  /** Interrupt = restart: batch math.exe cannot be reliably sent an Abort[]. */
  async interrupt() {
    return this._enqueue(async () => {
      this._log('interrupt requested; restarting kernel');
      await this._stopChild('interrupt');
      await this.ensureReady();
      return this.status();
    });
  }

  /** Stop the kernel process (used on server shutdown). */
  async shutdown() {
    this._ready = false;
    await this._stopChild('shutdown');
  }

  async _stopChild(reason) {
    const child = this._child;
    this._child = null;
    this._ready = false;
    this._buffer = '';
    if (this._pending) {
      const pending = this._pending;
      this._pending = null;
      clearTimeout(pending.beginTimer);
      clearTimeout(pending.hardTimer);
      pending.reject(
        new KernelError(`The Mathematica kernel was stopped (${reason}) before the evaluation completed.`, { code: 'kernel_stopped' }),
      );
    }
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    if (child.exitCode !== null) return;
    const exited = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000);
      if (timer.unref) timer.unref();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    const exitedGracefully = await exited;
    if (!exitedGracefully && process.platform === 'win32' && child.pid) {
      try {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } catch {
        /* ignore */
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        if (timer.unref) timer.unref();
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}
