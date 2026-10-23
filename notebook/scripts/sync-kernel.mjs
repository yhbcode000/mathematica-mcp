// Vendor the shared Wolfram kernel bridge from the repository root into this
// plugin bundle. The notebook Host half imports ./kernel/kernel.js, so the copy
// must stay byte-identical to ../../src/kernel.js (same for detect.js, which
// kernel-manager uses to discover the local Mathematica / Wolfram Engine).
//
//   node notebook/scripts/sync-kernel.mjs          # write the vendored copy
//   node notebook/scripts/sync-kernel.mjs --check  # assert it is up to date
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const bundleDir = resolve(scriptDir, '..')
const repoRoot = resolve(bundleDir, '..')
const targetDir = join(bundleDir, 'kernel')

const SOURCES = ['kernel.js', 'detect.js']
const checkOnly = process.argv.includes('--check')

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

let stale = 0
await mkdir(targetDir, { recursive: true })

for (const name of SOURCES) {
  const sourcePath = join(repoRoot, 'src', name)
  const targetPath = join(targetDir, name)
  const source = await readFile(sourcePath)

  if (checkOnly) {
    let existing = null
    try {
      existing = await readFile(targetPath)
    } catch {
      existing = null
    }
    if (!existing) {
      console.error(`sync-kernel: missing ${targetPath}`)
      stale += 1
      continue
    }
    if (sha256(source) !== sha256(existing)) {
      console.error(`sync-kernel: stale ${targetPath} (source ${sourcePath})`)
      stale += 1
    } else {
      console.log(`sync-kernel: up to date ${name} (${sha256(source).slice(0, 12)})`)
    }
    continue
  }

  await writeFile(targetPath, source)
  console.log(`sync-kernel: copied ${name} (${sha256(source).slice(0, 12)})`)
}

if (checkOnly && stale > 0) {
  console.error(`sync-kernel: ${stale} file(s) out of date; run node notebook/scripts/sync-kernel.mjs`)
  process.exit(1)
}
