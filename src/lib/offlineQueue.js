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
// collides — and a collision on client_uuid is SUCCESS, not an error. Getting
// that backwards is what turns "sync failed, tap retry" into a silently doubled
// dataset. A collision on any OTHER unique constraint is not proof of delivery;
// queuePush.js tells them apart, and owns every other server answer too.
// =============================================================================

import { supabase, isConfigured } from './supabase'
import { pushRow } from './queuePush'

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
  const stuck = rows.filter(isStuck)
  return {
    online: isOnline(),
    syncing,
    pending: rows.length,
    failing: stuck.length,
    oldest: rows[0]?.created_at ?? null,
    // What is stuck and why, without the payload (a photo row carries its bytes).
    // A count alone told a scout something was wrong and nothing about what, so
    // an entry refused for being outside the scouting window just sat there.
    problems: stuck.map(describe),
  }
}

// Stuck = the server has said no in a way a retry will not change, or it has
// failed often enough that the scout should be told rather than reassured.
function isStuck(row) {
  return row.terminal === true || row.attempts >= 3
}

function describe(row) {
  const p = row.payload ?? {}
  return {
    client_uuid: row.client_uuid,
    kind: row.kind,
    entryKind: p.kind ?? null,
    team: p.team_number ?? null,
    match: p.match_number ?? null,
    recordedAt: p.recorded_at ?? row.created_at,
    attempts: row.attempts,
    terminal: row.terminal === true,
    error: row.last_error,
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
 *
 * `force` is for a person tapping "sync now": it ignores the backoff and retries
 * terminal rows too. A tap is a decision to try again — the scout may have just
 * been told by a lead that the window is reopened — and silently skipping the
 * rows they are looking at would read as the button being broken.
 */
export async function drain({ force = false } = {}) {
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
      // the sixty good ones queued behind it. Terminal rows wait for a person.
      if (!force && row.terminal) continue
      if (!force && row.attempts > 0 && !backoffElapsed(row)) continue

      let result
      try {
        result = await pushRow(supabase, row, HANDLERS[row.kind])
      } catch (err) {
        // A thrown fetch (DNS, captive portal, aborted request) is a transport
        // failure, never a verdict on the data — always retryable.
        result = { ok: false, error: String(err?.message ?? err) }
      }
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
            terminal: result.terminal === true,
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
