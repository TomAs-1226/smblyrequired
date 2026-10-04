#!/usr/bin/env node
/**
 * Upload graphify output into the portal's Graphs tab.
 *
 * Reads a graphify-out directory, uploads `graph.json` (and `graph.html`, the
 * rendered view, when it is there), and records the graph with counts and god
 * nodes pulled out of `.graphify_analysis.json`, so the Graphs tab can show what
 * a graph is about without downloading the payload.
 *
 *   node scripts/upload-graphs.mjs <label> <path/to/graphify-out> [source]
 *
 * Runs on the Admin SDK (scripts/firebase/admin.mjs says what it needs). Run it
 * from a trusted machine — it bypasses the security rules by design, the same as
 * the backup job. Running it again for the same label replaces that graph.
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { db, putObject, FieldValue, Timestamp } from './firebase/admin.mjs'
import { fileId } from '../src/lib/ids.js'

const [, , label, dir, sourceArg] = process.argv
if (!label || !dir) {
  console.error('usage: upload-graphs.mjs <label> <graphify-out dir> [source]')
  process.exit(1)
}

const slugOf = (s) =>
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

const season = new Date().getFullYear()
const slug = slugOf(label)

console.log(
  `${label}: ${nodes.length} nodes, ${links.length} links, ${communities.size} communities, ${gods.length} gods`
)

/** Store one file in the `graphs` folder and index it; returns the reference a graph embeds. */
async function store(name, bytes, contentType, title, description) {
  const storagePath = `${season}/${slug}-${name}`
  await putObject('graphs', storagePath, bytes, contentType)
  const id = fileId('graphs', storagePath)
  const at = db.collection('files').doc(id)
  const existing = await at.get()
  await at.set({
    bucket: 'graphs',
    path: storagePath,
    title,
    description,
    kind: 'graph',
    season,
    tags: [],
    byte_size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    uploaded_by: null,
    created_at: existing.exists ? existing.data().created_at : FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  })
  console.log(`  uploaded -> graphs/${storagePath} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`)
  return { id, bucket: 'graphs', path: storagePath }
}

const file = await store(
  'graph.json', await readFile(graphPath), 'application/json',
  `${label} — knowledge graph`, `graphify output: ${nodes.length} nodes, ${links.length} edges`
)

// graphify's own rendered view is preferred by the portal's viewer when present.
let htmlFile = null
try {
  const html = await readFile(path.join(dir, 'graph.html'))
  htmlFile = await store('graph.html', html, 'text/html', `${label} — rendered graph`, 'graphify graph.html')
} catch {
  console.log('  no graph.html beside it; the portal will draw the graph from the JSON')
}

// A graph's id is its slug, so a second upload for the same label replaces it.
const at = db.collection('graphs').doc(slug)
const existing = await at.get()
await at.set({
  slug,
  title: label,
  summary: analysis?.questions?.[0] ?? null,
  source: sourceArg ?? label,
  node_count: nodes.length,
  edge_count: links.length,
  community_count: communities.size,
  god_nodes: gods,
  generated_at: Timestamp.now(),
  file,
  html_file: htmlFile ?? (existing.exists ? (existing.data().html_file ?? null) : null),
  created_by: existing.exists ? (existing.data().created_by ?? null) : null,
  created_at: existing.exists ? existing.data().created_at : FieldValue.serverTimestamp(),
  updated_at: FieldValue.serverTimestamp(),
})
console.log(`  graph "${slug}" recorded`)
