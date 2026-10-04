import { memoGet, memoSet } from './memo.js'
import { fail, logSafe, readBody, reason } from './safe.js'
import { asEventKey, asTeamNumber } from './validate.js'

// =============================================================================
// statboticsProxy — Statbotics EPA, cached and fail-soft.
//
// Statbotics is the open standard for FRC team strength (EPA, Expected Points
// Added), the number a lot of teams rank and pick by. It needs no API key, so
// this proxy exists for three smaller reasons than hiding a secret: it caches,
// so a pit full of tablets does not each hammer a free public service; it turns
// Statbotics' occasional outages into a clean "no data" the UI treats as
// optional; and it keeps the browser off a cross-origin request whose CORS
// policy we do not control.
//
// Fail-soft is the contract. EPA is an enrichment, never a dependency. When
// Statbotics is slow or down, this answers with a tidy error the caller is
// expected to swallow and show nothing for; our own scouting numbers stand on
// their own. Same posture as tbaProxy otherwise: members and up, whitelisted
// actions, validated parameters, upstream bodies never relayed.
// =============================================================================

const BASE = 'https://api.statbotics.io/v3'
const MAX_BODY_BYTES = 4_000

// EPA moves slowly across an event (it updates as matches complete), so a long
// cache is safe and kind to a free service. A miss is always correct.
const TTL = 15 * 60

async function sbGet(path, deps) {
  let res
  try {
    res = await deps.fetch(BASE + path, {
      headers: {
        Accept: 'application/json',
        // A polite, real user agent; some hosts reject the default one.
        'User-Agent': 'frc5805-portal/1.0 (+https://frc5805.com)',
      },
    })
  } catch (err) {
    return { data: null, status: 502, error: `Could not reach Statbotics: ${reason(err)}` }
  }
  if (!res.ok) {
    logSafe('[statbotics]', path, '->', String(res.status))
    // A 5xx here is routine (their backend cold-starts and scales). Reported
    // flatly; the caller shows no EPA and moves on.
    return { data: null, status: 502, error: `Statbotics is unavailable right now (${res.status}).` }
  }
  try {
    return { data: await res.json(), status: 200 }
  } catch {
    return { data: null, status: 502, error: 'Statbotics returned something unreadable.' }
  }
}

// EPA for every team at an event in one call: what the Analytics board wants.
async function actionEventTeams(params, force, deps) {
  const eventKey = asEventKey(params.event)
  if (!eventKey) throw fail('event must look like 2026casd.')

  const cacheKey = `sb:event:${eventKey}`
  if (!force) {
    const hit = memoGet(cacheKey, TTL)
    if (hit) return { ...hit, cached: true }
  }

  // A limit high enough for any single event's team list in one page.
  const res = await sbGet(`/team_events?event=${eventKey}&limit=1000`, deps)
  if (!res.data) throw fail(res.error ?? 'Upstream failed.', res.status)

  const payload = { event: eventKey, team_events: res.data, cached: false }
  memoSet(cacheKey, { ...payload, cached: true })
  return payload
}

// One team at one event, for a team-detail screen.
async function actionTeamEvent(params, force, deps) {
  const team = asTeamNumber(params.team)
  const eventKey = asEventKey(params.event)
  if (!team) throw fail('team must be a positive integer.')
  if (!eventKey) throw fail('event must look like 2026casd.')

  const cacheKey = `sb:te:${team}:${eventKey}`
  if (!force) {
    const hit = memoGet(cacheKey, TTL)
    if (hit) return { ...hit, cached: true }
  }

  const res = await sbGet(`/team_event/${team}/${eventKey}`, deps)
  if (!res.data) throw fail(res.error ?? 'Upstream failed.', res.status)

  const payload = { team, event: eventKey, team_event: res.data, cached: false }
  memoSet(cacheKey, { ...payload, cached: true })
  return payload
}

/** The callable's body, after the role check. `deps` lets the tests stand in for Statbotics. */
export async function handleStatbotics(data, deps = {}) {
  const { action, force, ...params } = readBody(data, MAX_BODY_BYTES)
  const d = { fetch: deps.fetch ?? globalThis.fetch }

  switch (action) {
    case 'event_teams':
      return actionEventTeams(params, force === true, d)
    case 'team_event':
      return actionTeamEvent(params, force === true, d)
    default:
      throw fail('Unknown action. Expected one of: event_teams, team_event.')
  }
}
