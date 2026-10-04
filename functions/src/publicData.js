import { FieldValue } from 'firebase-admin/firestore'
import { db, plain, millis } from './admin.js'
import { TBA_KEY } from './config.js'
import { fail, readBody, warnSafe } from './safe.js'
import { sbGet } from './statbotics.js'
import { tbaGet } from './tba.js'
import { asEventKey } from './validate.js'

// =============================================================================
// publicData — what the public record says about every team at an event.
//
// A team our size cannot put a scout on every robot in every match. The public
// record covers all of them: Statbotics publishes each team's expected points
// (EPA) split into autonomous, teleop and endgame and into the game's own
// components, with its record and rank; The Blue Alliance publishes OPR, DPR and
// CCWM. This gathers both into one row per team, so the portal can show a number
// for the teams we never watched — beside our own scouting, never instead of it.
//
// It is an estimate from match scores, not an observation: it cannot see a
// robot that broke, played defence, or was carried. Every screen that shows it
// says where it came from.
//
// Statbotics needs no key and is the source that must answer. The Blue Alliance
// is optional: with no TBA_KEY, or when it is down, the OPR columns are simply
// empty and the result says so. The merged table is cached in Firestore
// (public_event_data/{eventKey}) so a pit full of tablets shares one upstream
// call, and so the last good copy survives an outage.
// =============================================================================

const MAX_BODY_BYTES = 2_000
// EPA and OPR move only when a match is scored.
const TTL_SECONDS = 10 * 60

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const round = (v, places = 2) => (num(v) == null ? null : Math.round(v * 10 ** places) / 10 ** places)

// Statbotics' breakdown mixes the three phases, ranking points and the season's
// own components in one object. The phases get their own columns and ranking
// points are not points, so what is left is the game-specific part.
const NOT_COMPONENTS = new Set(['total_points', 'auto_points', 'teleop_points', 'endgame_points', 'tiebreaker_points'])
function components(breakdown) {
  const out = {}
  for (const [key, value] of Object.entries(breakdown ?? {})) {
    if (NOT_COMPONENTS.has(key) || /(^|_)rp(_|$)|^rp_/.test(key)) continue
    if (num(value) != null) out[key] = round(value)
  }
  return out
}

/** One team's row from a Statbotics team_event record. Pure; exported for the tests. */
export function teamFromStatbotics(row) {
  const epa = row?.epa ?? {}
  const b = epa.breakdown ?? {}
  const q = row?.record?.qual ?? {}
  const total = row?.record?.total ?? {}
  return {
    team_number: Number(row?.team),
    name: row?.team_name ?? null,
    epa: {
      total: round(epa.total_points ?? b.total_points),
      auto: round(b.auto_points),
      teleop: round(b.teleop_points),
      endgame: round(b.endgame_points),
      // How the estimate moved across the event: where it started, its mean, its best.
      start: round(epa.stats?.start),
      mean: round(epa.stats?.mean),
      max: round(epa.stats?.max),
      components: components(b),
    },
    record: {
      wins: num(total.wins) ?? 0,
      losses: num(total.losses) ?? 0,
      ties: num(total.ties) ?? 0,
      played: num(total.count) ?? 0,
      rank: num(q.rank),
      num_teams: num(q.num_teams),
    },
    opr: null,
    dpr: null,
    ccwm: null,
  }
}

/** Fold The Blue Alliance's OPR/DPR/CCWM ({ oprs: { frc254: 41.2 }, … }) into the rows. Pure. */
export function mergeOprs(teams, oprs) {
  const by = new Map(teams.map((t) => [t.team_number, t]))
  for (const [field, key] of [['opr', 'oprs'], ['dpr', 'dprs'], ['ccwm', 'ccwms']]) {
    for (const [frc, value] of Object.entries(oprs?.[key] ?? {})) {
      const n = Number(String(frc).replace(/^frc/, ''))
      // A team TBA knows and Statbotics does not still gets a row.
      if (!by.has(n) && Number.isInteger(n) && n > 0) {
        by.set(n, { ...teamFromStatbotics({ team: n }), epa: null })
      }
      const t = by.get(n)
      if (t) t[field] = round(value)
    }
  }
  return [...by.values()].sort((a, b) => a.team_number - b.team_number)
}

const fresh = (doc, now) => {
  const at = millis(doc?.synced_at) ?? Date.parse(doc?.synced_at)
  return Number.isFinite(at) && now - at < TTL_SECONDS * 1000
}

/**
 * The callable's body, after the role check. `deps` lets the tests stand in for
 * the two upstreams and for the cache.
 */
export async function handlePublicData(data, deps = {}) {
  const { action, force, ...params } = readBody(data, MAX_BODY_BYTES)
  if (action !== 'event') throw fail('Unknown action. Expected: event.')
  const eventKey = asEventKey(params.eventKey)
  if (!eventKey) throw fail('eventKey must look like 2026casd.')

  const now = deps.now ?? Date.now()
  const cache = deps.cache ?? {
    get: async () => (await db.collection('public_event_data').doc(eventKey).get()).data() ?? null,
    set: (doc) => db.collection('public_event_data').doc(eventKey).set(doc),
  }
  const d = {
    fetch: deps.fetch ?? globalThis.fetch,
    get key() {
      // The Blue Alliance is optional here: no key means no OPR, not a failure.
      try {
        return deps.key ?? TBA_KEY.value()
      } catch {
        return ''
      }
    },
  }

  const cached = await cache.get()
  if (cached && force !== true && fresh(cached, now)) return { ...plain(cached), cached: true }

  const sb = await sbGet(`/team_events?event=${encodeURIComponent(eventKey)}&limit=1000`, d)
  if (!Array.isArray(sb.data)) {
    // Statbotics is down. The last good copy is better than nothing, and says it is old.
    if (cached) return { ...plain(cached), cached: true, stale: true, sources: { ...cached.sources, statbotics: { ok: false, error: sb.error } } }
    throw fail(sb.error ?? 'Statbotics is unavailable right now.', 502)
  }

  let teams = sb.data.map(teamFromStatbotics).filter((t) => Number.isInteger(t.team_number) && t.team_number > 0)
  const sources = { statbotics: { ok: true, error: null }, tba: { ok: false, error: null } }

  const tba = await tbaGet(`/event/${eventKey}/oprs`, d)
  if (tba.data && typeof tba.data === 'object') {
    teams = mergeOprs(teams, tba.data)
    sources.tba = { ok: true, error: null }
  } else {
    sources.tba = { ok: false, error: tba.error ?? 'No OPR published for this event yet.' }
  }
  teams.sort((a, b) => a.team_number - b.team_number)

  const doc = { event_key: eventKey, teams, sources, team_count: teams.length }
  try {
    await cache.set({ ...doc, synced_at: deps.cache ? new Date(now).toISOString() : FieldValue.serverTimestamp() })
  } catch (err) {
    // A cache that will not write costs the next caller an upstream call, nothing more.
    warnSafe('[publicData] cache write failed:', err?.message ?? err)
  }
  return { ...doc, synced_at: new Date(now).toISOString(), cached: false }
}
