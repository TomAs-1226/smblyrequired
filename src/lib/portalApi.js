import {
  collection, doc, query, where, orderBy, limit as limitTo, getDoc as fsGetDoc, getDocs, setDoc, updateDoc,
  deleteDoc, writeBatch, getAggregateFromServer, count, sum,
} from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL, getBlob, deleteObject } from 'firebase/storage'
import { db, storage } from './firebase'
import { isConfigured, notConnected, wrap, row, rows, now, ts, call, currentUid, memberNames } from './db'
import { fileId } from './ids'
import { ROLES } from './auth'
import { findSecret, secretRefusal } from './secretPatterns'
import { uploadType, describeAllowed } from './uploadTypes'

// -----------------------------------------------------------------------------
// Portal data access: files, graphs, code archives, the knowledge base, the
// roster, the audit log and backup health.
//
// Every function here returns { data, error } with `error` already reduced to a
// sentence a student can read. None of them enforce permissions — the Firestore
// and Storage rules do that, on the server. The UI is not the thing making the
// decision; it only has to report the answer.
// -----------------------------------------------------------------------------

const objectRef = (bucket, path) => ref(storage, `${bucket}/${path}`)

// ---------- files ----------

const FILE_FIELDS = (f) => ({
  id: f.id, bucket: f.bucket, path: f.path, title: f.title, description: f.description ?? null,
  kind: f.kind ?? null, season: f.season ?? null, tags: f.tags ?? [], byte_size: f.byte_size ?? null,
  sha256: f.sha256 ?? null, created_at: f.created_at, uploaded_by: f.uploaded_by ?? null,
})

export async function listFiles({ kind, season, search, limit = 60 } = {}) {
  if (!isConfigured) return notConnected([])
  const term = search?.trim().toLowerCase()
  // Firestore has no substring search, so a search pulls a wider page and
  // filters it here. The index is one small document per stored object.
  const build = (mediaOnly) => {
    const parts = []
    if (mediaOnly) parts.push(where('bucket', 'in', ['media', 'public-media']))
    if (kind) parts.push(where('kind', '==', kind))
    if (season) parts.push(where('season', '==', season))
    return query(collection(db, 'files'), ...parts, orderBy('created_at', 'desc'), limitTo(term ? 500 : limit))
  }
  try {
    let snap
    try {
      snap = await getDocs(build(false))
    } catch (e) {
      // A viewer may read media rows only, and the rules need the query to say
      // so. Anyone refused the full list is given the media list instead.
      if (!String(e.code).includes('permission-denied')) throw e
      snap = await getDocs(build(true))
    }
    let data = rows(snap).map(FILE_FIELDS)
    if (term) {
      data = data
        .filter((f) => `${f.title ?? ''} ${f.description ?? ''}`.toLowerCase().includes(term))
        .slice(0, limit)
    }
    return { data, error: null }
  } catch (e) {
    return { data: [], error: wrap(e) }
  }
}

// A URL for a stored file. The Storage rules decide who may ask for one; the
// link it returns carries its own access token, so treat it like the file
// itself — do not paste it where the file should not go. For pictures of
// people, prefer `blobUrl`, which never creates a link at all.
// (`expiresIn` is accepted for the callers that pass it; Firebase links do not
// expire, they are revoked per file.)
export async function signedUrl(bucket, path, expiresIn = 300) { // eslint-disable-line no-unused-vars
  if (!isConfigured) return notConnected()
  try {
    return { data: await getDownloadURL(objectRef(bucket, path)), error: null }
  } catch (e) {
    return { data: null, error: wrap(e) }
  }
}

// The file's bytes fetched with the signed-in user's own credentials and handed
// to the page as an object URL: nothing shareable is created. Used for team
// photos. The caller revokes it (URL.revokeObjectURL) when done.
export async function blobUrl(bucket, path) {
  if (!isConfigured) return notConnected()
  try {
    return { data: URL.createObjectURL(await getBlob(objectRef(bucket, path))), error: null }
  } catch (e) {
    return { data: null, error: wrap(e) }
  }
}

export async function uploadFile({ bucket, path, file, metadata }) {
  if (!isConfigured) return notConnected()

  // The storage rules check the content type the browser reports, and browsers
  // report what the OS says — see uploadTypes.js for why that refused ordinary
  // uploads. The type is normalised here and sent explicitly.
  const { type, ok } = uploadType(bucket, file.name, file.type)
  if (!ok) {
    return { data: null, error: `${file.name} cannot go in ${bucket}. It takes ${describeAllowed(bucket)}.` }
  }
  const uid = currentUid()
  if (!uid) return { data: null, error: 'Your session expired. Sign in again.' }
  const id = fileId(bucket, path)

  try {
    // Nothing is overwritten by an upload: a path that is taken is refused, and
    // the caller picks another (CodeViewer bumps the version number).
    if ((await fsGetDoc(doc(db, 'files', id))).exists()) {
      return { data: null, error: `A file already exists at ${path}.` }
    }
    await uploadBytes(objectRef(bucket, path), file, {
      contentType: type,
      cacheControl: 'private, max-age=3600',
      customMetadata: { owner: uid },
    })
  } catch (e) {
    return { data: null, error: wrap(e) }
  }

  const fields = {
    bucket,
    path,
    title: metadata?.title ?? file.name,
    description: metadata?.description ?? null,
    kind: metadata?.kind ?? null,
    season: metadata?.season ?? null,
    tags: metadata?.tags ?? [],
    byte_size: file.size,
    sha256: metadata?.sha256 ?? null,
    uploaded_by: uid,
  }
  try {
    await setDoc(doc(db, 'files', id), { ...fields, created_at: now(), updated_at: now() })
  } catch (e) {
    // The object landed but its index document did not. Leaving the orphan would
    // make the file invisible to the portal *and* to the nightly manifest, so it
    // is removed rather than left as a silent inconsistency.
    await deleteObject(objectRef(bucket, path)).catch(() => {})
    return { data: null, error: wrap(e) }
  }
  return { data: { id, ...fields, created_at: new Date().toISOString() }, error: null }
}

// Remove a file: its index document and its stored object. (The onFileDeleted
// function also removes the object and anything that pointed at the file; the
// object is deleted here too so cleanup does not depend on it.)
export async function removeFile(fileRow) {
  if (!isConfigured) return notConnected()
  try {
    await deleteObject(objectRef(fileRow.bucket, fileRow.path)).catch(() => {})
    await deleteDoc(doc(db, 'files', fileRow.id ?? fileId(fileRow.bucket, fileRow.path)))
    return { data: true, error: null }
  } catch (e) {
    return { data: null, error: wrap(e) }
  }
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

const byTimeDesc = (key) => (a, b) => String(b[key] ?? '').localeCompare(String(a[key] ?? ''))

export async function listGraphs() {
  if (!isConfigured) return notConnected([])
  try {
    const data = rows(await getDocs(collection(db, 'graphs')))
      // Newest first; a graph with no date sorts last.
      .sort(byTimeDesc('generated_at'))
      // The panels read the payload as `files` and the rendered page as
      // `html_file`, the shapes the old joins produced.
      .map((g) => ({ ...g, file_id: g.file?.id ?? null, html_file_id: g.html_file?.id ?? null, files: g.file ?? null }))
    return { data, error: null }
  } catch (e) {
    return { data: [], error: wrap(e) }
  }
}

// A graph's id is its slug, so a slug in use is refused by the rules; the check
// here is what turns that into a sentence.
export async function createGraph(graph) {
  if (!isConfigured) return notConnected()
  const uid = currentUid()
  try {
    const at = doc(db, 'graphs', graph.slug)
    if ((await fsGetDoc(at)).exists()) {
      return { data: null, error: `A graph with the slug "${graph.slug}" already exists.` }
    }
    await setDoc(at, {
      slug: graph.slug,
      title: graph.title,
      summary: graph.summary ?? null,
      source: graph.source ?? null,
      node_count: graph.node_count ?? null,
      edge_count: graph.edge_count ?? null,
      community_count: graph.community_count ?? null,
      god_nodes: graph.god_nodes ?? [],
      generated_at: ts(graph.generated_at ?? new Date()),
      file: graph.file ?? null,
      html_file: graph.html_file ?? null,
      created_by: uid,
      created_at: now(),
      updated_at: now(),
    })
    return { data: { id: graph.slug }, error: null }
  } catch (e) {
    return { data: null, error: wrap(e) }
  }
}

// ---------- code archives ----------

export async function listCodeArchives() {
  if (!isConfigured) return notConnected([])
  try {
    const data = rows(await getDocs(collection(db, 'code_archives')))
      .sort((a, b) => (b.season ?? -1) - (a.season ?? -1) || byTimeDesc('created_at')(a, b))
      .map((a) => ({ ...a, file_id: a.file?.id ?? null, files: a.file ?? null }))
    return { data, error: null }
  } catch (e) {
    return { data: [], error: wrap(e) }
  }
}

export async function createCodeArchive(archive) {
  if (!isConfigured) return notConnected()
  try {
    const at = doc(collection(db, 'code_archives'))
    await setDoc(at, {
      repo: archive.repo,
      ref: archive.ref ?? null,
      commit_sha: archive.commit_sha ?? null,
      season: archive.season ?? null,
      notes: archive.notes ?? null,
      file: archive.file ?? null,
      created_by: currentUid(),
      created_at: now(),
      updated_at: now(),
    })
    return { data: { id: at.id }, error: null }
  } catch (e) {
    return { data: null, error: wrap(e) }
  }
}

// ---------- knowledge base ----------

const DOC_HEAD = (d) => ({
  id: d.id, slug: d.slug, title: d.title, category: d.category ?? null, is_pinned: Boolean(d.is_pinned), updated_at: d.updated_at,
})

export async function listDocs({ search } = {}) {
  if (!isConfigured) return notConnected([])
  try {
    const snap = await getDocs(
      query(collection(db, 'knowledge_docs'), orderBy('is_pinned', 'desc'), orderBy('updated_at', 'desc'))
    )
    let docs = rows(snap)
    // Search runs here, over what the reader may see: a doc matches when every
    // word asked for appears in its title, category or body.
    const terms = (search ?? '').toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length) {
      docs = docs.filter((d) => {
        const hay = `${d.title ?? ''} ${d.category ?? ''} ${d.body_md ?? ''}`.toLowerCase()
        return terms.every((t) => hay.includes(t))
      })
    }
    return { data: docs.map(DOC_HEAD), error: null }
  } catch (e) {
    return { data: [], error: wrap(e) }
  }
}

export async function getDoc(slug) {
  if (!isConfigured) return notConnected()
  try {
    const index = await fsGetDoc(doc(db, 'kb_slugs', slug))
    if (!index.exists()) return { data: null, error: null }
    const d = row(await fsGetDoc(doc(db, 'knowledge_docs', index.data().doc_id)))
    return { data: d && { ...DOC_HEAD(d), body_md: d.body_md }, error: null }
  } catch (e) {
    return { data: null, error: wrap(e) }
  }
}

export async function saveDoc({ id, slug, title, body_md, category }) {
  if (!isConfigured) return notConnected()
  // The rules refuse a body that looks like it holds a secret, but can only say
  // "denied". The same patterns are checked here first, to name what matched —
  // which is the actionable part.
  const secret = findSecret(body_md)
  if (secret) return { data: null, error: secretRefusal(secret) }

  const uid = currentUid()
  try {
    // A slug belongs to one doc. Claiming one in use is refused by the rules; the
    // read is what lets the answer be a sentence.
    const index = await fsGetDoc(doc(db, 'kb_slugs', slug))
    if (index.exists() && index.data().doc_id !== id) {
      return { data: null, error: `Another doc already uses the slug "${slug}". Pick a different one.` }
    }

    const batch = writeBatch(db)
    const at = id ? doc(db, 'knowledge_docs', id) : doc(collection(db, 'knowledge_docs'))
    const fields = { slug, title, body_md, category: category || null, updated_by: uid, updated_at: now() }
    if (id) {
      const before = await fsGetDoc(at)
      if (!before.exists()) return { data: null, error: 'That doc no longer exists.' }
      batch.update(at, fields)
      // A rename moves the slug: the new index in, the old one out, in one write.
      if (before.data().slug !== slug) {
        batch.set(doc(db, 'kb_slugs', slug), { doc_id: at.id })
        batch.delete(doc(db, 'kb_slugs', before.data().slug))
      }
    } else {
      batch.set(at, { ...fields, is_pinned: false, created_by: uid, created_at: now() })
      batch.set(doc(db, 'kb_slugs', slug), { doc_id: at.id })
    }
    await batch.commit()
    return {
      data: { id: at.id, slug, title, body_md, category: category || null, updated_at: new Date().toISOString() },
      error: null,
    }
  } catch (e) {
    return { data: null, error: wrap(e) }
  }
}

// ---------- backup health ----------

// The latest run of each leg of the nightly backup, with whether it is healthy:
// it finished ok and started within the last 36 hours. Whether it has been
// restore-tested is a separate claim, reported separately (BackupLeg.jsx).
export async function backupHealth() {
  if (!isConfigured) return notConnected([])
  try {
    const snap = await getDocs(query(collection(db, 'backup_runs'), orderBy('started_at', 'desc'), limitTo(60)))
    const latest = new Map()
    for (const r of rows(snap)) if (!latest.has(r.leg)) latest.set(r.leg, r)
    const data = [...latest.values()].map((r) => {
      const ageMs = Date.now() - new Date(r.started_at).getTime()
      return { ...r, age_ms: ageMs, healthy: r.status === 'ok' && ageMs < 36 * 3600_000 }
    })
    return { data, error: null }
  } catch (e) {
    return { data: [], error: wrap(e) }
  }
}

// ---------- roster ----------

export async function listMembers() {
  if (!isConfigured) return notConnected([])
  try {
    const data = rows(await getDocs(collection(db, 'profiles')))
      .map((m) => ({ id: m.id, full_name: m.full_name ?? null, grad_year: m.grad_year ?? null, subteam: m.subteam ?? null, role: m.role }))
      // Admins first, then down the role order; by name within a role.
      .sort((a, b) => ROLES.indexOf(b.role) - ROLES.indexOf(a.role) || String(a.full_name ?? '').localeCompare(String(b.full_name ?? '')))
    return { data, error: null }
  } catch (e) {
    return { data: [], error: wrap(e) }
  }
}

// The only way a role changes. The function checks the caller is an admin, that
// it is not their own role, and that the last admin is not being removed; its
// refusals are sentences and are shown as they are.
export async function setMemberRole(targetId, role) {
  const res = await call('setMemberRole', { targetId, role })
  if (!res.error) await memberNames({ fresh: true })
  return res
}

// A member's name, year or subteam (their own, or anyone's for an admin).
export async function updateMember(id, patch) {
  if (!isConfigured) return notConnected()
  try {
    await updateDoc(doc(db, 'profiles', id), { ...patch, updated_at: now() })
    return { data: true, error: null }
  } catch (e) {
    return { data: null, error: wrap(e) }
  }
}

// ---------- audit log ----------

// Leads read the audit trail. Each entry's `detail` is a map — for a role change
// it is { from, to }. The actor's name comes from the roster, so the log can say
// who acted; `entity_id` is the target's id, resolved the same way by the caller.
export async function listAuditLog({ limit = 50 } = {}) {
  if (!isConfigured) return notConnected([])
  try {
    const [snap, names] = await Promise.all([
      getDocs(query(collection(db, 'audit_log'), orderBy('created_at', 'desc'), limitTo(limit))),
      memberNames(),
    ])
    const data = rows(snap).map((e) => {
      const who = e.actor ? names.get(e.actor) : null
      return { ...e, actor: who ? { full_name: who.full_name ?? null, role: who.role } : null }
    })
    return { data, error: null }
  } catch (e) {
    return { data: [], error: wrap(e) }
  }
}

// ---------- storage summary ----------

// The five folders of the bucket. Listed here so the admin storage view can
// render an untouched one as 0 objects / 0 bytes rather than omitting it —
// "nothing has been uploaded to media yet" is information, and a missing row
// hides it.
export const BUCKETS = ['graphs', 'code', 'knowledge', 'media', 'public-media']

// Per-folder object counts and byte totals, computed by Firestore from the
// `files` index (an aggregate query costs one read per thousand documents, and
// never undercounts).
export async function storageSummary() {
  if (!isConfigured) return notConnected([])
  try {
    const data = await Promise.all(
      BUCKETS.map(async (bucket) => {
        const agg = await getAggregateFromServer(query(collection(db, 'files'), where('bucket', '==', bucket)), {
          objects: count(),
          bytes: sum('byte_size'),
        })
        return { bucket, objects: agg.data().objects, bytes: agg.data().bytes ?? 0 }
      })
    )
    return { data, error: null }
  } catch (e) {
    return { data: [], error: wrap(e) }
  }
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
