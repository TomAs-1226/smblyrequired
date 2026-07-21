#!/usr/bin/env node
/**
 * Upload graphify's rendered `graph.html` and attach it to an existing graph row.
 *
 *   node scripts/upload-graph-html.mjs <graph-slug> <path/to/graphify-out>
 *
 * graphify already produces a self-contained interactive view. Serving that is
 * better than reimplementing it: it is whatever graphify's authors intended,
 * it stays correct when graphify changes, and it is already tuned for the graphs
 * it generates.
 *
 * It is also ~2 MB of author-supplied markup WITH SCRIPTS IN IT, so the portal
 * renders it only inside `sandbox="allow-scripts"` WITHOUT `allow-same-origin`.
 * That combination is what stops the framed document reaching back into the
 * session — omitting it would hand any graph author the signed-in user's tokens.
 */

import { createClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const URL_ = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL_ || !KEY) {
  console.error('set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const [, , slug, dir] = process.argv
if (!slug || !dir) {
  console.error('usage: upload-graph-html.mjs <graph-slug> <graphify-out dir>')
  process.exit(1)
}

const supabase = createClient(URL_, KEY, { auth: { persistSession: false } })

const htmlPath = path.join(dir, 'graph.html')
let raw
try {
  raw = await readFile(htmlPath)
} catch {
  console.error(`no graph.html in ${dir}`)
  process.exit(1)
}

const { size } = await stat(htmlPath)
const sha256 = createHash('sha256').update(raw).digest('hex')
const season = new Date().getFullYear()
const storagePath = `${season}/${slug}-graph.html`

const { error: upErr } = await supabase.storage
  .from('graphs')
  .upload(storagePath, raw, { contentType: 'text/html', upsert: true })
if (upErr) {
  console.error(`upload failed: ${upErr.message}`)
  process.exit(1)
}

const { data: fileRow, error: fErr } = await supabase
  .from('files')
  .upsert(
    {
      bucket: 'graphs',
      path: storagePath,
      title: `${slug} — rendered graph`,
      description: "graphify's own interactive HTML view",
      kind: 'graph',
      season,
      byte_size: size,
      sha256,
    },
    { onConflict: 'bucket,path' }
  )
  .select('id')
  .single()
if (fErr) {
  console.error(`files row failed: ${fErr.message}`)
  process.exit(1)
}

const { error: gErr } = await supabase
  .from('graphs')
  .update({ html_file_id: fileRow.id })
  .eq('slug', slug)
if (gErr) {
  console.error(`graphs update failed: ${gErr.message}`)
  process.exit(1)
}

console.log(`  ${slug}: graph.html uploaded (${(size / 1024 / 1024).toFixed(1)} MB) and attached`)
