# Architecture

## What this repository ships

```
mathematica-mcp/
├── bin/mathematica-mcp.js   # stdio MCP server entry (shebang, Node ≥ 18)
├── src/                     # server implementation (protocol, tools, kernel bridge, config)
├── test/                    # node:test suites (kernel-dependent cases skip without a kernel)
├── dsh/                     # DeepSeek Harness plugin bundle (vendored server copy + patch)
├── market/index.json        # DSH plugin-market index (format 1)
└── docs/                    # this documentation
```

Two deliverables share one server:

1. **`mathematica-mcp`** — a generic, zero-dependency Node MCP stdio server usable from Claude
   Desktop, Cursor, DSH directly, or any MCP client ([mcp-clients.md](mcp-clients.md)).
2. **`dsh-mathematica-mcp`** — a DSH plugin bundle that installs the server into a DSH profile and
   registers it through the shipped `@deepseek-ai/dsh-mcp-client` bridge
   ([dsh-install.md](dsh-install.md)).

## Server architecture

```
MCP client (stdio, newline-delimited JSON-RPC 2.0)
        │  initialize / tools/list / tools/call / …
        ▼
bin/mathematica-mcp.js ──► src/server.js        protocol dispatch, tool schemas
                              │
                              ▼
                          src/kernel.js         serialized call queue
                              │  one wrapper expression per call
                              ▼
                     math.exe / WolframKernel   persistent kernel process
                              │  stdout markers @@MM:BEGIN/RESULT/MSGS/END:<id>@@
                              ▼
                     src/… → JSON result          result InputForm + captured stdout + messages
```

Design points:

- **No SDK dependency.** The wire protocol is implemented directly (newline-delimited JSON-RPC
  2.0), so the package installs and runs anywhere Node ≥ 18 exists, with `dependencies: {}`.
- **Persistent kernel.** One kernel process is spawned lazily and reused for the lifetime of the
  server, so definitions and state persist across tool calls. Calls are serialized through a queue
  because a single kernel is single-threaded; this also keeps stdout framing unambiguous.
- **Robust result extraction.** Each call wraps the user expression in a `Block` that prints
  begin/result/messages/end markers with a per-call random id. The bridge reads stdout until the
  matching end marker, converts the result with `InputForm`, and returns it together with captured
  side-channel output and `$MessageList`. A timeout (`TimeConstrained`) returns `$Aborted`; a
  runaway kernel is killed so the next call starts clean.
- **Truthful failures.** Tool-level failures return `isError: true` with an actionable message;
  the server never fabricates a success. Diagnostics go to stderr only, never stdout.
- **Kernel discovery.** Environment → `~/.mathematica-mcp.json` → platform install globs; a missing
  kernel degrades per-call rather than crashing the server.

## DSH bundle architecture

The bundle is **configuration-only**: `dsh/package.json` declares
`dsh.bundle.patch = ./cordis.patch.yml`, and the patch inserts one row for the shipped
`@deepseek-ai/dsh-mcp-client`. There is no Host plugin code of our own, so the bundle has no
runtime dependencies and nothing to build.

```
DSH profile ($DSH_PROFILE_DIR)
├── node_modules/dsh-mathematica-mcp/     ← installed bundle
│   ├── cordis.patch.yml
│   ├── locale/{en,zh}.json, icon.svg
│   └── server/{bin,src,package.json}     ← vendored copy of mathematica-mcp
└── cordis.patch.yml                      ← user layer, applied after bundles
        │
        └─► Loader composes rows → @deepseek-ai/dsh-mcp-client
                 spawns: <process.execPath> [ELECTRON_RUN_AS_NODE=1]
                         node_modules/dsh-mathematica-mcp/server/bin/mathematica-mcp.js
```

### Launch strategy

DSH runs the Host process as an Electron app in Node mode (`ELECTRON_RUN_AS_NODE`), or as plain
`node` for CLI installs. The patch exploits that instead of hardcoding an installation path:

| Config field | Value | Why |
| --- | --- | --- |
| `command` | `!!js process.execPath` | The running DSH executable. Electron-as-Node under Desktop, `node` under a CLI install. |
| `env` | `ELECTRON_RUN_AS_NODE: '1'` | Makes the Electron binary behave as plain Node; ignored by a real `node`. This is how DSH itself starts Node subprocesses, so the required Electron fuse is enabled in any DSH Desktop build. |
| `args[0]` | `node_modules/dsh-mathematica-mcp/server/bin/mathematica-mcp.js` resolved from `ctx.baseUrl` | `ctx.baseUrl` is the profile directory URL; bundles always install under `<profile>/node_modules/<name>/`. Works for `link:` (local) and packed (git/market) installs. |
| `cwd` | installed bundle root | Predictable working directory for the child. |
| `failOnStartupError` | `false` | A machine without a resolvable server or kernel still boots DSH; the row stays inactive and logs why. |
| `toolCallTimeoutMs` | `180000` | Graphics rasterization and heavy symbolic evaluation can take minutes. |

Escape hatches: `MATHEMATICA_MCP_NODE` (executable) and `MATHEMATICA_MCP_SERVER_ENTRY` (server
path) override detection; `MATHEMATICA_EXE`/`MATHEMATICA_KERNEL` select the kernel.

### The `!!js` evaluation context (verified against the shipped Loader)

Patch expressions are evaluated by the Loader with

```js
new Function('ctx', 'expr', 'with (ctx) { return eval(expr) }')
```

so inside a `!!js` expression you get:

- `ctx` — the row's plugin context, including inherited loader properties such as `baseUrl` and
  built-in helpers (`dshHomePath(...)`); services are reachable as `ctx.get('name')` (for example
  `ctx.get('profileContext').dir`, the profile directory).
- Node **globals** — `process` (with `process.env`, `process.execPath`, `process.platform`),
  `URL`, `JSON`, `Buffer`, … and, on the shipped Node 24 runtime, `process.getBuiltinModule(...)`
  for modules such as `node:fs`/`node:path`.
- **Not** `require`, `fs`, `path`, `__dirname`, or `import`.

Other verified properties:

- Both plain scalars (`!!js process.execPath`) and YAML block scalars (`!!js >-` / `!!js |-`) work.
- Expressions are evaluated after the row's declared `inject` dependencies activate, so a value may
  depend on a service the row injects.
- A throwing expression leaves an optional row inactive (boot continues, warning logged).
- `--dump-config` renders expressions verbatim, which lets a bundle author validate patch YAML
  without booting.

## Prior art and positioning

Wolfram MCP integrations exist, including for DSH. This project does not claim to be first or the
only option; it exists to cover a specific combination of properties.

| Project | Approach | Relationship to this project |
| --- | --- | --- |
| [WolframResearch/AgentTools](https://github.com/WolframResearch/AgentTools) (`Wolfram/AgentTools` paclet) | Official Wolfram-Language MCP server distributed as a paclet; a Wolfram kernel runs the MCP loop and exposes the tools. Verified headless on this machine (v2.2.0): stdio `initialize` + `tools/list` ≈ 2.8 s, `tools/call` ≈ 3.9 s. | Official component; can be wired into DSH with a plain `@deepseek-ai/dsh-mcp-client` row (see [dsh-install.md](dsh-install.md#official-wolfram-agenttools-direct-option)). It requires installing/updating the paclet in a specific Wolfram product. |
| [Zhen-WushuiLingchun/dsh-wolfram-bundle](https://github.com/Zhen-WushuiLingchun/dsh-wolfram-bundle) | MIT DSH bundle that wraps the official AgentTools server (7 tools, verified against AgentTools 2.2.0). | Closest prior art for a DSH Wolfram bundle; inherits the paclet requirement. |
| [hatter123/dsh-wolfram](https://github.com/hatter123/dsh-wolfram) | Minimal zero-dependency DSH plugin exposing a single tool through `wolframscript -code`. | Lightweight single-tool alternative; no persistent kernel session or export tooling. |
| **mathematica-mcp / dsh-mathematica-mcp** (this project) | Standalone zero-dependency Node stdio server (generic MCP), persistent kernel bridge managed in Node, bundled into a DSH configuration-only bundle and a market index. | Differentiators: **any MCP client** (not DSH-only), **no Wolfram paclet**, **zero npm runtime dependencies**, **persistent kernel state**, **graphics/data export**, and a **DSH bundle + market entry**. |

Factual positioning: "zero-dependency, headless, any-client, DSH-ready" — not "the official Wolfram
MCP" and not "the only Mathematica MCP".

## Security model

- **Local and explicit.** The server spawns a local kernel binary and never listens on a socket; the
  only transport is stdio with the MCP client.
- **Same trust as a shell.** `mathematica_evaluate` runs arbitrary Wolfram Language with the user's
  permissions — it can read files, start processes, and use network reachable from Wolfram code.
  Treat it like `wolframscript`/a terminal: enable the plugin only in profiles you trust, and use
  your client's approval surfaces for risky calls.
- **No credentials involved.** No API key, no cloud round-trip; a local Wolfram license is the only
  requirement. Kernel configuration files (`~/.mathematica-mcp.json`, env vars) contain paths only.
- **Bundle trust.** Installing a DSH bundle runs its code in the Host process. This bundle contains
  no Host code; its patch declares one MCP client row. Market text is third-party content and the
  market signature carries no authenticity guarantee — this repository is the source of truth.
- **Input bounding.** Tool results are capped in size with an explicit truncation notice; diagnostics
  stay on stderr; malformed JSON-RPC input is answered with a JSON-RPC error, never echoed.
