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
| Market index | same index URL as above; the notebook entry was added and pinned in this release |
| Release commit (contains `notebook/`) | `94091e41e1425c6074779f9c7b30a0351705d569` |
| Market install spec | `git+https://github.com/yhbcode000/mathematica-mcp.git#94091e41e1425c6074779f9c7b30a0351705d569&path:/notebook` |
| Market-index commit (`main` after publish) | `0ccc9a590e6de71109e29f3b6528cc10e6935095` |
| Raw index URL / status / bytes / SHA-256 | `https://raw.githubusercontent.com/yhbcode000/mathematica-mcp/main/market/index.json` → HTTP 200, no redirect, 5,135 bytes, `e248c3a9ee6e8c863e82eda30f39f631fdae36d028d3ec25ed7e3204843dd2d1` |
| Icon / locale | `notebook/icon.svg`, `notebook/locale/{en,zh}.json` |
| Maintainer documentation | [`notebook-plugin.md`](notebook-plugin.md) |

### Release checklist (evidence required before `[x]`)

- [x] Implementation complete: `notebook/index.js` + `notebook/lib/**` (9 modules) + `notebook/client.js`;
      repo-root `node --test` = 95/95 pass, `cd notebook && node --test` = 43/43 pass, skip mode
      27 pass / 16 skip / 0 fail (evidence N4).
- [x] Vendored kernel bridge in sync: `node notebook/scripts/sync-kernel.mjs --check` exits 0
      (kernel.js 861d5d28…, detect.js cc3c8cf8…); `dsh/scripts/sync-server.mjs --check` in sync (5 files).
- [x] Host half importable without DSH
      (`node --input-type=module -e "await import('./notebook/index.js')"`), and the market-installed
      copy imports standalone (exports: `apply`, `inject`, `name`, `pluginHealth`, `RPC_CHANNEL`,
      `SERVER_VERSION`, `ErrorCodes`, `PluginError`) — evidence N1.
- [x] Bundle installs in a DSH profile: Lead's `plugin_manager` `install_bundle` (link:) returned
      `application: "applied"`, client half loaded, both sidebar bodies registered; the released
      market spec also installs and composes in a throwaway profile — evidence N1/N2.
- [ ] Browser half verified in the DSH Web UI with the checklist below. **Open item:** the automated
      fake-React/fake-Host harness (60/60) and live post-fix RPC/kernel probes passed (N2), but the
      real-browser visual pass still needs user action.
- [x] Agent tool verified: `mathematica_notebook` `create` / `read` / `edit` / `run` against the real
      kernel, edits observed through the same store; agent edits appear in an open tab through the 2 s
      poll (live probe) — evidence N3.
- [x] `market/index.json` gains the notebook entry (`name` = `dsh-mathematica-notebook`, version
      `0.1.0`, `source.path` = `notebook`) and passes `node market/validate-index.mjs` — evidence N5.
- [x] Repo pushed; release commit recorded; market entry pinned to a commit whose tree contains
      `notebook/**`; index pushed again — evidence N4/N5.
- [x] Raw index URL returns 200 with no redirect; shipped-validator parse OK (two plugins); the pinned
      commit tree contains `notebook/lib/**`, `notebook/client.js`, `notebook/kernel/**` — evidence N5/N6.
- [x] CI workflow source updated for the notebook checks (repo copy **and** `docs/ci-workflow.yml`;
      both bodies identical, enforced by a CI step). Pushing `.github/workflows/**` remains blocked by
      the publication credential's missing `workflow` scope (documented route: E8).
- [x] User docs' claims match observed behavior: two independent kernels, code-cells-only v1, 2D SVG /
      3D PNG output, read-only foreign `.nb` imports, text placeholders/caps.

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
- **N1 — bundle install result.** Real profile (Lead): `plugin_manager` `install_bundle` (link:) →
  `application: "applied"`; client half loaded and both sidebar bodies registered in
  `sidebar.right.pane.tab` (keys `dsh-mathematica-notebook/page`,
  `dsh-mathematica-notebook/file`); authenticated client→Host hello present
  (`lastHello.payload.client = dsh-mathematica-notebook`). Release-time market install check (this
  publish): `pnpm add "git+https://github.com/yhbcode000/mathematica-mcp.git#94091e4…&path:/notebook"`
  in a throwaway DSH profile → `+ dsh-mathematica-notebook 0.1.0`; installed payload contains
  `client.js`, `index.js`, `lib/*.js` (9 modules), `kernel/{kernel,detect}.js`,
  `cordis.patch.yml`, `locale/*`, `icon.svg`; after selecting the bundle,
  `dsh --dump-config` composes `- id: dsh-mathematica-notebook / name: dsh-mathematica-notebook /
  config: {}`; the installed Host half imports standalone.
- **N2 — browser verification.** Automated client harness (external fake-React + fake-Host over the
  real `client.js`): 60/60 checks (create→evaluate→SVG pretty/raw→debounced save→conflict→
  keep-local→restart→open-in-mathematica→file-address open→failure/retry→unmount cleanup), plus the
  PNG/SVG MIME-sniff fix cases. Post-fix live RPC probes through the same dispatch the browser uses:
  3D `Plot3D[…]` → text `[typeset output]` + 249,163-byte PNG attachment (~1.1 s);
  2D `Plot[…]` → 31,371-byte SVG (~1.55 s); symbolic `Integrate[x^2,x]` → 10,162-byte SVG;
  placeholders uniform. **Real-browser visual pass remains pending user action** (manual table above).
- **N3 — agent tool calls.** `create` → `<cwd>/notebooks/Untitled-1.nb` (rev 1); `edit`
  (replace+insert) → rev 2; `run` all → `2+2`→4, `Plot`→SVG, `Integrate[x^2,x]`→`x^3/3`,
  multi-statement → 6; `read` preserved code incl. newlines; saved `.nb` re-imported by the separate
  MCP kernel (`Import[…,"NB"]` → 4 cells); foreign styled `.nb` opened read-only and `saveAs`
  produced an editable copy; timeout probe → `kernel_timeout` at 2,010 ms with the kernel still
  running; `openInMathematica` → `{"launched":true,"executable":"C:\\Program Files\\Wolfram
  Research\\Wolfram\\15.0\\WolframNB.exe","pid":25420}`; `close` → `{closed:true}` and the
  store entry is deleted/tombstoned (no premature count, save-after-close → `not_found`).
  Post-fix tool `run` placeholders are uniform for 2D/3D/symbolic; scalar results keep real values.
- **N4 — repo commits.** Release commit (contains `notebook/`):
  `94091e41e1425c6074779f9c7b30a0351705d569` ("Release 0.1.0: dsh-mathematica-notebook sidebar
  notebook plugin", 30 files, +10,429/−33); market-index commit:
  `0ccc9a590e6de71109e29f3b6528cc10e6935095`. Pinned tree has 73 entries; all required paths present
  (`notebook/package.json`, `cordis.patch.yml`, `client.js`, `index.js`, `lib/*` (9),
  `kernel/{kernel,detect}.js`, `locale/*`, `icon.svg`, `README.md`, `CONTRACT.md`, `test/*`,
  `docs/notebook-plugin.md`, `README.md`, `src/kernel.js`); no `.github/` in the tree. The 14
  published file SHA-256 prefixes match the Lead's release hashes with 0 mismatches.
- **N5 — market pin + validator.** Entry `dsh-mathematica-notebook` 0.1.0,
  `source = { git, url: https://github.com/yhbcode000/mathematica-mcp, commit: 94091e4…,
  path: notebook }`, `engines.dsh: ">=0.2.0"`, category `integration`, label
  `computer-algebra`, en+zh title/description, icon main-branch URL. `node
  market/validate-index.mjs` on the working copy and on the downloaded document → valid format 1
  (3 versions across 2 plugins). **Shipped validator** (`parseMarketIndex`, 0.2.1-rc.2, imported from
  `app.asar` via Electron-as-node) on the live raw URL → OK: format 1, plugins = 2, versions
  normalized descending. The existing `dsh-mathematica-mcp` 0.1.0/0.1.1 entries are untouched.
- **N6 — raw index URL.** `GET
  https://raw.githubusercontent.com/yhbcode000/mathematica-mcp/main/market/index.json` → HTTP 200,
  0 redirects, 5,135 bytes, SHA-256
  `e248c3a9ee6e8c863e82eda30f39f631fdae36d028d3ec25ed7e3204843dd2d1` (identical to the working-copy
  file), JSON parses.
<!-- /NOTEBOOK EVIDENCE -->

### Local integration evidence (Lead, real DSH profile)

Recorded from the Lead's real-profile verification after the two polish fixes (2026-10-23 ~22:52
Asia/Shanghai), plus the release-time checks in N1/N4/N5/N6:

- Bundle reinstalled after the fixes; debug: RPC registered/mounted, authenticated client hello
  present (client HMR picked up the MIME-sniff build), kernel 15.0.1 at
  `C:\Program Files\Wolfram Research\Wolfram\15.0\math.exe`.
- Rich output after the fix: 3D `Plot3D[…] ` → PNG attachment (249,163 B, PNG-signature asserted in
  tests, ~1.1 s), 2D `Plot[…]` → SVG (31,371 B), symbolic result → SVG (10,162 B); all three cells
  report the uniform short placeholder instead of tens of KB of `InputForm`.
- Tool `run` placeholders uniform for 2D SVG and 3D PNG; scalar results keep their real values.
- `close` flushes/disposes/deletes/tombstones the store entry (store count drops, no resurrection,
  save after close → `not_found`, open reloads).
- Tests after fixes: notebook `node --test` 43/43; repo-root `node --test` 95/95 (22.4 s, exit 0;
  one earlier 94/95 run was a flake under parallel kernel load — three subsequent runs, including
  this release run, were 95/95); skip mode 27 pass / 16 skip / 0 fail; both sync checks green.
- Uninstall/reinstall left the profile clean (the MCP bundle was untouched); a stale pnpm `link:`
  symlink can remain after removal (cosmetic, see notes below).

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

### Notebook 0.2.1 — WLJS web notebook (compatibility path)

Release of `dsh-mathematica-notebook` that adds the local WLJS Notebook bridge behind a **Web
notebook** toolbar button, so dynamic/rich Wolfram output that the plugin's own renderer cannot
express is produced by a real web frontend on the same local kernel.

| Item | Value |
| --- | --- |
| Package version | `0.2.1` |
| New Host module | `notebook/lib/web-notebook.js` (WLJS discovery, process lifetime, `/api/notebook/...` client) |
| New tests | `notebook/test/web-notebook.test.js` (9 cases) |
| New endpoints / tool actions | `webStatus`, `webStart`, `webStop`, `webOpen`, `webListNotebooks`, `webNewNotebook`, `webSeed`, `webListCells`, `webAddCells`, `webEvaluate`, `webKernelEvaluate` |
| Unit tests | `notebook`: 52/52 via `node --test` |
| Install spec | `git+https://github.com/yhbcode000/mathematica-mcp.git#a7f1ec988cdfbe703b1b3ba57566fb2a1b7623c3&path:/notebook` |
| Release commit | `a7f1ec988cdfbe703b1b3ba57566fb2a1b7623c3` |
| Market pin commit (`main`) | `00e7a1b0724dac6417ff254a6284ce230f1811a7` |
| Index file SHA-256 (local == published) | `a5baca96319e39627792893069329251ffbfb4f28444c6409dc7c7b79c15cfb7` |

Pre-publication verification (local Windows 10, Mathematica 15.0.1):

- **V1** WLJS Notebook 3.1.4 source tree extracted under
  `%DSH_HOME%/artifacts/wljs-notebook/app/wljs-notebook-3.1.4`; `GET /` answers HTTP 200 and the
  CSockets kernel prints `Windows >> Windows-x86-64`, `Loading library... LLink 8`,
  `Succesfully loaded!`.
- **V2** Real plugin flow through `mathematica_notebook`: `webStatus` reports
  `available/ready/running` plus `pid`; `webStart` spawns
  `<wolframscript> -f Scripts/start.wls` and becomes ready in ~7 s warm (~90 s cold); `webOpen`
  creates a `llm-*.wln` quick-note and returns its encoded URL; `webSeed` appends the intro cell
  plus four sample cells and evaluates them; `webEvaluate` evaluates one cell by id.
- **V3** Rendering proof (headless Edge over CDP, full-page screenshot): `2 + 2` → `4`,
  `Plot3D[..., ColorFunction -> "Rainbow"]` → interactive coloured surface,
  `Manipulate[Plot[Sin[n x] ...]]` → slider plus live plot, markdown intro cell typeset.
- **V4** Failure typing: missing installation → `web_notebook_unavailable` with the searched roots
  (unit-tested); start/API failures → `web_notebook_failed` with `logTail`.
- **V5** The toolbar button lives in the browser half, so the new button appears after the DSH page
  reloads; the Host half (tool actions and RPC endpoints) applies on bundle install.

Publication status: **published** — release commit `a7f1ec9`, market index updated in `00e7a1b`,
raw index verified HTTP 200 (6,073 bytes) with matching SHA-256, `market/validate-index.mjs` passes
for all four entries (`dsh-mathematica-mcp@0.1.0/0.1.1`,
`dsh-mathematica-notebook@0.1.0/0.2.1`), and the repository suite is 104/104 (`node --test` from the
repository root).
### Notebook 0.3.0 — animation GIF rendering (WLJS removed)

Feature release that makes dynamic output visible in the **native DSH sidebar notebook** (the product
answer to "Mathematica 有太多需要支持的 type"): animations are now rendered into the cell as a
looping GIF by the local kernel. The 0.2.1 WLJS web-notebook experiment is reverted, and its local
installation (≈660 MB) was removed from this machine.

| Item | Value |
| --- | --- |
| Package version | `0.3.0` |
| Release commit | `e77cf91d4c9a5596714e5582ebd9729dea0c085e` |
| Install spec | `git+https://github.com/yhbcode000/mathematica-mcp.git#e77cf91d4c9a5596714e5582ebd9729dea0c085e&path:/notebook` |
| Reverted | `0.2.1` WLJS integration (its commit `a7f1ec9` stays in history) |
| New rendering | GIF artifact (≤ 12 MiB) for `Animate[...]`, `ListAnimate[...]` and `Table` of plots; camera player chrome is stripped by rebuilding the animation as an explicit frame list |
| New module code | `lib/kernel-manager.js`: `guessArtifactFormat` / `inferResultArtifactFormat` gain `gif`, new `animationFramesCode` parser + `_renderCleanAnimation`; `client.js` sniffs `GIF87a/GIF89a` |

Verification (local Windows 10, Mathematica 15.0.1):

- **V1 — unit:** notebook suite 47/47 (`node --test`), repository root 99/99. New unit tests cover
  `guessArtifactFormat` (animation → gif, Table of plots → gif, Table of numbers → svg, 3D → png),
  `inferResultArtifactFormat`, and `animationFramesCode` rewriting
  (`Animate[body, {t, min, max}]` → `Table[...]` with 48 frames, supplied step respected, unsafe
  shapes → `null`).
- **V2 — real kernel:** `Animate[...]` → `GIF89a` artifact (clean frames, no Manipulate player
  chrome, 1.2 MB for a 48-frame 420 px wave), `ListAnimate[Table[...]]` → GIF, `Table[Plot[...]]` →
  GIF. The clean path deliberately skips the bridge-side artifact export, because rasterising the
  evaluated `Manipulate` object both captures the chrome and can exceed the evaluation timeout.
- **V3 — installed package:** after installing `dsh-mathematica-notebook@0.3.0` locally, the
  installed `KernelManager` produces a 1.2 MB `GIF89a` for `Animate[...]` and 243 KB for a `Table`
  frame list; the installed `client.js` contains the GIF sniffer and no web-notebook button; the
  running Host reports `serverVersion: "0.3.0"` and the client half re-registered (hello after HMR),
  so no DSH restart was needed for this release.
- **V4 — end-to-end notebook:** `D:\workspace\notebooks\animation-demo.nb` holds a note plus three
  animation cells (`Animate` wave, `Animate` rose curve, `Table` frame list); running it through the
  agent tool returns `[animation rendered in the notebook]` per animation cell (the bytes are not
  persisted in the store; the tab renders them when the user runs the cells).
- **V5 — degradation:** oversized/unrenderable animations fall back to a still PNG (or text); the
  artificial 48-frame rebuild is bounded by the 12 MiB attachment cap. Draggable `Manipulate`
  controls remain out of scope (needs Wolfram's proprietary frontend).

Publication status: **local release complete, push blocked.** The market index in this working tree
adds the 0.3.0 entry pinned to `e77cf91`, and both `market/validate-index.mjs` and the shipped
`@deepseek-ai/dsh-plugin-market-index` validator accept it. Pushing failed on 2026-10-24 because the
stored `gh` CLI token is invalid/expired and the local SSH key is not authorized on GitHub
(`Permission denied (publickey)`), so the published raw index still shows the 0.2.1 state. The
release/market commits are ready to push once `gh auth login -h github.com` (or an authorized SSH
key) restores credentials.
#### 0.3.0 remote verification (2026-10-24 14:53:17 +08:00)

- `git push origin main` succeeded; remote `main` = `0ef12650ed98c9a8756723929005ce04893c0b06` (local HEAD identical).
- Raw index `https://raw.githubusercontent.com/yhbcode000/mathematica-mcp/main/market/index.json`
  downloaded and byte-identical to the local `market/index.json` (SHA-256 `455F3D1DB6295AF07EBCF2B90A5459ED6F2A666AA8D3D459AC417BDFCA7E2B7C`).
- Raw index lists notebook `0.3.0` pinned to `e77cf91d4c9a5596714e5582ebd9729dea0c085e`; both `market/validate-index.mjs`
  and the shipped `@deepseek-ai/dsh-plugin-market-index` validator accept the local file.
- Public install spec:
  `git+https://github.com/yhbcode000/mathematica-mcp.git#e77cf91d4c9a5596714e5582ebd9729dea0c085e&path:/notebook`