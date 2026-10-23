# dsh-mathematica-notebook — maintainer documentation

Maintainer reference for the DSH sidebar notebook plugin in [`notebook/`](../notebook/). User-facing
docs live in [`notebook/README.md`](../notebook/README.md); the Host/browser contract is
[`notebook/CONTRACT.md`](../notebook/CONTRACT.md) and is authoritative for wire details. Release
status: [`publish-status.md`](publish-status.md#notebook-plugin-published-010).

The plugin is a **separate package** (`dsh-mathematica-notebook`) from the MCP tools bundle
(`dsh-mathematica-mcp`): it has its own Host plugin, browser half, kernel process, release entry and
market row, and the two can be installed, updated and removed independently.

## 1. Package anatomy

`notebook/package.json` is the contract with DSH. Every field exists for a reader:

| Field | Value | Read by |
| --- | --- | --- |
| `name` / `version` | `dsh-mathematica-notebook` 0.1.0 | Plugin Manager, market index, client factory id |
| `main` / `exports["."]` | `./index.js` | Loader (Host plugin import) |
| `exports["./client"]` | `./client.js` | Client module system (browser artifact) |
| `exports["./locale/*.json"]`, `exports["./icon"]` | locale + icon | `readPluginMeta` / Plugin Manager display |
| `dsh.bundle.patch` | `./cordis.patch.yml` | Profile composition |
| `dsh.client` | `{ platform: "web", immediately: true, inject: [...] }` | Client module loader |
| `files` | Host/client halves, `lib/**`, `kernel/**`, patch, locale, icon, README, CONTRACT | npm/pnpm pack for market installs |
| `scripts.test` | `node --test` | local + CI |
| `dependencies` | *(absent)* | zero runtime deps: Node built-ins + vendored kernel only |

`dsh.client.inject` lists the client-half Harness packages whose registrations this browser half
consumes (`dsh-client-connection` for `connection.rpc.call`, `dsh-client-ui-sidebar-right` for the
right-sidebar tab service, `dsh-client-locale` for the dictionary service, `dsh-client-ui-session`
for the session-scoped UI). It records ordering/availability dependencies, not npm dependencies —
DSH supplies these packages.

### Patch row and package resolution

`cordis.patch.yml` inserts exactly one Host row:

```yaml
- insert:
    - id: dsh-mathematica-notebook
      name: 'dsh-mathematica-notebook'
      config: {}
```

- **Name form: package specifier.** DSH also accepts patch-relative names (`./index.js`), which
  patch loading converts to a file URL beside the patch file. The package specifier is preferred so
  the row resolves through the profile's runtime resolution **and** Plugin Manager can read this
  package's locale metadata and icon for the row. The relative form is the documented fallback
  (`notebook/README.md` → Troubleshooting) for a profile that cannot resolve the package name.
- **`config: {}`.** The Host half needs no configuration; an empty config cannot fail schema
  validation. A failed import/activation of this optional row warns and leaves DSH booting (app-boot
  startup policy for optional entries), so a broken plugin never takes DSH down.
- The browser half needs no second row: it is declared by `dsh.client` and served by the client
  module system.

## 2. Architecture

```
┌─ browser (DSH Web UI) ────────────────────────────────┐      ┌─ Host (DSH process) ──────────────┐
│ client.js → tab type + guide + pane body + cell UI    │      │ index.js                          │
│   ctx.slots.inject('sidebar.right.pane.tab')          │      │  ├─ lib/rpc.js    prefix route    │
│   ctx.sidebarRightTabs.register({...})                │      │  ├─ lib/tools.js  agent tool      │
│   ctx.locale.register('dshMathematicaNotebook')       │ RPC  │  ├─ lib/store.js  documents       │
│   ctx.connection.rpc.call('/mathematica-notebook', …) │ ───► │  ├─ lib/paths.js  allowed roots   │
└───────────────────────────────────────────────────────┘      │  ├─ lib/nb-codec.js  .nb ⇄ cells  │
        POST envelope / multipart response                     │  ├─ lib/kernel-manager.js ──┐     │
                                                               │  ├─ lib/launcher.js         │     │
                                                               │  └─ vendored kernel/ ───────┘     │
                                                               └──────────┬───────────────┬────────┘
                                                                          │ stdio         │ spawn detached
                                                                     math.exe /      Mathematica.exe /
                                                                     WolframKernel   WolframNB.exe
```

### Why the channel is mounted manually

The spike established that `ctx.connection.rpc.handle` is not usable from a profile bundle in this
DSH build (0.2.1-rc.2): its owner context is the provider context, which lacks the `webServer`
injection the registration needs at route-registration time. The Host half therefore composes the
same primitives the Web carrier uses:

1. `webServer.register({ kind: 'prefix', path: '/mathematica-notebook', handler })` mounts a route;
2. `connection.admit({ headers })` performs the browser trust/authentication check and returns the
   peer (or a rejection);
3. the handler reads the request body under a 1 MiB cap, parses the `connection.rpc.call` envelope
   (`{ type: 'client-request', rpcId, method, payload }`), dispatches to the endpoint table, and
   replies with `{ type: 'server-response', rpcId, result }`.

The result is byte-compatible with a built-in RPC channel, so the browser half keeps using
`ctx.connection.rpc.call(...)`. Consequences we own because the carrier is not: the multipart encoder
for binary attachments, the owner-peer check (non-owner peers → 403, non-POST → 405), payload
validation, body limits, and `internal_error` mapping.

Binary results (rendered images — SVG for 2D/symbolic results, PNG for 3D graphics/raster images) stay JSON in `value` with placeholder paths plus an `attachments` array
`[{ path, codec: 'bytes', part: 'p0', bytes }]`, answered as `multipart/form-data` with a JSON
`metadata` part; the browser connection's parser fills the placeholders with `Uint8Array` instances.

If a future DSH build makes `connection.rpc.handle` usable from profile bundles, `lib/rpc.js` is the
single file to shrink — the envelope and endpoints do not change.

## 3. Module map

| File | Responsibility |
| --- | --- |
| `index.js` | Row entry: validates services, wires the modules below, mounts the RPC route, registers the agent tool, owns disposal (kernel, launches, store). Keeps `debug`/health state for verification. |
| `lib/rpc.js` | Prefix route: admission, envelope parse, 1 MiB body cap, endpoint dispatch table, multipart encoder, error mapping. |
| `lib/operations.js` | Shared operation layer behind **both** the RPC endpoints and the agent tool (create/open/save/saveAs/evaluate/restart/close), so the browser and the agent always observe the same store, revisions, path rules and kernel serialization; returns `{ value, attachments? }`. |
| `lib/errors.js` | Contract error vocabulary (`invalid_payload`, `path_denied`, `conflict`, `kernel_unavailable`/`kernel_timeout`, `syntax_error`, `evaluation_failed`, `launch_failed`, `forbidden`, …) and `toRpcError` conversion into the failure envelope. |
| `lib/paths.js` | Session resolution (`ctx.agents` + `ctx.workingDirectory`), default notebook dir (`<cwd>/notebooks`, fallback `$DSH_HOME/notebooks`), path validation (`path_denied`). |
| `lib/kernel-manager.js` | Vendored `kernel/kernel.js` + `kernel/detect.js`; lazy start, serialized evaluation queue, `evaluate(code, { timeoutSeconds, artifactPath })` with rendered-artifact capture (2 MiB cap), restart, status, dispose. |
| `lib/nb-codec.js` | Cell ⇄ `.nb` conversion (kernel `Export`/`Import`), import extraction and the editability decision for foreign notebooks. |
| `lib/store.js` | One document per `(sessionId, path)`: revisions, dirty tracking, 1.5 s auto-save debounce, serialized mutations shared by RPC and agent tool; output summaries for the agent tool. |
| `lib/tools.js` | `mathematica_notebook` tool definition and dispatch onto `lib/operations.js`. |
| `lib/launcher.js` | Native Mathematica locator and detached spawn for **Open in Mathematica**; `launch_failed` with a readable message. |

CONTRACT.md §8 names the required modules; the landed implementation splits the error envelope (`lib/errors.js`) and the shared operation layer (`lib/operations.js`) out of `lib/rpc.js`/`lib/tools.js` without changing the wire contract. The Host half **requires** the `tools` service and optionally injects `connection` + `webServer` for
the browser channel — a headless profile without a Web carrier keeps the agent tool and skips the
route.

## 4. Endpoints

Full request/value shapes are in [`CONTRACT.md` §2](../notebook/CONTRACT.md#2-endpoints). Summary:

| Endpoint | Purpose |
| --- | --- |
| `status` | Kernel state + current notebook `{path, revision, dirty, readOnly}` (+ `serverVersion`). |
| `list` | `*.nb` files in the default notebook dir. |
| `open` | Read a file into a notebook document; decides `origin` and `readOnly`. |
| `create` | Allocate `<default dir>/Untitled-N.nb` and write a valid empty `.nb` immediately. |
| `save` | Write cells with a revision precondition; stale `baseRevision` → `conflict` + current revision. |
| `saveAs` | Write a new `.nb` (used by read-only imports). |
| `evaluate` | Run cells (or `indices`) in the serialized kernel; per-cell ok/error, text, messages, duration and an optional rendered-artifact attachment. |
| `restartKernel` | Restart and return the new kernel status. |
| `openInMathematica` | Launch the native front end on the current `.nb`. |
| `close` | Flush pending save and release the store entry. |

## 5. `.nb` codec

- New notebooks are generated **by the kernel** (`Export[path, Notebook[{Cell[…]}]]`) so the file is
  a genuine Wolfram notebook, not a hand-written approximation.
- Opening reads with `Import[path, "NB"]` and maps cells: Wolfram `Cell[BoxData|InputForm, "Code"]`
  → `code` cells, text cells → `text` cells (v1 renders text read-only; no markdown editing).
- **Editability decision:** a foreign notebook is editable only when every non-output cell maps to a
  code/text cell; otherwise it opens `readOnly: true` and only **Save As** writes a new editable
  copy. Output cells and foreign styling are intentionally not round-tripped in v1.
- Rendered output: non-trivial results are exported **by the kernel** as an artifact through the
  bridge's frozen `artifactPath` option. The format is chosen up front from the evaluated code —
  **PNG** for 3D graphics and raster images (`Plot3D`, `ParametricPlot3D`, `Graphics3D`,
  `GraphicsComplex`, `Image`, …) and **SVG** for 2D graphics and symbolic results — and a result
  whose actual type disagrees with the guess is re-rendered once in the other format. The attachment
  is capped at 2 MiB; an oversized or failed render falls back to text only. When an artifact is
  attached the cell's `text` is a short placeholder (`[typeset output]` for RPC cells,
  `[typeset result rendered in the notebook]` for the agent tool) instead of tens of KB of
  `InputForm`; non-artifact text is truncated (4 000 characters per entry/tool result).
- The browser half sniffs the attachment bytes (`image/png` signature vs SVG markup) before
  creating an object URL, so a 3D PNG and a 2D SVG travel through the same multipart channel without
  wire-level MIME metadata; unrecognized bytes render no image (the text path stays).
- Outputs live in the in-memory document (and the wire attachment), never in the JSON session
  document; the `.nb` file stores cells.

## 6. Revision and conflict model

- One `revision` counter per stored notebook. Every Host-side mutation (save, evaluation result
  update, agent edit) increments it.
- `dirty` means in-memory changes are not on disk yet; a 1.5 s debounce auto-saves. The store
  serializes mutations, so RPC and agent-tool writes cannot interleave.
- The browser polls `status` every 2000 ms while a notebook tab is visible. On a revision change:
  without local dirty edits → silently reload; with local edits → banner offering reload or
  keep-local (a save then returns `conflict` and re-offers).
- The agent edits through the same store, so `revision` is the only change signal; the browser never
  reads files directly. Nothing watches the filesystem for external editors — a file changed by
  another program appears on the next `open`/reload.

## 7. Kernel lifecycle and the two-kernel rule

- `kernel/` is a **vendored copy** of the repository's shared bridge (`src/kernel.js`,
  `src/detect.js`). `node notebook/scripts/sync-kernel.mjs --check` (CI runs it) enforces
  byte-identity; edit the shared source, then re-vendor.
- Start is lazy (first evaluation or explicit status), the queue serializes calls, a timeout aborts
  evaluation and keeps the kernel usable, `restartKernel` kills and respawns, and disposal kills the
  process.
- **The notebook kernel and the `mcp__mathematica__*` MCP kernel are different processes.** The
  notebook plugin owns its kernel through this bridge; the MCP tools bundle owns a kernel inside its
  stdio server process. State, timeouts and restarts are independent, and both kernels can run at
  once. This keeps the two plugins independently installable, updatable and removable — at the cost
  of two kernel processes' memory and license seats. Documented for users in
  `notebook/README.md#two-kernels-not-one`.

## 8. Native launcher

`openInMathematica` locates a front end and spawns it detached on the current `.nb`:

- the target list (to confirm against `lib/launcher.js` when it lands) is derived from the same
  discovery inputs as the kernel (`MATHEMATICA_EXE`, `~/.mathematica-mcp.json`, standard install
  locations): `Mathematica.exe` / `WolframNB.exe` on Windows, `Mathematica.app` on macOS,
  `mathematica` / `WolframNB` on Linux;
- Wolfram Engine alone has no notebook front end, so the endpoint must return `launch_failed` with a
  readable message instead of a fake success;
- DSH cannot embed a native window; the launched application is external and independent of the DSH
  lifetime.

## 9. Paths, sessions and security

- Allowed roots: the session working directory (resolved through `ctx.agents` +
  `ctx.workingDirectory`) and `$DSH_HOME/notebooks`. Absolute paths must stay inside a root, end in
  `.nb`, and contain no `..` escape → otherwise `path_denied`.
- Relative paths resolve against the default notebook dir, created on demand; with no resolvable
  session the default is `$DSH_HOME/notebooks`.
- The RPC route is owner-peer only (`connection.admit`), POST-only, with a 1 MiB JSON body cap, hand
  validation of every payload, and a single `internal_error` mapping rather than leaking stacks.
- Arbitrary Wolfram Language code runs locally with the user's permissions — document it like shell
  access. No network requests are made by the plugin.

## 10. Browser-half registrations

Per [`CONTRACT.md` §7](../notebook/CONTRACT.md#7-client-registrations-browser-half):

- **Type A — page tab:** id `dsh-mathematica-notebook/page`, kind `mathematica-notebook`,
  `keepMounted`, `multiple`, localized title, one guide entry, body registered into the keyed slot
  `sidebar.right.pane.tab` under the same id. This guide entry is the primary launcher.
- **Type B — file resource:** id `dsh-mathematica-notebook/file`, kind
  `mathematica-notebook-file`, `patterns: ['*.nb']`, `priority: 'extension'`, `canOpen` restricted
  to `dsh-resource://file/…*.nb`, body registered under the same id — this makes `.nb` links open in
  a notebook tab.
- **Localization:** namespace `dshMathematicaNotebook` with `{ zh, en }` dictionaries registered
  through the Client locale service; all visible text goes through it.
- A left-footer launcher was prototyped and **removed**: the list-slot `inject` options that would
  carry the click handler are not accepted in this build. The guide entry is the supported launcher
  until a supported registration option exists.

## 11. Testing and CI layout

- `notebook/test/unit.test.js` — kernel-free Host tests (`node:test`): path rules, the store
  state machine with a fake codec, RPC envelope + multipart encoding, native launcher with fake
  filesystem/spawn, tool mapping, and plugin wiring against a fake Cordis context (27 tests).
- `notebook/test/kernel.test.js` — integration tests through the vendored bridge against a real
  Wolfram kernel: `.nb` codec cases (single/multi-statement, text, empty, unparseable), rendered
  artifact output, evaluation-error mapping and the store/operations end-to-end flow. They skip
  gracefully without a kernel and honour `MATHEMATICA_MCP_TEST_SKIP_KERNEL=1` (the CI workflow sets
  it).
- The browser half has no committed unit-test harness in this repository; during integration it was
  driven by an external fake-React + fake-Host harness over the real `client.js`, and the real
  browser UI still needs the manual checklist in `docs/publish-status.md`. Host behaviour is
  testable without a browser through `lib/*`.
- CI (`.github/workflows/ci.yml`) runs the Node 18/20/22 matrix (`node --test`), a server handshake
  smoke test, package/manifest/locale/icon validation for both bundles, `sync-server.mjs --check`,
  `sync-kernel.mjs --check`, the market-index validator, patch guardrails, and a check that this
  repository's workflow source stays in sync with `docs/ci-workflow.yml`.
- **Publishing route:** the publication credential cannot push `.github/workflows/**` (no `workflow`
  OAuth scope), so the runnable workflow source ships as
  [`docs/ci-workflow.yml`](ci-workflow.yml) and is copied to `.github/workflows/ci.yml` by a
  credential that has the scope. Both copies are edited together; a CI step verifies their bodies
  match. See `docs/publish-status.md` (E8).

<a id="roadmap"></a>

## 12. Known limitations and roadmap

| Area | v1 | Roadmap |
| --- | --- | --- |
| Cells | Code cells only; text cells render read-only | Markdown/text editing, cell insertion reordering |
| Outputs | Live document + rendered attachment (SVG for 2D/symbolic, PNG for 3D/raster); not written back to `.nb` | Write output cells back into the `.nb` |
| Kernel | One kernel per plugin | Shared kernel broker between notebook and MCP tools |
| Native window | External launch only | Not possible with the current DSH window model (documented non-goal) |
| Files | One default dir + session dir; no folder browser | Notebook dir picker, recent files |
| Collaboration | Owner browser peer only | Multi-session sharing (out of scope for v1) |
| Foreign `.nb` | Read-only unless fully mapped; Save As allowed | Styling-preserving round-trip |

## 13. Release status

`dsh-mathematica-notebook` **0.1.0 is published** in this repository and in the plugin-market
index (entry name = this package name, version `0.1.0`, install spec
`git+https://github.com/yhbcode000/mathematica-mcp.git#<pinned commit>&path:/notebook`). The
recorded evidence — release commit, market pin, validator output, live raw-index status, local
install checks — lives in
[`publish-status.md`](publish-status.md#notebook-plugin-published-010). Future versions add new
pinned `versions[]` entries without rewriting older ones. Do not mark release boxes before their
evidence exists.

## 14. Prior art and scope

This plugin is a UI integration for a locally licensed Wolfram kernel, not a new MCP server and not
a reimplementation of Wolfram's front end. The prior-art note in the root
[`README.md`](../README.md#prior-art-read-this-first) applies unchanged: the official
[Wolfram/AgentTools](https://github.com/WolframResearch/AgentTools) and the community DSH bundles
around it remain the reference implementations for model-facing Wolfram tools; this plugin's
distinct value is the **in-DSH sidebar notebook with real `.nb` files** and agent edits through the
same store.
