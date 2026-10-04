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
//   drain()    pushes pending rows to Firestore when there is real connectivity,
//              and only removes a row once the server has confirmed it.
//
// The contract that makes retries safe is `client_uuid`: generated here, on the
// device, before the row exists anywhere else, and carried on the document the
// server keeps. If a write was accepted but the answer was lost, the retry finds
// a document holding its own client_uuid — and that is SUCCESS, not an error.
// Getting that backwards is what turns "sync failed, tap retry" into a silently
// doubled dataset. A document holding somebody ELSE's client_uuid is not proof of
// delivery; queuePush.js tells them apart, and owns every other answer too.
//
// Firestore's own offline persistence is deliberately not what carries this. It
// would hold a write and replay it later, but a replayed write that the security
// rules refuse is dropped without anyone being told, and "your entry was outside
// the scouting window" is exactly what a scout has to be told.
// =============================================================================

import {
  doc,
  getDocFromServer,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore'
import { ref as storageRef, uploadBytesResumable } from 'firebase/storage'
import { db, storage } from './firebase'
import { isConfigured, currentUid, row as asRow } from './db'
import { pushRow } from './queuePush'

const DB_NAME = 'frc5805-offline'
const DB_VERSION = 1
const STORE = 'pending'

// What the queue knows how to push.
//
// Two shapes, because two things genuinely differ:
//
//   entry — one document. A scouting entry is a document and nothing else.
//   photo — bytes THEN documents. A pit photo is an object in Storage, a `files`
//           index document, and a `robot_photos` document, in that order, and a
//           phone in a pit with no signal has to be able to bank all three.
//
// The photo shape exists because the original single-write design could not
// express it: handing this queue a {bucket, path, file} envelope would have
// written that envelope straight into a collection, the server would have
// refused it as malformed, and the queue classifies that as terminal — so the
// photo would have been silently discarded rather than retried. Worth spelling
// out, because that failure looks like nothing at all until someone goes looking
// for a photo that was never there.
const HANDLERS = {
  scout_entry: { kind: 'entry' },
  robot_photo: { kind: 'photo' },
}

// How long one photo upload may take before it is abandoned until the next drain.
// The Storage SDK keeps retrying a dead connection for ten minutes on its own,
// which would hold every entry queued behind the photo for that long.
const UPLOAD_TIMEOUT_MS = 90_000

// The part of Firestore and Storage a push needs (see queuePush.js). Reads ask
// the server and never the SDK's cache: a decision to drop a row from the phone
// has to rest on what the server holds now.
//
// Every write is a transaction, including the single-document `create`. A plain
// setDoc with no connection does not fail: the SDK holds it in memory and its
// promise stays pending until the network returns, which would leave the drain
// stuck on one row with everything else queued behind it. A transaction is sent
// now or fails now, and this queue — not the SDK's — is the one that retries.
const store = {
  uid: currentUid,
  serverTime: serverTimestamp,
  get: async (collection, id) => asRow(await getDocFromServer(doc(db, collection, id))),
  create: (collection, id, data) =>
    runTransaction(db, async (t) => {
      t.set(doc(db, collection, id), data)
    }),
  transaction: (fn) =>
    runTransaction(db, (t) =>
      fn({
        get: async (collection, id) => asRow(await t.get(doc(db, collection, id))),
        create: (collection, id, data) => t.set(doc(db, collection, id), data),
        update: (collection, id, patch) => t.update(doc(db, collection, id), patch),
      })
    ),
  upload(bucket, path, file, { contentType, owner }) {
    // The five "buckets" are top-level folders of the one Storage bucket, and the
    // Storage rules require every object to name its owner.
    const task = uploadBytesResumable(storageRef(storage, `${bucket}/${path}`), file, {
      contentType,
      customMetadata: { owner },
    })
    const timer = setTimeout(() => task.cancel(), UPLOAD_TIMEOUT_MS)
    return task.then(
      () => clearTimeout(timer),
      (error) => {
        clearTimeout(timer)
        throw error
      }
    )
  },
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

/**
 * Try one write right now, without queueing it. Answers as queuePush does:
 * { ok } when the server has it, { ok: false, error, terminal } when it does not —
 * `terminal` meaning a retry would be refused the same way. For a caller that is
 * online and wants to tell the scout "uploaded" rather than "queued": on a
 * non-terminal failure it hands the same payload to enqueue().
 */
export async function pushNow(kind, payload) {
  if (!isConfigured) return { ok: false, error: 'The portal is not connected to a backend yet.', terminal: true }
  const client_uuid = payload.client_uuid ?? crypto.randomUUID()
  try {
    return await pushRow(store, { client_uuid, kind, payload: { ...payload, client_uuid } }, HANDLERS[kind])
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) }
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
  // Signed out, nothing can be delivered and nothing has been refused: the rows
  // wait for the next sign-in without spending their retries.
  if (!currentUid()) return { pushed: 0, failed: 0, skipped: true }
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
        result = await pushRow(store, row, HANDLERS[row.kind])
      } catch (err) {
        // queuePush turns every server answer into a result. Anything that still
        // throws (a blob the browser could not read back, a bug) is not a verdict
        // on the data — always retryable.
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
