// =============================================================================
// statbotics-proxy — Statbotics EPA, cached and fail-soft.
//
// Statbotics is the modern open standard for FRC team strength (EPA — Expected
// Points Added), the metric a lot of teams rank and pick by. It needs NO API key
// (unlike TBA/Nexus), so this proxy exists for three smaller reasons rather than
// secret-hiding: (1) it caches, so a pit full of tablets does not each hammer a
// free public service; (2) it normalises Statbotics' occasional outages into a
// clean "no data" the UI treats as optional; (3) it keeps the browser off a
// cross-origin request whose CORS policy we do not control.
//
// FAIL-SOFT IS THE CONTRACT. EPA is an enrichment, never a dependency. When
// Statbotics is slow, scaling, or down (their App Engine backend 5xxs more than
// you'd like), this returns a tidy error the caller is expected to swallow and
// show nothing for — the Catalyst engine's own numbers, from our scouting, stand
// on their own. Same security posture as tba-proxy: member+, whitelisted
// actions, validated params, upstream bodies never relayed.
// =============================================================================

import {
  fail,
  logSafe,
  memoGet,
  memoSet,
  ok,
  preflight,
  readJsonBody,
  requireCaller,
  scrub,
} from '../_shared/auth.ts'

const BASE = 'https://api.statbotics.io/v3'
const MAX_BODY_BYTES = 4_000

// EPA moves slowly across an event (it updates as matches complete), so a long
// cache is safe and kind to a free service. A miss is always correct.
const TTL = 15 * 60

interface Result<T> {
  data: T | null
  status: number
  error?: string
}

async function sbGet<T>(path: string): Promise<Result<T>> {
  let res: Response
  try {
    res = await fetch(BASE + path, {
      headers: {
        Accept: 'application/json',
        // A polite, real UA; some hosts reject the default fetch agent.
        'User-Agent': 'frc5805-portal/1.0 (+https://frc5805.com)',
      },
    })
  } catch (err) {
    return { data: null, status: 502, error: `Could not reach Statbotics: ${scrub(err)}` }
  }
  if (!res.ok) {
    logSafe('[statbotics]', path, '->', String(res.status))
    // 5xx here is routine (their backend cold-starts / scales). Report it flatly;
    // the caller shows no EPA and moves on.
    return { data: null, status: 502, error: `Statbotics is unavailable right now (${res.status}).` }
  }
  try {
    return { data: (await res.json()) as T, status: 200 }
  } catch {
    return { data: null, status: 502, error: 'Statbotics returned something unreadable.' }
  }
}

// Same strict event-key shape TBA/Nexus enforce.
function asEventKey(v: unknown): string | null {
  const s = String(v ?? '').trim().toLowerCase()
  return /^\d{4}[a-z0-9]{1,20}$/.test(s) ? s : null
}
function asTeamNumber(v: unknown): number | null {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 && n < 100000 ? n : null
}

// EPA for every team at an event, in one call — what the Analytics board wants.
async function actionEventTeams(req: Request, params: Record<string, unknown>, force: boolean) {
  const eventKey = asEventKey(params.event)
  if (!eventKey) return fail(req, 'event must look like 2026casd.')

  const cacheKey = `sb:event:${eventKey}`
  if (!force) {
    const hit = memoGet<unknown>(cacheKey, TTL)
    if (hit) return ok(req, { ...(hit as object), cached: true })
  }

  // limit high enough for any single event's team list in one page.
  const res = await sbGet<unknown[]>(`/team_events?event=${eventKey}&limit=1000`)
  if (!res.data) return fail(req, res.error ?? 'Upstream failed.', res.status)

  const payload = { event: eventKey, team_events: res.data, cached: false }
  memoSet(cacheKey, { ...payload, cached: true })
  return ok(req, payload)
}

// One team at one event — for a team-detail screen.
async function actionTeamEvent(req: Request, params: Record<string, unknown>, force: boolean) {
  const team = asTeamNumber(params.team)
  const eventKey = asEventKey(params.event)
  if (!team) return fail(req, 'team must be a positive integer.')
  if (!eventKey) return fail(req, 'event must look like 2026casd.')

  const cacheKey = `sb:te:${team}:${eventKey}`
  if (!force) {
    const hit = memoGet<unknown>(cacheKey, TTL)
    if (hit) return ok(req, { ...(hit as object), cached: true })
  }

  const res = await sbGet<unknown>(`/team_event/${team}/${eventKey}`)
  if (!res.data) return fail(req, res.error ?? 'Upstream failed.', res.status)

  const payload = { team, event: eventKey, team_event: res.data, cached: false }
  memoSet(cacheKey, { ...payload, cached: true })
  return ok(req, payload)
}

Deno.serve(async (req) => {
  const pre = preflight(req)
  if (pre) return pre
  if (req.method !== 'POST') return fail(req, 'Use POST.', 405)

  const auth = await requireCaller(req, 'member')
  if (!auth.ok) return auth.response

  const parsed = await readJsonBody(req, MAX_BODY_BYTES)
  if ('error' in parsed) return fail(req, parsed.error, /too large/.test(parsed.error) ? 413 : 400)

  const { action, force, ...params } = parsed.body as Record<string, unknown>
  const forced = force === true

  try {
    switch (action) {
      case 'event_teams':
        return await actionEventTeams(req, params, forced)
      case 'team_event':
        return await actionTeamEvent(req, params, forced)
      default:
        return fail(req, 'Unknown action. Expected one of: event_teams, team_event.')
    }
  } catch (err) {
    logSafe('[statbotics] unhandled:', err instanceof Error ? err.message : String(err))
    return fail(req, 'The Statbotics lookup failed unexpectedly.', 500)
  }
})
