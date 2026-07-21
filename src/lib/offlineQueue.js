// =============================================================================
// Offline-first write queue.
//
// A scout stands in an arena with four thousand people and no usable wifi and
// records sixty matches. None of that may be lost, and none of it may be
// duplicated. Those two requirements pull in opposite directions, and almost
// every rule in this file exists to satisfy both at once.
//
// The shape:
//   enqueue()  writes to IndexedDB FIRST and returns. It never waits on the
//              network, so saving a match is instant and cannot fail.
//   drain()    pushes pending rows to Supabase when there is real connectivity,
//              and only removes a row once the server has confirmed it.
//
// The contract that makes retries safe is `client_uuid`: generated here, on the
// device, before the row exists anywhere else, and UNIQUE in the database
// (migration 0005). If a row was accepted but the response was lost, the retry
// collides — and a collision is SUCCESS, not an error. Getting that backwards
// is what turns "sync failed, tap retry" into a silently doubled dataset.
// =============================================================================

import { supabase, isConfigured } from './supabase'

const DB_NAME = 'frc5805-offline'
const DB_VERSION = 1
const STORE = 'pending'

// What the queue knows how to push.
//
// Two shapes, because two things genuinely differ:
//
//   table   — one insert. A scouting entry is a row and nothing else.
//   storage — bytes THEN rows. A pit photo is a file in a bucket, a `files`
//             index row, and a domain row, in that order, and a phone in a pit
//             with no signal has to be able to bank all three.
//
// The storage shape exists because the original single-insert design could not
// express it: handing this queue a {bucket, path, file} envelope would have
// inserted that envelope straight into a table, Postgres would have rejected it
// as a column error, and the queue classifies column errors as terminal — so
// the photo would have been silently discarded rather than retried. Worth
// spelling out, because that failure looks like nothing at all until someone
// goes looking for a photo that was never there.
const HANDLERS = {
  scout_entry: { kind: 'table', table: 'scout_entries' },
  robot_photo: { kind: 'storage', table: 'robot_photos' },
}

let dbPromise = null

function openDb() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'client_uuid' })
        store.createIndex('by_created', 'created_at')
        store.createIndex('by_kind', 'kind')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx(mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode)
        const store = t.objectStore(STORE)
        let result
        try {
          result = fn(store)
        } catch (err) {
          reject(err)
          return
        }
        t.oncomplete = () => resolve(result)
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error)
      })
  )
}

const req2promise = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })

// --- listeners ---------------------------------------------------------------

const listeners = new Set()
export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
async function notify() {
  const state = await getState()
  for (const fn of listeners) fn(state)
}

// --- public API ---------------------------------------------------------------

/**
 * Persist a write locally and attempt to sync it.
 *
 * Resolves as soon as the row is durably in IndexedDB — deliberately NOT when
 * the server has it. The scout's next tap must never wait on a radio.
 */
export async function enqueue(kind, payload) {
  if (!HANDLERS[kind]) throw new Error(`unknown queue kind: ${kind}`)

  const row = {
    client_uuid: payload.client_uuid ?? crypto.randomUUID(),
    kind,
    payload: { ...payload },
    created_at: new Date().toISOString(),
    attempts: 0,
    last_error: null,
  }
  row.payload.client_uuid = row.client_uuid

  await tx('readwrite', (s) => s.put(row))
  notify()

  // Fire and forget. A failure here is not a failure of enqueue — the row is
  // already safe on disk and will go out on the next drain.
  drain().catch(() => {})
  return row.client_uuid
}

export async function pending() {
  return tx('readonly', (s) => req2promise(s.getAll())).then((rows) =>
    rows.sort((a, b) => a.created_at.localeCompare(b.created_at))
  )
}

export async function pendingCount() {
  return tx('readonly', (s) => req2promise(s.count()))
}

export async function getState() {
  const rows = await pending()
  return {
    online: isOnline(),
    syncing,
    pending: rows.length,
    failing: rows.filter((r) => r.attempts >= 3).length,
    oldest: rows[0]?.created_at ?? null,
  }
}

/** Discard a row that will never succeed. Requires an explicit user decision. */
export async function discard(clientUuid) {
  await tx('readwrite', (s) => s.delete(clientUuid))
  notify()
}

// --- connectivity -------------------------------------------------------------

// navigator.onLine only reports whether a network interface exists. At a venue
// it is frequently `true` while attached to a captive portal that answers every
// request with a login page — so it is used as a fast negative signal only.
// A `true` here means "worth attempting", never "the server is reachable".
export function isOnline() {
  return typeof navigator === 'undefined' ? true : navigator.onLine !== false
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    notify()
    drain().catch(() => {})
  })
  window.addEventListener('offline', notify)
}

// --- sync ---------------------------------------------------------------------

let syncing = false
let drainAgain = false

/**
 * Push everything pending. Safe to call concurrently — overlapping calls
 * collapse into one pass plus at most one follow-up, so a burst of saves does
 * not start a burst of competing drains against the same rows.
 */
export async function drain() {
  if (!isConfigured || !isOnline()) return { pushed: 0, failed: 0, skipped: true }
  if (syncing) {
    drainAgain = true
    return { pushed: 0, failed: 0, busy: true }
  }

  syncing = true
  notify()
  let pushed = 0
  let failed = 0

  try {
    const rows = await pending()
    for (const row of rows) {
      // Backoff is checked per row so one permanently-broken entry cannot block
      // the sixty good ones queued behind it.
      if (row.attempts > 0 && !backoffElapsed(row)) continue

      const result = await push(row)
      if (result.ok) {
        await tx('readwrite', (s) => s.delete(row.client_uuid))
        pushed += 1
      } else {
        failed += 1
        await tx('readwrite', (s) =>
          s.put({
            ...row,
            attempts: row.attempts + 1,
            last_error: result.error,
            last_attempt: new Date().toISOString(),
          })
        )
      }
      notify()
    }
  } finally {
    syncing = false
    notify()
  }

  if (drainAgain) {
    drainAgain = false
    return drain()
  }
  return { pushed, failed }
}

// Exponential, capped. Retrying a dead network every 200ms drains a phone
// battery that has to last a full competition day.
const BACKOFF_MS = [0, 2_000, 10_000, 60_000, 300_000]
function backoffElapsed(row) {
  const wait = BACKOFF_MS[Math.min(row.attempts, BACKOFF_MS.length - 1)]
  if (!row.last_attempt) return true
  return Date.now() - new Date(row.last_attempt).getTime() >= wait
}

async function push(row) {
  const handler = HANDLERS[row.kind]
  if (!handler) return { ok: false, error: `unknown kind ${row.kind}` }

  if (handler.kind === 'storage') return pushStorage(row, handler)

  const { error } = await supabase.from(handler.table).insert(row.payload)

  if (!error) return { ok: true }

  // 23505 = unique_violation on client_uuid. The row is already on the server;
  // this is a duplicate delivery of a message that succeeded, which is exactly
  // what the client_uuid column exists to make detectable. Treating it as an
  // error here would strand the row in the queue forever and show the scout a
  // permanent failure for data that is safely stored.
  if (error.code === '23505') return { ok: true, deduped: true }

  // 42501 / RLS denial and 22P02 / malformed input will never succeed on retry.
  // Surface them as terminal so the UI can offer to discard rather than
  // pretending a hundred more attempts might help.
  if (error.code === '42501' || error.code === '22P02' || error.code === '23514') {
    return { ok: false, error: `${error.code}: ${error.message}`, terminal: true }
  }

  return { ok: false, error: error.message }
}

/**
 * Three-step push: bytes → files row → domain row.
 *
 * Every step has to be independently re-runnable, because the queue can be
 * interrupted between any two of them — the phone goes back in a pocket, the
 * signal drops, the tab is closed. So each step treats "it is already there" as
 * success rather than as a conflict:
 *
 *   storage   upsert:true, so a half-finished upload simply completes
 *   files     unique(bucket,path) — on collision, read back the existing id
 *   domain    unique(client_uuid) — on collision, the row already landed
 *
 * The order matters and is not negotiable: the domain row references the files
 * row, which references bytes that must already exist. Reversed, a crash leaves
 * a row pointing at a file nobody uploaded, which reads as data loss to anyone
 * looking at it later.
 */
async function pushStorage(row, handler) {
  const { _upload, ...record } = row.payload
  if (!_upload?.file) return { ok: false, error: 'queued photo has no file attached', terminal: true }

  const { bucket, path, title, kind, season, sha256 } = _upload

  // 1. bytes
  const { error: upErr } = await supabase.storage
    .from(bucket)
    .upload(path, _upload.file, { cacheControl: '3600', upsert: true })
  if (upErr && !/exists/i.test(upErr.message ?? '')) {
    return { ok: false, error: `upload: ${upErr.message}` }
  }

  // 2. index row
  let fileId = record.file_id
  if (!fileId) {
    const { data: userRes } = await supabase.auth.getUser()
    const { data: fileRow, error: fErr } = await supabase
      .from('files')
      .insert({
        bucket,
        path,
        title: title ?? path.split('/').pop(),
        kind: kind ?? 'photo',
        season: season ?? null,
        byte_size: _upload.file.size ?? null,
        sha256: sha256 ?? null,
        uploaded_by: userRes?.user?.id ?? null,
      })
      .select('id')
      .single()

    if (fErr) {
      if (fErr.code === '23505') {
        // A previous attempt got this far. Recover the id rather than failing —
        // the unique constraint is doing exactly what it exists to do.
        const { data: existing } = await supabase
          .from('files')
          .select('id')
          .eq('bucket', bucket)
          .eq('path', path)
          .maybeSingle()
        if (!existing) return { ok: false, error: 'files row conflicted but could not be read back' }
        fileId = existing.id
      } else {
        return { ok: false, error: `files: ${fErr.message}` }
      }
    } else {
      fileId = fileRow.id
    }
  }

  // 3. domain row
  const { error: dErr } = await supabase.from(handler.table).insert({ ...record, file_id: fileId })
  if (!dErr) return { ok: true }
  if (dErr.code === '23505') return { ok: true, deduped: true }
  if (dErr.code === '42501' || dErr.code === '22P02' || dErr.code === '23514') {
    return { ok: false, error: `${dErr.code}: ${dErr.message}`, terminal: true }
  }
  return { ok: false, error: dErr.message }
}

// Periodic retry while the app is open. Cheap when the queue is empty (a single
// IndexedDB count), and it is what recovers a scout who wandered back into
// signal without touching the screen.
if (typeof window !== 'undefined') {
  setInterval(() => {
    if (isOnline()) drain().catch(() => {})
  }, 30_000)

  // A last attempt as the tab goes away. Not guaranteed to complete, which is
  // precisely why the durable store is written first and this is only a bonus.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') drain().catch(() => {})
  })
}
