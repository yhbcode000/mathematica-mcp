/**
 * dsh-mathematica-notebook — Host half.
 *
 * Owns the persistent Wolfram kernel, the notebook store, the `.nb` codec, the
 * authenticated RPC channel and the `mathematica_notebook` agent tool. The
 * browser half (`client.js`) is loaded by the DSH client module system and talks
 * to this plugin over `/mathematica-notebook` (CONTRACT.md §1).
 *
 * `tools` is required; the browser carrier (`connection` + `webServer`) is
 * optional, so a headless profile keeps the agent tool and just registers no
 * channel. Everything else (store, kernel, temporary files, timers) is owned by
 * this plugin and disposed on unload.
 */

import { NotebookCodec } from './lib/nb-codec.js';
import { ErrorCodes, PluginError } from './lib/errors.js';
import { KernelManager } from './lib/kernel-manager.js';
import { createLauncher } from './lib/launcher.js';
import { NotebookOperations, SERVER_VERSION } from './lib/operations.js';
import { NotebookPaths } from './lib/paths.js';
import { RPC_CHANNEL, createDispatcher, mountRpcRoute } from './lib/rpc.js';
import { NotebookStore } from './lib/store.js';
import { createNotebookTool } from './lib/tools.js';
import { WebNotebook } from './lib/web-notebook.js';

export const name = 'dsh-mathematica-notebook';

/** Host services this plugin needs. `tools` is required; RPC is optional. */
export const inject = ['tools'];

export { RPC_CHANNEL, SERVER_VERSION };

/** Cross-generation slots: the browser channel outlives a plugin HMR reload. */
const RPC_DISPATCH = Symbol.for('dsh-mathematica-notebook.rpc-dispatch');
const RPC_STATE = Symbol.for('dsh-mathematica-notebook.rpc-state');

/** Shared diagnostics state (survives plugin reloads so hello history persists). */
function diagnosticsState() {
  let state = globalThis[RPC_STATE];
  if (!state) {
    state = { hellos: [], registered: false, mounted: false, lastError: null };
    globalThis[RPC_STATE] = state;
  }
  return state;
}

function createDiagnostics(state) {
  return {
    recordHello(payload) {
      state.hellos.push({ at: new Date().toISOString(), payload: payload ?? null });
      if (state.hellos.length > 20) state.hellos.shift();
    },
    helloCount() {
      return state.hellos.length;
    },
    lastHello() {
      return state.hellos.length > 0 ? state.hellos[state.hellos.length - 1] : null;
    },
    setLastError(error) {
      state.lastError = { at: new Date().toISOString(), ...(error ?? {}) };
    },
    setRegistered(registered) {
      state.registered = Boolean(registered);
    },
    setMounted(mounted) {
      state.mounted = Boolean(mounted);
    },
    snapshot() {
      return {
        channel: RPC_CHANNEL,
        registered: state.registered,
        mounted: state.mounted,
        helloCount: state.hellos.length,
        lastHello: state.hellos.length > 0 ? state.hellos[state.hellos.length - 1] : null,
        lastError: state.lastError,
      };
    },
  };
}

/**
 * Resolve the WLJS web-notebook settings from the plugin config and the
 * environment (a headless or differently-laid-out machine can point at any
 * extracted WLJS tree without a rebuild).
 *
 * @param {object} config plugin config
 * @returns {object} `webNotebook` config for `lib/web-notebook.js`
 */
export function decideWebNotebookConfig(config = {}) {
  const section = config && typeof config === 'object' && config.webNotebook && typeof config.webNotebook === 'object' ? config.webNotebook : {};
  const env = process.env;
  const out = { ...section };
  if (typeof out.root !== 'string' || out.root.trim() === '') {
    if (typeof env.WLJS_NOTEBOOK_DIR === 'string' && env.WLJS_NOTEBOOK_DIR.trim() !== '') out.root = env.WLJS_NOTEBOOK_DIR.trim();
  }
  if (out.httpPort === undefined || out.httpPort === null || out.httpPort === '') {
    const port = Number(env.WLJS_HTTP_PORT);
    if (Number.isInteger(port) && port > 0 && port < 65536) out.httpPort = port;
  }
  if (out.enabled === undefined && env.DSH_MATHEMATICA_WLJS === '0') out.enabled = false;
  return out;
}

/**
 * Mount the Host half.
 *
 * @param {object} ctx Cordis plugin context
 * @param {object} [config] plugin config (`webNotebook` section is forwarded)
 */
export function apply(ctx, config = {}) {
  const state = diagnosticsState();
  const diagnostics = createDiagnostics(state);
  const logger = (message) => {
    try {
      if (typeof ctx?.logger?.debug === 'function') ctx.logger.debug(`mathematica-notebook: ${message}`);
    } catch {
      /* logging must never throw */
    }
  };

  const webConfig = decideWebNotebookConfig(config);
  const paths = new NotebookPaths({ ctx, env: process.env });
  const kernel = new KernelManager({ logger });
  const codec = new NotebookCodec({ kernel, logger });
  const store = new NotebookStore({ codec, paths, logger });
  const launcher = createLauncher();
  const webNotebook = new WebNotebook({ config: webConfig, env: process.env, logger });
  const operations = new NotebookOperations({
    store,
    kernel,
    paths,
    launcher,
    diagnostics,
    webNotebook,
    serverVersion: SERVER_VERSION,
    logger,
  });
  const dispatch = createDispatcher({ operations, diagnostics });

  // Debug probe: run any endpoint through the SAME dispatch table with a
  // synthetic owner peer (Lead verification hook; never exposed to the browser).
  operations.setProbe((endpoint, payload) => dispatch(endpoint, payload, { peer: { principal: { kind: 'owner' } }, synthetic: true }));

  // The channel handler resolves the newest dispatcher so a reloaded plugin can
  // take over without re-registering the route (the connection service outlives
  // this plugin across HMR reloads).
  globalThis[RPC_DISPATCH] = dispatch;
  diagnostics.setRegistered(false);
  diagnostics.setMounted(false);
  mountRpcRoute(ctx, () => globalThis[RPC_DISPATCH] ?? dispatch, {
    logger,
    onMounted: () => {
      diagnostics.setMounted(true);
      diagnostics.setRegistered(true);
    },
    onError: (error) => diagnostics.setLastError({ code: ErrorCodes.INTERNAL_ERROR, message: String(error?.message ?? error) }),
  });

  ctx.effect(
    () => ctx.tools.register(createNotebookTool({ operations, diagnostics, serverVersion: SERVER_VERSION })),
    'mathematica-notebook: agent tool',
  );

  ctx.effect(
    () => async () => {
      if (globalThis[RPC_DISPATCH] === dispatch) delete globalThis[RPC_DISPATCH];
      diagnostics.setRegistered(false);
      diagnostics.setMounted(false);
      // Flush pending notebook saves first (they need the kernel), then release
      // the kernel process and every store timer. Async disposers are awaited by
      // Cordis before the plugin fiber goes away.
      try {
        await store.dispose();
      } catch (error) {
        logger(`store dispose failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        await kernel.dispose();
      } catch (error) {
        logger(`kernel dispose failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      // The WLJS web notebook is a separate Wolfram process this plugin started
      // on demand; stop it so uninstalling/restarting the plugin leaves no
      // orphan server behind.
      if (webNotebook !== null) {
        try {
          await webNotebook.dispose();
        } catch (error) {
          logger(`web notebook dispose failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
    'mathematica-notebook: dispose',
  );
}

/** Exported for tests: diagnostics-only health value (no side effects). */
export function pluginHealth() {
  return createDiagnostics(diagnosticsState()).snapshot();
}

export { ErrorCodes, PluginError };
