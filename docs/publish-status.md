# Publish status and release checklist

Artifact: **mathematica-mcp** + **dsh-mathematica-mcp** (DSH plugin bundle) + plugin-market index.

## Identity

| Item | Value |
| --- | --- |
| GitHub repository | https://github.com/yhbcode000/mathematica-mcp (public) |
| Server package | `mathematica-mcp` 0.1.0 (zero runtime dependencies, entry `bin/mathematica-mcp.js`) |
| DSH bundle package | `dsh-mathematica-mcp` 0.1.0 (bundle directory `dsh/`) |
| DSH server name / tool namespace | `mathematica` → `mcp__mathematica__*` |
| Market index (raw URL) | https://raw.githubusercontent.com/yhbcode000/mathematica-mcp/main/market/index.json |
| Market install spec | `git+https://github.com/yhbcode000/mathematica-mcp.git#<pinned commit>&path:/dsh` |
| License | MIT (using it requires a separately licensed Mathematica or Wolfram Engine) |

## Status checklist

Honest state: boxes stay unchecked until the named evidence is recorded below.

- [x] Repository page created on GitHub (public) — `gh repo create`, see evidence E1
- [ ] All files pushed to `main`, first commit SHA recorded — evidence E2
- [ ] `market/index.json` pinned to a commit whose tree contains `dsh/`, pushed — evidence E3
- [ ] Raw index URL returns HTTP 200 with no redirect and parses as JSON — evidence E4
- [ ] `market/index.json` passes `node market/validate-index.mjs` (format 1) — evidence E5
- [ ] `dsh/scripts/sync-server.mjs --check` passes (vendored server in sync) — evidence E6
- [x] DSH bundle installed in a profile; `mcp__mathematica__*` tools live and a real kernel call succeeds — evidence E7
- [ ] CI workflow shipped (server tests Node 18/20/22 + layout/bundle/market validation) — evidence E8
- [ ] npm publish of `mathematica-mcp` (optional; DSH does not need it, `npx github:` works)

Local pre-publication verification already completed in a throwaway `DSH_HOME`
(`D:\workspace\integrator-scratch\dshhome`, the user's profile untouched):

- `dsh plugin add link:<bundle>` installed the bundle into the profile.
- `dsh --profile <throwaway> --dump-config` composed the `mcp-mathematica` row from
  `dsh/cordis.patch.yml`.
- Booting that profile spawned the bundled server as `DeepSeek Harness.exe` with
  `ELECTRON_RUN_AS_NODE=1` (Electron 44.7.0, Node 24.21.0), cwd
  `<profile>/node_modules/dsh-mathematica-mcp`, argv
  `<profile>/node_modules/dsh-mathematica-mcp/server/bin/mathematica-mcp.js`; the MCP
  `initialize` / `notifications/initialized` / `tools/list` exchange succeeded (4 tools). This used a
  stub server to validate the bundle mechanics before the real server landed.

## Recorded evidence

<!-- EVIDENCE -->
### E1 — repository page created
`gh repo create yhbcode000/mathematica-mcp --public --description "Zero-dependency MCP server for
local Mathematica / Wolfram Engine kernels, with a DeepSeek Harness (DSH) plugin bundle and
plugin-market index."` → `https://github.com/yhbcode000/mathematica-mcp`. No commits yet at creation
time.

### E2 — first push
Pending.

### E3 — index pinned and pushed
Pending.

### E4 — raw index URL
Pending.

### E5 — index validator
Pending.

### E6 — vendored server in sync
Pending.

### E7 — DSH install and tool call (real profile, DSH Desktop 0.2.1-rc.2)

`plugin_manager` `install_bundle`, target `D:\workspace\mathematica-mcp\dsh`:

```json
{"stage":"enable","target":"dsh-mathematica-mcp","enabled":true,"changed":true,
 "application":"applied",
 "packageResult":{"exitCode":0,"output":"dependencies:\n+ dsh-mathematica-mcp 0.1.0 <- D:\\workspace\\mathematica-mcp\\dsh", "...": "..."},
 "bundle":"dsh-mathematica-mcp","version":"0.1.0","warnings":[]}
```

HMR applied the bundle live, no DSH restart. The installed dependency is
`"dsh-mathematica-mcp": "link:D:/workspace/mathematica-mcp/dsh"`.

Tools registered and **called through DSH** (server name `mathematica`):

| Call | Result |
| --- | --- |
| `mathematica_evaluate {code:"2+2"}` | `{"ok":true,"result":4}` |
| `f[3]` after setting `a=17` in an earlier call | `26` (persistent kernel state) |
| `"中文测试 αβγ ∑ →"` round-trip | returned intact |
| `mathematica_export` PNG of `Plot[Sin[x] + 1/3 Sin[3x], {x,0,2Pi}]` | 74,261 bytes at `…\Temp\mathematica-mcp\mathematica-export-20261023-194821-33d611.png`; rendered plot visually confirmed |
| `mathematica_information(["Integrate","Plot"])` | attributes/options returned |
| `While[True,1]` with `timeout_seconds:2` | `isError` "timeout" after 2,023 ms |
| `N[Integrate[Sin[x]^2,{x,0,Pi}]]` after the timeout | `1.5707963267948966` (kernel survived) |
| `mathematica_kernel_status` | kernel_found true, path `C:\Program Files\Wolfram Research\Wolfram\15.0\math.exe`, detection_source `platform-default`, license probe `{"ok":true,"detail":"kernel is licensed and responsive"}` |

Server instructions reached the agent prompt correctly.

Independent pre-DSH harness by the reviewer: 21/21 checks passed against `bin/mathematica-mcp.js`
with no environment override (protocol `initialize`/`ping`/`tools/list`, the 4 tools,
evaluate/state/unicode/messages/syntax-error recovery/`Print` capture/timeout/PNG/CSV/SVG
content/kernel_status/information/restart/state-cleared/unknown-tool).

### E8 — CI workflow
Pending.
<!-- /EVIDENCE -->

## Release procedure (verified on the publication machine)

The publication machine had **no git on PATH**. Two verified paths:

### A. Portable Git (preferred — one clean commit)

```powershell
# 1. Download MinGit (portable, no installer, no admin)
gh api repos/git-for-windows/git/releases/latest |
  ConvertFrom-Json |
  ForEach-Object { $_.assets } |
  Where-Object { $_.name -match '^MinGit-.*-64-bit\.zip$' } |
  Select-Object -First 1 |
  ForEach-Object { Invoke-WebRequest $_.browser_download_url -OutFile MinGit.zip }
Expand-Archive MinGit.zip -DestinationPath mingit

# 2. Initialize and commit (from the repository root)
.\mingit\cmd\git.exe init -b main
.\mingit\cmd\git.exe config user.name 'yhbcode000'
.\mingit\cmd\git.exe config user.email '<account>@users.noreply.github.com'
.\mingit\cmd\git.exe add -A
.\mingit\cmd\git.exe commit -m "Initial public release"

# 3. Push using a token that is never written to .git/config
$token = gh auth token
$header = 'AUTHORIZATION: basic ' + [Convert]::ToBase64String(
  [Text.Encoding]::UTF8.GetBytes("x-access-token:$token"))
.\mingit\cmd\git.exe -c "http.https://github.com/.extraheader=$header" push -u origin main
```

### B. GitHub contents API (no git at all)

```powershell
# Create/update one file per request; base64 the UTF-8 bytes.
$content = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Content -Raw -Encoding UTF8 path)))
gh api --method PUT repos/yhbcode000/mathematica-mcp/contents/<repo-relative-path> `
  -f message='add <path>' -f content=$content
# Updating an existing file also needs -f sha=<blob sha> from GET contents/<path>.
# For bodies over ~20 KB, build a JSON body file and pass --input body.json.
```

Commit SHAs produced this way are real commits; a commit-pinned market install works the same.

### Pin the market index

1. Push everything **except** the final `market/index.json` content (a placeholder commit SHA must
   never be published).
2. Read the commit SHA of the pushed tree:
   `gh api repos/yhbcode000/mathematica-mcp/commits/main --jq .sha`.
3. Edit `market/index.json`: set `versions[0].source.commit` to that SHA and keep
   `publishTimestamp` as the release Unix-seconds integer.
4. Commit and push the index (its own commit SHA differs — that is fine; the pin must only
   reference a commit whose tree contains `dsh/`).
5. Verify with evidence E4/E5.

### Publish a new version

1. Bump `dsh/package.json` and the server `package.json` version.
2. Re-sync the vendored server: `node dsh/scripts/sync-server.mjs`.
3. Commit + push; take the new commit SHA.
4. Add a new `versions[]` entry in `market/index.json` (do **not** rewrite older entries) pinned to
   the new SHA, with a new `publishTimestamp`.
5. Validate and push; DSH indexes refresh within their 10-minute cache TTL.
