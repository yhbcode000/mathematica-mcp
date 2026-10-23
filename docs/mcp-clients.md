# Use `mathematica-mcp` from MCP clients

`mathematica-mcp` is an ordinary **stdio MCP server**: a single Node.js process that speaks
newline-delimited JSON-RPC 2.0 on stdin/stdout. Any MCP-capable client can launch it.

- Entry point: `bin/mathematica-mcp.js` (shebang, Node ≥ 18).
- No runtime dependencies: `npm install` is not required — a checkout plus Node is enough.
- Diagnostics go to **stderr only**; stdout carries protocol frames.
- Kernel state persists for the lifetime of the server process (a persistent Mathematica kernel is
  spawned lazily and reused).

## Client configuration template

Replace `/absolute/path/to` with the path to your checkout.

```json
{
  "mcpServers": {
    "mathematica": {
      "command": "node",
      "args": ["/absolute/path/to/mathematica-mcp/bin/mathematica-mcp.js"],
      "env": {
        "MATHEMATICA_EXE": "C:/Program Files/Wolfram Research/Wolfram/15.0/math.exe"
      }
    }
  }
}
```

- **Windows**: use a real path and either forward slashes or escaped backslashes in JSON
  (`"C:\\\\Program Files\\\\Wolfram Research\\\\..."`).
- `node` must resolve on the client's `PATH`. If it does not, use an absolute executable path as
  `command` (for example `C:/Program Files/nodejs/node.exe`).
- `MATHEMATICA_EXE` is optional when the kernel is in a standard install location; see
  [Kernel configuration](#kernel-configuration).
- The tools appear as `mathematica_evaluate`, `mathematica_export`, `mathematica_kernel_status`,
  and `mathematica_information` (in DSH they are namespaced: `mcp__mathematica__*`).

### Run from a git clone without installing

`npx` can execute a package straight from GitHub, which avoids any `npm install` step:

```json
{
  "mcpServers": {
    "mathematica": {
      "command": "npx",
      "args": ["-y", "github:yhbcode000/mathematica-mcp"]
    }
  }
}
```

This requires `npx` (bundled with Node) and network access the first time. Prefer a local clone for
offline use.

## Claude Desktop

Edit the client config file:

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

Add the `mathematica` entry from the template above (merge it into an existing `"mcpServers"`
object if one is present), then restart Claude Desktop completely. If the server fails to start,
Claude Desktop logs the child process error in its developer console.

## Cursor

Cursor's MCP settings live in `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per project).
Use the same `mcpServers` shape:

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

## DeepSeek Harness (DSH)

DSH users should not wire this JSON by hand — install the companion plugin bundle in
[`dsh/`](../dsh/README.md), which registers the same server and exposes
`mcp__mathematica__*` tools. See [dsh-install.md](dsh-install.md) for the step-by-step guide and a
manual `cordis.patch.yml` fallback.

## Generic MCP clients (SDK / custom)

Launch the server yourself and speak MCP over its stdio:

```js
import { spawn } from 'node:child_process'

const child = spawn(process.execPath, ['/absolute/path/to/mathematica-mcp/bin/mathematica-mcp.js'], {
  stdio: ['pipe', 'pipe', 'inherit'],
})
```

Write one JSON-RPC message per line to `child.stdin` and read one message per line from
`child.stdout`. Start with:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"my-client","version":"0.0.0"}}}
```

then send `{"jsonrpc":"2.0","method":"notifications/initialized"}` and use `tools/list` /
`tools/call`. Supported protocol versions: `2024-11-05`, `2025-03-26`, `2025-06-18` (the server
answers with the requested version when it is one of those, otherwise with `2024-11-05`).

## Kernel configuration

The kernel executable is resolved in this order:

1. `MATHEMATICA_EXE`, then `MATHEMATICA_KERNEL` environment variables.
2. `kernelPath` in `~/.mathematica-mcp.json`:

   ```json
   { "kernelPath": "C:/Program Files/Wolfram Research/Wolfram/15.0/math.exe" }
   ```

3. Platform defaults, newest version first:
   - Windows: `C:\Program Files\Wolfram Research\Wolfram\<ver>\math.exe` and
     `C:\Program Files\Wolfram Research\Wolfram\Mathematica\<ver>\math.exe`
   - macOS: `/Applications/Mathematica.app/Contents/MacOS/WolframKernel` and
     `/Applications/Wolfram Engine.app/Contents/MacOS/WolframKernel`
   - Linux: `math`, `WolframKernel`, `/usr/local/Wolfram/*/Executables/math`, `/opt/Wolfram/...`

A missing kernel is reported per tool call (the server itself stays healthy), so a misconfigured
client shows an actionable error instead of failing to start.

## Tool reference

| Tool | Arguments | Result |
| --- | --- | --- |
| `mathematica_evaluate` | `code` (string), `timeout_seconds` (default 60) | Evaluation result as InputForm text plus captured stdout and message names. |
| `mathematica_export` | `code` (string), `format` (`png`/`svg`/`pdf`/`csv`/`txt`/`json`/`tex`), `file_path` (optional), `width`, `height`, `timeout_seconds` (default 180) | `{path, bytes, format}` of the written file. |
| `mathematica_kernel_status` | `action` (`status`/`restart`/`interrupt`, default `status`) | Kernel process state, and the effect of a restart/interrupt. |
| `mathematica_information` | `symbols` (string array) | `Information` for each symbol. |

## Security note

The tools run arbitrary Wolfram Language code locally with your user's permissions. Treat an MCP
client configured with this server exactly like a local shell: only enable it for agents and
sessions you trust, and review code before approving execution where your client supports
approvals.
