# DSH plugin market index — Mathematica MCP

This directory hosts the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
**plugin market index** for [`dsh-mathematica-mcp`](../dsh/), a bundle that connects a local
Mathematica / Wolfram Engine kernel to DSH as `mcp__mathematica__*` tools.

- **Index URL (use this exact one):**
  `https://raw.githubusercontent.com/yhbcode000/mathematica-mcp/main/market/index.json`

## Add the index to DSH

1. Open the DSH Web UI and go to the **Discover** tab (Settings → Plugins → market sources works too).
2. Add a market source and paste the raw index URL above.
3. Search for **Mathematica MCP** and install it.

Notes:

- The index URL must be the **final** URL. DSH refuses redirects, so never use
  `github.com/.../raw/...` (it redirects) and do not append a query or fragment.
- Indexes are cached for 10 minutes; a fresh publish can take that long to appear.
- Installing the market entry is a **commit-pinned git install**
  (`git+https://github.com/yhbcode000/mathematica-mcp.git#<commit>&path:/dsh`), so it requires
  `git` on `PATH`. Without git, install the bundle from a local checkout instead — see
  [docs/dsh-install.md](../docs/dsh-install.md).
- Market text is third-party content; installing a bundle runs its code in the DSH Host process.
  This one only adds an MCP client row that launches the bundled stdio server.

## Format

The file is a [format 1](https://github.com/deepseek-ai/deepseek-harness) market index validated by
the shipped `@deepseek-ai/dsh-plugin-market-index` reader:

```jsonc
{
  "format": 1,                       // required, must be 1
  "title": { "en": "…" },            // localized text, must contain "en"
  "description": { "en": "…" },      // optional
  "metadata": {                      // optional declared categories/labels/sort keys
    "categories": { "integration": { "title": { "en": "Integrations" } } }
  },
  "plugins": [{
    "name": "dsh-mathematica-mcp",   // must equal the bundle package.json name
    "title": { "en": "…", "zh": "…" },
    "author": "yhbcode000",
    "homepage": "https://github.com/yhbcode000/mathematica-mcp",
    "repository": { "url": "https://github.com/yhbcode000/mathematica-mcp", "directory": "dsh" },
    "metadata": { "category": "integration", "keywords": ["mathematica", "wolfram"] },
    "versions": [{
      "version": "0.1.0",            // exact SemVer
      "publishTimestamp": 1792784263, // integer Unix SECONDS
      "source": {
        "type": "git",
        "url": "https://github.com/yhbcode000/mathematica-mcp", // https, canonical, no trailing slash
        "commit": "<40 lowercase hex commit>",
        "path": "dsh"                // package directory inside the repo
      },
      "engines": { "dsh": ">=0.2.0" }
    }]
  }]
}
```

A published `index.json` is verified before release: it is fetched from the raw URL and passed
through the shipped validator (`parseMarketIndex`) together with this URL. Releasing a new version
means adding a `versions[]` entry pinned to the commit that contains it.
