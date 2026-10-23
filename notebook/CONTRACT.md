# dsh-mathematica-notebook 鈥?Host/Client contract (v1.1)

This file is the single source of truth shared by the Host half (`index.js` + `lib/`) and the
browser half (`client.js`). Keep both sides in sync with it; change it in one commit with both
implementations.

## 1. Channel

- Browser: `ctx.connection.rpc.call('/mathematica-notebook', endpoint, payload, signal?)`
- Host: mounted by the plugin at the same path with `webServer.register({ kind: 'prefix' })` and
  admitted through `ctx.connection.admit({ headers })` (owner browser Peer only). Envelope is the
  `connection.rpc.call` envelope: request `{type:'client-request', rpcId, method, payload}`, response
  `{type:'server-response', rpcId, result}` with `result = {ok:true, value, attachments?} | {ok:false, error:{code,message,details}}`.
- Binary results: response stays JSON for `value` with placeholders `null`, plus an `attachments`
  array `[{ path: string|number[], codec: 'bytes', part: 'p0', bytes: Uint8Array }]`; respond with
  `multipart/form-data` where the `metadata` part is the JSON envelope and `p0鈥 are the bytes.
  The browser connection's multipart parser replaces the null placeholders with `Uint8Array`.
- Non-owner peers and non-POST methods are refused (403 / 405). Payloads are hand-validated; malformed
  input returns `invalid_payload`.

## 2. Endpoints

### status
Request: `{ sessionId?: string, path?: string }`
Value:
```json
{
  "ok": true,
  "kernel": { "state": "stopped|starting|running|busy|unavailable", "path": string|null, "version": string|null },
  "notebook": { "path": string, "revision": number, "dirty": boolean, "readOnly": boolean } | null,
  "serverVersion": "0.1.0"
}
```

### list
Request: `{ sessionId: string }`
Value: `{ dir: string, files: [{ path, name, size, mtimeMs }] }` 鈥?`*.nb` only, default notebook dir.

### open
Request: `{ sessionId: string, path: string }`
Value:
```json
{ "notebook": {
    "id": "n1", "path": "/abs/notebook.nb", "origin": "created|imported",
    "readOnly": false, "revision": 3, "dirty": false, "title": "notebook",
    "cells": [ { "id": "c1", "kind": "code|text", "code": "Plot[x,{x,0,1}]",
                 "outputs": [ { "type": "text|svg|msg", "text": string|null } ] } ]
} }
```
- New files are created by the plugin; imported `.nb` files become editable only when every non-output
  cell maps to a code/text cell (otherwise `readOnly: true`, with `saveAs` allowed).

### create
Request: `{ sessionId: string }`
Value: `{ notebook }` (as `open`) 鈥?allocates `<default dir>/Untitled-N.nb` and writes an empty valid
`.nb` immediately (auto-saved).

### save
Request: `{ sessionId, path, cells: [{id,kind,code}], baseRevision: number }`
Value: `{ path, revision }`. If `baseRevision` is stale 鈫?`error.code = "conflict"` and
`error.details = { revision }`; the client reloads/merges per the banner rule.

### saveAs
Request: `{ sessionId, path, name: string, cells: [{id,kind,code}] }`
Value: `{ notebook }` 鈥?writes a new `.nb` next to `path` (or in the default dir), returns the new
document. Used by read-only imports.

### evaluate
Request: `{ sessionId, path, cells?: [{id, code, timeoutSeconds?}], indices?: number[] }`
Value:
```json
{ "ok": true, "cells": [
  { "id": "c1", "ok": true, "text": "2", "messages": [], "durationMs": 4,
    "svg": null, "svgBytes": null } ] }
```
- `svg` is a placeholder path `["cells",0,"svg"]` only in the attachments variant; in JSON-only
  responses it is `null`. The Host renders typeset SVG (鈮? MiB) for non-trivial results and returns
  it as a binary attachment; oversized/failed keeps `null` and text only.
- `ok:false` entries carry `error: {code, message}` (`kernel_unavailable`, `kernel_timeout`,
  `syntax_error`, `evaluation_failed`) while the remaining cells still run.
- The kernel is serialized; evaluation is aborted at `timeoutSeconds` (default 60) and stays usable.

### restartKernel
Request: `{}` 鈫?Value: `{ kernel }` (as `status.kernel`).

### openInMathematica
Request: `{ sessionId, path }` 鈫?Value: `{ launched: true, executable: string, pid?: number }` or
`error.code = "launch_failed"` with a user-readable `message`.

### close
Request: `{ sessionId, path }` 鈫?Value: `{ closed: true }` (flush pending save, release store entry).

### webStatus / webStart / webStop
- `webStatus` `{}` 鈫?Value: `{ enabled, available, root, version, wolframscript, running, ready, pid, url, lastNotebook, lastError, logTail }`.
  Never throws for a missing installation (`available: false`).
- `webStart` `{}` 鈫?Value: the same status after `ensureRunning()` (starts `Scripts/start.wls` on demand, waits for HTTP).
- `webStop` `{}` 鈫?Value: `{ stopped, status }` (taskkill of the WLJS process tree on Windows).

### webOpen
Request: `{ sessionId?, fresh?: boolean }` 鈫?Value: `{ url, notebookId, created }`.
Reuses the last notebook unless `fresh`; the browser half opens `url` in a right-sidebar Browser tab.

### webListNotebooks / webNewNotebook
`{}` 鈫?`{ notebooks: [...] }` / `{ id, pathEncoded, url }`.

### webSeed
Request: `{ notebook }` 鈫?Value: `{ notebook, cells: [ids], evaluated: [{cell, ok, output?, error?}] }`.
Waits for the notebook to be ready, appends an intro `.md` cell plus sample cells, then evaluates the samples.

### webListCells / webAddCells
- `webListCells` `{ notebook }` 鈫?`{ cells: [{Id, Type, Display, Lines, FirstLine}] }`.
- `webAddCells` `{ notebook, cells: [{content}] }` 鈫?`{ notebook, Created: [ids], Count }`.
  Cell `content` may start with a WLJS type marker (`.md`, `.html`, `.js`, `.mermaid`, 鈥?.

### webEvaluate / webKernelEvaluate
- `webEvaluate` `{ cell, timeLimit?, maxCharacters?, summarize? }` 鈫?`{ cell, output: [output cell ids/records] }`.
- `webKernelEvaluate` `{ expression, kernel?, timeLimit?, maxCharacters? }` 鈫?`{ result }`.
- Failures: `error.code = "web_notebook_unavailable"` (not installed/disabled) or `"web_notebook_failed"`.

## 3. Revision / sync / conflict rules

- One `revision` per stored notebook; every Host-side mutation (save, evaluate result update, agent
  edit) increments it. `dirty` means in-memory changes are not yet on disk (auto-save debounce 1.5 s).
- The client polls `status` every 2000 ms while a notebook tab is visible. If `revision` differs from
  the rendered revision: without local dirty edits 鈫?silently reload `open`; with local dirty edits 鈫?  show a banner offering reload or keep-local (save returns conflict and re-offers).
- The agent tool edits through the same store, so `revision` is the only change signal; the client does
  not read files directly.

## 4. Data model

- `NotebookDoc`: `{ id, sessionId, path, origin, readOnly, cells, revision, savedRevision, dirty, createdAt, mtimeMs }`
- `Cell`: `{ id, kind: 'code'|'text', code: string, outputs?: Output[], stale?: boolean }`
- `Output`: `{ type: 'text'|'svg'|'msg', text?: string, svgPath?: string|null }` 鈥?`svg` bytes are only
  returned over the wire (never stored in the JSON session document).
- `.nb` files are real Wolfram notebook files generated by the kernel (`Export[path, Notebook[...]]`)
  and parsed back with `Import[path, "NB"]`; v1 stores code/text cells only and does not round-trip
  foreign styling/output cells (read-only import path).

## 5. Agent tool

`mathematica_notebook` (registered by the Host half, `ctx.tools.register`):
- `{ action: 'list', sessionId? }` 鈫?notebook list
- `{ action: 'create', cells?: [{code}] }` 鈫?new notebook `{path, cells}`
- `{ action: 'read', path, includeOutputs?: true }` 鈫?`{path, cells:[{id,kind,code,outputSummary}], readOnly}`
- `{ action: 'edit', path, operations: [{op:'insert'|'replace'|'delete', index?, code?}] }` 鈫?`{path, revision}`
- `{ action: 'run', path, indices?: number[] }` 鈫?`{path, results:[{index, ok, text, messages, durationMs}]}`
- `{ action: 'debug' }` 鈫?plugin/RPC health + `webNotebook` status (kept for verification; small)
- `{ action: 'webStatus' | 'webStart' | 'webStop' | 'webOpen', fresh? }` 鈫?WLJS web-notebook runtime controls
- `{ action: 'webListNotebooks' | 'webNewNotebook' | 'webSeed', notebook? }` 鈫?WLJS notebook creation/listing
- `{ action: 'webListCells', notebook }` / `{ action: 'webAddCells', notebook, webCells: [{content}] }` 鈫?WLJS cell IO
- `{ action: 'webEvaluate', cell, timeLimit?, maxCharacters? }` / `{ action: 'webKernelEvaluate', expression }` 鈫?WLJS evaluation

The tool maps 1:1 onto the same Host operations as the RPC endpoints; it never opens UI and never
writes outside the allowed roots.

## 6. Path rules

- Allowed roots: the Session working directory (resolved via `ctx.agents.get(sessionId)` +
  `ctx.workingDirectory.get(session)`) and `$DSH_HOME/notebooks`. Relative paths resolve against the
  default notebook dir (`<cwd>/notebooks`, created on demand); absolute paths must be inside an
  allowed root, end with `.nb`, and carry no `..` escape. Refusals: `error.code = "path_denied"`.
- Default notebook dir fallback when no Session can be resolved: `$DSH_HOME/notebooks`.

## 7. Client registrations (browser half)

- Type A 鈥?page: `id: "dsh-mathematica-notebook/page"`, `kind: "mathematica-notebook"`,
  `keepMounted: true`, `multiple: true`, `title: () => t('tab.title')`,
  `guide: [{ id: 'new', title: () => t('guide.title'), description: () => t('guide.description') }]`,
  body registered in keyed slot `sidebar.right.pane.tab` under the same id.
- Type B 鈥?file resource: `id: "dsh-mathematica-notebook/file"`, `kind: "mathematica-notebook-file"`,
  `patterns: ['*.nb']`, `priority: "extension"`, `canOpen: address => /^dsh-resource:\/\/file\//.test(address) && /\.nb([?#]|$)/i.test(address)`,
  `title: basename`, body registered under the same id.
- Type A body toolbar carries **Web notebook**: `webOpen` 鈫?`ctx.sidebarRight.openTab('browser', { params: { url } })`.
  The compatibility notebook therefore runs in the shipped Browser carrier (Electron `<webview>` on
  Desktop, iframe on Web) instead of being re-rendered by this plugin; no second browser surface is
  added by this package.
- If the notebook was just created (`created: true`), the body fires `webSeed` best-effort 2.5 s later.
- Body component receives the standard slot props and the owner-injected `inject: (sessionId, actions) => ({ call, ... })`
  helpers; it reads its tab through the framework-injected `useTabInfo()` and uses `t` from `locale: NS`.
- Launcher: the guide entry is the primary entry. An additional left-footer launcher may be added once
  a supported registration option carries the click handler (the spike proved list-slot `inject`
  options are not accepted in this build).
- Localization: dictionary namespace `dshMathematicaNotebook` registered with `{ zh, en }`; keys used by
  both the UI and guide cards.

## 8. Host module layout (contract for the consumers above)

- `lib/rpc.js` 鈥?route mount (admission + envelope + multipart encoder), endpoint dispatch table.
- `lib/paths.js` 鈥?session resolution, default dir, path validation.
- `lib/kernel-manager.js` 鈥?vendored `kernel/kernel.js` bridge + `kernel/detect.js` probing, serialized
  evaluation, `evaluate(code, { timeoutSeconds, artifactPath })`, restart, status, dispose.
- `lib/nb-codec.js` 鈥?cell 鈬?`.nb` codec, import extraction, editability decision, typeset SVG rendering.
- `lib/store.js` 鈥?per (sessionId, path) documents, revisions, dirty/auto-save, serialized mutations.
- `lib/tools.js` 鈥?the `mathematica_notebook` tool definition + dispatch to the same operations.
- `lib/launcher.js` 鈥?native Mathematica/WolframNB locator + detached spawn.
- `lib/web-notebook.js` 鈥?WLJS installation discovery, server process lifetime (`wolframscript -f
  Scripts/start.wls`, HTTP 127.0.0.1:20560), and the WLJS JSON API client (`/api/notebook/...`,
  promise envelopes through `/api/promise/`).
- `index.js` 鈥?wire modules, keep `debug` for verification, own disposal (including the WLJS server).
- The vendored `kernel/` copy must stay byte-identical to `../src/kernel.js` and `../src/detect.js`
  (`node notebook/scripts/sync-kernel.mjs --check`).

## 9. WLJS web notebook (compatibility path)

The `.nb` tab above is this plugin's own renderer: two dimensions and symbolic output are
typeset to SVG and 3D output to PNG, which cannot represent `Manipulate`, event handlers,
`Dataset`, sound, JavaScript/HTML cells, or any other dynamic frontend feature.

For those, the plugin embeds **WLJS Notebook** (AGPLv3, https://github.com/WLJSTeam/wljs-notebook),
an open-source web-native Wolfram Language notebook frontend that computes with the *local*
Wolfram Engine 鈥?i.e. the "web notebook on this computer" path. The plugin owns only the server
lifetime and the cell API; the UI is the real WLJS frontend inside a shipped Browser tab.

Rules:

- **Discovery** (no config required): `webNotebook.root` 鈫?`$WLJS_NOTEBOOK_DIR` 鈫?  `$DSH_HOME/wljs-notebook` 鈫?`$DSH_HOME/wljs-notebook-3.1.4` 鈫?`$DSH_HOME/apps/wljs-notebook-3.1.4`
  鈫?`$DSH_HOME/artifacts/wljs-notebook/app/wljs-notebook-3.1.4` 鈫?`$DSH_HOME/artifacts/wljs-notebook/app`
  鈫?`%LOCALAPPDATA%/Programs/WLJS Notebook/resources/app`. A valid root has
  `Scripts/start.wls` + `package.json`.
- **Process**: `<wolframscript> -f Scripts/start.wls` with `cwd` at the root; the script serves
  `http://127.0.0.1:20560/` (ports overridable with the script's own `key value` argv pairs).
  `WLJS_HTTP_PORT` overrides the port this plugin talks to. One server is shared by every tab and
  by the agent tool; it is stopped on plugin dispose.
- **API**: only `POST /api/notebook/...` JSON endpoints are used; a `{Promise}` envelope is polled
  through `POST /api/promise/` until `{ReadyQ: true, Result}`. `WLJS_READ_ONLY`-style hardening and
  the WLJS MCP server are *not* used by this plugin 鈥?the agent reaches the same notebook through
  `mathematica_notebook`'s `web*` actions instead of a second MCP connection.
- **Failure modes**: not installed/disabled 鈫?`web_notebook_unavailable` (with the searched roots);
  start timeout, early exit or API error 鈫?`web_notebook_failed` (with `logTail`).
- **Security**: the WLJS server binds loopback only and is started by the owner Host process; the
  embedded page is loaded by the shipped Browser carrier, which keeps it in its own origin. The
  plugin never executes WLJS-served script in the Host.
