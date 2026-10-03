// =============================================================================
// The Content-Type an upload is sent with, per bucket.
//
// Supabase enforces each bucket's allowed_mime_types (migration 0002) against
// the type the BROWSER puts on the multipart part — and supabase-js ignores the
// `contentType` option for a File, using file.type as-is. Browsers report that
// type from the operating system, which is where it went wrong:
//
//   - Windows reports .zip as application/x-zip-compressed, which no bucket
//     allows, so a code archive uploaded from a school laptop was refused;
//   - .md, .7z, .step, .stl and .f3d usually arrive with an EMPTY type, sent
//     as application/octet-stream, which only `code` allows — so a markdown
//     note could not go into `knowledge` at all.
//
// This maps aliases and extensions onto the types the buckets list, and lets
// `code` (a byte archive by design) take anything as octet-stream. Pure, so
// scripts/test/upload-types.mjs can pin it in Node.
// =============================================================================

// Mirrors allowed_mime_types in supabase/migrations/0002_storage.sql.
export const BUCKET_TYPES = {
  graphs: ['application/json', 'text/html', 'image/svg+xml', 'application/gzip',
    'application/x-tar', 'application/zip'],
  code: ['application/zip', 'application/gzip', 'application/x-tar',
    'application/octet-stream', 'text/plain', 'application/json'],
  knowledge: ['application/pdf', 'image/png', 'image/jpeg', 'image/webp',
    'text/markdown', 'text/plain'],
  media: ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'video/mp4',
    'video/quicktime', 'application/pdf', 'text/markdown'],
  'public-media': ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/svg+xml'],
}

// What operating systems actually report, mapped to what the buckets list.
const ALIASES = {
  'application/x-zip-compressed': 'application/zip',
  'application/x-zip': 'application/zip',
  'application/x-gzip': 'application/gzip',
  'application/x-compressed': 'application/gzip',
  'application/x-gtar': 'application/x-tar',
  'text/x-markdown': 'text/markdown',
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
}

const BY_EXTENSION = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  log: 'text/plain',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  svg: 'image/svg+xml',
  zip: 'application/zip',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  tar: 'application/x-tar',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
}

function extensionOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name ?? '')
  return m ? m[1].toLowerCase() : ''
}

/**
 * { type, ok } — the type to send for `name` (with browser-reported `reported`)
 * into `bucket`, and whether that bucket will accept it. `ok: false` lets the
 * caller say so before spending the upload, in words, instead of relaying the
 * storage API's "mime type … is not supported".
 */
export function uploadType(bucket, name, reported) {
  const allowed = BUCKET_TYPES[bucket]
  const raw = (reported ?? '').toLowerCase().split(';')[0].trim()
  let type = ALIASES[raw] ?? raw
  // An empty or generic type says nothing; the extension usually does.
  if (!type || type === 'application/octet-stream' || (allowed && !allowed.includes(type))) {
    type = BY_EXTENSION[extensionOf(name)] ?? type
  }
  if (!allowed) return { type: type || 'application/octet-stream', ok: true }
  if (allowed.includes(type)) return { type, ok: true }
  // The code bucket is an archive of bytes — CAD, 7z, build output. Anything
  // goes, labelled honestly as opaque.
  if (allowed.includes('application/octet-stream')) return { type: 'application/octet-stream', ok: true }
  return { type: type || 'application/octet-stream', ok: false }
}

/** Human list of what a bucket takes, for the refusal message. */
export function describeAllowed(bucket) {
  const exts = Object.entries(BY_EXTENSION)
    .filter(([, t]) => BUCKET_TYPES[bucket]?.includes(t))
    .map(([e]) => `.${e}`)
  return exts.join(', ')
}
