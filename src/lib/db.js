import { Timestamp, serverTimestamp, collection, getDocsFromServer } from 'firebase/firestore'
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
 * with an HttpsError whose message is already written for the reader ("Your
 * account is still pending approval…", "You cannot change your own role."), so
 * unlike a rules refusal, the message is kept: only a failure to reach the
 * function at all is replaced with the generic sentence. The client SDK appends
 * the HTTP status ("… [404]"); that is stripped.
 */
export async function call(name, payload) {
  if (!isConfigured) return notConnected()
  try {
    const res = await httpsCallable(functions, name)(payload ?? {})
    return { data: res.data, error: null }
  } catch (e) {
    if (isTransportError(e)) return { data: null, error: wrap(e) }
    const message = String(e?.message ?? '').replace(/\s*\[\d{3}\]$/, '').trim()
    const bare = !message || /^(internal|unknown)$/i.test(message)
    return { data: null, error: bare ? 'The server could not do that just now. Try again in a moment.' : message }
  }
}

// uid -> profile, for rows that used to join the scout's or actor's profile.
// The roster is small (one read of a few dozen documents) and is kept for two
// minutes, and per signed-in user: a roster read by one account is not served to
// the next one to sign in on the same browser.
let roster = null
let rosterAt = 0
let rosterFor = null
export async function memberNames({ fresh = false } = {}) {
  if (!isConfigured) return new Map()
  const uid = currentUid()
  if (!roster || fresh || rosterFor !== uid || Date.now() - rosterAt > 2 * 60_000) {
    try {
      const snap = await getDocsFromServer(collection(db, 'profiles'))
      roster = new Map(snap.docs.map((d) => [d.id, d.data()]))
      rosterAt = Date.now()
      rosterFor = uid
    } catch {
      // No roster (offline, or a role that may not read it): names are simply absent.
      if (rosterFor !== uid) roster = new Map()
      roster = roster ?? new Map()
    }
  }
  return roster
}
