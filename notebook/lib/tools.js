/**
 * `mathematica_notebook` agent tool (CONTRACT.md §5).
 *
 * Plain raw registry definition (the shape `dsh-tools`' `defineTool` helper
 * builds) so this package needs no Harness imports at runtime. The tool maps
 * 1:1 onto the same operation layer as the RPC endpoints: list / create / read /
 * edit / run / debug. It never opens UI and never writes outside the allowed
 * roots (path rules are enforced by `lib/paths.js`).
 */

import { ErrorCodes, PluginError, isPlainObject } from './errors.js';

/** Tool name exposed to the model. */
export const TOOL_NAME = 'mathematica_notebook';

const ACTION_DESCRIPTIONS = {
  list: 'List the *.nb notebooks in the session notebook directory.',
  create: 'Create a new .nb notebook in the session notebook directory; returns its path and cells.',
  read: 'Read a notebook: path, cells (id/kind/code), readOnly flag, optional last output summaries.',
  edit: 'Edit a notebook with insert/replace/delete operations; returns the new revision (saved immediately).',
  run: 'Evaluate code cells (all, or selected indices) and return text results per cell.',
  debug: 'Debug-only: report plugin/kernel/RPC health; optionally probe one RPC endpoint (probeEndpoint).',
};

function buildParameters() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'create', 'read', 'edit', 'run', 'debug'],
        description: 'Operation to perform.',
      },
      sessionId: {
        type: 'string',
        description: 'DSH session id. Optional: defaults to the calling agent session, or the DSH_HOME notebook dir.',
      },
      path: {
        type: 'string',
        description: 'Notebook path: absolute inside the session working directory / $DSH_HOME/notebooks, or relative to the default notebook dir. Must end with .nb.',
      },
      cells: {
        type: 'array',
        description: 'For "create": initial cells. For "save"-like edits use the edit action instead.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            code: { type: 'string', description: 'Cell source (Wolfram Language for code cells, plain text for text cells).' },
            kind: { type: 'string', enum: ['code', 'text'], description: 'Cell kind; defaults to code.' },
          },
          required: ['code'],
        },
      },
      includeOutputs: {
        type: 'boolean',
        description: 'For "read": include the last known output summary of each cell.',
      },
      operations: {
        type: 'array',
        description: 'For "edit": ordered cell operations. insert appends or inserts at index; replace/delete need an index.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            op: { type: 'string', enum: ['insert', 'replace', 'delete'] },
            index: { type: 'integer', minimum: 0, description: 'Zero-based cell index.' },
            code: { type: 'string', description: 'New cell source for insert/replace.' },
          },
          required: ['op'],
        },
      },
      indices: {
        type: 'array',
        description: 'For "run": zero-based indices of the code cells to evaluate; omit to run every code cell.',
        items: { type: 'integer', minimum: 0 },
      },
      probeEndpoint: {
        type: 'string',
        description: 'Debug-only: RPC endpoint name to run through the real dispatch table with an owner peer.',
      },
      probePayload: {
        type: 'object',
        additionalProperties: true,
        description: 'Debug-only: payload for probeEndpoint.',
      },
    },
    required: ['action'],
  };
}

function errorValue(error) {
  if (error instanceof PluginError) {
    return { ok: false, error: { code: error.code, message: error.message, details: error.details ?? {} } };
  }
  return {
    ok: false,
    error: {
      code: ErrorCodes.INTERNAL_ERROR,
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  };
}

/**
 * Build the tool definition.
 *
 * @param {object} options
 * @param {object} options.operations NotebookOperations
 * @param {object|null} [options.diagnostics]
 * @param {string} [options.serverVersion]
 * @returns {object} raw tool registry definition
 */
export function createNotebookTool({ operations, diagnostics = null, serverVersion = '0.1.0' }) {
  return {
    name: TOOL_NAME,
    description: [
      'Work with a Mathematica notebook in the DSH sidebar: list/create/read/edit/run real .nb files with a persistent Wolfram Language kernel.',
      'Actions:',
      ...Object.entries(ACTION_DESCRIPTIONS).map(([action, description]) => `- ${action}: ${description}`),
      'Use run to evaluate cells (returns per-cell ok/text/messages/durationMs). Edits are written immediately; read shows cells and readOnly. Paths ending in .nb only.',
    ].join('\n'),
    isConcurrencySafe: false,
    parameters: buildParameters(),
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const action = isPlainObject(args) && typeof args.action === 'string' ? args.action : '';
      const sessionId = typeof args?.sessionId === 'string' && args.sessionId.trim() ? args.sessionId.trim() : execSessionId(exec);
      try {
        switch (action) {
          case 'list': {
            return JSON.stringify(await unwrap(operations.list({ sessionId })), null, 2);
          }
          case 'create': {
            const cells = Array.isArray(args?.cells) ? args.cells : undefined;
            return JSON.stringify(await unwrap(operations.create({ sessionId, cells })), null, 2);
          }
          case 'read': {
            return JSON.stringify(
              await unwrap(operations.readForTool({ sessionId, path: args?.path, includeOutputs: args?.includeOutputs === true })),
              null,
              2,
            );
          }
          case 'edit': {
            return JSON.stringify(
              await unwrap(operations.editForTool({ sessionId, path: args?.path, operations: args?.operations })),
              null,
              2,
            );
          }
          case 'run': {
            return JSON.stringify(await unwrap(operations.runForTool({ sessionId, path: args?.path, indices: args?.indices })), null, 2);
          }
          case 'debug': {
            const value = await unwrap(
              operations.debug({
                sessionId,
                path: args?.path,
                probeEndpoint: args?.probeEndpoint,
                probePayload: args?.probePayload,
              }),
            );
            return JSON.stringify({ ...value, rpc: { ...value.rpc, diagnostics: diagnosticsSnapshot(diagnostics) }, serverVersion }, null, 2);
          }
          default:
            throw new PluginError(ErrorCodes.INVALID_PAYLOAD, `"action" must be one of list, create, read, edit, run, debug (got ${JSON.stringify(action)})`, {
              field: 'action',
            });
        }
      } catch (error) {
        return JSON.stringify(errorValue(error), null, 2);
      }
    },
  };
}

async function unwrap(promise) {
  const result = await promise;
  return result?.value ?? result;
}

/** Resolve the calling agent session when the model omits `sessionId`. */
function execSessionId(exec) {
  try {
    const id = exec?.agent?.session?.id;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}

function diagnosticsSnapshot(diagnostics) {
  if (!diagnostics) return null;
  try {
    if (typeof diagnostics.snapshot === 'function') return diagnostics.snapshot();
    return {
      registered: Boolean(diagnostics.registered),
      helloCount: typeof diagnostics.helloCount === 'function' ? diagnostics.helloCount() : 0,
    };
  } catch {
    return null;
  }
}
