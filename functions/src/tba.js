import { Timestamp } from 'firebase-admin/firestore'
import { db, millis, plain } from './admin.js'
import { TBA_KEY } from './config.js'
import { eventTeamId } from './ids.js'
import { memoGet, memoSet } from './memo.js'
import { fail, logSafe, readBody, reason } from './safe.js'
import { asEventKey, asTeamNumber, asYear } from './validate.js'

// =============================================================================
// tbaProxy — The Blue Alliance API v3, without shipping the key.
//
// scripts/fetch-tba.mjs does the same job at build time for the public site's
// season summary. This is the portal's runtime equivalent: a scout standing in a
// pit needs the team list now, not at the next deploy.
//
// Two constraints shape everything here.
//
// 1. Not an open proxy. The action names are a whitelist and each URL is built
//    from validated parameters. There is deliberately no `path` parameter to
//    forward: a function that takes a caller-supplied path and attaches a
//    credential to it is an open relay wearing our API key.
//
// 2. Cache hard. A pit full of scouts should not each be hitting an upstream API
//    over a saturated venue network. Events and team lists are kept in Firestore
//    (`events`, `event_teams`), where the portal also reads them directly; live
//    results are remembered for two minutes in memory. `force: true` skips the
//    cache for the case where somebody knows the upstream just changed.
//
// The cache is written with the Admin SDK because the rules let only leads write
// those two collections, and a member refreshing the team list should not need
// to be a lead.
// =============================================================================

const BASE = 'https://www.thebluealliance.com/api/v3'
const MAX_BODY_BYTES = 4_000 // this endpoint takes four small scalars, nothing more

// Freshness, in seconds, chosen by how fast the underlying thing moves. Too
// fresh costs an upstream call; too stale costs a scout standing at the wrong
// field.
const TTL = {
  events: 12 * 60 * 60, // a season's event list is essentially static
  eventTeams: 6 * 60 * 60, // team lists shuffle up to and slightly into an event
  matches: 120, // scores change live, so this is the one that must stay short
  teamHistory: 15 * 60, // ranks move between matches
}

const ACTIONS = 'events, event_teams, event_matches, team_history, team_event_detail'

export async function tbaGet(path, deps) {
  if (!deps.key) return { data: null, status: 500, error: 'TBA_KEY is not configured on the server.' }

  let res
  try {
    res = await deps.fetch(BASE + path, { headers: { 'X-TBA-Auth-Key': deps.key } })
  } catch (err) {
    return { data: null, status: 502, error: `Could not reach The Blue Alliance: ${reason(err)}` }
  }

  if (!res.ok) {
    // The upstream status is passed along but the upstream body is not: an error
    // page from an API we authenticate to is exactly the sort of text that can
    // quote a credential back.
    logSafe('[tba]', path, '->', String(res.status))
    if (res.status === 401) return { data: null, status: 502, error: 'The Blue Alliance rejected our API key.' }
    if (res.status === 404) return { data: null, status: 404, error: 'Not found on The Blue Alliance.' }
    return { data: null, status: 502, error: `The Blue Alliance returned ${res.status}.` }
  }

  try {
    return { data: await res.json(), status: 200 }
  } catch {
    return { data: null, status: 502, error: 'The Blue Alliance returned something unreadable.' }
  }
}

// --- row mapping -------------------------------------------------------------

// TBA's `event_type` is an integer code with a separate human string. The string
// is what a mentor reading the list wants; the code means nothing without TBA's
// lookup table. Dates stay 'YYYY-MM-DD' strings, as TBA sends them.
function eventRow(e, now) {
  return {
    key: e.key,
    year: e.year,
    name: e.name,
    short_name: e.short_name ?? null,
    event_type: e.event_type_string ?? (e.event_type != null ? String(e.event_type) : null),
    city: e.city ?? null,
    state_prov: e.state_prov ?? null,
    country: e.country ?? null,
    start_date: e.start_date ?? null,
    end_date: e.end_date ?? null,
    week: e.week ?? null,
    synced_at: now,
  }
}

function teamRow(t, eventKey, now) {
  return {
    event_key: eventKey,
    team_number: t.team_number,
    nickname: t.nickname ?? null,
    name: t.name ?? null,
    city: t.city ?? null,
    state_prov: t.state_prov ?? null,
    country: t.country ?? null,
    rookie_year: t.rookie_year ?? null,
    synced_at: now,
  }
}

// TBA's status strings are HTML fragments with <b> and <a> in them, and they end
// up rendered as plain text here.
const strip = (html) => (html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

const byStartDate = (a, b) => String(a.start_date ?? '').localeCompare(String(b.start_date ?? ''))
const matchLabel = (m) => (m.comp_level === 'qm' ? 'Qual ' : String(m.comp_level).toUpperCase() + ' ') + m.match_number

// The newest `synced_at` among cached documents, in milliseconds. A document a
// lead wrote by hand may have no time on it; it counts as never synced.
const newestSync = (docs) => docs.reduce((max, d) => Math.max(max, millis(d.synced_at) ?? 0), 0)
const freshEnough = (ms, ttlSeconds) => ms > 0 && Date.now() - ms < ttlSeconds * 1000

// `synced_at` is a Timestamp in the database and an ISO string in the response.
// Written in chunks because a season is more events than one batch may hold.
async function cacheRows(collection, rows, idOf, at) {
  const synced_at = Timestamp.fromDate(at)
  for (let i = 0; i < rows.length; i += 400) {
    const batch = db.batch()
    for (const row of rows.slice(i, i + 400)) {
      batch.set(db.collection(collection).doc(idOf(row)), { ...row, synced_at })
    }
    await batch.commit()
  }
}

// A failed cache write is not a failed request: the caller asked for events and
// we have events. It is logged so a permanently broken cache is visible rather
// than merely slow.
async function cacheQuietly(what, write) {
  try {
    await write()
  } catch (err) {
    logSafe(`[tba] ${what} cache write failed:`, reason(err))
  }
}

// TBA keys are lower-case letters, digits and underscores. Anything else would
// not be a safe document id, and is not an event either.
const safeKey = (k) => typeof k === 'string' && /^[a-z0-9_]{1,40}$/.test(k)

// -----------------------------------------------------------------------------
// Actions
// -----------------------------------------------------------------------------

async function actionEvents(params, force, deps) {
  const year = asYear(params.year)
  if (!year) throw fail('year must be a season year, e.g. 2026.')

  if (!force) {
    const snap = await db.collection('events').where('year', '==', year).get()
    const cached = snap.docs.map((d) => d.data())
    const newest = newestSync(cached)
    if (cached.length && freshEnough(newest, TTL.events)) {
      return {
        events: cached.sort(byStartDate).map(plain),
        cached: true,
        synced_at: new Date(newest).toISOString(),
      }
    }
  }

  // The full endpoint, not /simple. /simple omits `short_name`, `week` and the
  // event-type string, and caching from it would write nulls over values a
  // previous full fetch had filled in. The list is cached for half a day, so the
  // extra payload is paid once.
  const res = await tbaGet(`/events/${year}`, deps)
  if (!res.data) throw fail(res.error ?? 'Upstream failed.', res.status)

  const at = new Date()
  const now = at.toISOString()
  const rows = (Array.isArray(res.data) ? res.data : []).filter((e) => safeKey(e?.key)).map((e) => eventRow(e, now))
  await cacheQuietly('events', () => cacheRows('events', rows, (r) => r.key, at))

  rows.sort(byStartDate)
  return { events: rows, cached: false, synced_at: now }
}

// A team list for an event the cache has never seen: the portal lists events
// from `events`, so the event itself is cached first.
async function ensureEvent(eventKey, deps) {
  const existing = await db.doc(`events/${eventKey}`).get()
  if (existing.exists) return null

  // The full /event/{key} rather than /simple, which omits `week` and the
  // event-type string.
  const res = await tbaGet(`/event/${eventKey}`, deps)
  if (!res.data) return res.error ?? 'Unknown event.'

  const at = new Date()
  await cacheQuietly('event', () => cacheRows('events', [eventRow({ ...res.data, key: eventKey }, at.toISOString())], (r) => r.key, at))
  return null
}

async function actionEventTeams(params, force, deps) {
  const eventKey = asEventKey(params.eventKey)
  if (!eventKey) throw fail('eventKey must look like 2026casd.')

  if (!force) {
    const snap = await db.collection('event_teams').where('event_key', '==', eventKey).get()
    const cached = snap.docs.map((d) => d.data())
    const newest = newestSync(cached)
    if (cached.length && freshEnough(newest, TTL.eventTeams)) {
      return {
        teams: cached.sort((a, b) => a.team_number - b.team_number).map(plain),
        cached: true,
        synced_at: new Date(newest).toISOString(),
      }
    }
  }

  const parentErr = await ensureEvent(eventKey, deps)
  if (parentErr) throw fail(parentErr, 502)

  // The full team endpoint, not /simple, which omits rookie_year.
  const res = await tbaGet(`/event/${eventKey}/teams`, deps)
  if (!res.data) throw fail(res.error ?? 'Upstream failed.', res.status)

  const at = new Date()
  const now = at.toISOString()
  const rows = (Array.isArray(res.data) ? res.data : [])
    .filter((t) => Number.isInteger(t?.team_number) && t.team_number > 0)
    .map((t) => teamRow(t, eventKey, now))
  if (rows.length) {
    await cacheQuietly('event_teams', () =>
      cacheRows('event_teams', rows, (r) => eventTeamId(r.event_key, r.team_number), at)
    )
  }

  rows.sort((a, b) => a.team_number - b.team_number)
  return { teams: rows, cached: false, synced_at: now }
}

const LEVEL_ORDER = { qm: 0, ef: 1, qf: 2, sf: 3, f: 4 }

// Nothing in Firestore mirrors the match schedule, so this is remembered in
// memory for two minutes and nothing more: short enough that a live score is
// never badly wrong, long enough to absorb thirty scouts opening it at once.
async function actionEventMatches(params, force, deps) {
  const eventKey = asEventKey(params.eventKey)
  if (!eventKey) throw fail('eventKey must look like 2026casd.')

  const cacheKey = `matches:${eventKey}`
  if (!force) {
    const hit = memoGet(cacheKey, TTL.matches)
    if (hit) return { matches: hit, cached: true }
  }

  const res = await tbaGet(`/event/${eventKey}/matches/simple`, deps)
  if (!res.data) throw fail(res.error ?? 'Upstream failed.', res.status)

  // Flattened to what "which match am I watching" needs. Team keys are reduced
  // to numbers because everything else in the portal keys on the integer, and
  // leaving both forms in circulation invites a comparison that matches nothing.
  const matches = res.data
    .map((m) => ({
      key: m.key,
      comp_level: m.comp_level,
      set_number: m.set_number,
      match_number: m.match_number,
      label: matchLabel(m),
      red: (m.alliances?.red?.team_keys ?? []).map((k) => Number(k.replace('frc', ''))),
      blue: (m.alliances?.blue?.team_keys ?? []).map((k) => Number(k.replace('frc', ''))),
      red_score: m.alliances?.red?.score ?? null,
      blue_score: m.alliances?.blue?.score ?? null,
      winning_alliance: m.winning_alliance || null,
      // TBA gives epoch seconds; ISO is what every time in the portal is.
      scheduled_at: m.time ? new Date(m.time * 1000).toISOString() : null,
      actual_at: m.actual_time ? new Date(m.actual_time * 1000).toISOString() : null,
    }))
    .sort(
      (a, b) =>
        (LEVEL_ORDER[a.comp_level] ?? 9) - (LEVEL_ORDER[b.comp_level] ?? 9) ||
        a.set_number - b.set_number ||
        a.match_number - b.match_number
    )

  memoSet(cacheKey, matches)
  return { matches, cached: false }
}

// Feeds the "they have already played N events" line. The count of completed
// events is the part that matters: a team with three events behind it and one
// rank is a different read from a team with one.
async function actionTeamHistory(params, force, deps) {
  const teamNumber = asTeamNumber(params.teamNumber)
  const year = asYear(params.year)
  if (!teamNumber) throw fail('teamNumber must be a positive integer.')
  if (!year) throw fail('year must be a season year, e.g. 2026.')

  const cacheKey = `history:${teamNumber}:${year}`
  if (!force) {
    const hit = memoGet(cacheKey, TTL.teamHistory)
    if (hit) return hit
  }

  // Full events again rather than /simple, for the same reason as actionEvents:
  // these rows go straight into the events cache below.
  const evRes = await tbaGet(`/team/frc${teamNumber}/events/${year}`, deps)
  if (!evRes.data) throw fail(evRes.error ?? 'Upstream failed.', evRes.status)

  // Statuses are best-effort: a team with no completed matches has no status
  // object at all, and that must read as "no data yet" rather than as an error.
  const stRes = await tbaGet(`/team/frc${teamNumber}/events/${year}/statuses`, deps)
  const statuses = stRes.data ?? {}

  const events = [...evRes.data].sort(byStartDate).map((e) => {
    const s = statuses[e.key] ?? {}
    const rec = s.qual?.ranking?.record ?? null
    return {
      key: e.key,
      name: e.name,
      start_date: e.start_date ?? null,
      end_date: e.end_date ?? null,
      week: e.week ?? null,
      rank: s.qual?.ranking?.rank ?? null,
      total_teams: s.qual?.num_teams ?? null,
      record: rec ? `${rec.wins}-${rec.losses}-${rec.ties}` : null,
      result: strip(s.overall_status_str) || null,
      // A qual ranking is the signal that they actually played, rather than
      // merely being registered for a future event.
      played: Boolean(s.qual?.ranking?.rank),
    }
  })

  // These are real event rows and we are already holding them, so the events
  // cache is filled as a side effect: the next caller asking for one of these
  // events' teams does not need the ensureEvent round trip.
  const at = new Date()
  const rows = evRes.data.filter((e) => safeKey(e?.key)).map((e) => eventRow(e, at.toISOString()))
  await cacheQuietly('team_history event', () => cacheRows('events', rows, (r) => r.key, at))

  const payload = {
    team_number: teamNumber,
    year,
    events,
    events_registered: events.length,
    events_played: events.filter((e) => e.played).length,
    cached: false,
  }
  memoSet(cacheKey, { ...payload, cached: true })
  return payload
}

// The official numbers for one team at one event: OPR, DPR, CCWM, ranking,
// record, and that team's own matches. This is the counterweight to human
// scouting on the team-detail screen. Where the two disagree is exactly the
// conversation a strategy lead wants to have.
async function actionTeamEventDetail(params, force, deps) {
  const eventKey = asEventKey(params.eventKey)
  const teamNumber = asTeamNumber(params.teamNumber)
  if (!eventKey) throw fail('eventKey must look like 2026casd.')
  if (!teamNumber) throw fail('teamNumber must be a positive integer.')
  const teamKey = `frc${teamNumber}`

  const cacheKey = `ted:${eventKey}:${teamNumber}`
  if (!force) {
    const hit = memoGet(cacheKey, TTL.matches)
    if (hit) return { ...hit, cached: true }
  }

  // Fetched together; each degrades to null rather than failing the whole view,
  // because early in an event OPRs and rankings do not exist yet, and a page
  // that errors then is worse than one showing "not ranked yet".
  const [oprsRes, rankRes, matchesRes] = await Promise.all([
    tbaGet(`/event/${eventKey}/oprs`, deps),
    tbaGet(`/event/${eventKey}/rankings`, deps),
    tbaGet(`/team/${teamKey}/event/${eventKey}/matches/simple`, deps),
  ])

  const rankRow = rankRes.data?.rankings?.find((r) => r.team_key === teamKey) ?? null

  const detail = {
    team_number: teamNumber,
    event_key: eventKey,
    opr: oprsRes.data?.oprs?.[teamKey] ?? null,
    dpr: oprsRes.data?.dprs?.[teamKey] ?? null,
    ccwm: oprsRes.data?.ccwms?.[teamKey] ?? null,
    rank: rankRow?.rank ?? null,
    total_ranked: rankRes.data?.rankings?.length ?? null,
    record: rankRow?.record ? `${rankRow.record.wins}-${rankRow.record.losses}-${rankRow.record.ties}` : null,
    matches: (Array.isArray(matchesRes.data) ? matchesRes.data : [])
      .map((m) => {
        const onRed = (m.alliances?.red?.team_keys ?? []).includes(teamKey)
        const us = onRed ? m.alliances?.red : m.alliances?.blue
        const them = onRed ? m.alliances?.blue : m.alliances?.red
        const outcome =
          m.winning_alliance == null || m.winning_alliance === ''
            ? null
            : (onRed ? 'red' : 'blue') === m.winning_alliance
              ? 'W'
              : m.winning_alliance === 'tie'
                ? 'T'
                : 'L'
        return {
          key: m.key,
          label: matchLabel(m),
          comp_level: m.comp_level,
          match_number: m.match_number,
          alliance: onRed ? 'red' : 'blue',
          us_score: us?.score ?? null,
          them_score: them?.score ?? null,
          outcome,
          actual_at: m.actual_time ? new Date(m.actual_time * 1000).toISOString() : null,
        }
      })
      .sort((a, b) => (a.match_number ?? 0) - (b.match_number ?? 0)),
  }

  memoSet(cacheKey, detail)
  return detail
}

// -----------------------------------------------------------------------------

/**
 * The callable's body, after the role check. `deps` exists so the tests can
 * stand in for The Blue Alliance; in production it is the real fetch and the
 * real key.
 */
export async function handleTba(data, deps = {}) {
  const { action, force, ...params } = readBody(data, MAX_BODY_BYTES)
  const forced = force === true
  const d = {
    fetch: deps.fetch ?? globalThis.fetch,
    // Read only when an upstream call is about to be made.
    get key() {
      return deps.key ?? TBA_KEY.value()
    },
  }

  switch (action) {
    case 'events':
      return actionEvents(params, forced, d)
    case 'event_teams':
      return actionEventTeams(params, forced, d)
    case 'event_matches':
      return actionEventMatches(params, forced, d)
    case 'team_history':
      return actionTeamHistory(params, forced, d)
    case 'team_event_detail':
      return actionTeamEventDetail(params, forced, d)
    default:
      // The whitelist is the security control, so an unknown action is refused
      // outright rather than anything resembling a fallthrough.
      throw fail(`Unknown action. Expected one of: ${ACTIONS}.`)
  }
}
