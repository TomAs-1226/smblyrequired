// -----------------------------------------------------------------------------
// Extension / MIME → viewer routing.
//
// Deliberately dependency-free and tiny: panels import this statically to decide
// whether to offer a "preview" affordance at all, so it rides along in the
// Portal chunk. Everything it *names* is loaded lazily by FileViewer — this file
// only knows strings.
//
// Routing is by extension first, MIME second. The extension is what the uploader
// controlled and what the team actually reasons about ("open the .java file");
// the MIME is whatever the storage layer guessed at upload time, which for
// anything unusual is `application/octet-stream` and therefore useless.
// -----------------------------------------------------------------------------

// Two-part extensions have to be tested before the single-part fallback, or
// `archive.tar.gz` reads as `.gz` and gets routed to the wrong unpacker.
const COMPOUND = ['tar.gz', 'tar.bz2', 'tar.xz']

export function extensionOf(pathOrName) {
  const name = String(pathOrName ?? '')
    .split(/[\\/]/)
    .pop()
    .toLowerCase()
  for (const c of COMPOUND) {
    if (name.endsWith('.' + c)) return c
  }
  const dot = name.lastIndexOf('.')
  // `lastIndexOf` returning 0 means a dotfile (`.gitignore`) — that is a name,
  // not an extension, and treating it as one routes every dotfile identically.
  return dot > 0 ? name.slice(dot + 1) : ''
}

export function baseName(pathOrName) {
  return String(pathOrName ?? '')
    .split(/[\\/]/)
    .pop()
}

// The language id is also the highlighter's dialect key. Grouping aliases here
// keeps the tokenizer from having to know that `.mjs` and `.js` are the same
// thing, and that `.h` is usually C++ in this repo's world.
export const CODE_EXT = {
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  markdown: 'markdown',
  txt: 'text',
  log: 'text',
  csv: 'text',
  css: 'css',
  scss: 'css',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'toml',
  cfg: 'toml',
  sql: 'sql',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  c: 'cpp',
  h: 'cpp',
  hpp: 'cpp',
  gradle: 'java',
  properties: 'properties',
  sh: 'shell',
  bash: 'shell',
  env: 'properties',
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico'])
const ARCHIVE_EXT = new Set(['zip', 'tar.gz', 'tgz', 'tar'])
// Rendered (as opposed to read as source) only ever inside a sandboxed iframe.
const MARKUP_EXT = new Set(['html', 'htm', 'svg'])

/**
 * Resolve a file to a viewer kind.
 * @returns {'code'|'json'|'image'|'pdf'|'archive'|'markup'|null} null = no preview
 */
export function pickViewer({ path, mime } = {}) {
  const ext = extensionOf(path)
  const type = String(mime ?? '').toLowerCase()

  if (ext === 'pdf' || type === 'application/pdf') return 'pdf'
  if (ARCHIVE_EXT.has(ext)) return 'archive'
  if (MARKUP_EXT.has(ext)) return 'markup'
  if (ext === 'json') return 'json'
  if (IMAGE_EXT.has(ext)) return 'image'
  if (ext in CODE_EXT) return 'code'

  // MIME fallback, for objects stored without a useful filename. `image/svg+xml`
  // is checked ahead of the generic image branch on purpose: an SVG is a
  // document that can carry script, not a bitmap, and must not reach <img>.
  if (type === 'image/svg+xml') return 'markup'
  if (type.startsWith('image/')) return 'image'
  if (type === 'application/json') return 'json'
  if (type === 'text/html') return 'markup'
  if (type.startsWith('text/')) return 'code'
  if (type === 'application/zip' || type === 'application/gzip') return 'archive'

  return null
}

export function canPreview(file) {
  return pickViewer(file) !== null
}

export function languageFor(pathOrName) {
  return CODE_EXT[extensionOf(pathOrName)] ?? 'text'
}

// `2026/abc-Robot.java` → `2026/abc-Robot-v2.java`, and `-v2` → `-v3`.
//
// A new path every time, never an overwrite. The nightly backup manifest records
// a checksum per stored object, so silently mutating one in place would leave the
// manifest describing bytes that no longer exist — which breaks the ability to
// verify a restore, and does it quietly, which is worse.
//
// Lives here rather than in CodeViewer so it is pure and testable.
export function bumpVersion(path, forceN) {
  const str = String(path ?? '')
  const slash = str.lastIndexOf('/')
  const dir = slash >= 0 ? str.slice(0, slash + 1) : ''
  const file = slash >= 0 ? str.slice(slash + 1) : str
  const dot = file.lastIndexOf('.')
  // `dot > 0` so a dotfile keeps its whole name as the stem rather than being
  // split into an empty stem and a ".gitignore" extension.
  const stem = dot > 0 ? file.slice(0, dot) : file
  const ext = dot > 0 ? file.slice(dot) : ''
  const m = stem.match(/^(.*)-v(\d+)$/)
  const base = m ? m[1] : stem
  const n = forceN ?? (m ? Number(m[2]) + 1 : 2)
  return { path: `${dir}${base}-v${n}${ext}`, n }
}

// Whether a name looks like something CodeViewer can render as text. Used by the
// archive lister to decide which entries are clickable.
export function isTextLike(pathOrName) {
  const ext = extensionOf(pathOrName)
  if (ext in CODE_EXT) return true
  // Extensionless files at the root of a repo archive are nearly always text
  // (LICENSE, Makefile, Dockerfile) and are worth being able to open.
  return ext === ''
}
