/**
 * mathematica-mcp: a zero-dependency MCP server that exposes a local Wolfram
 * Language (Mathematica / Wolfram Engine) kernel over stdio.
 *
 * Transport: newline-delimited JSON-RPC 2.0 messages on stdin/stdout.
 * stdout carries protocol frames only; all diagnostics go to stderr.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { kernelCandidates, kernelNotFoundHint, resolveKernel } from './detect.js';
import {
  DEFAULT_TIMEOUT_SECONDS,
  KernelBridge,
  KernelError,
  MAX_TIMEOUT_SECONDS,
  MIN_TIMEOUT_SECONDS,
  normalizeTimeoutSeconds,
  wlStringLiteral,
} from './kernel.js';

const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const SERVER_NAME = 'mathematica-mcp';
export const SERVER_VERSION = typeof PACKAGE.version === 'string' ? PACKAGE.version : '0.1.0';

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const FALLBACK_PROTOCOL_VERSION = '2024-11-05';

/** Mathematica export format names keyed by the tool's format argument. */
export const EXPORT_FORMATS = {
  png: 'PNG',
  svg: 'SVG',
  pdf: 'PDF',
  csv: 'CSV',
  txt: 'Text',
  json: 'JSON',
  tex: 'TeX',
};

const EXPORT_EXTENSIONS = {
  png: 'png',
  svg: 'svg',
  pdf: 'pdf',
  csv: 'csv',
  txt: 'txt',
  json: 'json',
  tex: 'tex',
};

const MAX_TOOL_TEXT_CHARS = 200_000;
const DEFAULT_EXPORT_TIMEOUT_SECONDS = 180;
const DEFAULT_INFORMATION_TIMEOUT_SECONDS = 60;

export const SERVER_INSTRUCTIONS = [
  'mathematica-mcp exposes a local Wolfram Language (Mathematica / Wolfram Engine) kernel over MCP.',
  '',
  'Important behaviour:',
  '- The kernel is persistent. Variables, function definitions, options and loaded packages set by earlier mathematica_evaluate calls remain available in later calls, and mathematica_export can plot/export data computed earlier.',
  '- Results are returned as JSON. "result" contains the decoded value for plain strings and numbers; "result_inputform" always contains the raw Mathematica InputForm. Text printed by Print[...] appears in "output", and warning/error message names appear in "messages".',
  '- mathematica_evaluate returns an error when the program has a syntax error ("$Failed") or exceeds timeout_seconds ("$Aborted"). In both cases the kernel stays alive and usable.',
  '- The default evaluation timeout is 60 seconds; the default export timeout is 180 seconds. Raise timeout_seconds for long computations.',
  '- mathematica_kernel_status restarts the kernel on request (all in-memory state is lost). "interrupt" is implemented as a restart because a batch math.exe process cannot be reliably interrupted.',
  '- mathematica_export writes files on the local machine and returns the absolute path and byte size. Supported formats: png, svg, pdf, csv, txt, json, tex.',
  '- A locally installed and licensed Mathematica (or the free Wolfram Engine) is required; nothing is sent to a cloud service, and there is no cloud Wolfram API involved.',
  '- The server executes arbitrary Wolfram Language code with the privileges of the user running it. Only connect trusted MCP clients and only evaluate code you trust.',
].join('\n');

const TOOL_DEFINITIONS = [
  {
    name: 'mathematica_evaluate',
    title: 'Evaluate Wolfram Language code',
    description:
      'Evaluate Wolfram Language (Mathematica) code in a persistent local kernel and return the result in InputForm. ' +
      'Variables and function definitions persist between calls. Printed output is captured in "output", and printed ' +
      'messages are listed in "messages". Requires a locally licensed Mathematica or the free Wolfram Engine.',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'Wolfram Language source code to evaluate, e.g. "2+2", "Plot[Sin[x], {x, 0, 2 Pi}]", or a multi-line program. ' +
            'It is parsed with ToExpression, so newline-separated statements are evaluated in order.',
        },
        timeout_seconds: {
          type: 'number',
          description: `Maximum evaluation time in seconds (default ${DEFAULT_TIMEOUT_SECONDS}). On timeout the evaluation is aborted and the kernel stays usable.`,
          minimum: MIN_TIMEOUT_SECONDS,
          maximum: MAX_TIMEOUT_SECONDS,
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'mathematica_export',
    title: 'Export Mathematica graphics or data to a file',
    description:
      'Evaluate Wolfram Language code and export its result to a file on the local machine. ' +
      'Returns the absolute path and byte size of the created file. Useful for plots (png/svg/pdf), tables/data (csv/json/txt) and LaTeX (tex).',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'Wolfram Language expression to export, e.g. "Plot[Sin[x], {x, 0, 2 Pi}]" or "Table[{i, i^2}, {i, 10}]". ' +
            'Variables defined by earlier mathematica_evaluate calls can be used.',
        },
        format: {
          type: 'string',
          enum: ['png', 'svg', 'pdf', 'csv', 'txt', 'json', 'tex'],
          description: 'Output format.',
        },
        file_path: {
          type: 'string',
          description:
            'Absolute path of the output file. When omitted, a timestamped file is created under the OS temp directory (mathematica-mcp artifacts folder).',
        },
        width: {
          type: 'number',
          description: 'For png/svg/pdf: image width in pixels, passed to Mathematica as ImageSize.',
          minimum: 1,
        },
        height: {
          type: 'number',
          description: 'For png/svg/pdf: image height in pixels, passed to Mathematica as ImageSize.',
          minimum: 1,
        },
        timeout_seconds: {
          type: 'number',
          description: `Maximum time for the export in seconds (default ${DEFAULT_EXPORT_TIMEOUT_SECONDS}). The first raster export can take several seconds.`,
          minimum: MIN_TIMEOUT_SECONDS,
          maximum: MAX_TIMEOUT_SECONDS,
        },
      },
      required: ['code', 'format'],
    },
  },
  {
    name: 'mathematica_kernel_status',
    title: 'Inspect or restart the Mathematica kernel',
    description:
      'Report whether the local Mathematica kernel is running (pid, uptime, call count), restart it, or interrupt it. ' +
      'Restarting clears all in-memory state. Interrupt is implemented as a restart because a batch math.exe cannot be reliably interrupted.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'restart', 'interrupt'],
          description: 'Action to perform (default "status").',
          default: 'status',
        },
      },
    },
  },
  {
    name: 'mathematica_information',
    title: 'Look up Wolfram Language symbol information',
    description:
      'Return information about Wolfram Language symbols: attributes, context, option count and definitions (for user-defined symbols). ' +
      'Useful for discovering how to use a built-in function such as Plot or Table.',
    inputSchema: {
      type: 'object',
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'Symbol names to inspect, e.g. ["Plot", "Table", "Integrate"]. Context-qualified names such as "Global`f" are allowed.',
        },
      },
      required: ['symbols'],
    },
  },
];

class JsonRpcError extends Error {
  constructor(code, message, data = undefined) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
    this.data = data;
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Serialize a tool payload to text, keeping the MCP response under ~200 KB. */
export function capPayloadText(payload, limit = MAX_TOOL_TEXT_CHARS) {
  let text;
  try {
    text = JSON.stringify(payload, null, 2);
  } catch {
    text = JSON.stringify({ ok: false, message: 'Failed to serialize the tool result.' });
  }
  if (text.length <= limit) return text;
  const copy = { ...payload, truncated: true };
  for (const key of ['output', 'output_raw', 'result_inputform', 'messages_inputform', 'definition', 'stack']) {
    const value = copy[key];
    if (typeof value === 'string' && value.length > 30_000) {
      copy[key] = `${value.slice(0, 30_000)}\n… [truncated: ${value.length - 30_000} characters omitted]`;
    }
  }
  text = JSON.stringify(copy, null, 2);
  if (text.length > limit) {
    text = `${text.slice(0, limit)}\n… [response truncated at ${limit} characters]`;
  }
  return text;
}

function textContent(payload, { isError = false } = {}) {
  const result = { content: [{ type: 'text', text: capPayloadText(payload) }] };
  if (isError) result.isError = true;
  return result;
}

function errorContent(message, extra = {}) {
  return textContent({ ok: false, message, ...extra }, { isError: true });
}

/** Build the `Export[...]` expression for mathematica_export. */
export function buildExportCode(code, filePath, format, width, height) {
  const options = exportImageOptions(format, width, height);
  return `Export[${wlStringLiteral(filePath)}, (${code}), ${wlStringLiteral(EXPORT_FORMATS[format])}${options}]`;
}

function exportImageOptions(format, width, height) {
  if (!['png', 'svg', 'pdf'].includes(format)) return '';
  const clamp = (value) => Math.max(1, Math.min(20_000, Math.round(Number(value))));
  const hasWidth = Number.isFinite(Number(width)) && Number(width) > 0;
  const hasHeight = Number.isFinite(Number(height)) && Number(height) > 0;
  if (hasWidth && hasHeight) return `, ImageSize -> {${clamp(width)}, ${clamp(height)}}`;
  if (hasWidth) return `, ImageSize -> ${clamp(width)}`;
  if (hasHeight) return `, ImageSize -> {Automatic, ${clamp(height)}}`;
  return '';
}

/** Build the `Association[...]` expression used by mathematica_information. */
export function buildInformationCode(symbols) {
  const entries = symbols
    .map(
      (symbol) =>
        `${wlStringLiteral(symbol)} -> <|` +
        `"Attributes" -> ToString[Attributes @@ HoldComplete[${symbol}], InputForm], ` +
        `"Context" -> ToString[Context @@ HoldComplete[${symbol}]], ` +
        `"OptionsCount" -> Length[Options @@ HoldComplete[${symbol}]], ` +
        `"Definition" -> With[{mathematica$mcp$def = ToString[Definition @@ HoldComplete[${symbol}], InputForm]}, ` +
        `If[StringLength[mathematica$mcp$def] > 8000, StringTake[mathematica$mcp$def, 8000] <> " ... [definition truncated]", mathematica$mcp$def]]|>`,
    )
    .join(',\n  ');
  return `Association[{\n  ${entries}\n}]`;
}

function defaultExportPath(format) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const suffix = randomBytes(3).toString('hex');
  const extension = EXPORT_EXTENSIONS[format] || format;
  return join(tmpdir(), 'mathematica-mcp', `mathematica-export-${stamp}-${suffix}.${extension}`);
}

const SYMBOL_NAME_RE = /^[A-Za-z$][A-Za-z0-9$]*(`[A-Za-z0-9$]*)*$/;

export class McpServer {
  constructor({ cliKernelPath = null, env = process.env, logger = null, input = process.stdin, output = process.stdout } = {}) {
    this._env = env;
    this._cliKernelPath = cliKernelPath;
    this._kernel = null;
    this._resolution = null;
    this._kernelPromise = null;
    this._logSink = typeof logger === 'function' ? logger : null;
    this._input = input;
    this._output = output;
    this._shuttingDown = false;
    this._closedPromise = null;
    this._cleanupFns = [];
  }

  _diag(message) {
    const line = `[mathematica-mcp] ${message}`;
    if (this._logSink) {
      this._logSink(line);
      return;
    }
    try {
      process.stderr.write(`${line}\n`);
    } catch {
      /* ignore */
    }
  }

  /**
   * Probe kernel candidates (cached for the process lifetime; failed probes are
   * retried after a short TTL so a license activated mid-session can be picked
   * up by a later call).
   */
  async _ensureResolution() {
    const now = Date.now();
    if (this._resolution && (this._resolution.ok || now - this._resolution.at < 15_000)) {
      return this._resolution;
    }
    const resolution = await resolveKernel({ cliPath: this._cliKernelPath, env: this._env });
    this._resolution = { ...resolution, at: now };
    if (resolution.ok) {
      this._diag(`using kernel: ${resolution.path} (${resolution.source})`);
    } else {
      this._diag(`no working kernel found (${resolution.tried.length} candidate(s) probed)`);
    }
    return this._resolution;
  }

  async _getKernel() {
    if (this._kernel) return this._kernel;
    if (!this._kernelPromise) {
      this._kernelPromise = (async () => {
        const resolution = await this._ensureResolution();
        if (!resolution.ok) {
          throw new KernelError(resolution.error, {
            code: 'kernel_not_found',
            details: { tried: resolution.tried },
          });
        }
        this._kernel = new KernelBridge({
          kernelPath: resolution.path,
          env: this._env,
          logger: (message) => this._diag(message),
        });
        return this._kernel;
      })().finally(() => {
        this._kernelPromise = null;
      });
    }
    return this._kernelPromise;
  }

  _kernelStatusPayload() {
    const candidates = kernelCandidates({ cliPath: this._cliKernelPath, env: this._env });
    const resolution = this._resolution;
    const bridgeStatus = this._kernel
      ? this._kernel.status()
      : {
          kernel_path: resolution && resolution.ok ? resolution.path : null,
          running: false,
          ready: false,
          pid: null,
          uptime_seconds: null,
          calls: 0,
          pending_call: null,
          last_error: resolution && !resolution.ok ? resolution.error : null,
        };
    const payload = {
      ok: true,
      kernel_found: resolution ? resolution.ok : null,
      kernel_path: resolution && resolution.ok ? resolution.path : null,
      detection_source: resolution && resolution.ok ? resolution.source : null,
      candidates: candidates.map((candidate) => ({ path: candidate.path, source: candidate.source })),
      resolution_attempted: Boolean(resolution),
      tried: resolution ? resolution.tried : [],
      kernel: bridgeStatus,
    };
    if (!resolution) {
      payload.hint =
        'The kernel has not been probed yet. The first tool call probes the candidates above and caches the first working kernel.';
    } else if (!resolution.ok) {
      payload.hint = resolution.error;
    }
    return payload;
  }

  // ---------------------------------------------------------------- protocol

  /** Start reading protocol frames. Resolves when stdin closes and cleanup is done. */
  async run() {
    const readline = createInterface({ input: this._input, crlfDelay: Infinity });
    this._closedPromise = new Promise((resolve) => {
      readline.on('close', () => resolve());
    });
    readline.on('line', (line) => {
      void this._onLine(line);
    });
    this._input.on('error', (error) => this._diag(`stdin error: ${error.message}`));

    const onSignal = (signal) => {
      this._diag(`received ${signal}; shutting down`);
      void this.shutdown().finally(() => process.exit(0));
    };
    const onSigint = () => onSignal('SIGINT');
    const onSigterm = () => onSignal('SIGTERM');
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    this._cleanupFns.push(() => {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    });

    await this._closedPromise;
    await this.shutdown();
  }

  _send(message) {
    const frame = `${JSON.stringify(message)}\n`;
    try {
      this._output.write(frame);
    } catch (error) {
      this._diag(`failed to write response: ${error.message}`);
    }
  }

  async _onLine(line) {
    const trimmed = String(line).trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (error) {
      this._send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: `Parse error: ${error.message}` },
      });
      return;
    }
    if (Array.isArray(message)) {
      this._send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch requests are not supported.' } });
      return;
    }
    if (!isPlainObject(message)) {
      this._send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: expected a JSON object.' } });
      return;
    }

    const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
    const id = hasId ? message.id : null;
    const method = message.method;

    if (!hasId) {
      // Notifications never receive a response.
      if (typeof method === 'string' && method !== 'notifications/initialized' && !method.startsWith('notifications/')) {
        this._diag(`ignoring unknown notification: ${method}`);
      }
      return;
    }

    if (typeof method !== 'string' || method.length === 0) {
      this._send({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request: missing method.' } });
      return;
    }

    try {
      const result = await this._handleRequest(method, message.params);
      this._send({ jsonrpc: '2.0', id, result });
    } catch (error) {
      if (error instanceof JsonRpcError) {
        const errorObject = { code: error.code, message: error.message };
        if (error.data !== undefined) errorObject.data = error.data;
        this._send({ jsonrpc: '2.0', id, error: errorObject });
        return;
      }
      this._diag(`internal error handling ${method}: ${error && error.stack ? error.stack : error}`);
      this._send({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: `Internal error: ${error instanceof Error ? error.message : String(error)}` },
      });
    }
  }

  async _handleRequest(method, params) {
    switch (method) {
      case 'initialize':
        return this._handleInitialize(params);
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: TOOL_DEFINITIONS };
      case 'tools/call':
        return this._handleToolCall(params);
      case 'resources/list':
        return { resources: [] };
      case 'resources/templates/list':
        return { resourceTemplates: [] };
      case 'prompts/list':
        return { prompts: [] };
      default:
        throw new JsonRpcError(-32601, `Method not found: ${method}`);
    }
  }

  _handleInitialize(params) {
    const requested = isPlainObject(params) && typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
    const protocolVersion = requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : FALLBACK_PROTOCOL_VERSION;
    this._diag(`initialize (requested protocol ${requested || 'none'} -> ${protocolVersion})`);
    return {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        title: 'Mathematica MCP',
        description: 'Local Wolfram Language kernel over MCP (evaluate code and export graphics/data).',
      },
      instructions: SERVER_INSTRUCTIONS,
    };
  }

  async _handleToolCall(params) {
    if (!isPlainObject(params)) throw new JsonRpcError(-32602, 'Invalid params: expected an object with "name".');
    const name = params.name;
    if (typeof name !== 'string' || !name) throw new JsonRpcError(-32602, 'Invalid params: "name" must be a non-empty string.');
    const args = isPlainObject(params.arguments) ? params.arguments : {};
    try {
      return await this._callTool(name, args);
    } catch (error) {
      if (error instanceof KernelError) {
        return errorContent(error.message, { error: error.code });
      }
      throw error;
    }
  }

  async _callTool(name, args) {
    switch (name) {
      case 'mathematica_evaluate':
        return this._toolEvaluate(args);
      case 'mathematica_export':
        return this._toolExport(args);
      case 'mathematica_kernel_status':
        return this._toolKernelStatus(args);
      case 'mathematica_information':
        return this._toolInformation(args);
      default:
        return errorContent(`Unknown tool: "${name}". Available tools: ${TOOL_DEFINITIONS.map((tool) => tool.name).join(', ')}.`);
    }
  }

  // ------------------------------------------------------------------- tools

  async _toolEvaluate(args) {
    const code = this._requireCode(args, 'mathematica_evaluate');
    const timeoutSeconds = this._optionalTimeout(args.timeout_seconds, DEFAULT_TIMEOUT_SECONDS);
    const kernel = await this._getKernel();
    const outcome = await kernel.evaluate(code, { timeoutSeconds, label: 'evaluate' });
    return textContent(outcome.payload, { isError: outcome.isError });
  }

  async _toolExport(args) {
    const code = this._requireCode(args, 'mathematica_export');
    const format = typeof args.format === 'string' ? args.format.trim().toLowerCase() : '';
    if (!EXPORT_FORMATS[format]) {
      return errorContent(
        `mathematica_export requires "format" to be one of: ${Object.keys(EXPORT_FORMATS).join(', ')}.`,
        { error: 'invalid_arguments' },
      );
    }
    const timeoutSeconds = this._optionalTimeout(args.timeout_seconds, DEFAULT_EXPORT_TIMEOUT_SECONDS);
    const width = this._optionalDimension(args.width, 'width');
    const height = this._optionalDimension(args.height, 'height');
    if (width instanceof Error) return errorContent(width.message, { error: 'invalid_arguments' });
    if (height instanceof Error) return errorContent(height.message, { error: 'invalid_arguments' });

    let filePath;
    if (args.file_path !== undefined) {
      if (typeof args.file_path !== 'string' || !args.file_path.trim()) {
        return errorContent('"file_path" must be a non-empty string when provided.', { error: 'invalid_arguments' });
      }
      filePath = isAbsolute(args.file_path) ? args.file_path : resolve(process.cwd(), args.file_path);
    } else {
      filePath = defaultExportPath(format);
    }

    try {
      await mkdir(dirname(filePath), { recursive: true });
    } catch (error) {
      return errorContent(`Could not create the output directory "${dirname(filePath)}": ${error.message}`, {
        error: 'filesystem_error',
      });
    }

    const kernel = await this._getKernel();
    const exportCode = buildExportCode(code, filePath, format, width, height);
    const outcome = await kernel.evaluate(exportCode, { timeoutSeconds, label: `export:${format}` });
    const payload = {
      ok: outcome.payload.ok,
      path: filePath,
      format,
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      duration_ms: outcome.payload.duration_ms,
    };
    if (outcome.payload.messages) payload.messages = outcome.payload.messages;
    if (outcome.payload.error) payload.error = outcome.payload.error;
    if (outcome.payload.message) payload.message = outcome.payload.message;
    if (outcome.payload.result_inputform !== undefined && outcome.payload.result_inputform !== 'Null') {
      payload.result_inputform = outcome.payload.result_inputform;
    }
    if (outcome.payload.output) payload.output = outcome.payload.output;

    if (outcome.isError) {
      payload.message = payload.message || 'The export evaluation failed.';
      return textContent(payload, { isError: true });
    }

    let fileStat = null;
    try {
      fileStat = await stat(filePath);
    } catch {
      fileStat = null;
    }
    if (!fileStat || !fileStat.isFile()) {
      return textContent(
        {
          ok: false,
          ...payload,
          message:
            `Export did not create a file at "${filePath}". Check that the code produced an exportable expression ` +
            '(a Graphics, Image, list of data, string, ...) and that the format is appropriate for it.',
        },
        { isError: true },
      );
    }
    if (fileStat.size === 0) {
      return textContent(
        {
          ok: false,
          ...payload,
          bytes: 0,
          message: `Export created an empty file at "${filePath}". The exported expression may not be valid for the "${format}" format.`,
        },
        { isError: true },
      );
    }

    return textContent({ ...payload, ok: true, bytes: fileStat.size });
  }

  async _toolKernelStatus(args) {
    const action = args.action === undefined ? 'status' : String(args.action).trim().toLowerCase();
    if (!['status', 'restart', 'interrupt'].includes(action)) {
      return errorContent('mathematica_kernel_status "action" must be one of: status, restart, interrupt.', {
        error: 'invalid_arguments',
      });
    }
    if (action === 'status') {
      return textContent(this._kernelStatusPayload());
    }

    const kernel = await this._getKernel();
    const actionVerb = action === 'restart' ? 'restart' : 'interrupt';
    let status;
    try {
      status = action === 'restart' ? await kernel.restart() : await kernel.interrupt();
    } catch (error) {
      if (error instanceof KernelError) {
        return errorContent(`Failed to ${actionVerb} the Mathematica kernel: ${error.message}`, { error: error.code });
      }
      throw error;
    }
    const payload = {
      ok: true,
      action,
      restarted: true,
      note:
        action === 'restart'
          ? 'The Mathematica kernel was restarted. All in-memory state (variables, definitions, loaded packages) was lost.'
          : 'Interrupt is implemented as a kernel restart because a batch math.exe process cannot be reliably interrupted. All in-memory state was lost.',
      kernel: status,
    };
    return textContent(payload);
  }

  async _toolInformation(args) {
    if (!Array.isArray(args.symbols) || args.symbols.length === 0) {
      return errorContent('mathematica_information requires "symbols" to be a non-empty array of symbol names.', {
        error: 'invalid_arguments',
      });
    }
    if (args.symbols.length > 50) {
      return errorContent('mathematica_information accepts at most 50 symbols per call.', { error: 'invalid_arguments' });
    }
    const symbols = [];
    for (const raw of args.symbols) {
      if (typeof raw !== 'string' || !raw.trim()) {
        return errorContent('mathematica_information "symbols" must contain non-empty strings.', { error: 'invalid_arguments' });
      }
      const symbol = raw.trim();
      if (!SYMBOL_NAME_RE.test(symbol)) {
        return errorContent(
          `Invalid symbol name "${symbol}". Use a plain Wolfram symbol name such as Plot, Table or Global\`f.`,
          { error: 'invalid_arguments' },
        );
      }
      if (!symbols.includes(symbol)) symbols.push(symbol);
    }

    const kernel = await this._getKernel();
    const outcome = await kernel.evaluate(buildInformationCode(symbols), {
      timeoutSeconds: DEFAULT_INFORMATION_TIMEOUT_SECONDS,
      label: 'information',
    });
    const payload = { ok: outcome.payload.ok, symbols, ...outcome.payload };
    delete payload.ok;
    payload.ok = outcome.payload.ok;
    return textContent(payload, { isError: outcome.isError });
  }

  _requireCode(args, toolName) {
    if (typeof args.code !== 'string' || !args.code.trim()) {
      throw new KernelError(`${toolName} requires "code" to be a non-empty string of Wolfram Language code.`, {
        code: 'invalid_arguments',
      });
    }
    return args.code;
  }

  _optionalTimeout(value, fallback) {
    if (value === undefined || value === null) return fallback;
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return fallback;
    return normalizeTimeoutSeconds(number, fallback);
  }

  _optionalDimension(value, fieldName) {
    if (value === undefined || value === null) return undefined;
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) {
      return new Error(`"${fieldName}" must be a positive number when provided.`);
    }
    return Math.max(1, Math.min(20_000, Math.round(number)));
  }

  // --------------------------------------------------------------- lifecycle

  async shutdown() {
    if (this._shuttingDown) return;
    this._shuttingDown = true;
    for (const cleanup of this._cleanupFns.splice(0)) {
      try {
        cleanup();
      } catch {
        /* ignore */
      }
    }
    if (this._kernel) {
      try {
        await this._kernel.shutdown();
      } catch (error) {
        this._diag(`error while stopping kernel: ${error.message}`);
      }
    }
  }
}

export function parseCliArgs(argv) {
  const options = { kernel: null, help: false, version: false, unknown: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--version' || argument === '-v') {
      options.version = true;
    } else if (argument === '--kernel') {
      options.kernel = argv[index + 1] || null;
      index += 1;
    } else if (argument.startsWith('--kernel=')) {
      options.kernel = argument.slice('--kernel='.length) || null;
    } else {
      options.unknown.push(argument);
    }
  }
  return options;
}

export const HELP_TEXT = `${SERVER_NAME} ${SERVER_VERSION}
MCP server exposing a local Wolfram Language (Mathematica / Wolfram Engine) kernel.

Usage:
  mathematica-mcp [--kernel <path-to-math-executable>] [--help] [--version]

The server speaks MCP over stdio (newline-delimited JSON-RPC 2.0). It is normally
started by an MCP client, not by hand.

Kernel detection (first match wins):
  1. --kernel <path>
  2. MATHEMATICA_EXE or MATHEMATICA_KERNEL environment variable
  3. ~/.mathematica-mcp.json with {"kernelPath": "<path>"}
  4. well-known install locations for the current platform

Diagnostics are written to stderr; stdout carries protocol frames only.
`;

/** CLI entry point. */
export async function main(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv);
  if (options.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }
  if (options.version) {
    process.stdout.write(`${SERVER_NAME} ${SERVER_VERSION}\n`);
    return;
  }
  if (options.unknown.length > 0) {
    process.stderr.write(`[mathematica-mcp] ignoring unknown arguments: ${options.unknown.join(' ')}\n`);
  }
  const server = new McpServer({ cliKernelPath: options.kernel });
  // Never let a broken pipe crash the protocol loop.
  process.stdout.on('error', (error) => {
    if (error && error.code === 'EPIPE') process.exit(0);
  });
  await server.run();
}
