import { getApps, initializeApp } from 'firebase-admin/app'
import { Timestamp, getFirestore } from 'firebase-admin/firestore'

// The Admin SDK bypasses the security rules. That is the point of these
// functions (they do what a browser must not) and the reason each one checks the
// caller's role itself before it reads or writes anything.
//
// The tests import these modules next to an app they have already pointed at the
// emulator, so an existing app is reused instead of initialised twice.
if (!getApps().length) initializeApp()

export const db = getFirestore()

/** Firestore values as plain JSON: Timestamps become ISO strings, recursively. */
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

/** Milliseconds for a stored time, or null when the field is not a time. */
export function millis(value) {
  if (value instanceof Timestamp) return value.toMillis()
  return null
}
