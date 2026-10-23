# Install Mathematica MCP in DeepSeek Harness (DSH)

This guide installs [`dsh-mathematica-mcp`](../dsh/README.md), which connects a **local Mathematica
kernel** (or free Wolfram Engine) to DSH. When it is active the agent can call:

| Tool | Purpose |
| --- | --- |
| `mcp__mathematica__mathematica_evaluate` | Evaluate Wolfram Language in a persistent kernel. |
| `mcp__mathematica__mathematica_export` | Export an expression to `png`/`svg`/`pdf`/`csv`/`txt`/`json`/`tex`. |
| `mcp__mathematica__mathematica_kernel_status` | Kernel status / restart / interrupt. |
| `mcp__mathematica__mathematica_information` | `Information[...]` for symbols. |

## Prerequisites

| Requirement | Why |
| --- | --- |
| A DSH profile (Desktop app or `dsh` CLI ≥ 0.2.0) | The bundle inserts the shipped `@deepseek-ai/dsh-mcp-client` bridge. |
| A licensed **Mathematica** or **Wolfram Engine** on the same machine | Evaluation happens in a local kernel; no cloud API is used. |
| Node.js ≥ 18 | The server is zero-dependency Node. On DSH Desktop you do **not** install Node: the bundle launches it through DSH's own Electron-as-Node executable. |
| `git` (market-path installs only) | A market install is a commit-pinned `git+https` package spec; DSH calls `git ls-remote` and pnpm clones the repo. |

## Option A — from the plugin market (Discover)

1. Open the DSH Web UI → **Discover** (or Settings → Plugins → market sources).
2. Add this index URL exactly (no redirects, no query, no fragment):

   ```text
   https://raw.githubusercontent.com/yhbcode000/mathematica-mcp/main/market/index.json
   ```

3. Find **Mathematica MCP** and install it. DSH installs
   `git+https://github.com/yhbcode000/mathematica-mcp.git#<commit>&path:/dsh`, selects the bundle,
   and applies it live when HMR is on (otherwise restart DSH).
4. Call a tool, for example ask the agent to run `2+2` with Mathematica, or invoke
   `mcp__mathematica__mathematica_evaluate`.

Indexes are cached for 10 minutes; a just-published version can take that long to show up.

## Option B — from a local checkout (no git required)

1. Clone or download this repository somewhere permanent, for example
   `D:\tools\mathematica-mcp`.
2. Make the vendored server copy current:

   ```powershell
   node D:\tools\mathematica-mcp\dsh\scripts\sync-server.mjs
   ```

3. Install the bundle directory. With the agent, call `plugin_manager`:

   ```json
   { "action": "install_bundle", "target": "D:\\tools\\mathematica-mcp\\dsh" }
   ```

   Or from a shell with the CLI:

   ```powershell
   dsh plugin --profile <profile> add link:D:\tools\mathematica-mcp\dsh
   ```

   The plugin manager records a `link:` dependency, installs it into the profile's
   `node_modules`, and enables the bundle.
4. Expect `application: "applied"` (HMR) or `restart-required`. Then verify the tools appear and a
   call succeeds.

Because a `link:` install points at your checkout, `dsh/server/` must stay in sync with the root
`bin/` + `src/` — re-run `sync-server.mjs` after updating the server and restart DSH.

## Official Wolfram AgentTools direct option

If you prefer Wolfram Research's own MCP server (the `Wolfram/AgentTools` paclet) instead of this
package, you can wire it into DSH without any bundle — it is the same `@deepseek-ai/dsh-mcp-client`
row pointed at a Wolfram kernel running the AgentTools MCP server. It requires the AgentTools
paclet installed in your Wolfram product (v2.2.0 verified working headless on this machine).

```yaml
- insert:
    - id: mcp-wolfram-agenttools
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: wolfram
        transport: stdio
        command: 'C:/Program Files/Wolfram Research/Wolfram/15.0/wolfram.exe'
        args:
          - '-run'
          - 'PacletSymbol["Wolfram/AgentTools", "Wolfram`AgentTools`StartMCPServer"][]'
          - '-noinit'
          - '-noprompt'
        env:
          MCP_SERVER_NAME: WolframLanguage
        toolCallTimeoutMs: 180000
```

That gives `mcp__wolfram__*` tools. This is the **official-component** option: it depends on the
AgentTools paclet and on a `wolfram.exe`/kernel path for your product, and it is not installed or
supported by this repository. Prior art for DSH bundles around it:
[Zhen-WushuiLingchun/dsh-wolfram-bundle](https://github.com/Zhen-WushuiLingchun/dsh-wolfram-bundle)
(bundle wrapper) and [hatter123/dsh-wolfram](https://github.com/hatter123/dsh-wolfram) (single tool
via `wolframscript -code`).

## Option C — manual `cordis.patch.yml` row (no bundle install)

Any DSH install can wire the server directly. Append to
`$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: mcp-mathematica
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: mathematica
        transport: stdio
        command: node
        args: ['D:/tools/mathematica-mcp/bin/mathematica-mcp.js']
        toolCallTimeoutMs: 180000
```

`command: node` requires `node` on PATH. To use DSH's own runtime instead (Desktop has no `node` on
PATH), mirror what the bundle does:

```yaml
        command: !!js process.execPath
        env:
          ELECTRON_RUN_AS_NODE: '1'
        args:
          - 'D:/tools/mathematica-mcp/bin/mathematica-mcp.js'
```

Apply with HMR (edit the file; the running profile reloads) or restart DSH. This variant is also the
fallback for environments where `git` is unavailable and the plugin manager's market path cannot
be used.

## Verify the installation

1. The plugin is active: `plugin_manager` → `list_plugins` shows a row `mcp-mathematica` (name
   `@deepseek-ai/dsh-mcp-client`) with `fiberPhase` indicating a live fiber; `list_bundles` shows
   `dsh-mathematica-mcp`.
2. The tools exist: ask the agent to evaluate `2+2` in Mathematica, or check the tool list for
   `mcp__mathematica__mathematica_evaluate` … `mcp__mathematica__mathematica_information`.
3. A real kernel call works: `mcp__mathematica__mathematica_evaluate` with
   `{"code": "N[Pi, 30]"}` returns `3.14159265358979323846264338328`.

## Kernel configuration

Priority order:

1. `MATHEMATICA_EXE` then `MATHEMATICA_KERNEL` environment variables,
2. `"kernelPath"` in `~/.mathematica-mcp.json`,
3. standard install locations (newest version first).

Without an explicit override, each candidate is started once and briefly probed. Desktop Mathematica
kernels are preferred, and an **activated Wolfram Engine** is the automatic fallback: it is used when
Mathematica is not installed or its kernel is unlicensed/unusable. The cached choice is revalidated
before every call — if the kernel executable disappears (Mathematica removed or upgraded), the server
re-detects candidates on the next call, so the Engine can take over without restarting DSH. To prefer
the Engine while Mathematica is also installed, set `MATHEMATICA_EXE` to
`C:\Program Files\Wolfram Research\Wolfram Engine\15.0\math.exe`.

Set an environment variable globally, or put it in `$DSH_HOME/.env` (DSH loads the Harness-home
`.env`; variables that decide process startup such as `PATH`/`DSH_*` are rejected there, but
`MATHEMATICA_EXE` is fine), or configure a non-standard kernel through the JSON file:

```json
{ "kernelPath": "C:/Program Files/Wolfram Research/Wolfram/15.0/math.exe" }
```

`MATHEMATICA_MCP_NODE` and `MATHEMATICA_MCP_SERVER_ENTRY` override the launch executable and the
server entry path respectively; they exist only for unusual layouts.

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| No `mcp__mathematica__*` tools | Bundle not installed/enabled, or install needs a restart (HMR off). Check `plugin_manager` `list_plugins` and DSH logs for `mcp-mathematica`. |
| Entry inactive with a config/`!!js` error | The expression could not resolve the server path. Set `MATHEMATICA_MCP_SERVER_ENTRY` to `<checkout>/server/bin/mathematica-mcp.js` or to the installed `node_modules/dsh-mathematica-mcp/server/bin/mathematica-mcp.js`. |
| Spawn `ENOENT` for the server | Same as above; also verify `node_modules/dsh-mathematica-mcp/server/bin/mathematica-mcp.js` exists in the profile (a `link:` install needs `dsh/server/` synced). |
| `kernel not found` / license error from tools | Mathematica/Wolfram Engine not installed, not licensed, or not findable: set `MATHEMATICA_EXE`. Wolfram Engine requires activating a free license once. |
| Tools stopped working after Mathematica was removed | Not a problem: the next call re-detects candidates and falls back to an activated Wolfram Engine. If it still fails, restart the kernel with `mathematica_kernel_status {"action":"restart"}` or set `MATHEMATICA_EXE` to the Engine `math.exe`. |
| Market install fails mentioning `git` | Install Git (ensure `git --version` works in the DSH environment) or use Option B/C. |
| `$Aborted` results | Evaluation exceeded `timeout_seconds`; raise the argument or restart the kernel. |
| Kernel died / stale state | `mcp__mathematica__mathematica_kernel_status` with `{"action":"restart"}`; the next evaluation respawns the kernel. |
| First call slow (~seconds) | The kernel is spawned and warmed lazily on first use, then reused. |

## Uninstall

Use `plugin_manager` → `remove_bundle` with `dsh-mathematica-mcp` (or
`dsh plugin --profile <profile> remove dsh-mathematica-mcp` for a `link:` install: remove the
dependency the same way you added it). The manual row from Option C is removed by deleting it from
`cordis.patch.yml`.

## How it works (for the curious)

- `dsh/cordis.patch.yml` inserts one row: the shipped `@deepseek-ai/dsh-mcp-client` configured for
  `transport: stdio`, `serverName: mathematica`.
- The command is `process.execPath` inside the DSH Host process. DSH Desktop is Electron, so
  `ELECTRON_RUN_AS_NODE: '1'` (set in the row's `env`) makes it start as plain Node — the same
  mechanism DSH uses for its own subprocesses. A CLI install runs under plain `node`, where the
  variable is inert.
- The server entry is resolved from the Loader's `ctx.baseUrl`, which DSH anchors at the profile
  directory: `<profile>/node_modules/dsh-mathematica-mcp/server/bin/mathematica-mcp.js`. Nothing is
  hardcoded, so the bundle works in any profile directory.
- `failOnStartupError: false` keeps DSH booting on a machine where the server path or kernel is
  missing; the row stays inactive and the reason is logged.
- The server keeps a **persistent kernel**, so state (`a = 17`) survives between tool calls until
  restart.
