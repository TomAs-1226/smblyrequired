import { getAuth } from 'firebase-admin/auth'
import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError } from 'firebase-functions/https'
import { db, plain } from './admin.js'
import { NO_ACCESS_MESSAGE, ROLES, asRole } from './roles.js'
import { readBody, warnSafe } from './safe.js'

// Role changes and member removal.
//
// The security rules give no client a way to write `role` or delete a profile,
// so these two functions are the only path, and the guards below are the only
// guards. The codes are chosen so each sentence reaches the reader: the portal
// replaces every `permission-denied` message with a generic one, and "you cannot
// change your own role" is worth saying exactly.

const MAX_BODY_BYTES = 1_000

function targetOf(data) {
  const id = typeof data.targetId === 'string' ? data.targetId.trim() : ''
  // A uid becomes a document path segment, so it cannot contain a slash.
  if (!id || id.length > 128 || id.includes('/')) {
    throw new HttpsError('invalid-argument', 'targetId must be a member id.')
  }
  return id
}

const profileRef = (uid) => db.doc(`profiles/${uid}`)
const adminsQuery = () => db.collection('profiles').where('role', '==', 'admin')

// Everything a decision rests on, read in the same transaction as the write it
// allows: the target, the caller, and (when an admin is about to stop being one)
// the list of admins.
//
// You cannot target yourself, so the last admin can only be removed in a race:
// two admins acting on each other at the same instant, each of whom was an admin
// a moment ago when the callable checked. The transaction makes the second one
// see what the first one did, and these two checks are what it then runs into.
async function readForChange(tx, callerUid, targetId, losesAdmin) {
  const target = await tx.get(profileRef(targetId))
  const me = await tx.get(profileRef(callerUid))
  const from = target.exists ? asRole(target.get('role')) : null
  const admins = from === 'admin' && losesAdmin ? (await tx.get(adminsQuery())).size : null
  return { target, from, admins, callerIsAdmin: asRole(me.get('role')) === 'admin' }
}

function refuseUnlessStillAdmin(state) {
  if (!state.callerIsAdmin) throw new HttpsError('permission-denied', NO_ACCESS_MESSAGE)
}

function audit(tx, actor, action, entityId, detail) {
  tx.set(db.collection('audit_log').doc(), {
    actor,
    action,
    entity: 'profiles',
    entity_id: entityId,
    detail,
    created_at: FieldValue.serverTimestamp(),
  })
}

/**
 * setMemberRole({ targetId, role }): the only way a role changes.
 * Admins only; never your own; never the last admin's.
 */
export async function setMemberRole(request, caller) {
  const data = readBody(request.data, MAX_BODY_BYTES)
  const targetId = targetOf(data)
  const role = data.role
  if (!ROLES.includes(role)) {
    throw new HttpsError('invalid-argument', `role must be one of: ${ROLES.join(', ')}.`)
  }
  // Not even to step down. An admin who demotes themselves by a slip of the
  // thumb has nobody to ask for it back when they are the only one.
  if (targetId === caller.uid) throw new HttpsError('failed-precondition', 'You cannot change your own role.')

  await db.runTransaction(async (tx) => {
    const state = await readForChange(tx, caller.uid, targetId, role !== 'admin')
    const { target, from } = state
    if (!target.exists) throw new HttpsError('not-found', 'No such member.')
    if (state.admins != null && state.admins <= 1) {
      throw new HttpsError('failed-precondition', 'Refusing to remove the last remaining admin.')
    }
    refuseUnlessStillAdmin(state)
    // Setting the role a member already has changes nothing and is not an event.
    if (from === role) return

    tx.update(target.ref, { role, updated_at: FieldValue.serverTimestamp() })
    audit(tx, caller.uid, 'role.change', targetId, { from, to: role })
  })

  const updated = await profileRef(targetId).get()
  return { id: updated.id, ...plain(updated.data()) }
}

/**
 * deleteMember({ targetId }): removes the profile and the sign-in account.
 * Admins only; never yourself; never the last admin.
 */
export async function deleteMember(request, caller) {
  const data = readBody(request.data, MAX_BODY_BYTES)
  const targetId = targetOf(data)
  if (targetId === caller.uid) throw new HttpsError('failed-precondition', 'You cannot delete your own account.')

  const auth = getAuth()
  const account = await auth.getUser(targetId).catch((err) => {
    if (err?.code === 'auth/user-not-found') return null
    throw err
  })

  // The profile first, inside the transaction that holds the guards. If the
  // account delete then fails, what is left is a sign-in with no profile, which
  // is `pending` and can read nothing; calling this again finishes the job. The
  // other order could delete an account and then refuse to delete its profile.
  const removed = await db.runTransaction(async (tx) => {
    const state = await readForChange(tx, caller.uid, targetId, true)
    const { target, from: role } = state
    if (!target.exists && !account) throw new HttpsError('not-found', 'No such member.')
    if (state.admins != null && state.admins <= 1) {
      throw new HttpsError('failed-precondition', 'Refusing to delete the last remaining admin.')
    }
    refuseUnlessStillAdmin(state)
    if (target.exists) tx.delete(target.ref)
    // The name is kept because the profile it came from is about to be gone, and
    // "who was that?" is the first question anyone reading the log will ask.
    audit(tx, caller.uid, 'member.delete', targetId, {
      role,
      full_name: target.exists ? (target.get('full_name') ?? null) : null,
    })
    return { role }
  })

  if (account) {
    try {
      await auth.deleteUser(targetId)
    } catch (err) {
      if (err?.code !== 'auth/user-not-found') {
        warnSafe('[deleteMember] profile removed, account delete failed:', err?.code ?? 'unknown')
        throw new HttpsError(
          'internal',
          'The profile was removed, but the sign-in account could not be deleted. Try again.'
        )
      }
    }
  }

  return { id: targetId, deleted: true, role: removed.role }
}
