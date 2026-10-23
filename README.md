# mathematica-mcp

A **zero-dependency MCP server** that connects a locally installed **Wolfram Language** kernel
(Mathematica or the free Wolfram Engine) to any [Model Context Protocol](https://modelcontextprotocol.io)
client: Claude Desktop, Cursor, VS Code, Cline, DeepSeek Harness, or your own agent.

It starts a persistent `math.exe` / `WolframKernel` process on the same machine and exposes four tools
over stdio JSON-RPC:

| Tool | What it does |
| --- | --- |
| `mathematica_evaluate` | Evaluate Wolfram Language code in a **persistent kernel** and return the result (`InputForm` + decoded value). |
| `mathematica_export` | Evaluate an expression and export it to **png / svg / pdf / csv / txt / json / tex**; returns the file path and size. |
| `mathematica_kernel_status` | Report kernel status, restart it, or interrupt it (interrupt = restart). |
| `mathematica_information` | Look up attributes, context, option count and definitions for Wolfram Language symbols. |

Variables and definitions survive between calls: `a = 17` in one call, `a + 1` in the next returns `18`.
Everything runs in a local kernel process — **no cloud API, no API keys, no network requests**.

- **Runtime dependencies:** none. Node.js ≥ 18 at runtime; no npm packages, no Wolfram paclet, no build step.
- **Transport:** newline-delimited JSON-RPC 2.0 (MCP stdio); stdout carries protocol frames only, diagnostics go to stderr.
- **Kernel discovery:** ordered candidate probing that skips unlicensed or broken installations and falls back to the next candidate.

```text
mathematica-mcp/
├── bin/mathematica-mcp.js     # executable entry point (package.json "bin")
├── src/server.js              # MCP protocol, tool schemas, tool handlers
├── src/kernel.js              # kernel process bridge: queue, framing, timeouts, restart
├── src/detect.js              # kernel discovery + license/health probe
├── test/                      # node:test suite (skips kernel tests when no kernel is installed)
├── dsh/                       # companion DeepSeek Harness plugin bundle (vendors this server)
├── market/                    # DSH plugin-market index for this bundle
└── docs/                      # client setup, DSH install, architecture, publishing notes
```

## Prior art (read this first)

This project is **not** the first Mathematica/Wolfram MCP integration, and it makes no claim to be
first, only, or comprehensive. Related projects include:

- [WolframResearch/AgentTools](https://github.com/WolframResearch/AgentTools) — Wolfram Research's
  official WL paclet that runs an MCP server from inside a Wolfram kernel. Install the paclet, then
  point an MCP client at its server.
- [Zhen-WushuiLingchun/dsh-wolfram-bundle](https://github.com/Zhen-WushuiLingchun/dsh-wolfram-bundle) —
  an MIT-licensed DeepSeek Harness bundle that wraps AgentTools and exposes its tools in DSH.
- [hatter123/dsh-wolfram](https://github.com/hatter123/dsh-wolfram) — a minimal single-tool DSH plugin
  that calls `wolframscript -code`.

What this project adds, factually:

- a **standalone Node MCP stdio server** that works with any MCP client, with **no Wolfram paclet,
  no npm install and no build step** on the server side (zero runtime dependencies);
- **persistent kernel state** across tool calls, with a bridge-level timeout/restart/watchdog;
- **graphics and data export** (png, svg, pdf, csv, txt, json, tex) as a first-class tool;
- an optional **DeepSeek Harness plugin bundle + plugin-market index** in [`dsh/`](dsh/) and
  [`market/`](market/), which vendors the same server.

These projects are independent; this one is not affiliated with them.

## Requirements

1. **A locally licensed Mathematica or a free Wolfram Engine** on the same machine. There is no
   cloud/API fallback: if no licensed kernel is found, the tools return an actionable error.
2. **Node.js ≥ 18** to run the server (no packages to install).
3. For the optional DSH bundle: a DeepSeek Harness profile that ships `@deepseek-ai/dsh-mcp-client`
   (any standard profile does).

The server finds the kernel automatically. The first usable candidate wins; each candidate is probed
by starting it and evaluating a trivial program, so unlicensed installs
(`No valid password found.`, exit code `69`) and broken binaries are skipped:

1. `--kernel <path>` command-line argument (highest priority),
2. `MATHEMATICA_EXE` or `MATHEMATICA_KERNEL` environment variable,
3. `~/.mathematica-mcp.json` with `{"kernelPath": "<path>"}`,
4. well-known install locations, newest version first. On Windows, desktop `...\Wolfram\<ver>\math.exe`
   and `...\Mathematica\<ver>\math.exe` are preferred over `...\Wolfram Engine\<ver>\math.exe`;
   `math.exe` is used rather than `MathKernel.exe` because only `math.exe` is a reliable stdio REPL.

Example (`Windows`):

```powershell
setx MATHEMATICA_EXE "C:\Program Files\Wolfram Research\Wolfram\15.0\math.exe"
```

Linux/macOS:

```bash
export MATHEMATICA_EXE="/usr/local/Wolfram/Mathematica/15.0/Executables/math"
export MATHEMATICA_EXE="/Applications/Mathematica.app/Contents/MacOS/WolframKernel"
```

## Install and run

### From a git clone

```bash
git clone https://github.com/yhbcode000/mathematica-mcp.git
cd mathematica-mcp
node bin/mathematica-mcp.js --version   # mathematica-mcp 0.1.0
node bin/mathematica-mcp.js --help
```

The server speaks MCP on stdin/stdout and is normally started by an MCP client, not by hand.

### From npm (after publication)

```bash
npx -y mathematica-mcp
# or
npm install -g mathematica-mcp
mathematica-mcp --version
```

> The npm package is zero-dependency; `npx` only downloads this package itself.

## MCP client configuration

The server is a plain stdio MCP server. Use an absolute path to `bin/mathematica-mcp.js` (and an
absolute `node` path if your GUI client does not inherit `PATH`). JSON configs below use forward
slashes; on Windows both `C:/...` and escaped `C:\\...` are accepted.

### Claude Desktop

`claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "mathematica": {
      "command": "node",
      "args": ["D:/tools/mathematica-mcp/bin/mathematica-mcp.js"],
      "env": {
        "MATHEMATICA_EXE": "C:/Program Files/Wolfram Research/Wolfram/15.0/math.exe"
      }
    }
  }
}
```

The `env` block is only needed when auto-detection does not find the kernel.

### Cursor

`.cursor/mcp.json` in your project (or the global equivalent):

```json
{
  "mcpServers": {
    "mathematica": {
      "command": "node",
      "args": ["D:/tools/mathematica-mcp/bin/mathematica-mcp.js"]
    }
  }
}
```

### Generic stdio client

Any client that launches a command and speaks newline-delimited JSON-RPC 2.0 on its stdin/stdout can
use the server:

```json
{
  "command": "node",
  "args": ["/opt/mathematica-mcp/bin/mathematica-mcp.js", "--kernel", "/usr/local/Wolfram/Mathematica/15.0/Executables/math"],
  "cwd": "/opt/mathematica-mcp",
  "env": {}
}
```

See [`docs/mcp-clients.md`](docs/mcp-clients.md) for more client-specific notes.

### DeepSeek Harness (DSH)

This repository also ships a companion DSH plugin bundle in [`dsh/`](dsh/) (`dsh-mathematica-mcp`).
It vendors this server and inserts the shipped `@deepseek-ai/dsh-mcp-client` bridge, registering
the tools as `mcp__mathematica__mathematica_evaluate`, `mcp__mathematica__mathematica_export`,
`mcp__mathematica__mathematica_kernel_status` and `mcp__mathematica__mathematica_information`.

From a local checkout (no git required):

```powershell
# 1. Copy bin/ + src/ into the bundle's vendored server directory
node dsh/scripts/sync-server.mjs

# 2. Ask the agent to install the bundle, or call plugin_manager with:
#    { "action": "install_bundle", "target": "<absolute path to checkout>/dsh" }
```

From the plugin market (requires `git` on `PATH`), add the raw index URL
`https://raw.githubusercontent.com/yhbcode000/mathematica-mcp/main/market/index.json` in
**Discover** and install **Mathematica MCP**.

Full install and manual `cordis.patch.yml` instructions:
[`dsh/README.md`](dsh/README.md) and [`docs/dsh-install.md`](docs/dsh-install.md).
Design notes: [`docs/architecture.md`](docs/architecture.md).

## Tool reference

Every tool result is a single MCP `content` block of type `text` whose text is a JSON object. Tool
failures use `isError: true` (the MCP connection itself stays healthy).

### `mathematica_evaluate`

Evaluate Wolfram Language code in the persistent kernel.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `code` | string (required) | — | Wolfram Language source. May be multi-line; newline-separated statements are evaluated in order. |
| `timeout_seconds` | number | `60` | Evaluation time limit. On timeout the evaluation is aborted (`$Aborted`) and the kernel stays usable. |

Example call:

```json
{ "name": "mathematica_evaluate", "arguments": { "code": "Integrate[Sin[x]^2, {x, 0, Pi}] // N" } }
```

Example success result:

```json
{
  "ok": true,
  "result": 1.5707963267948966,
  "result_inputform": "1.5707963267948966`",
  "output": "",
  "duration_ms": 12
}
```

Fields:

- `result` — decoded value when the result is a plain string or number (omitted for compound expressions).
- `result_inputform` — the raw Mathematica `InputForm` of the result; always present.
- `output` — text printed during the evaluation (e.g. `Print[...]`), when any.
- `messages` — message names such as `Power::infy`, when messages were generated.
- `duration_ms` — wall-clock duration of the call.

A syntax error or an aborted evaluation returns `isError: true` with `error: "evaluation_failed"` /
`error: "timeout"`, a human-readable `message`, and the kernel stays alive for the next call.

### `mathematica_export`

Evaluate an expression and write its result to a file.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `code` | string (required) | — | Wolfram Language expression to export (a `Graphics`, `Image`, data table, string, …). |
| `format` | enum (required) | — | `png`, `svg`, `pdf`, `csv`, `txt`, `json` or `tex`. |
| `file_path` | string | timestamped file under the OS temp dir | Absolute output path (relative paths resolve against the server's CWD). Parent directories are created. |
| `width` | number | — | For png/svg/pdf: `ImageSize` width in pixels. |
| `height` | number | — | For png/svg/pdf: `ImageSize` height in pixels. |
| `timeout_seconds` | number | `180` | Export time limit. The first raster/vector export in a kernel session can take several seconds (rasterizer initialisation), hence the generous default. |

Example:

```json
{ "name": "mathematica_export", "arguments": { "code": "Plot[Sin[x], {x, 0, 2 Pi}]", "format": "png", "width": 900 } }
```

Result:

```json
{
  "ok": true,
  "path": "C:\\Users\\you\\AppData\\Local\\Temp\\mathematica-mcp\\mathematica-export-20260101-120000-ab12cd.png",
  "format": "png",
  "width": 900,
  "bytes": 74261,
  "duration_ms": 4100
}
```

Default artifact directory: `%TEMP%\mathematica-mcp` on Windows,
`$TMPDIR/mathematica-mcp` on macOS/Linux.

### `mathematica_kernel_status`

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `action` | enum | `status` | `status`, `restart`, or `interrupt`. |

- `status` reports kernel state: running/ready, pid, uptime, call count, detection source, and the
  candidate-probe results (`tried`). It never starts a kernel; before first use `resolution_attempted`
  is `false` and `candidates` lists the paths that will be probed.
- `restart` kills and respawns the kernel: **all in-memory state is lost**.
- `interrupt` is implemented honestly as a restart — a batch `math.exe` process cannot be reliably
  interrupted from another thread — and the result says so.

### `mathematica_information`

| Parameter | Type | Description |
| --- | --- | --- |
| `symbols` | string[] (required) | Symbol names, e.g. `["Plot", "Integrate"]`. Context-qualified names like ``"Global`f"`` are allowed. Up to 50 per call. |

Returns attributes, context, option count and (possibly truncated) definition for each symbol.
Example: `{"symbols": ["Plot"]}` returns `"Attributes" -> "{HoldAll, Protected, ReadProtected}"`,
`"Context" -> "System`"`, `"OptionsCount" -> 68`, and the `Options[Plot]` definition. Per-symbol
definitions are truncated at 8000 characters to keep tool responses context-friendly.

## Configuration

| Setting | How | Notes |
| --- | --- | --- |
| Kernel executable | `--kernel <path>` | Highest priority; wins over everything below. |
| Kernel executable | `MATHEMATICA_EXE` / `MATHEMATICA_KERNEL` env vars | Checked in that order. |
| Kernel executable | `~/.mathematica-mcp.json` → `{"kernelPath": "..."}` | Aliases `kernel` / `path` are also accepted. |
| Default evaluate timeout | tool argument `timeout_seconds` | Default 60 s; max 3600 s. |
| Default export timeout | tool argument `timeout_seconds` | Default 180 s. |
| Artifact location | tool argument `file_path` | Omit to write under the OS temp dir. |

CLI options:

```text
mathematica-mcp [--kernel <path>] [--help] [--version]
```

There are no other environment variables and no configuration files written by the server.

## How it works

- The MCP server reads newline-delimited JSON-RPC frames from stdin and writes responses to stdout.
  `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`, `prompts/list` are implemented;
  unknown methods return `-32601`, malformed JSON returns `-32700`.
- On first tool use the server probes kernel candidates (spawn, trivial evaluation, 20 s budget),
  caches the first working kernel, then starts a long-lived kernel with `-noprompt` and
  `$CharacterEncoding = "UTF-8"`.
- Each evaluation is serialized through a queue (the kernel is single-threaded) and wrapped in one WL
  `Block[...]` expression: the user program is passed as a string and evaluated with `ToExpression`,
  so syntax errors become ordinary `$Failed` results (plus `ToExpression::sntx*` messages) instead of
  wedging the input parser. Results and messages are returned through length-prefixed
  `WriteString[$Output, ...]` frames, which is what keeps multi-line/Unicode results intact.
- A `TimeConstrained` limit aborts long evaluations; a hard watchdog kills and respawns a kernel that
  stops responding entirely. stdout is reserved for the MCP protocol — never for kernel chatter.

## Security notes

- **The server executes arbitrary Wolfram Language code with the privileges of the user running it.**
  Anything the kernel can do, the MCP client can do: read and write files, run `RunProcess`, make
  network requests, import/export files, etc. Only connect MCP clients you trust and only evaluate
  code you trust.
- Files created by `mathematica_export` are written wherever you ask (or under the OS temp directory).
  Treat any output path from an untrusted prompt as sensitive.
- The transport is stdio only. Do not expose this server over a network socket; if you need remote
  access, wrap it in your own authenticated transport.
- Nothing is sent to Wolfram or any cloud service; all evaluation is local. Wolfram licence
  requirements still apply (see below).

## Troubleshooting

**`No working Mathematica kernel was found` / kernel-start errors**

The error lists every candidate that was probed and the reason each failed. Point the server at a
licensed executable:

```powershell
setx MATHEMATICA_EXE "C:\Program Files\Wolfram Research\Wolfram\15.0\math.exe"
```

Check it manually first:

```powershell
& "C:\Program Files\Wolfram Research\Wolfram\15.0\math.exe" -noprompt
# then type:  2+2   and press Enter twice
```

**`No valid password found.` / exit code 69**

That candidate is an **unlicensed Wolfram Engine** installation. The server skips it automatically and
tries the next candidate. Use a desktop Mathematica `math.exe`, or activate the Wolfram Engine licence.

**`MathKernel.exe` does not respond**

Use `math.exe` instead — it is the documented stdio REPL launcher. The server never selects
`MathKernel.exe`/`WolframKernel.exe` on Windows for this reason.

**`evaluation_failed` / syntax errors**

The code could not be parsed (`ToExpression::sntx*`). This is an ordinary tool error; the kernel stays
usable. Check parentheses/brackets and retry.

**`timeout` errors**

The evaluation exceeded `timeout_seconds`, was aborted, and the kernel is still usable. Raise
`timeout_seconds` for long-running computations. An evaluation that cannot be aborted at all is killed
by a hard watchdog and the next call starts a fresh kernel (state is lost).

**First PNG/PDF export is slow**

The first export in a kernel session initialises the rasterizer (and may install a one-time paclet) and
can take several seconds; later exports are fast. The default export timeout is 180 s.

**The client reports no tools / server exits immediately**

Run `node bin/mathematica-mcp.js --help`; check stderr (the client usually shows server logs). If `node`
is not on the GUI client's `PATH`, use an absolute node path in the command. On Windows, prefer forward
slashes in JSON paths.

**A restart cleared my variables**

`mathematica_kernel_status {action: "restart"}` (and `interrupt`) drop in-memory state by design;
re-run the definitions you need.

## Testing

The test suite uses the built-in `node:test` runner and speaks raw JSON-RPC against the real server:

```bash
npm test
# or, without npm:
node --test
```

The suite includes protocol/JSON-RPC checks, unit tests for kernel detection, and integration tests
against a real Mathematica kernel. **Kernel integration tests are skipped automatically when no kernel
is installed**, so the suite is green on CI machines without Mathematica:

```bash
# Force-skip kernel tests (e.g. in CI):
MATHEMATICA_MCP_TEST_SKIP_KERNEL=1 npm test
```

Test-only environment variables:

| Variable | Purpose |
| --- | --- |
| `MATHEMATICA_MCP_TEST_SKIP_KERNEL=1` | Skip all kernel integration tests. |
| `MATHEMATICA_MCP_TEST_KERNEL=<path>` | Use this kernel for integration tests instead of auto-detection. |
| `MATHEMATICA_EXE=<path>` | Also used by the tests (normal kernel configuration). |

Note: run the runner without a directory argument (`node --test`), or with explicit files/glob
(`node --test "test/*.test.js"`). On recent Node versions a bare directory argument
(`node --test test/`) is treated as a single test file and fails; `node --test` auto-discovery works on
Node 18+.

## License and trademarks

MIT-licensed software; see [LICENSE](LICENSE). Using it requires **your own licensed Mathematica or free
Wolfram Engine** — this project does not include, redistribute or sublicense Wolfram software.

Wolfram, Mathematica, Wolfram Language and Wolfram Engine are trademarks of Wolfram Research, Inc.
This project is not affiliated with or endorsed by Wolfram Research.

DeepSeek Harness and DSH are part of the DeepSeek Harness project; this project's `dsh/` bundle is a
community integration.
