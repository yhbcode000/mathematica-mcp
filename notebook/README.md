# dsh-mathematica-notebook

An **interactive Mathematica notebook in the DeepSeek Harness (DSH) right sidebar**: run Wolfram
Language cells next to the chat, see typeset output, keep a real `.nb` file on disk, open it in
Mathematica, and let the agent create, edit and run notebooks through a tool.

It is the companion plugin to [`dsh-mathematica-mcp`](../dsh/README.md) (the `mcp__mathematica__*`
tools) and shares its requirements — but **not** its kernel process; see
[Two kernels, not one](#two-kernels-not-one).

## What you get

| Piece | What it does |
| --- | --- |
| **Sidebar notebook tab** | Open from the right sidebar (**New Mathematica notebook**) or by opening any `*.nb` file. Multiple notebook tabs are supported. |
| **Code cells** | Type Wolfram Language, run a cell (or all cells), see the result as text, typeset **SVG** (2D plots, formulas, tables) or a **PNG** image (3D graphics and raster images). `v1` supports code cells only. |
| **Persistent notebook kernel** | Definitions persist between cells and between agent calls until you restart the kernel. |
| **Real `.nb` files** | New notebooks are written immediately as valid Wolfram notebooks; saves keep a revision counter so the tab and the agent cannot silently overwrite each other. |
| **Open in Mathematica** | Hands the current `.nb` to your installed Mathematica front end (external window). |
| **Agent tool `mathematica_notebook`** | The agent can list, create, read, edit and run notebooks in the same store the tab uses — so a prompt like *"在 notebook 里加一节，导出这张图的 CSV"* works without switching windows. |
| **Web notebook (WLJS)** | The **Web notebook** toolbar button starts a local [WLJS Notebook](https://github.com/WLJSTeam/wljs-notebook) server and embeds it in a right-sidebar **Browser** tab: a full Wolfram frontend (`Manipulate`, `Dataset`, interactive 3D, Markdown/HTML/JS cells) computed by the local kernel. |

## Requirements

- A DSH profile whose Web UI includes the right sidebar (the shipped Desktop/Web profiles do).
- A **locally licensed Mathematica** or the free **Wolfram Engine** on the same machine. No cloud
  API, no API key — the same requirement as the MCP server in this repository.
- `git` on `PATH` only for a market install; a local-checkout install needs no git, no npm, and no
  build step. The plugin ships zero runtime dependencies (Node built-ins + the vendored kernel
  bridge).

## Install

### From the plugin market

Add the raw index URL in the DSH **Discover** tab (or Settings → Plugins → market sources):

```text
https://raw.githubusercontent.com/yhbcode000/mathematica-mcp/main/market/index.json
```

Then install **Mathematica Notebook** (`dsh-mathematica-notebook`). The install is a commit-pinned
git spec, so `git` must be available. The notebook plugin and the MCP tools plugin are separate
market entries — install either or both. The notebook plugin ships in the same index as `dsh-mathematica-notebook` 0.1.0; release evidence
(release commit, market pin, validator output) is tracked in
[`docs/publish-status.md`](../docs/publish-status.md#notebook-plugin-published-010).

### From a local checkout (no git required)

1. Keep the checkout somewhere permanent, for example `D:\tools\mathematica-mcp`.
2. Vendor the shared kernel bridge (must stay byte-identical to the repo root copy):

   ```powershell
   node notebook/scripts/sync-kernel.mjs
   ```

3. Install the bundle directory. With the agent, call `plugin_manager`:

   ```json
   { "action": "install_bundle", "target": "D:\\tools\\mathematica-mcp\\notebook" }
   ```

   Expect `application: "applied"` with HMR on, otherwise restart DSH.

There is no separate browser asset to build: the `dsh.client` manifest declares the browser half and
DSH's client module system serves `client.js`.

## First use

1. Open the **right sidebar** and choose **New Mathematica notebook** from the tab guide. The plugin
   creates `<notebook dir>/Untitled-N.nb` immediately (so nothing is lost if DSH closes).
2. Type Wolfram Language in a cell and run it (the cell's run control; the tab shows the
   shortcut it supports). The first run starts the kernel — allow a few seconds.
3. The result appears as text, and for rich results as a rendered image: typeset **SVG** for 2D/symbolic
   output (plots, formulas, tables) and **PNG** for 3D graphics and images. The cell text shows a short
   placeholder (for example `[typeset output]`) instead of the raw `InputForm`.
4. Save when you want to pin the revision, or let the 1.5 s auto-save debounce write to disk.
5. **Open in Mathematica** launches the file in your Mathematica front end for full
   typesetting, printing, and interactive manipulation.
6. Open an existing `.nb` from the sidebar file list or a `.nb` link; it appears in a new tab.

By default notebooks live in `<session working directory>/notebooks`, and in
`$DSH_HOME/notebooks` when no session directory can be resolved. Files outside these allowed roots
are refused (`path_denied`), and relative paths are resolved against the default notebook directory.

### Agent examples

Ask in natural language; the agent maps it onto `mathematica_notebook` actions:

- *"在 notebook 里新建一节，计算 2+2 并画一张 Plot[Sin[x], {x, 0, 2 Pi}]"*
- *"打开 notebooks/analysis.nb，读取单元格列表，把第 2 个单元格改成 …"*
- *"运行 notebook 里所有单元格，把结果整理成表格"*
- *"在 notebook 里加一节，用 CSV 导出刚才计算的数据"*

The tool's actions (`list` / `create` / `read` / `edit` / `run` / `debug`) are documented in
[CONTRACT.md](CONTRACT.md#5-agent-tool).

## Web notebook (WLJS, full compatibility)

The `.nb` tab renders rich output by attaching an SVG/PNG produced by the kernel — which covers 2D
graphics, formulas, tables and raster 3D, but cannot express `Manipulate`, event handlers,
`Dataset`, sound, or JavaScript/HTML/Markdown cells.

For those, press **Web notebook** in the tab toolbar. The Host starts
[WLJS Notebook](https://github.com/WLJSTeam/wljs-notebook) (AGPLv3) — an open-source, web-native
Wolfram Language frontend — on demand and opens it in a right-sidebar **Browser** tab:

- computed by this machine's Wolfram kernel; fully local, no cloud account;
- full frontend compatibility: interactive 3D, `Manipulate` controls, `Dataset`, images, sound,
  Markdown/HTML/JS/Mermaid/RevealJS cells, `.nb` import and standalone HTML export;
- the same notebook is reachable from the agent through the tool's `web*` actions
  (`webStatus`, `webStart`, `webOpen`, `webAddCells`, `webEvaluate`, `webKernelEvaluate`, …).

Setup (one time):

1. Download the WLJS Notebook **source archive** (`wljs-notebook-<version>.zip`, not the Electron
   installer) from the [releases page](https://github.com/WLJSTeam/wljs-notebook/releases) and
   extract it to one of: `$DSH_HOME/wljs-notebook`,
   `$DSH_HOME/artifacts/wljs-notebook/app/wljs-notebook-3.1.4`, or any directory pointed at by
   `WLJS_NOTEBOOK_DIR`.
2. Make sure `wolframscript` and a licensed Mathematica/Wolfram Engine are installed. WLJS starts
   with `wolframscript -f Scripts/start.wls`; Mathematica 14.1–15.0 is the tested range (15.0.1
   works with a version warning).
3. That is all — the button discovers the tree, starts the server on `127.0.0.1:20560` (loopback
   only), and stops it when the plugin unloads. Set `WLJS_HTTP_PORT` if the default port is taken
   (WLJS itself also accepts `Scripts/start.wls http <port> ws <port>` pairs).

The first open is the slow one (WLJS loads ~30 paclets; up to a minute). Notebooks created from the
button live in WLJS's quick-notes directory — save them from the WLJS UI to keep them.

## Two kernels, not one

This is important and intentional:

- The **notebook plugin** starts its own persistent Wolfram kernel through the vendored bridge in
  `notebook/kernel/` (`math.exe` / `WolframKernel`).
- The companion **`mcp__mathematica__*` tools** (from [`dsh-mathematica-mcp`](../dsh/README.md))
  start a **different** kernel process, owned by the stdio MCP server.

Consequences:

1. **State does not cross.** `a = 17` in a notebook cell is not visible to
   `mcp__mathematica__mathematica_evaluate`, and vice versa. Each has its own session, its own
   timeout, and its own restart button.
2. **Two kernels can run at the same time**, using two Wolfram kernels' worth of memory and license
   seats. On a single-user machine this is normally fine; if your Wolfram entitlement is tight, run
   only one of the two plugins or restart the unused kernel.
3. **Results move only through files.** To share a computed object, export it from one side
   (`mathematica_export` / a notebook `Export[...]`) and import it on the other.

A shared kernel broker is on the roadmap (see
[docs/notebook-plugin.md](../docs/notebook-plugin.md#roadmap)); v1 keeps the kernels independent so
the two plugins can be installed, uninstalled and updated separately.

## Configuration

Kernel discovery is shared with the MCP server and uses the same inputs:

1. `MATHEMATICA_EXE`, then `MATHEMATICA_KERNEL` environment variables;
2. `"kernelPath"` in `~/.mathematica-mcp.json`;
3. standard install locations, newest version first.

The plugin itself needs no configuration; its Host row is inserted with an empty `config: {}`.
Evaluation uses a default per-cell timeout of 60 seconds (the tool's `run` and the cell runner send
explicit timeouts when needed), and a timed-out evaluation is aborted while the kernel stays usable.

## Limitations (v1)

| Limit | Detail |
| --- | --- |
| **Code cells only** | Markdown/text sections and rich cell styling are not editable in v1. |
| **Foreign `.nb` imports are read-only** | A notebook whose cells cannot all be mapped to code/text is opened read-only; **Save As** is available to create an editable copy. Output cells and styling are not round-tripped. |
| **3D output is raster** | 3D graphics (`Plot3D`, `Graphics3D`, …) and images are attached as **PNG**, not vector SVG; 2D graphics and symbolic results use SVG. |
| **Output text is bounded** | When a rendered image is attached the cell text is a short placeholder; very large plain-text results are truncated (≤ 4000 characters in the agent tool, longer entries truncated on the wire). |
| **No output write-back to `.nb`** | Evaluated outputs are kept in the live notebook document; the `.nb` file stores cells. Re-run cells after reopening. |
| **External window for Mathematica** | "Open in Mathematica" launches your front end; a native notebook embedded inside DSH is not possible with the current DSH window model. |
| **Separate kernel** | See [Two kernels, not one](#two-kernels-not-one). |
| **WLJS is not bundled** | The full-compatibility web notebook needs a separate [WLJS Notebook](https://github.com/WLJSTeam/wljs-notebook) download (AGPLv3) plus `wolframscript`; without it the button reports `web_notebook_unavailable`, while the built-in `.nb` tab keeps working. |
| **Single user** | The RPC channel admits only the owner browser peer and filesystem access is limited to the session directory and `$DSH_HOME/notebooks`. |

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| No notebook tab or guide entry | The browser half did not mount: check that the bundle is enabled in Plugin Manager, then restart DSH (client halves load at page start). |
| `mcp__mathematica__*`-style tool missing (`mathematica_notebook`) | The Host half did not activate. Check DSH logs for `dsh-mathematica-notebook`; verify the bundle is installed. |
| "Kernel unavailable" | Mathematica/Wolfram Engine not installed or not licensed, or not detected: set `MATHEMATICA_EXE` (for example `C:\Program Files\Wolfram Research\Wolfram\15.0\math.exe`). |
| A 3D plot appears as an image, not vector graphics | Expected: 3D/raster results are PNG attachments; only 2D/symbolic results are SVG. |
| Cells run but the tab looks stale | The tab polls the Host every 2 s; if a banner appears, an external change (agent edit or another tab) conflicts with local edits — reload or save to resolve. |
| "Path denied" when opening/saving | Paths must end in `.nb` and stay inside the session directory or `$DSH_HOME/notebooks`. |
| Open in Mathematica fails | The launcher reports `launch_failed` when no front end is installed (Wolfram Engine alone has no notebook UI); open the file manually or install the Mathematica front end. |
| Bundle row fails to resolve its package name | Edit `notebook/cordis.patch.yml` and replace `name: 'dsh-mathematica-notebook'` with `name: './index.js'` (patch-relative file URL), then reload. |

## Uninstall

Use `plugin_manager` → `remove_bundle` with `dsh-mathematica-notebook` (the installed kernel keeps
running until the bundle is unloaded). Your `.nb` files on disk are untouched.

## Security

- The notebook runs **arbitrary Wolfram Language code** with your user's permissions — the same trust
  level as a local Mathematica session. Only open notebooks you trust.
- The browser channel (`/mathematica-notebook`) is authenticated and admits **only the owner browser
  peer**; other peers get 403 and non-POST methods get 405. Payloads are hand-validated.
- File access is restricted to the session working directory and `$DSH_HOME/notebooks`, with `.nb`
  extension and path-traversal checks.
- No network requests are made; everything is local.

## Files

```text
notebook/
├── index.js               # Host half: row entry, RPC channel mount, disposal
├── client.js              # browser half: sidebar tab type + guide + cell UI
├── lib/                   # Host modules (rpc, operations, errors, paths, kernel-manager, nb-codec, store, tools, launcher)
├── kernel/                # vendored copy of ../src/kernel.js + ../src/detect.js (generated)
├── scripts/sync-kernel.mjs
├── cordis.patch.yml       # bundle patch: one Host row
├── locale/{en,zh}.json    # Plugin Manager display metadata
├── icon.svg
└── CONTRACT.md            # Host/browser contract (source of truth)
```

`kernel/` is generated — change the shared bridge in `src/` and run
`node notebook/scripts/sync-kernel.mjs`. `node notebook/scripts/sync-kernel.mjs --check` verifies it
(CI runs this).

## Development

```bash
node notebook/scripts/sync-kernel.mjs          # vendor the kernel bridge
node --test                                    # all unit tests (repo root; skips kernel tests without a kernel)
MATHEMATICA_MCP_TEST_SKIP_KERNEL=1 node --test # force-skip kernel tests (CI mode)
```

Maintainer documentation — architecture, RPC envelope, `.nb` codec, revision model, native launcher,
security, roadmap: [`docs/notebook-plugin.md`](../docs/notebook-plugin.md).

## License and trademarks

MIT — see [LICENSE](../LICENSE).

**Separate licensing required:** using this plugin requires your own licensed **Mathematica** or
free **Wolfram Engine**; no Wolfram software is bundled or sublicensed.

"Wolfram", "Mathematica", "Wolfram Language" and "Wolfram Engine" are trademarks of Wolfram
Research, Inc. This project is not affiliated with, endorsed by, or sponsored by Wolfram Research.
DeepSeek Harness and DSH are part of the DeepSeek Harness project; this plugin is a community
integration.
