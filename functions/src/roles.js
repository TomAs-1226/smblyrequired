import { HttpsError } from 'firebase-functions/https'
import { db } from './admin.js'
import { fail, logSafe } from './safe.js'

// Privilege order. firebase/firestore.rules (`rank`) and src/lib/auth.jsx hold
// the same list; the three must agree.
export const ROLES = ['pending', 'viewer', 'member', 'lead', 'mentor', 'admin']

/** A stored role, or `pending` for anything that is not one of the six. */
export const asRole = (value) => (ROLES.includes(value) ? value : 'pending')

export const isAtLeast = (role, minimum) => ROLES.indexOf(asRole(role)) >= ROLES.indexOf(minimum)

export const PENDING_MESSAGE = 'Your account is still pending approval. Ask a lead to approve it.'
export const NO_ACCESS_MESSAGE = 'You do not have access to that.'

/**
 * Who is calling, and whether they may.
 *
 * A valid sign-in is not authorization. Anyone who can reach the sign-in form
 * holds a perfectly good token and is entitled to nothing until a lead approves
 * them, so every callable resolves the caller's role and compares it to a floor.
 *
 * The role is read from profiles/{uid} on every call and never from a token
 * claim: a claim keeps saying `lead` for up to an hour after an admin has taken
 * the role away. A missing profile, or a role that is not one of the six, is
 * `pending` — the default is the least privilege, never the benefit of the doubt.
 */
export async function requireRole(request, minimum) {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in to use this.')

  const snap = await db.doc(`profiles/${uid}`).get()
  const role = asRole(snap.get('role'))

  // Deliberately vague about what the floor is. Telling a pending account which
  // role unlocks the OpenAI key is free reconnaissance, and the person who
  // legitimately lands here needs to talk to a lead either way.
  if (!isAtLeast(role, minimum)) {
    throw new HttpsError('permission-denied', role === 'pending' ? PENDING_MESSAGE : NO_ACCESS_MESSAGE)
  }
  return { uid, role }
}

/**
 * Wraps a callable's body: the role check first, then the handler, with anything
 * unexpected turned into one plain sentence. An error this code did not write
 * (a driver message, a stack) is logged scrubbed and never sent to the browser.
 */
export function guarded(minimum, label, fallback, handler) {
  return async (request) => {
    const caller = await requireRole(request, minimum)
    try {
      return await handler(request, caller)
    } catch (err) {
      if (err instanceof HttpsError) throw err
      logSafe(`[${label}] unhandled:`, err instanceof Error ? err.message : String(err))
      throw fail(fallback, 500)
    }
  }
}
