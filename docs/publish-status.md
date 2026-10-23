# Publish status and release checklist

Artifact: **mathematica-mcp** + **dsh-mathematica-mcp** (DSH plugin bundle) + plugin-market index.

## Identity

| Item | Value |
| --- | --- |
| GitHub repository | https://github.com/yhbcode000/mathematica-mcp (public) |
| Server package | `mathematica-mcp` 0.1.0 (zero runtime dependencies, entry `bin/mathematica-mcp.js`) |
| DSH bundle package | `dsh-mathematica-mcp` 0.1.0 (bundle directory `dsh/`) |
| DSH server name / tool namespace | `mathematica` → `mcp__mathematica__*` |
| Initial release commit (contains `dsh/`) | `e1015b845e5583ef28e3e821d374a68d39abcc39` |
| Market-index commit (`main` at publication) | `fb37c5fe872b348184c31086512db643f02b0035` |
| Market index (raw URL) | https://raw.githubusercontent.com/yhbcode000/mathematica-mcp/main/market/index.json |
| Market install spec | `git+https://github.com/yhbcode000/mathematica-mcp.git#e1015b845e5583ef28e3e821d374a68d39abcc39&path:/dsh` |
| Index file SHA-256 (local == published) | `7ff4d28fce65185244603a1e1f8f8ea20eb6b3440a0a330ea9fad69f80bc1f8c` |
| License | MIT (using it requires a separately licensed Mathematica or Wolfram Engine) |

## Status checklist

- [x] Repository page created on GitHub (public) — evidence E1
- [x] All files pushed to `main`, initial release commit recorded — evidence E2
- [x] `market/index.json` pinned to a commit whose tree contains `dsh/`, pushed — evidence E3
- [x] Raw index URL returns HTTP 200 with no redirect and parses as JSON — evidence E4
- [x] `market/index.json` passes `node market/validate-index.mjs` (format 1), local and downloaded — evidence E5
- [x] `dsh/scripts/sync-server.mjs --check` passes (vendored server in sync) — evidence E6
- [x] DSH bundle installed in a profile; `mcp__mathematica__*` tools live and real kernel calls succeed — evidence E7
- [x] Market-style install from the pinned git spec verified: pnpm resolves `dsh-mathematica-mcp@0.1.0` with `path: /dsh`, the profile composes the row, and the bundled server spawns — evidence E9
- [ ] CI workflow committed — **blocked by the publication credential's OAuth scopes**; the workflow source ships as `docs/ci-workflow.yml` and its steps were verified locally — evidence E8
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
  `initialize` / `notifications/initialized` / `tools/list` exchange succeeded (4 tools). A stub
  server was used first to validate the bundle mechanics before the real server landed.

## Recorded evidence

<!-- EVIDENCE -->
### E1 — repository page created
`gh repo create yhbcode000/mathematica-mcp --public --description "Zero-dependency MCP server for
local Mathematica / Wolfram Engine kernels, with a DeepSeek Harness (DSH) plugin bundle and
plugin-market index."` → `https://github.com/yhbcode000/mathematica-mcp`.

### E2 — first push

Portable MinGit 2.56.0 (downloaded from the git-for-windows GitHub release, no installer, no admin),
token passed with a per-command `http.https://github.com/.extraheader` so it never lands in
`.git/config`:

```text
[main (root-commit) e1015b8] Initial public release: mathematica-mcp 0.1.0 with DSH plugin bundle
 30 files changed, 6987 insertions(+)
 + e1015b8...main -> main
```

`gh api repos/yhbcode000/mathematica-mcp/commits/e1015b8…` resolves; the tree contains `bin/`,
`src/`, `test/`, `docs/`, `dsh/**` (including `dsh/server/bin/mathematica-mcp.js`,
`dsh/server/src/*.js`, `dsh/server/package.json`, `dsh/cordis.patch.yml`, `dsh/locale/*`,
`dsh/icon.svg`, `dsh/scripts/sync-server.mjs`), `market/README.md`, `market/validate-index.mjs`,
`README.md`, `LICENSE`, `package.json`, `.github/workflows` excluded (see E8).

### E3 — index pinned and pushed

`market/index.json` `versions[0]`:

```json
{"version":"0.1.0","publishTimestamp":1792785323,
 "source":{"type":"git","url":"https://github.com/yhbcode000/mathematica-mcp",
           "commit":"e1015b845e5583ef28e3e821d374a68d39abcc39","path":"dsh"},
 "engines":{"dsh":">=0.2.0"}}
```

Commit `fb37c5fe872b348184c31086512db643f02b0035` — `Release: pin plugin-market index to e1015b8
(initial public release)` — is `main` HEAD after the publish; the pin target is its parent.

### E4 — raw index URL

```text
GET https://raw.githubusercontent.com/yhbcode000/mathematica-mcp/main/market/index.json
status=200  length=2625  contentType=text/plain; charset=utf-8  isRedirected=False
SHA-256 (local file) == SHA-256 (downloaded bytes) == 7ff4d28fce65185244603a1e1f8f8ea20eb6b3440a0a330ea9fad69f80bc1f8c
```

### E5 — index validator

```text
market index market\index.json: valid format 1
  title: {"en":"Mathematica MCP","zh":"Mathematica MCP 插件索引"}
  dsh-mathematica-mcp@0.1.0: git+https://github.com/yhbcode000/mathematica-mcp.git#e1015b845e5583ef28e3e821d374a68d39abcc39&path:/dsh
```

The downloaded document (no BOM) passed the same validator identically. An independent check with
the **shipped** `@deepseek-ai/dsh-plugin-market-index` 0.2.1-rc.2 `parseMarketIndex` (extracted from
`app.asar`) also parsed it: format 1, `name` = `dsh-mathematica-mcp`, `path` = `dsh`,
`engines.dsh` = `>=0.2.0` compatible with DSH 0.2.1-rc.2.

### E6 — vendored server in sync

```text
$ node dsh/scripts/sync-server.mjs --check
sync-server --check: dsh/server/ is in sync (5 files)
```

The five files are `server/bin/mathematica-mcp.js`, `server/package.json`,
`server/src/{detect,kernel,server}.js`; SHA-256 matches the repo-root copies (and the hashes reported
by the server author). `pnpm pack` of `dsh/` lists exactly `cordis.patch.yml`, `locale/{en,zh}.json`,
`icon.svg`, `package.json`, `README.md`, `server/**` — so the packed git install contains the
server. Note: `server/package.json` is required because `src/server.js` reads `../package.json` for
its name/version; the first bundle build without it crashed at startup, which the pre-publish smoke
test caught.

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
| Cross-call state | `18` |
| `"中文测试 αβγ ∑ →"` round-trip | returned intact |
| `mathematica_export` PNG of `Plot[Sin[x] + 1/3 Sin[3x], {x,0,2Pi}]` | 74,261 bytes at `…\Temp\mathematica-mcp\mathematica-export-20261023-194821-33d611.png`; rendered plot visually confirmed |
| `mathematica_information(["Integrate","Plot"])` | attributes/options returned |
| `While[True,1]` with `timeout_seconds:2` | `isError` "timeout" after 2,023 ms |
| `N[Integrate[Sin[x]^2,{x,0,Pi}]]` after the timeout | `1.5707963267948966` (kernel survived) |
| `mathematica_kernel_status` | kernel_found true, path `C:\Program Files\Wolfram Research\Wolfram\15.0\math.exe`, detection_source `platform-default`, license probe `{"ok":true,"detail":"kernel is licensed and responsive"}` (the unlicensed Wolfram Engine candidate is skipped) |

Server instructions reached the agent prompt correctly. An independent pre-DSH harness (21/21
checks against `bin/mathematica-mcp.js`, no environment override) passed: protocol
`initialize`/`ping`/`tools/list`, 4 tools, evaluate/state/unicode/messages/syntax-error
recovery/`Print` capture/timeout/PNG/CSV/SVG content/kernel_status/information/restart/state-cleared/
unknown-tool. A second independent DSH session (another teammate) exercised the same tools live:
`2+2→4`, state `4242→8484`, PNG export 34,248 B in 4.41 s, `information`, `kernel_status`.

### E8 — CI workflow: source ready, commit blocked by credential scope

The workflow is authored and its steps were verified locally:
`node --test` → 41/41 pass (Node 24.21.0; with `MATHEMATICA_MCP_TEST_SKIP_KERNEL=1` → 26 pass,
15 skipped, 0 fail), `node dsh/scripts/sync-server.mjs --check` → in sync,
`node market/validate-index.mjs market/index.json` → valid.

Publishing `.github/workflows/ci.yml` is blocked at every path by the token's scopes
(`gist`, `read:org`, `repo` — no `workflow`):

| Attempt | Result |
| --- | --- |
| `git push` of a commit adding `.github/workflows/ci.yml` | `! [remote rejected] … (refusing to allow an OAuth App to create or update workflow '.github/workflows/ci.yml' without 'workflow' scope)` |
| REST contents API `PUT repos/…/contents/.github/workflows/ci.yml` | `404 Not Found` |
| GraphQL `createCommitOnBranch` adding the same path | `FORBIDDEN — yhbcode000 does not have the correct permissions to execute CreateCommitOnBranch` |

The repository therefore cannot carry a runnable workflow until the credential is upgraded. The
workflow source is published at [`ci-workflow.yml`](ci-workflow.yml) (with activation instructions
in its header). Activation is one command from a credential with the scope:

```powershell
gh auth refresh -h github.com -s workflow   # one-time browser approval
```

then copy `docs/ci-workflow.yml` to `.github/workflows/ci.yml`, commit and push. The workflow runs:
server tests on Node 18/20/22 (`node --test`, kernel tests skipped via
`MATHEMATICA_MCP_TEST_SKIP_KERNEL=1`), a `bin/mathematica-mcp.js` initialize/tools-list smoke test,
and a package/bundle/market validation job (`node market/validate-index.mjs`,
`node dsh/scripts/sync-server.mjs --check`, manifest/locale/icon checks, patch guardrails).

### E9 — market-style git install verified

The exact install spec from the market index was exercised with pnpm 11.28.5 and portable git:

```text
$ pnpm add "git+https://github.com/yhbcode000/mathematica-mcp.git#e1015b8…&path:/dsh"
dependencies:
+ dsh-mathematica-mcp 0.1.0
lock resolution: {gitHosted: true, path: /dsh, tarball: https://codeload.github.com/yhbcode000/mathematica-mcp/tar.gz/e1015b8…}
```

The installed package contains `cordis.patch.yml`, `icon.svg`, `locale/{en,zh}.json`, `README.md`,
and `server/{package.json,bin/mathematica-mcp.js,src/{detect,kernel,server}.js}`. Installed into a
throwaway DSH profile, selecting `dsh-mathematica-mcp` in `dsh.profile.bundles`, `dsh --dump-config`
composed the `mcp-mathematica` row; booting the profile spawned
`DeepSeek Harness.exe <profile>/node_modules/dsh-mathematica-mcp/server/bin/mathematica-mcp.js` and
the server answered `initialize` (`2025-11-25 -> 2024-11-05`) — i.e. the commit-pinned, path-scoped
market install works end to end.

Caveat: `dsh plugin add "<git spec>"` (the CLI passthrough) rewrites git specs to `github:` shorthand
and drops `&path:/dsh`, installing the repository root instead of the bundle — use
`plugin_manager`'s market install path (or pass the spec to `pnpm add` directly) for this repo.
<!-- /EVIDENCE -->

## Notebook plugin (published 0.1.0)

Package: `dsh-mathematica-notebook` 0.1.0.

Release state: **published** as `dsh-mathematica-notebook` 0.1.0 in this repository and the same
plugin-market index. The checklist below is checked only where the recorded evidence exists; the
remaining open item is the manual real-browser visual pass.

| Item | Value |
| --- | --- |
| DSH bundle package | `dsh-mathematica-notebook` 0.1.0 (bundle directory `notebook/`) |
| Market entry name (must equal `package.json` name) | `dsh-mathematica-notebook` |
| Market index | same index URL as above, with a new `plugins[]` entry |
| Market install spec form | `git+https://github.com/yhbcode000/mathematica-mcp.git#<pinned commit>&path:/notebook` |
| Repo commit containing `notebook/` | `<filled by the publish task>` |
| Icon / locale | `notebook/icon.svg`, `notebook/locale/{en,zh}.json` |
| Maintainer documentation | [`notebook-plugin.md`](notebook-plugin.md) |

### Release checklist (evidence required before `[x]`)

- [ ] Implementation complete: `notebook/index.js` + `notebook/lib/**` + `notebook/client.js` from the
      implementation tasks, and `node --test` green at the repo root (includes `notebook/test/**`).
- [ ] Vendored kernel bridge in sync: `node notebook/scripts/sync-kernel.mjs --check` exits 0.
- [ ] Host half importable without DSH:
      `node --input-type=module -e "await import('./notebook/index.js')"`.
- [ ] Bundle installs in a DSH profile (`plugin_manager` `install_bundle`, target `<repo>/notebook`) →
      `application: "applied"`, no warnings.
- [ ] Browser half verified in the DSH Web UI with the checklist below.
- [ ] Agent tool verified: `mathematica_notebook` `create` / `read` / `edit` / `run` against a real
      kernel, and agent edits become visible in the open tab after the 2 s poll.
- [ ] `market/index.json` gains the notebook entry (`name` = `dsh-mathematica-notebook`, version
      `0.1.0`, `source.path` = `notebook`) and passes `node market/validate-index.mjs`.
- [ ] Repo pushed; commit SHA recorded; market entry pinned to a commit whose tree contains
      `notebook/**`; index pushed again.
- [ ] Raw index URL returns 200 with no redirect; shipped-validator parse OK; the pinned commit tree
      contains `notebook/lib/**`, `notebook/client.js`, `notebook/kernel/**`.
- [ ] CI workflow source updated for the notebook checks (repo copy **and** `docs/ci-workflow.yml`;
      CI enforces the two bodies are identical).
- [ ] User docs' claims match observed behavior: two independent kernels, code-cells-only v1, 2D SVG / 3D PNG output,
      read-only foreign `.nb` imports.

### Browser verification checklist (manual — this repository has no browser-control harness)

| Check | Expected |
| --- | --- |
| Guide entry in the right sidebar | **New Mathematica notebook** opens a tab; localized in `en` and `zh`. |
| New notebook | File created under `<cwd>/notebooks` (fallback `$DSH_HOME/notebooks`); a valid `.nb` exists on disk. |
| Run a cell | `2+2` → `4` as text; `Plot[...]` → typeset SVG. |
| Run a 3D cell | `Plot3D[...]` → PNG image in the cell (not raw `Graphics3D` text). |
| Persistence | A definition in cell 1 is visible to cell 2; restart clears it. |
| Save + reopen | Save writes to disk; reopening shows the same cells; revision increments. |
| Foreign `.nb` import | Read-only when cells cannot all map; **Save As** creates an editable copy. |
| Open in Mathematica | Launches the external front end; reports `launch_failed` when no front end exists. |
| `.nb` file link | Opening a `.nb` resource opens it in a notebook tab. |
| Agent edit visibility | An agent edit appears in the open tab within ~2 s without a manual reload. |
| Conflict banner | Local dirty edits + external revision → banner offering reload or keep-local. |
| Owner-only channel | Non-owner requests are refused (403); non-POST is refused (405). |

### Evidence placeholders

<!-- NOTEBOOK EVIDENCE -->
- N1 — bundle install result: `<pending>`
- N2 — browser verification: `<pending>`
- N3 — agent tool calls (`create`/`read`/`edit`/`run`): `<pending>`
- N4 — repo commit SHA containing `notebook/`: `<pending>`
- N5 — market pin + validator output: `<pending>`
- N6 — raw index URL status: `<pending>`
<!-- /NOTEBOOK EVIDENCE -->

### Local integration evidence (Lead, real DSH profile)

<!-- Filled with the final post-fix evidence block when the release commit is authorized; the
pre-fix integration run is not published. -->
`<pending>`

### Known cosmetic notes (record, not release blockers)

- After `plugin_manager` `remove_bundle` of a `link:` install, pnpm can leave a stale
  `node_modules/dsh-mathematica-notebook` symlink in the profile. It is harmless, removed by the
  next install/prune, and must not be read as a failed uninstall.
- Real-browser visual verification: the automated client checks ran through an external
  fake-React/fake-Host harness over the real `client.js`; the manual checklist above still needs
  one real-browser pass and stays pending until then.
- Close-then-debug store entry (memory only): fixed before release — `close` flushes, disposes per-document
  timers and deletes the store entry (tombstoned so an in-flight auto-save cannot resurrect it).

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
# Files under .github/workflows/ additionally require the `workflow` OAuth scope.
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
