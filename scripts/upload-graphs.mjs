#!/usr/bin/env node
/**
 * Upload graphify output into the portal's `graphs` bucket.
 *
 * Reads a graphify-out directory, uploads `graph.json`, and records a `graphs`
 * row with counts and god nodes pulled out of `.graphify_analysis.json` so the
 * Graphs tab can show what a graph is about without downloading the payload.
 *
 *   node scripts/upload-graphs.mjs <label> <path/to/graphify-out> [source]
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Run from a trusted machine
 * — this bypasses RLS by design, the same as the backup job.
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

const [, , label, dir, sourceArg] = process.argv
if (!label || !dir) {
  console.error('usage: upload-graphs.mjs <label> <graphify-out dir> [source]')
  process.exit(1)
}

const supabase = createClient(URL_, KEY, { auth: { persistSession: false } })

const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

async function readJson(p) {
  try {
    return JSON.parse(await readFile(p, 'utf8'))
  } catch {
    return null
  }
}

const graphPath = path.join(dir, 'graph.json')
const graph = await readJson(graphPath)
if (!graph) {
  console.error(`no readable graph.json in ${dir}`)
  process.exit(1)
}

// graphify writes NetworkX node-link JSON: nodes[] + links[] with source/target.
const nodes = graph.nodes ?? []
const links = graph.links ?? graph.edges ?? []
const communities = new Set(nodes.map((n) => n.community).filter((c) => c != null))

// God nodes live in the analysis sidecar, not the graph itself. They are the
// highest-centrality entities graphify found — the fastest read on what a graph
// is actually about, which is why the portal shows them inline on the row.
const analysis = await readJson(path.join(dir, '.graphify_analysis.json'))
const gods = (analysis?.gods ?? [])
  .map((g) => (typeof g === 'string' ? g : (g?.id ?? g?.name ?? g?.label)))
  .filter(Boolean)
  .slice(0, 12)

const raw = await readFile(graphPath)
const sha256 = createHash('sha256').update(raw).digest('hex')
const { size } = await stat(graphPath)
const season = new Date().getFullYear()
const storagePath = `${season}/${slug(label)}-graph.json`

console.log(
  `${label}: ${nodes.length} nodes, ${links.length} links, ${communities.size} communities, ${gods.length} gods`
)

const { error: upErr } = await supabase.storage
  .from('graphs')
  .upload(storagePath, raw, { contentType: 'application/json', upsert: true })
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
      title: `${label} — knowledge graph`,
      description: `graphify output: ${nodes.length} nodes, ${links.length} edges`,
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

const { error: gErr } = await supabase.from('graphs').upsert(
  {
    slug: slug(label),
    title: label,
    summary: analysis?.questions?.[0] ?? null,
    source: sourceArg ?? label,
    node_count: nodes.length,
    edge_count: links.length,
    community_count: communities.size,
    god_nodes: gods,
    generated_at: new Date().toISOString(),
    file_id: fileRow.id,
  },
  { onConflict: 'slug' }
)
if (gErr) {
  console.error(`graphs row failed: ${gErr.message}`)
  process.exit(1)
}

console.log(`  uploaded -> graphs/${storagePath} (${(size / 1024 / 1024).toFixed(1)} MB)`)
