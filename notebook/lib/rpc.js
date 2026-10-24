/**
 * Authenticated RPC channel (CONTRACT.md §1/§2).
 *
 * The browser half calls `connection.rpc.call('/mathematica-notebook', endpoint,
 * payload)`, which POSTs the standard client-request envelope to
 * `/mathematica-notebook/<endpoint>`. The Web carrier exposes the same
 * primitives used by the shipped RPC channels — `connection.admit` for owner
 * browser trust/authentication and `webServer.register({kind:'prefix'})` for
 * the route — so this module mounts a byte-compatible channel:
 *
 *   JSON response:    { type:'server-response', rpcId, result }
 *   binary response:  multipart/form-data with one `bytes-N` part per
 *                     attachment plus a final `metadata` part carrying the JSON
 *                     envelope and `attachments:[{path, codec:'bytes', part}]`.
 *
 * The browser connection's multipart parser replaces the JSON `null`
 * placeholders at each attachment `path` with `Uint8Array`, so `value` stays
 * JSON and errors always stay JSON.
 */

import { randomBytes } from 'node:crypto';
import { ErrorCodes, invalidPayload, rpcError, toRpcError } from './errors.js';

/** RPC channel prefix mounted on the Host web server. */
export const RPC_CHANNEL = '/mathematica-notebook';

/** Max accepted request body (CONTRACT.md §1). */
export const RPC_BODY_LIMIT = 1024 * 1024;

/** Allowed endpoint segment shape (mirrors the shipped connection channel). */
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;

/** Fallback correlation id for an unparseable request. */
const INVALID_REQUEST_RPC_ID = 'invalid-request';

/* ----------------------------- validation ------------------------------ */

function optionalSessionId(payload) {
  if (payload.sessionId === undefined || payload.sessionId === null) return payload;
  if (typeof payload.sessionId !== 'string' || payload.sessionId.trim().length === 0) {
    throw invalidPayload('"sessionId" must be a non-empty string', { field: 'sessionId' });
  }
  return payload;
}

function requireSessionId(payload) {
  const withSession = optionalSessionId(payload);
  if (typeof withSession.sessionId !== 'string') {
    throw invalidPayload('"sessionId" must be a non-empty string', { field: 'sessionId' });
  }
  return withSession;
}

function requirePath(payload) {
  if (typeof payload.path !== 'string' || payload.path.trim().length === 0) {
    throw invalidPayload('"path" must be a non-empty string', { field: 'path' });
  }
  return payload;
}

function requireCells(payload) {
  if (!Array.isArray(payload.cells)) throw invalidPayload('"cells" must be an array', { field: 'cells' });
  return payload;
}

function validateCellsAndIndices(payload) {
  if (payload.cells !== undefined && payload.cells !== null && !Array.isArray(payload.cells)) {
    throw invalidPayload('"cells" must be an array', { field: 'cells' });
  }
  if (payload.indices !== undefined && payload.indices !== null && !Array.isArray(payload.indices)) {
    throw invalidPayload('"indices" must be an array', { field: 'indices' });
  }
  return payload;
}

/**
 * Endpoint dispatch table. `run` receives the validated payload and returns
 * `{ value, attachments? }`.
 */
const ENDPOINTS = new Map([
  ['status', { run: (operations, payload) => operations.status(optionalSessionId(payload)) }],
  ['list', { run: (operations, payload) => operations.list(requireSessionId(payload)) }],
  ['open', { run: (operations, payload) => operations.open(requirePath(requireSessionId(payload))) }],
  ['create', { run: (operations, payload) => operations.create(requireSessionId(payload)) }],
  [
    'save',
    {
      run: (operations, payload) => {
        requireCells(payload);
        if (typeof payload.baseRevision !== 'number' || !Number.isFinite(payload.baseRevision)) {
          throw invalidPayload('"baseRevision" must be a finite number', { field: 'baseRevision' });
        }
        return operations.save(requirePath(requireSessionId(payload)));
      },
    },
  ],
  [
    'saveAs',
    {
      run: (operations, payload) => {
        requireCells(payload);
        if (typeof payload.name !== 'string' || payload.name.trim().length === 0) {
          throw invalidPayload('"name" must be a non-empty string', { field: 'name' });
        }
        return operations.saveAs(requirePath(requireSessionId(payload)));
      },
    },
  ],
  ['evaluate', { run: (operations, payload) => operations.evaluate(validateCellsAndIndices(requirePath(requireSessionId(payload)))) }],
  [
    'restartKernel',
    {
      run: (operations, payload) => {
        if (payload !== undefined && payload !== null && typeof payload !== 'object') {
          throw invalidPayload('payload must be an object');
        }
        return operations.restartKernel();
      },
    },
  ],
  ['openInMathematica', { run: (operations, payload) => operations.openInMathematica(requirePath(requireSessionId(payload))) }],
  ['close', { run: (operations, payload) => operations.close(requirePath(requireSessionId(payload))) }],
  [
    'debug',
    {
      run: (operations, payload) => {
        const withSession = optionalSessionId(payload);
        if (withSession.probeEndpoint !== undefined && typeof withSession.probeEndpoint !== 'string') {
          throw invalidPayload('"probeEndpoint" must be a string', { field: 'probeEndpoint' });
        }
        return operations.debug(withSession);
      },
    },
  ],
]);

/** Endpoint names (used by tests / diagnostics). */
export function listEndpoints() {
  return [...ENDPOINTS.keys(), 'hello'];
}

/**
 * Build the endpoint dispatcher used by both the HTTP route and the debug probe.
 *
 * @param {object} options
 * @param {object} options.operations NotebookOperations
 * @param {object|null} [options.diagnostics] shared diagnostics state
 * @returns {(endpoint: string, payload: unknown, context?: {peer?: object, signal?: AbortSignal}) => Promise<object>}
 */
export function createDispatcher({ operations, diagnostics = null }) {
  return async function dispatch(endpoint, payload, context = {}) {
    try {
      if (typeof endpoint !== 'string' || endpoint.length === 0) {
        throw invalidPayload('endpoint is required');
      }
      const peer = context.peer;
      if (peer && peer.principal && peer.principal.kind !== 'owner') {
        return rpcError(ErrorCodes.FORBIDDEN, 'this RPC channel accepts the owner browser peer only');
      }
      if (endpoint === 'hello') {
        if (diagnostics && typeof diagnostics.recordHello === 'function') diagnostics.recordHello(payload ?? null);
        const count = diagnostics && typeof diagnostics.helloCount === 'function' ? diagnostics.helloCount() : 0;
        return { ok: true, value: { ok: true, hello: true, count } };
      }
      const entry = ENDPOINTS.get(endpoint);
      if (!entry) return rpcError(ErrorCodes.UNKNOWN_ENDPOINT, `unknown endpoint: ${endpoint}`, { endpoint });
      const result = await entry.run(operations, payload ?? {});
      const success = { ok: true, value: result.value };
      if (Array.isArray(result.attachments) && result.attachments.length > 0) success.attachments = result.attachments;
      return success;
    } catch (error) {
      const envelope = toRpcError(error);
      if (diagnostics && typeof diagnostics.setLastError === 'function') {
        diagnostics.setLastError(envelope.error);
      }
      return envelope;
    }
  };
}

/* ---------------------------- HTTP encoding ---------------------------- */

/**
 * Encode one endpoint result into an HTTP response (JSON or multipart).
 *
 * @param {import('node:http').ServerResponse} res
 * @param {string} rpcId
 * @param {object} result success or failure envelope result
 */
export function writeRpcResult(res, rpcId, result) {
  if (result && result.ok === true && Array.isArray(result.attachments) && result.attachments.length > 0) {
    return writeMultipartResult(res, rpcId, result);
  }
  const { attachments: _dropped, ...plain } = result ?? rpcError(ErrorCodes.INTERNAL_ERROR, 'missing result');
  const body = JSON.stringify({ type: 'server-response', rpcId, result: plain });
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(body)) });
  res.end(body);
}

function writeMultipartResult(res, rpcId, result) {
  const boundary = `----dshMathematicaNotebook${randomBytes(12).toString('hex')}`;
  const chunks = [];
  const attachmentMetadata = [];
  result.attachments.forEach((attachment, index) => {
    const part = `bytes-${index}`;
    const bytes = attachment.bytes instanceof Uint8Array ? attachment.bytes : new Uint8Array(attachment.bytes ?? []);
    attachmentMetadata.push({ path: [...(attachment.path ?? [])], codec: 'bytes', part });
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part}"; filename="blob"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        'utf8',
      ),
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      Buffer.from('\r\n', 'utf8'),
    );
  });
  const metadata = JSON.stringify({
    type: 'server-response',
    rpcId,
    result: { ok: true, value: result.value },
    attachments: attachmentMetadata,
  });
  chunks.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${metadata}\r\n--${boundary}--\r\n`, 'utf8'),
  );
  const body = Buffer.concat(chunks);
  res.writeHead(200, { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) });
  res.end(body);
}

/* ------------------------------ HTTP route ------------------------------ */

class BodyTooLargeError extends Error {}

/** Read a request body with a hard cap. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) {
        fail(new BodyTooLargeError('request body too large'));
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', fail);
    req.on('aborted', () => fail(new BodyTooLargeError('request aborted')));
  });
}

function writeText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

/**
 * Handle one HTTP request on the RPC prefix route.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{connection: object, dispatch: Function, bodyLimit?: number, logger?: Function|null}} options
 */
export async function handleRpcRequest(req, res, { connection, dispatch, bodyLimit = RPC_BODY_LIMIT, logger = null }) {
  if (req.method !== 'POST') {
    writeText(res, 405, 'method not allowed');
    return;
  }
  let admission;
  try {
    admission = connection.admit({ headers: req.headers });
  } catch (error) {
    logger?.(`rpc admission failed: ${error instanceof Error ? error.message : String(error)}`);
    writeText(res, 403, 'forbidden');
    return;
  }
  if (!admission || 'rejection' in admission) {
    const rejection = admission?.rejection ?? 401;
    writeText(res, rejection, rejection === 401 ? 'unauthorized' : 'forbidden');
    return;
  }
  const peer = admission.peer;
  if (!peer || !peer.principal || peer.principal.kind !== 'owner') {
    writeText(res, 403, 'forbidden');
    return;
  }

  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (!pathname.startsWith(`${RPC_CHANNEL}/`)) {
    writeText(res, 404, 'not found');
    return;
  }
  const endpoint = pathname.slice(RPC_CHANNEL.length + 1);
  if (!endpoint || endpoint.split('/').some((segment) => segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    writeText(res, 404, 'not found');
    return;
  }

  let rawBody;
  try {
    rawBody = await readBody(req, bodyLimit);
  } catch (error) {
    if (error instanceof BodyTooLargeError) writeText(res, 413, 'request body too large');
    else writeText(res, 400, 'could not read request body');
    return;
  }

  let envelope;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    writeRpcResult(res, INVALID_REQUEST_RPC_ID, rpcError(ErrorCodes.INVALID_PAYLOAD, 'request body is not JSON'));
    return;
  }
  const rpcId = typeof envelope?.rpcId === 'string' ? envelope.rpcId : INVALID_REQUEST_RPC_ID;
  if (!envelope || typeof envelope !== 'object' || envelope.type !== 'client-request' || typeof envelope.rpcId !== 'string' || typeof envelope.method !== 'string') {
    writeRpcResult(res, rpcId, rpcError(ErrorCodes.INVALID_PAYLOAD, 'invalid client-request envelope'));
    return;
  }
  if (envelope.method !== endpoint) {
    writeRpcResult(res, rpcId, rpcError(ErrorCodes.INVALID_PAYLOAD, `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(endpoint)}`));
    return;
  }

  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort(new Error('client disconnected'));
  };
  res.on('close', onClose);
  let result;
  try {
    result = await dispatch(endpoint, envelope.payload, { peer, signal: controller.signal });
  } catch (error) {
    result = toRpcError(error);
  } finally {
    res.off('close', onClose);
  }
  writeRpcResult(res, rpcId, result);
}

/**
 * Mount the RPC prefix route, optionally (the browser carrier is optional so a
 * headless profile keeps the agent tool). The route registration belongs to the
 * injected `connection`+`webServer` context, so it is removed when the plugin
 * unloads.
 *
 * @param {object} ctx plugin context
 * @param {() => Function} currentDispatch returns the active dispatcher (allows
 *   an HMR-reloaded plugin to take over without re-registering the channel)
 * @param {{onMounted?: Function, onError?: Function, logger?: Function|null}} [options]
 */
export function mountRpcRoute(ctx, currentDispatch, { onMounted = null, onError = null, logger = null } = {}) {
  ctx.inject(['connection', 'webServer'], (connectionCtx) => {
    const { connection, webServer } = connectionCtx;
    const handler = async (req, res) => {
      try {
        await handleRpcRequest(req, res, { connection, dispatch: currentDispatch(), logger });
      } catch (error) {
        onError?.(error);
        try {
          if (!res.writableEnded) writeText(res, 500, 'internal error');
        } catch {
          /* response already gone */
        }
      }
    };
    connectionCtx.effect(
      () =>
        webServer.register({
          kind: 'prefix',
          path: RPC_CHANNEL,
          handler,
        }),
      'dsh-mathematica-notebook: rpc channel',
    );
    onMounted?.();
  });
}
