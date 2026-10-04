import { FieldValue } from 'firebase-admin/firestore'
import { db } from './admin.js'

/**
 * A per-user sliding window that survives a cold start.
 *
 * The old limiter counted in one instance's memory, so the real allowance was
 * "N per window per instance" and a restart reset it to zero. This one keeps the
 * recent request times in rate_limits/{uid}_{name}, read and written in one
 * transaction, so the count is the same whichever instance answers. The security
 * rules close every collection they do not name, so no client can read or reset
 * its own counter.
 *
 * It guards against a stuck retry loop or one student hammering a button. It is
 * still not a spend cap: the cap that holds is a hard monthly limit set in the
 * OpenAI dashboard. Set one.
 *
 * @returns {Promise<boolean>} true when the request may go ahead
 */
export async function takeToken(uid, name, max, windowSeconds, now = Date.now()) {
  const ref = db.doc(`rate_limits/${uid}_${name}`)
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    const stored = snap.exists && Array.isArray(snap.get('hits')) ? snap.get('hits') : []
    const cutoff = now - windowSeconds * 1000
    const recent = stored.filter((t) => typeof t === 'number' && t > cutoff)
    // A refusal is not recorded: being told to wait must not push the wait out.
    if (recent.length >= max) return false

    recent.push(now)
    tx.set(ref, { uid, name, hits: recent, updated_at: FieldValue.serverTimestamp() })
    return true
  })
}
