/**
 * Shared error vocabulary for the dsh-mathematica-notebook Host half.
 *
 * Every failure the RPC channel / agent tool can report travels as a
 * `PluginError` carrying one of the contract's error codes. `toRpcError`
 * converts any thrown value into the contract's failure envelope
 * `{ ok: false, error: { code, message, details } }`.
 */

/** Contract error codes (CONTRACT.md §1/§2/§6). */
export const ErrorCodes = Object.freeze({
  INVALID_PAYLOAD: 'invalid_payload',
  PATH_DENIED: 'path_denied',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  KERNEL_UNAVAILABLE: 'kernel_unavailable',
  KERNEL_TIMEOUT: 'kernel_timeout',
  SYNTAX_ERROR: 'syntax_error',
  EVALUATION_FAILED: 'evaluation_failed',
  LAUNCH_FAILED: 'launch_failed',
  UNKNOWN_ENDPOINT: 'unknown_endpoint',
  FORBIDDEN: 'forbidden',
  TOO_LARGE: 'too_large',
  INTERNAL_ERROR: 'internal_error',
});

/** A failure with a contract error code and JSON-safe details. */
export class PluginError extends Error {
  /**
   * @param {string} code contract error code
   * @param {string} message user/model readable message
   * @param {object} [details] JSON-safe extra information
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PluginError';
    this.code = code;
    this.details = isPlainObject(details) ? details : {};
  }
}

/** True for non-null, non-array objects. */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Build an `invalid_payload` failure with a readable field hint. */
export function invalidPayload(message, details = {}) {
  return new PluginError(ErrorCodes.INVALID_PAYLOAD, message, details);
}

/** Contract failure envelope. */
export function rpcError(code, message, details = {}) {
  return { ok: false, error: { code, message, details: isPlainObject(details) ? details : {} } };
}

/** Convert any thrown value into the contract failure envelope. */
export function toRpcError(error) {
  if (error instanceof PluginError) return rpcError(error.code, error.message, error.details);
  const message = error instanceof Error ? error.message : String(error);
  return rpcError(ErrorCodes.INTERNAL_ERROR, message || 'internal error');
}

/**
 * Read a required string property from a payload.
 *
 * @param {object} payload
 * @param {string} field
 * @param {{trim?: boolean}} [options]
 * @returns {string}
 */
export function requireString(payload, field, { trim = true } = {}) {
  const value = payload?.[field];
  if (typeof value !== 'string' || (trim && value.trim().length === 0)) {
    throw invalidPayload(`"${field}" must be a non-empty string`, { field });
  }
  return trim ? value.trim() : value;
}

/**
 * Read an optional finite non-negative number property.
 *
 * @param {object} payload
 * @param {string} field
 * @returns {number|undefined}
 */
export function optionalNumber(payload, field) {
  const value = payload?.[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw invalidPayload(`"${field}" must be a non-negative finite number`, { field });
  }
  return value;
}
