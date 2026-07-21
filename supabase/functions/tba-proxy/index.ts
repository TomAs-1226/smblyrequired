// =============================================================================
// tba-proxy — The Blue Alliance API v3, without shipping the key.
//
// scripts/fetch-tba.mjs does the same job at *build* time for the public site's
// season summary. This is the portal's runtime equivalent: a scout standing in a
// pit needs the match schedule now, not at the next deploy. Same base URL, same
// auth header, same response shapes — read that script first if the TBA payloads
// below look unfamiliar.
//
// Two constraints shape everything here.
//
// 1. NOT AN OPEN PROXY. The action names are a whitelist and the URL is built
//    from validated parameters. There is deliberately no `path` parameter to
//    forward, because a function that takes a caller-supplied path and attaches
//    a credential to it is an open relay wearing our API key — and, since it
//    runs inside our project, a way to make requests that appear to come from us.
//
// 2. CACHE HARD. The TBA cache tables in 0005 exist because "a pit full of
//    scouts should not each be hitting an upstream API over a saturated
//    network". Every read prefers a recent cached row; `force: true` bypasses it
//    for the case where somebody knows the upstream just changed.
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
  serviceClient,
} from '../_shared/auth.ts'

const BASE = 'https://www.thebluealliance.com/api/v3'
const MAX_BODY_BYTES = 4_000 // this endpoint takes four small scalars, nothing more

// Freshness windows, chosen by how fast the underlying thing actually moves.
// Being wrong in the "too fresh" direction costs an upstream call; being wrong
// in the "too stale" direction costs a scout standing at the wrong field.
const TTL = {
  events: 12 * 60 * 60, // a season's event list is essentially static
  eventTeams: 6 * 60 * 60, // team lists shuffle up to and slightly into an event
  matches: 120, // scores change live — this is the one that must stay short
  teamHistory: 15 * 60, // ranks move between matches
}

interface TbaResult<T> {
  data: T | null
  status: number
  error?: string
}

async function tbaGet<T>(path: string): Promise<TbaResult<T>> {
  const key = Deno.env.get('TBA_KEY')
  if (!key) return { data: null, status: 500, error: 'TBA_KEY is not configured on the server.' }

  let res: Response
  try {
    res = await fetch(BASE + path, { headers: { 'X-TBA-Auth-Key': key } })
  } catch (err) {
    return { data: null, status: 502, error: `Could not reach The Blue Alliance: ${scrub(err)}` }
  }

  if (!res.ok) {
    // The upstream status is passed along but the upstream *body* is not: an
    // error page from an API we authenticate to is exactly the sort of text
    // that can quote a credential back at you.
    logSafe('[tba]', path, '->', String(res.status))
    if (res.status === 401) {
      return { data: null, status: 502, error: 'The Blue Alliance rejected our API key.' }
    }
    if (res.status === 404) return { data: null, status: 404, error: 'Not found on The Blue Alliance.' }
    return { data: null, status: 502, error: `The Blue Alliance returned ${res.status}.` }
  }

  try {
    return { data: (await res.json()) as T, status: 200 }
  } catch {
    return { data: null, status: 502, error: 'The Blue Alliance returned something unreadable.' }
  }
}

// --- parameter validation ----------------------------------------------------
// Each of these is the only thing standing between a caller-supplied value and a
// URL we sign with our key, so they are strict rather than forgiving.

function asYear(v: unknown): number | null {
  const n = Number(v)
  return Number.isInteger(n) && n >= 1992 && n <= 2100 ? n : null
}

function asEventKey(v: unknown): string | null {
  const s = String(v ?? '').trim().toLowerCase()
  return /^\d{4}[a-z0-9]{1,20}$/.test(s) ? s : null
}

function asTeamNumber(v: unknown): number | null {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 && n < 100000 ? n : null
}

// --- row mapping -------------------------------------------------------------

interface TbaEvent {
  key: string
  year: number
  name: string
  short_name?: string | null
  event_type?: number | null
  event_type_string?: string | null
  city?: string | null
  state_prov?: string | null
  country?: string | null
  start_date?: string | null
  end_date?: string | null
  week?: number | null
}

// public.events.event_type is text, TBA's `event_type` is an integer code with a
// separate human string. The string is what a mentor reading the table wants;
// the code is meaningless without TBA's lookup table.
function eventRow(e: TbaEvent, now: string) {
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

interface TbaTeam {
  team_number: number
  nickname?: string | null
  name?: string | null
  city?: string | null
  state_prov?: string | null
  country?: string | null
  rookie_year?: number | null
}

function teamRow(t: TbaTeam, eventKey: string, now: string) {
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

// Same tag-stripping fetch-tba.mjs does: TBA's status strings are HTML fragments
// with <b> and <a> in them, and they end up rendered as plain text here.
const strip = (html?: string | null) =>
  (html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

const teamKey = (n: number) => `frc${n}`
const freshEnough = (iso: string | null | undefined, ttl: number) =>
  Boolean(iso) && Date.now() - new Date(iso as string).getTime() < ttl * 1000

// -----------------------------------------------------------------------------
// Actions
// -----------------------------------------------------------------------------

// The service client is used for the cache writes only. A member has no INSERT
// grant on public.events (0005 puts that at lead+), and a member refreshing the
// schedule should not need to be a lead — so the write happens as the service
// role while every *read* below still goes through the caller's own client.
type Db = ReturnType<typeof serviceClient>

async function actionEvents(req: Request, db: Db, params: Record<string, unknown>, force: boolean) {
  const year = asYear(params.year)
  if (!year) return fail(req, 'year must be a season year, e.g. 2026.')

  if (!force) {
    const { data: cached } = await db
      .from('events')
      .select('*')
      .eq('year', year)
      .order('start_date', { ascending: true })
    const newest = cached?.reduce<string | null>(
      (max, r) => (!max || r.synced_at > max ? r.synced_at : max),
      null
    )
    if (cached?.length && freshEnough(newest, TTL.events)) {
      return ok(req, { events: cached, cached: true, synced_at: newest })
    }
  }

  // The full endpoint, not /simple. Event_Simple omits `short_name`, `week`, and
  // the event-type string — all three are columns on public.events, and caching
  // from /simple would write nulls over values a previous full fetch had filled
  // in. A season's event list is cached for half a day, so the extra payload is
  // paid once and the columns stay populated.
  const res = await tbaGet<TbaEvent[]>(`/events/${year}`)
  if (!res.data) return fail(req, res.error ?? 'Upstream failed.', res.status)

  const now = new Date().toISOString()
  const rows = res.data.map((e) => eventRow(e, now))
  const { error } = await db.from('events').upsert(rows, { onConflict: 'key' })
  // A failed cache write is not a failed request — the caller asked for events
  // and we have events. It is logged so a permanently broken cache is visible
  // rather than merely slow.
  if (error) logSafe('[tba] events cache write failed:', error.message)

  rows.sort((a, b) => (a.start_date ?? '').localeCompare(b.start_date ?? ''))
  return ok(req, { events: rows, cached: false, synced_at: now })
}

// event_teams has an FK onto events(key). Upserting teams for an event we have
// never cached fails on that constraint, which reads as a mystifying error at
// exactly the moment somebody is trying to scout a new event — so the parent
// row is ensured first.
async function ensureEvent(db: Db, eventKey: string): Promise<string | null> {
  const { data: existing } = await db.from('events').select('key').eq('key', eventKey).maybeSingle()
  if (existing) return null

  // The full /event/{key} rather than /simple: /simple omits `week` and the
  // event-type string, and both are columns we have.
  const res = await tbaGet<TbaEvent>(`/event/${eventKey}`)
  if (!res.data) return res.error ?? 'Unknown event.'

  const { error } = await db
    .from('events')
    .upsert([eventRow(res.data, new Date().toISOString())], { onConflict: 'key' })
  return error ? error.message : null
}

async function actionEventTeams(req: Request, db: Db, params: Record<string, unknown>, force: boolean) {
  const eventKey = asEventKey(params.eventKey)
  if (!eventKey) return fail(req, 'eventKey must look like 2026casd.')

  if (!force) {
    const { data: cached } = await db
      .from('event_teams')
      .select('*')
      .eq('event_key', eventKey)
      .order('team_number', { ascending: true })
    const newest = cached?.reduce<string | null>(
      (max, r) => (!max || r.synced_at > max ? r.synced_at : max),
      null
    )
    if (cached?.length && freshEnough(newest, TTL.eventTeams)) {
      return ok(req, { teams: cached, cached: true, synced_at: newest })
    }
  }

  const parentErr = await ensureEvent(db, eventKey)
  if (parentErr) return fail(req, parentErr, 502)

  // The full team endpoint, not /simple, because /simple omits rookie_year and
  // that is a column on event_teams.
  const res = await tbaGet<TbaTeam[]>(`/event/${eventKey}/teams`)
  if (!res.data) return fail(req, res.error ?? 'Upstream failed.', res.status)

  const now = new Date().toISOString()
  const rows = res.data.map((t) => teamRow(t, eventKey, now))
  if (rows.length) {
    const { error } = await db.from('event_teams').upsert(rows, { onConflict: 'event_key,team_number' })
    if (error) logSafe('[tba] event_teams cache write failed:', error.message)
  }

  rows.sort((a, b) => a.team_number - b.team_number)
  return ok(req, { teams: rows, cached: false, synced_at: now })
}

interface TbaMatch {
  key: string
  comp_level: string
  set_number: number
  match_number: number
  winning_alliance?: string
  predicted_time?: number | null
  actual_time?: number | null
  time?: number | null
  alliances?: {
    red?: { score?: number; team_keys?: string[] }
    blue?: { score?: number; team_keys?: string[] }
  }
}

const LEVEL_ORDER: Record<string, number> = { qm: 0, ef: 1, qf: 2, sf: 3, f: 4 }

// No Postgres table mirrors the match schedule, so this one is memo-cached in
// the isolate with a short TTL and nothing more. That is the honest ceiling: an
// in-memory cache in a function that scales out is best-effort by construction.
// A two-minute window is short enough that a live score is never badly wrong and
// long enough to absorb thirty scouts opening the schedule at once.
async function actionEventMatches(req: Request, params: Record<string, unknown>, force: boolean) {
  const eventKey = asEventKey(params.eventKey)
  if (!eventKey) return fail(req, 'eventKey must look like 2026casd.')

  const cacheKey = `matches:${eventKey}`
  if (!force) {
    const hit = memoGet<unknown>(cacheKey, TTL.matches)
    if (hit) return ok(req, { matches: hit, cached: true })
  }

  const res = await tbaGet<TbaMatch[]>(`/event/${eventKey}/matches/simple`)
  if (!res.data) return fail(req, res.error ?? 'Upstream failed.', res.status)

  // Flattened to what "which match am I watching" actually needs. Team keys are
  // reduced to numbers because every other table in this schema keys on the
  // integer, and leaving both forms in circulation invites a join that silently
  // matches nothing.
  const matches = res.data
    .map((m) => ({
      key: m.key,
      comp_level: m.comp_level,
      set_number: m.set_number,
      match_number: m.match_number,
      label:
        (m.comp_level === 'qm' ? 'Qual ' : m.comp_level.toUpperCase() + ' ') + m.match_number,
      red: (m.alliances?.red?.team_keys ?? []).map((k) => Number(k.replace('frc', ''))),
      blue: (m.alliances?.blue?.team_keys ?? []).map((k) => Number(k.replace('frc', ''))),
      red_score: m.alliances?.red?.score ?? null,
      blue_score: m.alliances?.blue?.score ?? null,
      winning_alliance: m.winning_alliance || null,
      // TBA gives epoch seconds; ISO is what every timestamp in this project is.
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
  return ok(req, { matches, cached: false })
}

interface TbaStatus {
  qual?: {
    num_teams?: number
    ranking?: { rank?: number; record?: { wins: number; losses: number; ties: number } | null }
  }
  overall_status_str?: string
  playoff?: { status?: string; level?: string } | null
}

// Feeds the "they have already played N events, here is what we know" line. The
// count of *completed* events is the part that matters: a team with three events
// behind them and one rank is a different read from a team with one.
async function actionTeamHistory(
  req: Request,
  db: Db,
  params: Record<string, unknown>,
  force: boolean
) {
  const teamNumber = asTeamNumber(params.teamNumber)
  const year = asYear(params.year)
  if (!teamNumber) return fail(req, 'teamNumber must be a positive integer.')
  if (!year) return fail(req, 'year must be a season year, e.g. 2026.')

  const cacheKey = `history:${teamNumber}:${year}`
  if (!force) {
    const hit = memoGet<unknown>(cacheKey, TTL.teamHistory)
    if (hit) return ok(req, hit)
  }

  // Full events again rather than /simple, for the same reason as actionEvents:
  // these rows are written straight into the events cache below, and /simple
  // would blank out `week` and `short_name` for any event already cached.
  const evRes = await tbaGet<TbaEvent[]>(`/team/${teamKey(teamNumber)}/events/${year}`)
  if (!evRes.data) return fail(req, evRes.error ?? 'Upstream failed.', evRes.status)

  // Statuses are best-effort: a team with no completed matches has no status
  // object at all, and that must read as "no data yet" rather than as an error.
  const stRes = await tbaGet<Record<string, TbaStatus | null>>(
    `/team/${teamKey(teamNumber)}/events/${year}/statuses`
  )
  const statuses = stRes.data ?? {}

  const events = [...evRes.data]
    .sort((a, b) => (a.start_date ?? '').localeCompare(b.start_date ?? ''))
    .map((e) => {
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
        // The presence of a qual ranking is the signal that they actually
        // played, rather than merely being registered for a future event.
        played: Boolean(s.qual?.ranking?.rank),
      }
    })

  // These are real event rows and we are already holding them, so the events
  // cache gets populated as a side effect. Costs nothing, and means the next
  // caller asking for this event's teams does not need the ensureEvent round
  // trip above.
  const now = new Date().toISOString()
  const { error } = await db
    .from('events')
    .upsert(evRes.data.map((e) => eventRow(e, now)), { onConflict: 'key' })
  if (error) logSafe('[tba] team_history event cache write failed:', error.message)

  const payload = {
    team_number: teamNumber,
    year,
    events,
    events_registered: events.length,
    events_played: events.filter((e) => e.played).length,
    cached: false,
  }
  memoSet(cacheKey, { ...payload, cached: true })
  return ok(req, payload)
}

// -----------------------------------------------------------------------------

Deno.serve(async (req) => {
  const pre = preflight(req)
  if (pre) return pre
  if (req.method !== 'POST') return fail(req, 'Use POST.', 405)

  // member, not viewer: alumni and parents sit at `viewer` and have no business
  // spending the team's TBA quota. Matches the read floor 0005 puts on the two
  // cache tables this writes.
  const auth = await requireCaller(req, 'member')
  if (!auth.ok) return auth.response

  const parsed = await readJsonBody(req, MAX_BODY_BYTES)
  if ('error' in parsed) return fail(req, parsed.error, /too large/.test(parsed.error) ? 413 : 400)

  const { action, force, ...params } = parsed.body as Record<string, unknown>
  const forced = force === true

  try {
    // Inside the try: serviceClient() throws when the service-role key is
    // missing from the environment, and an uncaught throw here would return a
    // bare 500 with no CORS headers — which the browser reports as a network
    // error, hiding the actual (very fixable) misconfiguration.
    const db = serviceClient()

    switch (action) {
      case 'events':
        return await actionEvents(req, db, params, forced)
      case 'event_teams':
        return await actionEventTeams(req, db, params, forced)
      case 'event_matches':
        return await actionEventMatches(req, params, forced)
      case 'team_history':
        return await actionTeamHistory(req, db, params, forced)
      default:
        // The whitelist is the security control, so an unknown action is a hard
        // 400 rather than anything resembling a fallthrough.
        return fail(
          req,
          'Unknown action. Expected one of: events, event_teams, event_matches, team_history.'
        )
    }
  } catch (err) {
    logSafe('[tba] unhandled:', err instanceof Error ? err.message : String(err))
    return fail(req, 'The Blue Alliance lookup failed unexpectedly.', 500)
  }
})
