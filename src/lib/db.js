import { Timestamp, serverTimestamp, collection, getDocs } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { auth, db, functions, isConfigured } from './firebase'

// Shared plumbing for everything that talks to Firestore. The portal's panels were
// written against rows with ISO-string timestamps and an `id`; these helpers keep
// that shape, so a panel does not need to know which backend it is on.

export const NOT_CONNECTED = 'The portal is not connected to a backend yet.'

/** Every API function returns { data, error } with `error` already a sentence. */
export const notConnected = (data = null) => ({ data, error: NOT_CONNECTED })

export { isConfigured }

/** The signed-in user's id, or null. */
export const currentUid = () => auth?.currentUser?.uid ?? null

/** Server time, for created_at / updated_at. The rules require exactly this. */
export const now = () => serverTimestamp()

/** An ISO string (or Date) as a Firestore Timestamp; null stays null. */
export function ts(value) {
  if (value == null) return null
  if (value instanceof Timestamp) return value
  return Timestamp.fromDate(value instanceof Date ? value : new Date(value))
}

/** Firestore values to plain JSON: Timestamps become ISO strings, recursively. */
export function plain(value) {
  if (value == null) return value
  if (value instanceof Timestamp) return value.toDate().toISOString()
  if (Array.isArray(value)) return value.map(plain)
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = plain(v)
    return out
  }
  return value
}

/** A document snapshot as a row: its data, plain, with `id`. Null if it does not exist. */
export function row(snap) {
  return snap.exists() ? { id: snap.id, ...plain(snap.data()) } : null
}

/** A query snapshot as rows. */
export const rows = (snap) => snap.docs.map((d) => ({ id: d.id, ...plain(d.data()) }))

/**
 * A Firebase error as something a student on a phone can act on. Rules refusals
 * all arrive as `permission-denied`; where a caller can say more precisely why
 * (a locked pick list, a closed scouting window), it does so before calling this.
 */
export function wrap(error) {
  if (!error) return null
  const code = String(error.code || '')
  const raw = String(error.message || error)
  if (code.includes('unauthenticated')) return 'Your session expired. Sign in again.'
  if (code.includes('permission-denied') || code.includes('unauthorized')) return 'You do not have access to that.'
  if (code.includes('unavailable') || code.includes('network') || /offline|network/i.test(raw))
    return 'Could not reach the server. Check your connection.'
  if (code.includes('resource-exhausted')) return 'Too many requests. Wait a minute and try again.'
  // Callable functions put their own sentence in message, behind an "internal"-style code.
  return raw.replace(/^Firebase(Error)?: /, '').replace(/ \((functions|firestore|storage|auth)\/[a-z-]+\)\.?$/, '')
}

/** True when a failure never reached the server, so retrying later may succeed. */
export function isTransportError(error) {
  const code = String(error?.code || '')
  if (/unavailable|deadline-exceeded|network|cancelled/.test(code)) return true
  return !code && /offline|network|fetch/i.test(String(error?.message || ''))
}

/**
 * Call a Cloud Function. Functions answer with their data directly and refuse
 * with an HttpsError whose message is already written for the reader.
 */
export async function call(name, payload) {
  if (!isConfigured) return notConnected()
  try {
    const res = await httpsCallable(functions, name)(payload ?? {})
    return { data: res.data, error: null }
  } catch (e) {
    return { data: null, error: wrap(e) }
  }
}

// uid -> full name, for rows that used to join the scout's or actor's profile.
// The roster is small (one read of a few dozen documents) and kept for the session.
let roster = null
let rosterAt = 0
export async function memberNames({ fresh = false } = {}) {
  if (!isConfigured) return new Map()
  if (!roster || fresh || Date.now() - rosterAt > 5 * 60_000) {
    try {
      const snap = await getDocs(collection(db, 'profiles'))
      roster = new Map(snap.docs.map((d) => [d.id, d.data()]))
      rosterAt = Date.now()
    } catch {
      roster = roster ?? new Map()
    }
  }
  return roster
}
