import { FieldValue } from 'firebase-admin/firestore'
import { db } from './admin.js'
import { teamStatId } from './ids.js'
import { affectedPairs, computeTeamEventStats } from './stats.js'

/**
 * Recompute one team's statistics at one event from scratch.
 *
 * From scratch, not incrementally: a trigger can run twice for one write and two
 * triggers can run out of order, and "add one to the count" is wrong in both
 * cases. Reading the team's entries and writing what they add up to is right no
 * matter how many times it runs. A team has a few dozen entries at an event, so
 * the read is cheap.
 *
 * In a transaction that also reads the statistics document, so two scouts
 * submitting the same team at the same moment cannot leave the older answer on
 * top: the second writer is retried and sees both entries.
 */
export async function recomputeTeamStats(eventKey, teamNumber) {
  const ref = db.doc(`team_event_stats/${teamStatId(eventKey, teamNumber)}`)
  const entriesQuery = db
    .collection('scout_entries')
    .where('event_key', '==', eventKey)
    .where('team_number', '==', teamNumber)
  const photosQuery = db
    .collection('robot_photos')
    .where('event_key', '==', eventKey)
    .where('team_number', '==', teamNumber)
    .count()

  await db.runTransaction(async (tx) => {
    await tx.get(ref)
    const entries = (await tx.get(entriesQuery)).docs.map((d) => d.data())
    const photos = (await tx.get(photosQuery)).data().count

    const stats = computeTeamEventStats(eventKey, teamNumber, entries, photos)
    // Nothing left to describe. A document of zeroes would put the team in
    // Analytics as "scouted, scored nothing", which is not what happened.
    if (!stats) tx.delete(ref)
    else tx.set(ref, { ...stats, updated_at: FieldValue.serverTimestamp() })
  })
}

/**
 * For both triggers: refresh every (event, team) the change touched. A document
 * with no event names no pair, and nothing is written for it.
 */
export async function refreshStatsFor(event) {
  const before = event.data?.before?.exists ? event.data.before.data() : null
  const after = event.data?.after?.exists ? event.data.after.data() : null
  for (const { eventKey, teamNumber } of affectedPairs(before, after)) {
    await recomputeTeamStats(eventKey, teamNumber)
  }
}
