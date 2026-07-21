import { supabase, isConfigured } from './supabase'

// -----------------------------------------------------------------------------
// Portal data access.
//
// Every function here returns { data, error } with `error` already reduced to a
// string a student can read. None of them enforce permissions — RLS does that,
// in the database. A caller getting an empty list because policy denied them is
// indistinguishable from an empty list, and that is correct: the UI should not
// be able to tell the difference, because it is not the thing making the
// decision.
// -----------------------------------------------------------------------------

const NOT_CONFIGURED = 'The portal is not connected to a backend yet.'

function wrap(error) {
  if (!error) return null
  if (/JWT|not authenticated/i.test(error.message)) return 'Your session expired. Sign in again.'
  if (/permission denied|violates row-level security/i.test(error.message))
    return 'You do not have access to that.'
  return error.message
}

// ---------- files ----------

export async function listFiles({ kind, season, search, limit = 60 } = {}) {
  if (!isConfigured) return { data: [], error: NOT_CONFIGURED }
  let q = supabase
    .from('files')
    .select('id, bucket, path, title, description, kind, season, tags, byte_size, sha256, created_at')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (kind) q = q.eq('kind', kind)
  if (season) q = q.eq('season', season)
  // Escape the PostgREST `or` metacharacters. An unescaped comma or paren in a
  // search box would otherwise be parsed as filter syntax rather than as text.
  if (search) {
    const safe = search.replace(/[,()\\]/g, ' ').trim()
    if (safe) q = q.or(`title.ilike.%${safe}%,description.ilike.%${safe}%`)
  }

  const { data, error } = await q
  return { data: data ?? [], error: wrap(error) }
}

// Buckets are private, so there is no durable public URL to link to. A signed
// URL is minted per request and expires; that is the point. Default is short —
// long-lived signed URLs get pasted into group chats and outlive their welcome.
export async function signedUrl(bucket, path, expiresIn = 300) {
  if (!isConfigured) return { data: null, error: NOT_CONFIGURED }
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, expiresIn)
  return { data: data?.signedUrl ?? null, error: wrap(error) }
}

export async function uploadFile({ bucket, path, file, metadata }) {
  if (!isConfigured) return { data: null, error: NOT_CONFIGURED }

  const { error: upErr } = await supabase.storage.from(bucket).upload(path, file, {
    cacheControl: '3600',
    upsert: false,
  })
  if (upErr) return { data: null, error: wrap(upErr) }

  const { data: userRes } = await supabase.auth.getUser()
  const { data, error } = await supabase
    .from('files')
    .insert({
      bucket,
      path,
      title: metadata?.title ?? file.name,
      description: metadata?.description ?? null,
      kind: metadata?.kind ?? null,
      season: metadata?.season ?? null,
      tags: metadata?.tags ?? [],
      byte_size: file.size,
      sha256: metadata?.sha256 ?? null,
      uploaded_by: userRes?.user?.id ?? null,
    })
    .select()
    .single()

  // The object landed but its index row did not. Leaving the orphan would make
  // the file invisible to the portal *and* invisible to the nightly manifest,
  // so it is removed rather than left as a silent inconsistency.
  if (error) {
    await supabase.storage.from(bucket).remove([path])
    return { data: null, error: wrap(error) }
  }
  return { data, error: null }
}

// Computed in the browser so the checksum describes what the user actually
// selected, before it crosses the network. The nightly mirror re-derives it on
// the pulled copy; a mismatch then means corruption in transit or at rest.
export async function sha256Hex(file) {
  const buf = await file.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// ---------- graphs ----------

export async function listGraphs() {
  if (!isConfigured) return { data: [], error: NOT_CONFIGURED }
  const { data, error } = await supabase
    .from('graphs')
    .select(
      'id, slug, title, summary, source, node_count, edge_count, community_count, god_nodes, generated_at, file_id, files(bucket, path)'
    )
    .order('generated_at', { ascending: false, nullsFirst: false })
  return { data: data ?? [], error: wrap(error) }
}

// ---------- code archives ----------

export async function listCodeArchives() {
  if (!isConfigured) return { data: [], error: NOT_CONFIGURED }
  const { data, error } = await supabase
    .from('code_archives')
    .select('id, repo, ref, commit_sha, season, notes, file_id, created_at, files(bucket, path, byte_size)')
    .order('season', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
  return { data: data ?? [], error: wrap(error) }
}

// ---------- knowledge base ----------

export async function listDocs({ search } = {}) {
  if (!isConfigured) return { data: [], error: NOT_CONFIGURED }
  let q = supabase
    .from('knowledge_docs')
    .select('id, slug, title, category, is_pinned, updated_at')
    .order('is_pinned', { ascending: false })
    .order('updated_at', { ascending: false })

  // Uses the generated tsvector + GIN index from migration 0003 rather than a
  // LIKE scan, so this stays fast as the knowledge base grows.
  if (search?.trim()) q = q.textSearch('search', search.trim(), { type: 'websearch' })

  const { data, error } = await q
  return { data: data ?? [], error: wrap(error) }
}

export async function getDoc(slug) {
  if (!isConfigured) return { data: null, error: NOT_CONFIGURED }
  const { data, error } = await supabase
    .from('knowledge_docs')
    .select('id, slug, title, body_md, category, is_pinned, updated_at')
    .eq('slug', slug)
    .maybeSingle()
  return { data, error: wrap(error) }
}

export async function saveDoc({ id, slug, title, body_md, category }) {
  if (!isConfigured) return { data: null, error: NOT_CONFIGURED }
  const row = { slug, title, body_md, category: category || null }
  const q = id
    ? supabase.from('knowledge_docs').update(row).eq('id', id)
    : supabase.from('knowledge_docs').insert(row)
  const { data, error } = await q.select().single()

  // The database-side secret guard (migration 0003) raises on write. Surface it
  // verbatim — it names what it matched, which is the actionable part.
  if (error && /refusing to store this document/i.test(error.message)) {
    return { data: null, error: error.message }
  }
  return { data, error: wrap(error) }
}

// ---------- backup health ----------

export async function backupHealth() {
  if (!isConfigured) return { data: [], error: NOT_CONFIGURED }
  const { data, error } = await supabase.from('backup_health').select('*')
  return { data: data ?? [], error: wrap(error) }
}

// ---------- roster ----------

export async function listMembers() {
  if (!isConfigured) return { data: [], error: NOT_CONFIGURED }
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, grad_year, subteam, role')
    .order('role', { ascending: false })
    .order('full_name')
  return { data: data ?? [], error: wrap(error) }
}

export function formatBytes(n) {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}
