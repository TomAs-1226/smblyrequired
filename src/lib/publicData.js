import { useEffect, useState } from 'react'
import { doc, getDocFromServer } from 'firebase/firestore'
import { db } from './firebase'
import { call, isConfigured, notConnected, row, wrap } from './db'

// The public record for an event: Statbotics EPA and The Blue Alliance's OPR for
// every team there, merged by the publicData function (functions/src/publicData.js)
// and cached in public_event_data/{eventKey}.
//
// It is an estimate from match scores, not something anyone watched. It is here
// for the teams we could not put a scout on, shown beside our own scouting and
// never blended into it without saying so.

/**
 * Every team at the event from the public record.
 * → { data: { event_key, teams[], sources, synced_at, cached, stale? }, error }
 *
 * The function refreshes its cache when it is older than ten minutes. If the
 * function cannot be reached at all, the last copy it cached is read directly, so
 * a phone with a weak signal still has yesterday's numbers rather than nothing.
 */
export async function publicEventData(eventKey, { force = false } = {}) {
  if (!isConfigured) return notConnected()
  if (!eventKey) return { data: null, error: null }
  const live = await call('publicData', { action: 'event', eventKey, force })
  if (!live.error) return live
  try {
    const cached = row(await getDocFromServer(doc(db, 'public_event_data', eventKey)))
    if (cached) return { data: { ...cached, cached: true, stale: true }, error: null }
  } catch (e) {
    return { data: null, error: live.error || wrap(e) }
  }
  return live
}

// One answer per event is shared by every panel that asks within the function's
// own cache window, so opening Team detail after Field data costs nothing.
const SHARED_MS = 10 * 60 * 1000
const shared = new Map()

function sharedEventData(eventKey) {
  const hit = shared.get(eventKey)
  if (hit && Date.now() - hit.at < SHARED_MS) return hit.promise
  const promise = publicEventData(eventKey).then((res) => {
    // A failure is not worth remembering: the next panel should try again.
    if (res.error || !res.data) shared.delete(eventKey)
    return res
  })
  shared.set(eventKey, { at: Date.now(), promise })
  return promise
}

/** Forget the shared copy, after a forced refresh has fetched a newer one. */
export const forgetPublicEvent = (eventKey) => shared.delete(eventKey)

/**
 * The public record for an event as a map, team number → row. Fail-soft: a
 * panel that shows these numbers as a supplement gets an empty map when the
 * source is down, never an error to render.
 */
export function usePublicEvent(eventKey) {
  const [teams, setTeams] = useState(() => new Map())
  useEffect(() => {
    let alive = true
    setTeams(new Map())
    if (!eventKey) return undefined
    sharedEventData(eventKey).then((res) => {
      if (alive) setTeams(byTeam(res.data))
    })
    return () => {
      alive = false
    }
  }, [eventKey])
  return teams
}

/** team number → its public row, for panels that want one team's numbers. */
export const byTeam = (data) => new Map((data?.teams ?? []).map((t) => [t.team_number, t]))

/** 'coral_l4' → 'Coral l4': a game component's key as a column heading. */
export function componentLabel(key) {
  const words = String(key).replace(/_points$/, '').split('_').filter(Boolean)
  return words.map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1) : w)).join(' ')
}
