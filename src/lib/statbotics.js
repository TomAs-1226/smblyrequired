import { supabase, isConfigured } from './supabase'

// -----------------------------------------------------------------------------
// Statbotics EPA — an OPTIONAL external check on the Catalyst engine.
//
// Every function here is fail-soft by construction: any error, outage, or shape
// surprise resolves to "no EPA", never a thrown error or a red banner. EPA
// enriches the analytics when Statbotics is answering and is simply absent when
// it is not. The caller renders around its presence, never depends on it.
//
// EPA field paths are read defensively because Statbotics' v3 payload nests the
// headline number differently across shapes; we try the likely spots and give up
// quietly. The proxy (member+, cached) does the actual fetch — see
// supabase/functions/statbotics-proxy.
// -----------------------------------------------------------------------------

// Pull the single comparable EPA number (expected points) out of a TeamEvent /
// TeamYear object, whatever the exact nesting.
function extractEpa(row) {
  const e = row?.epa
  if (e == null) return null
  const candidate =
    e?.total_points?.mean ??
    e?.breakdown?.total_points ??
    e?.total_points ??
    e?.unitless ??
    (typeof e === 'number' ? e : null)
  const n = Number(candidate)
  return Number.isFinite(n) ? n : null
}

const teamOf = (row) => row?.team ?? row?.team_number ?? null

/**
 * EPA for every team at an event, as a plain map `{ [teamNumber]: epa }`.
 * Resolves to `{ data: null }` on any problem — the caller shows nothing.
 */
export async function statboticsEvent(eventKey) {
  if (!isConfigured || !eventKey) return { data: null, error: null }
  try {
    const { data, error } = await supabase.functions.invoke('statbotics-proxy', {
      body: { action: 'event_teams', event: eventKey },
    })
    if (error) return { data: null, error: null } // Statbotics down / non-2xx — swallow
    const payload = data?.data ?? data
    const list = payload?.team_events
    if (!Array.isArray(list)) return { data: null, error: null }
    const map = {}
    for (const row of list) {
      const team = teamOf(row)
      const epa = extractEpa(row)
      if (team != null && epa != null) map[team] = epa
    }
    return { data: Object.keys(map).length ? map : null, error: null }
  } catch {
    return { data: null, error: null }
  }
}

/**
 * EPA for one team at one event — for a team-detail screen. `{ data: null }`
 * whenever Statbotics can't answer.
 */
export async function statboticsTeamEvent(team, eventKey) {
  if (!isConfigured || !team || !eventKey) return { data: null, error: null }
  try {
    const { data, error } = await supabase.functions.invoke('statbotics-proxy', {
      body: { action: 'team_event', team: Number(team), event: eventKey },
    })
    if (error) return { data: null, error: null }
    const payload = data?.data ?? data
    const row = payload?.team_event
    const epa = extractEpa(row)
    return { data: epa == null ? null : { epa, raw: row }, error: null }
  } catch {
    return { data: null, error: null }
  }
}
