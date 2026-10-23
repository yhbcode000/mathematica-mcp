// Sync the standalone mathematica-mcp server (repo root bin/ + src/ + package.json)
// into this plugin bundle's server/ directory, preserving the server's own layout
// so its relative imports keep working after installation.
//
//   node dsh/scripts/sync-server.mjs          sync into dsh/server/
//   node dsh/scripts/sync-server.mjs --check  verify dsh/server/ is in sync (CI)
//
// The copy is generated, never hand-edited: change the server in bin/ and src/
// at the repository root, then re-run this script and commit both.
//
// package.json is copied too: src/server.js reads `../package.json` (its package
// root) for name/version metadata, and dsh/server/ is that root once vendored.
import { cp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, sep } from 'node:path'

const checkOnly = process.argv.includes('--check')
const scriptDir = dirname(fileURLToPath(import.meta.url))
const bundleDir = resolve(scriptDir, '..')
const repoRoot = resolve(bundleDir, '..')
const serverDir = join(bundleDir, 'server')

const directories = ['bin', 'src']
const rootFiles = ['package.json']

async function exists (path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function listTree (root, prefix = '') {
  const entries = await readdir(root, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...await listTree(join(root, entry.name), relative))
    else files.push(relative)
  }
  return files
}

for (const directory of directories) {
  if (!(await exists(join(repoRoot, directory)))) {
    console.error(`sync-server: missing source directory ${join(repoRoot, directory)}`)
    process.exit(1)
  }
}
for (const file of rootFiles) {
  if (!(await exists(join(repoRoot, file)))) {
    console.error(`sync-server: missing source file ${join(repoRoot, file)}`)
    process.exit(1)
  }
}

if (checkOnly) {
  const problems = []
  const expectedFiles = []
  for (const directory of directories) {
    for (const file of await listTree(join(repoRoot, directory))) expectedFiles.push(`${directory}/${file}`)
  }
  for (const file of rootFiles) expectedFiles.push(file)

  for (const file of expectedFiles) {
    const vendored = join(serverDir, file)
    if (!(await exists(vendored))) {
      problems.push(`missing dsh/server/${file}`)
      continue
    }
    const left = await readFile(vendored)
    const right = await readFile(join(repoRoot, file))
    if (!left.equals(right)) problems.push(`out-of-date dsh/server/${file}`)
  }

  // Everything under dsh/server/ must be generated; report stray files.
  const actualFiles = (await exists(serverDir)) ? await listTree(serverDir) : []
  for (const file of actualFiles) {
    if (!expectedFiles.includes(file)) problems.push(`stale dsh/server/${file} (not generated from bin/ + src/ + package.json)`)
  }

  if (problems.length > 0) {
    console.error('sync-server --check: dsh/server/ is out of sync with the repo-root server:')
    for (const problem of problems) console.error(`  ${problem}`)
    console.error('run: node dsh/scripts/sync-server.mjs')
    process.exit(1)
  }
  console.log(`sync-server --check: dsh/server/ is in sync (${expectedFiles.length} files)`)
  process.exit(0)
}

await rm(serverDir, { recursive: true, force: true })
await mkdir(serverDir, { recursive: true })

for (const directory of directories) {
  await cp(join(repoRoot, directory), join(serverDir, directory), {
    recursive: true,
    filter: (path) => !path.split(sep).includes('node_modules'),
  })
}
for (const file of rootFiles) {
  await cp(join(repoRoot, file), join(serverDir, file))
}

const entry = join(serverDir, 'bin', 'mathematica-mcp.js')
if (!(await exists(entry))) {
  console.error(`sync-server: expected server entry ${entry} after copying`)
  process.exit(1)
}
if (!(await exists(join(serverDir, 'package.json')))) {
  console.error('sync-server: expected dsh/server/package.json after copying')
  process.exit(1)
}

const files = await listTree(serverDir)
console.log(`sync-server: copied ${files.length} file(s) from ${repoRoot} into ${serverDir}`)
for (const file of files) console.log(`  server/${file}`)
