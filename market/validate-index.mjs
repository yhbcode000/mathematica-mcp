// Validate market/index.json against DSH plugin-market index format 1.
//
// Zero-dependency re-implementation of the rules enforced by the shipped
// @deepseek-ai/dsh-plugin-market-index validator (lib/index.js, 0.2.1-rc.2),
// covering every rule that can be checked from the document alone.
//
//   node market/validate-index.mjs [path-to-index.json]
//
// Exits 0 and prints a summary on success; prints each violation and exits 1.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const target = process.argv[2] ?? join(here, 'index.json')

const LANGUAGE_ID = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u
const PACKAGE_NAME_MAX_LENGTH = 214
const NUMERIC = '(?:0|[1-9]\\d*)'
const PRERELEASE_PART = `(?:${NUMERIC}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`
const SEMVER = new RegExp(`^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}(?:-${PRERELEASE_PART}(?:\\.${PRERELEASE_PART})*)?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`, 'u')
const COMMIT = /^[0-9a-f]{40}$/u
const PATH_SEGMENT = /^[A-Za-z0-9._@+-]+$/u
const DATA_ICON = /^data:(?:image\/svg\+xml|image\/png|image\/jpeg|image\/webp);base64,([A-Za-z0-9+/]*={0,2})$/u
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
const MAX_INLINE_ICON_BYTES = 32 * 1024
const MAX_PUBLISH_TIMESTAMP = 1e11

const failures = []

function fail (path, reason) {
  failures.push(`${path} ${reason}`)
}

function objectAt (value, path) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, 'must be an object')
    return {}
  }
  return value
}

function stringAt (value, path) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(path, 'must be a string with a non-whitespace character')
    return ''
  }
  return value
}

function optional (object, key, path, read) {
  return Object.hasOwn(object, key) ? read(object[key], `${path}.${key}`) : undefined
}

function localizedText (value, path) {
  if (typeof value === 'string') return stringAt(value, path)
  const object = objectAt(value, path)
  const text = {}
  for (const [language, member] of Object.entries(object)) {
    if (!LANGUAGE_ID.test(language)) fail(`${path}.${language}`, 'must be keyed by a lowercase language id')
    text[language] = stringAt(member, `${path}.${language}`)
  }
  if (!Object.hasOwn(text, 'en')) fail(path, 'must contain en')
  return text
}

function declarations (value, path, read) {
  const result = {}
  for (const [id, member] of Object.entries(objectAt(value, path))) {
    if (id === '') fail(path, 'must not declare an empty id')
    result[id] = read(objectAt(member, `${path}.${id}`), `${path}.${id}`)
  }
  return result
}

function indexMetadata (value, path) {
  const object = value === undefined ? {} : objectAt(value, path)
  return {
    categories: optional(object, 'categories', path, (m, p) => declarations(m, p, (o, q) => ({ title: localizedText(o.title, `${q}.title`) }))) ?? {},
    labels: optional(object, 'labels', path, (m, p) => declarations(m, p, (o, q) => ({ title: localizedText(o.title, `${q}.title`) }))) ?? {},
    sortKeys: optional(object, 'sortKeys', path, (m, p) => declarations(m, p, (o, q) => {
      if (o.order !== 'asc' && o.order !== 'desc') fail(`${q}.order`, 'must be "asc" or "desc"')
      return { title: localizedText(o.title, `${q}.title`), order: o.order }
    })) ?? {},
  }
}

function declaredId (value, path, declared) {
  const id = stringAt(value, path)
  if (!declared[id]) fail(path, `references undeclared id ${JSON.stringify(id)}`)
  return id
}

function pluginMetadata (value, path, index) {
  const object = value === undefined ? {} : objectAt(value, path)
  optional(object, 'category', path, (m, p) => declaredId(m, p, index.categories))
  optional(object, 'keywords', path, (m, p) => {
    if (!Array.isArray(m)) fail(p, 'must be an array')
    else m.forEach((keyword, position) => {
      if (typeof keyword !== 'string') fail(`${p}[${position}]`, 'must be a string')
    })
  })
  optional(object, 'labels', path, (m, p) => {
    if (!Array.isArray(m)) fail(p, 'must be an array')
    else {
      const ids = m.map((label, position) => declaredId(label, `${p}[${position}]`, index.labels))
      if (new Set(ids).size !== ids.length) fail(p, 'must not repeat a label')
    }
  })
  optional(object, 'sortKeys', path, (m, p) => {
    for (const id of Object.keys(objectAt(m, p))) declaredId(id, `${p}.${id}`, index.sortKeys)
  })
}

function httpUrl (value, path, protocols) {
  const text = stringAt(value, path)
  let url
  try {
    url = new URL(text)
  } catch {
    fail(path, 'must be an absolute URL')
    return new URL('https://invalid.example/')
  }
  if (!protocols.includes(url.protocol)) fail(path, `must use ${protocols.join(' or ')}`)
  if (url.username !== '' || url.password !== '') fail(path, 'must not contain credentials')
  if (url.href.includes('?') || url.href.includes('#')) fail(path, 'must not contain a query or fragment')
  return url
}

function homepageUrl (value, path) {
  const text = stringAt(value, path)
  if (!URL.canParse(text)) {
    fail(path, 'must be an absolute URL')
    return text
  }
  const url = new URL(text)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail(path, 'must use https: or http:')
  return url.href
}

function gitUrl (value, path) {
  const url = httpUrl(value, path, ['https:'])
  if (url.href !== value) fail(path, 'must be a canonical URL')
  if (!/^(?:\/[^/]+){2,}$/u.test(url.pathname)) fail(path, 'must name a repository with at least two path segments')
  if (/\.(?:tgz|tar\.gz)$/iu.test(url.pathname)) fail(path, 'must name a repository, not a tarball')
  return url
}

function packagePath (value, path) {
  const text = stringAt(value, path)
  if (text.split('/').some((segment) => segment === '.' || segment === '..' || !PATH_SEGMENT.test(segment))) {
    fail(path, 'must be a relative directory of letters, digits, and ._@+- segments without . or ..')
  }
  return text
}

function repository (value, path) {
  const object = objectAt(value, path)
  const url = httpUrl(object.url, `${path}.url`, ['https:', 'http:']).href
  optional(object, 'directory', path, packagePath)
  return { url }
}

function icon (value, path, indexUrl) {
  const text = stringAt(value, path)
  if (text.startsWith('data:')) {
    const payload = DATA_ICON.exec(text)?.[1]
    if (payload === undefined || payload === '' || !BASE64.test(payload)) {
      fail(path, 'must be a base64 SVG, PNG, JPEG, or WebP data URL')
      return text
    }
    const bytes = payload.length / 4 * 3 - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0)
    if (bytes > MAX_INLINE_ICON_BYTES) fail(path, `must not exceed ${MAX_INLINE_ICON_BYTES / 1024} KiB of decoded bytes`)
    return text
  }
  let resolved
  try {
    resolved = new URL(text, indexUrl)
  } catch {
    fail(path, 'must be a URL reference')
    return text
  }
  if (resolved.protocol !== 'https:' && resolved.origin !== new URL(indexUrl).origin) {
    fail(path, 'must resolve to https or the index origin')
  }
  return resolved.href
}

function source (value, path) {
  const object = objectAt(value, path)
  if (object.type === 'npm') {
    optional(object, 'registry', path, (m, p) => httpUrl(m, p, ['https:', 'http:']))
    return { type: 'npm' }
  }
  if (object.type !== 'git') {
    fail(`${path}.type`, 'must be "npm" or "git"')
    return { type: 'git' }
  }
  const commit = stringAt(object.commit, `${path}.commit`)
  if (!COMMIT.test(commit)) fail(`${path}.commit`, 'must be a lowercase 40-hex-digit commit SHA')
  const url = gitUrl(object.url, `${path}.url`).href
  optional(object, 'path', path, packagePath)
  return { type: 'git', url, commit }
}

function engines (value, path) {
  const object = objectAt(value, path)
  optional(object, 'dsh', path, (m, at) => {
    const range = stringAt(m, at)
    if (range.startsWith('workspace:')) fail(at, 'must not be a workspace: range')
    // Deliberately permissive: the shipped validator uses semver.validRange.
    if (!/^[\d\s.<>=~^*|vxX-]+$/u.test(range)) fail(at, 'must be a SemVer range')
  })
}

function marketVersion (value, path) {
  const object = objectAt(value, path)
  const version = stringAt(object.version, `${path}.version`)
  if (!SEMVER.test(version)) fail(`${path}.version`, 'must be an exact SemVer version')
  const publishTimestamp = object.publishTimestamp
  if (typeof publishTimestamp !== 'number' || !Number.isInteger(publishTimestamp) || publishTimestamp < 0 || publishTimestamp >= MAX_PUBLISH_TIMESTAMP) {
    fail(`${path}.publishTimestamp`, 'must be an integer number of Unix seconds in [0, 10^11)')
  }
  const parsed = source(object.source, `${path}.source`)
  optional(object, 'engines', path, engines)
  return { version, source: parsed }
}

function versions (value, path) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(path, 'must be a non-empty array')
    return []
  }
  const seen = new Set()
  const parsed = value.map((member, position) => {
    const at = `${path}[${position}]`
    const entry = marketVersion(member, at)
    if (seen.has(entry.version)) fail(`${at}.version`, `duplicates ${entry.version}`)
    seen.add(entry.version)
    return entry
  })
  return parsed
}

function plugin (value, path, index, indexUrl) {
  const object = objectAt(value, path)
  const name = stringAt(object.name, `${path}.name`)
  if (name.length > PACKAGE_NAME_MAX_LENGTH || !PACKAGE_NAME.test(name)) fail(`${path}.name`, 'must be a valid npm package name')
  optional(object, 'title', path, localizedText)
  optional(object, 'description', path, localizedText)
  optional(object, 'icon', path, (m, p) => icon(m, p, indexUrl))
  optional(object, 'author', path, stringAt)
  optional(object, 'homepage', path, homepageUrl)
  optional(object, 'repository', path, repository)
  pluginMetadata(object.metadata, `${path}.metadata`, index)
  return { name, versions: versions(object.versions, `${path}.versions`) }
}

async function main () {
  const indexUrl = 'https://raw.githubusercontent.com/yhbcode000/mathematica-mcp/main/market/index.json'
  const text = await readFile(target, 'utf8')
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    console.error(`${target}: not valid JSON: ${error.message}`)
    process.exit(1)
  }

  const object = objectAt(raw, '$')
  if (object.format !== 1) fail('$.format', 'must be 1')
  const metadata = indexMetadata(object.metadata, '$.metadata')
  const title = localizedText(object.title, '$.title')
  optional(object, 'description', '$', localizedText)
  if (!Array.isArray(object.plugins)) fail('$.plugins', 'must be an array')

  const names = new Set()
  const plugins = (object.plugins ?? []).map((entry, position) => {
    const parsed = plugin(entry, `$.plugins[${position}]`, metadata, indexUrl)
    if (names.has(parsed.name)) fail(`$.plugins[${position}].name`, `duplicates ${parsed.name}`)
    names.add(parsed.name)
    return parsed
  })

  if (failures.length > 0) {
    console.error(`market index ${target}: ${failures.length} violation(s)`)
    for (const failure of failures) console.error(`  ${failure}`)
    process.exit(1)
  }

  console.log(`market index ${target}: valid format 1`)
  console.log(`  title: ${typeof title === 'string' ? title : JSON.stringify(title)}`)
  for (const entry of plugins) {
    for (const version of entry.versions) {
      if (version.source.type !== 'git') {
        console.log(`  ${entry.name}@${version.version}: npm install`)
        continue
      }
      const path = version.source.path === undefined ? '' : `&path:/${version.source.path}`
      const spec = `git+${version.source.url.endsWith('.git') ? version.source.url : `${version.source.url}.git`}#${version.source.commit}${path}`
      console.log(`  ${entry.name}@${version.version}: ${spec}`)
    }
  }
}

await main()
