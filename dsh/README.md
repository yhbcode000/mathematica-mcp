# dsh-mathematica-mcp

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) **plugin bundle** that connects a
locally licensed **Mathematica** (or free Wolfram Engine) kernel to the agent as MCP tools.

The bundle vendors the zero-dependency [`mathematica-mcp`](../) stdio server and inserts the shipped
`@deepseek-ai/dsh-mcp-client` bridge for it, so after installation the agent can call:

| Tool | What it does |
| --- | --- |
| `mcp__mathematica__mathematica_evaluate` | Evaluate Wolfram Language code in a **persistent** kernel session and return the result. |
| `mcp__mathematica__mathematica_export` | Evaluate an expression and export it to `png` / `svg` / `pdf` / `csv` / `txt` / `json` / `tex`, returning the file path and size. |
| `mcp__mathematica__mathematica_kernel_status` | Report kernel status, restart the kernel, or interrupt a stuck evaluation. |
| `mcp__mathematica__mathematica_information` | Look up `Information` for symbols (usage, attributes, options). |

Kernel state persists between calls (`a = 17` then `a` returns `17`) until a restart, the kernel
process dies, or DSH restarts.

## Requirements

- A DSH profile (Desktop or CLI) that already provides `@deepseek-ai/dsh-mcp-client` — any shipped
  profile does.
- A licensed Mathematica installation, or a free
  [Wolfram Engine](https://www.wolfram.com/engine/), on the same machine. **No cloud API and no API
  key are used**; all evaluation happens in a local kernel process.
- **Node.js ≥ 18** reachable without a separate install: the bundle launches the server through the
  DSH process's own executable, which is Electron-as-Node on Desktop and `node` on a CLI install.

The kernel is auto-detected:

1. `MATHEMATICA_EXE` or `MATHEMATICA_KERNEL` environment variable,
2. `"kernelPath"` in `~/.mathematica-mcp.json`,
3. the usual install locations (on Windows the newest
   `C:\Program Files\Wolfram Research\Wolfram\<version>\math.exe` and
   `…\Mathematica\<version>\math.exe`; on macOS/Linux the standard Wolfram/Mathematica paths).

If detection fails, the tools return an actionable error instead of crashing the server; point them
at a kernel with `MATHEMATICA_EXE`.

## Install

### From a local checkout (no git required)

1. Sync the vendored server and install the bundle directory:

   ```powershell
   node dsh/scripts/sync-server.mjs     # copies bin/ + src/ into dsh/server/
   ```

2. Ask the agent to install the bundle, or call `plugin_manager` yourself:

   ```json
   { "action": "install_bundle", "target": "D:\\path\\to\\mathematica-mcp\\dsh" }
   ```

   The plugin manager installs it into the profile's `node_modules` and enables it. Changes apply
   live when HMR is on, otherwise restart DSH.

### From the plugin market (git)

Add the raw index URL
`https://raw.githubusercontent.com/yhbcode000/mathematica-mcp/main/market/index.json` in the
**Discover** tab (or Settings → Plugins → market sources), then install **Mathematica MCP**. The
market install is a commit-pinned git spec, so it requires **git** on `PATH` (any Git installation;
`git --version` must work). If you cannot install git, use the local-checkout or manual steps.

### Manual configuration (any DSH install, no plugin manager)

Append this row to your profile's `cordis.patch.yml`
(`$DSH_HOME/profiles/<profile>/cordis.patch.yml`), replacing `<REPO>` with this checkout path:

```yaml
- insert:
    - id: mcp-mathematica
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: mathematica
        transport: stdio
        command: !!js process.execPath
        args:
          - !!js >-
              (() => {
                const url = new URL('node_modules/dsh-mathematica-mcp/server/bin/mathematica-mcp.js', ctx.baseUrl);
                return decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1');
              })()
        env:
          ELECTRON_RUN_AS_NODE: '1'
        failOnStartupError: false
        toolCallTimeoutMs: 180000
```

Or, if you would rather not install the bundle at all, point the same `@deepseek-ai/dsh-mcp-client`
row at the checkout directly:

```yaml
- insert:
    - id: mcp-mathematica
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: mathematica
        transport: stdio
        command: node                      # or an absolute node.exe path
        args: ['D:/path/to/mathematica-mcp/bin/mathematica-mcp.js']
        toolCallTimeoutMs: 180000
```

## How the launch works

DSH evaluates the patch's `!!js` expressions inside the Host process, where `process`, `ctx` and the
Loader's `baseUrl` are available (but not `require`, `fs`, or `__dirname`).

- **command** = `process.execPath` — the DSH process's own executable. DSH Desktop is an Electron
  app; `ELECTRON_RUN_AS_NODE: '1'` makes it start as plain Node, which is exactly how DSH launches
  its own Node subprocesses. A CLI install (`dsh` from npm) runs under plain `node`, where the
  variable is ignored.
- **args[0]** = the installed server entry, resolved from `ctx.baseUrl` — dsh-app-boot anchors
  `baseUrl` at the profile directory, and a bundle always installs to
  `<profile>/node_modules/<package-name>/`. No install path is hardcoded, so the bundle works in
  any DSH profile directory.
- **cwd** = the installed bundle root.

Overrides, if auto-detection ever fails:

| Variable | Effect |
| --- | --- |
| `MATHEMATICA_MCP_SERVER_ENTRY` | Absolute path to `mathematica-mcp.js` to run instead of the bundled copy. |
| `MATHEMATICA_MCP_NODE` | Executable used to launch the server (for example an absolute `node.exe`). |
| `MATHEMATICA_EXE` / `MATHEMATICA_KERNEL` | Mathematica kernel executable. |
| `~/.mathematica-mcp.json` | `{"kernelPath": "…"}` fallback for the kernel executable. |

Set them in the environment DSH runs in or in `$DSH_HOME/.env`, then reload the plugin.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| No `mcp__mathematica__*` tools appear | The entry stayed inactive. Check the DSH log for `mcp-mathematica`; verify the bundle is installed (`node_modules/dsh-mathematica-mcp` inside the profile) and that DSH was restarted after a non-HMR install. |
| `ENOENT` spawning the server | The resolved entry path does not exist. Set `MATHEMATICA_MCP_SERVER_ENTRY` to the checkout's `bin/mathematica-mcp.js`. |
| Tools return "kernel not found" | Install Mathematica/Wolfram Engine or set `MATHEMATICA_EXE`; on Windows an example is `C:\Program Files\Wolfram Research\Wolfram\15.0\math.exe`. |
| First evaluation is slow | The kernel is spawned and warmed lazily on first use and kept alive afterwards. |
| Evaluation reports `$Aborted` | The call hit `timeout_seconds`; raise it, or restart the kernel with `mathematica_kernel_status`. |
| Market install fails with `git` errors | The git entry needs `git` on `PATH`. Install Git or use the local-checkout/manual path above. |

## Prior art and alternatives

DSH-specific Wolfram integrations already exist, and the official Wolfram tooling is usable from
DSH too. Use whichever fits your setup — this bundle is one option, not the only one.

| Option | What it is | Notes |
| --- | --- | --- |
| [WolframResearch/AgentTools](https://github.com/WolframResearch/AgentTools) (official) | Wolfram Research's Wolfram-Language MCP server, distributed as a paclet (v2.2.0 verified working headless on this machine: stdio `initialize` + `tools/list` in ~2.8 s, a `tools/call` in ~3.9 s) | Official component. Needs the AgentTools paclet installed into your Wolfram product; can be wired into DSH directly with an `@deepseek-ai/dsh-mcp-client` row (see [dsh-install.md](../docs/dsh-install.md#official-wolfram-agenttools-direct-option)). |
| [Zhen-WushuiLingchun/dsh-wolfram-bundle](https://github.com/Zhen-WushuiLingchun/dsh-wolfram-bundle) | MIT DSH bundle wrapping the official AgentTools server (7 tools, verified against AgentTools 2.2.0) | Closest prior art for a DSH bundle; requires the Wolfram paclet like AgentTools itself. |
| [hatter123/dsh-wolfram](https://github.com/hatter123/dsh-wolfram) | Minimal zero-dependency DSH plugin exposing one tool through `wolframscript -code` | Lightweight single-tool option. |
| **this bundle** (`dsh-mathematica-mcp`) | Standalone zero-dependency Node MCP server (also usable from Claude Desktop/Cursor/any MCP client) + DSH bundle + market index | No Wolfram paclet, no `npm install`; persistent kernel state between calls; graphics/data export (`png`/`svg`/`pdf`/`csv`/`txt`/`json`/`tex`); kernel status/restart/interrupt. |

Positioning, factually: this project's differentiators are the **standalone generic stdio server**
(works with any MCP client, zero runtime dependencies, no Wolfram paclet), **persistent kernel
state**, **graphics/data export**, and shipping a **DSH bundle plus a plugin-market index**. It is
not claimed to be the first or only Mathematica/Wolfram MCP integration.

## Security

The tools evaluate **arbitrary Wolfram Language code** in a local kernel with your user's
permissions — the same trust level as running `wolframscript`. Only enable this plugin in profiles
where you are comfortable with that, and review the code the agent intends to run. The server
accepts no network input; it communicates only over stdio with DSH.

## Files

```
dsh/
├── cordis.patch.yml     # Loader patch inserting the MCP client row
├── locale/{en,zh}.json  # plugin display metadata
├── icon.svg             # plugin icon
├── server/              # generated copy of ../bin + ../src + package.json (do not edit by hand)
└── scripts/sync-server.mjs
```

`server/` is generated: change the server at the repository root, then run
`node dsh/scripts/sync-server.mjs`. It includes the server's `package.json` because
`src/server.js` reads `../package.json` for its name/version metadata. `node
dsh/scripts/sync-server.mjs --check` verifies the copy is current (CI does this).

## License

MIT — see [LICENSE](../LICENSE).

**Separate licensing required:** this software is MIT-licensed, but using it requires your own
licensed **Mathematica** installation or a free **Wolfram Engine** (with an activated Wolfram
license). No Wolfram license is bundled or sublicensed here.

"Wolfram", "Mathematica", "Wolfram Language" and "Wolfram Engine" are trademarks of Wolfram
Research, Inc. This project is not affiliated with, sponsored by, or endorsed by Wolfram Research.
