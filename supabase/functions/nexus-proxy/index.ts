// =============================================================================
// nexus-proxy — Nexus for FRC live event status, without shipping the key.
//
// The sibling of tba-proxy, and it exists for the same one reason: an API key
// (NEXUS_KEY) must never reach a public static bundle. Read tba-proxy first —
// the security model here is identical and deliberately so: member+ only, a
// whitelist of actions rather than a forwarded path, upstream error *bodies*
// never relayed, and a short in-isolate cache so a pit full of scouts hitting
// "refresh" does not hammer Nexus over a saturated venue network.
//
// WHAT NEXUS IS, AND IS NOT. Nexus is the field/queuing system many events run.
// Its API answers "what is happening on the field right now" — which match is
// queuing, estimated vs scheduled times, announcements, parts requests. It is
// NOT a results source: final scores, OPR, rankings all come from TBA
// (tba-proxy). The two are complementary — TBA is the past, Nexus is the next
// ten minutes — and keeping them in separate functions keeps that boundary
// honest and the two keys isolated.
//
// PASS-THROUGH BY DESIGN. Unlike tba-proxy, nothing here is written into a
// Postgres cache table and nothing is reshaped into our schema. Live status has
// a useful life measured in seconds; persisting it would only invite a stale
// read. So this returns Nexus's own JSON under a stable envelope, plus a small
// best-effort `summary` for a status pill. The raw payload is always present, so
// a field this function guesses wrong about is fixed in the UI without a
// redeploy — the function's job is the key and the whitelist, not the schema.
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

const BASE = 'https://frc.nexus/api/v1'
const MAX_BODY_BYTES = 4_000 // an action name and an event key, nothing more

// Live status moves on the order of ~15-30s at the field. Thirty seconds keeps a
// scout's "now queuing" honest while absorbing thirty phones refreshing at once —
// the same tradeoff tba-proxy's `matches` TTL makes, for the same reason.
const TTL_STATUS = 30

// The auth header Nexus expects. Confirmed empirically: a request with this
// header and a bad key returns 403 (recognised, invalid) whereas every other
// header name — and no header — returns 401 (missing). 403-vs-401 is how we know
// this is the right name and not a guess.
const AUTH_HEADER = 'Nexus-Api-Key'

interface NexusResult<T> {
  data: T | null
  status: number
  error?: string
}

async function nexusGet<T>(path: string): Promise<NexusResult<T>> {
  const key = Deno.env.get('NEXUS_KEY')
  if (!key) {
    return {
      data: null,
      status: 500,
      error:
        'NEXUS_KEY is not configured on the server. A lead sets it with ' +
        '`supabase secrets set NEXUS_KEY=…` from their Nexus account.',
    }
  }

  let res: Response
  try {
    res = await fetch(BASE + path, { headers: { [AUTH_HEADER]: key } })
  } catch (err) {
    return { data: null, status: 502, error: `Could not reach Nexus: ${scrub(err)}` }
  }

  if (!res.ok) {
    // Status is passed along; the upstream *body* is not. An auth error page from
    // a service we send a key to is exactly the kind of text that can echo a
    // credential back — the same rule tba-proxy follows.
    logSafe('[nexus]', path, '->', String(res.status))
    if (res.status === 401 || res.status === 403) {
      return {
        data: null,
        status: 502,
        error: 'Nexus rejected our API key. A lead needs to check NEXUS_KEY.',
      }
    }
    if (res.status === 404) {
      return {
        data: null,
        status: 404,
        error: 'Nexus has no live data for that event (it may not be using Nexus).',
      }
    }
    if (res.status === 429) {
      return { data: null, status: 429, error: 'Nexus is rate-limiting us — try again shortly.' }
    }
    return { data: null, status: 502, error: `Nexus returned ${res.status}.` }
  }

  try {
    return { data: (await res.json()) as T, status: 200 }
  } catch {
    return { data: null, status: 502, error: 'Nexus returned something unreadable.' }
  }
}

// --- parameter validation ----------------------------------------------------
// The only thing between a caller-supplied value and a URL we sign with our key.
// Same shape tba-proxy enforces (`2026casd`), strict rather than forgiving.
function asEventKey(v: unknown): string | null {
  const s = String(v ?? '')
    .trim()
    .toLowerCase()
  return /^\d{4}[a-z0-9]{1,20}$/.test(s) ? s : null
}

// --- best-effort summary -----------------------------------------------------
//
// A tiny, defensive read of the fields a status pill needs. Everything here is
// optional-chained and falls back to null: Nexus's exact field names are
// confirmed against a live key at runtime, and the raw payload rides along
// regardless, so a wrong guess here degrades the pill, never the feature.
function summarise(payload: unknown): Record<string, unknown> {
  const p = (payload ?? {}) as Record<string, unknown>
  const matches = Array.isArray(p.matches) ? p.matches : []

  // "Now queuing" appears in the wild as either a top-level label or a per-match
  // status; try the cheap top-level form first, then fall back to scanning.
  let nowQueuing: unknown = p.nowQueuing ?? null
  if (!nowQueuing) {
    const q = matches.find((m) => {
      const s = String((m as Record<string, unknown>)?.status ?? '').toLowerCase()
      return s.includes('queue') || s.includes('queuing')
    })
    nowQueuing = (q as Record<string, unknown>)?.label ?? null
  }

  return {
    now_queuing: nowQueuing,
    match_count: matches.length,
    announcement_count: Array.isArray(p.announcements) ? p.announcements.length : 0,
    parts_request_count: Array.isArray(p.partsRequests) ? p.partsRequests.length : 0,
    data_as_of: p.dataAsOfTime ?? null,
  }
}

// -----------------------------------------------------------------------------

async function actionEventStatus(req: Request, params: Record<string, unknown>, force: boolean) {
  const eventKey = asEventKey(params.eventKey)
  if (!eventKey) return fail(req, 'eventKey must look like 2026casd.')

  const cacheKey = `status:${eventKey}`
  if (!force) {
    const hit = memoGet<unknown>(cacheKey, TTL_STATUS)
    if (hit) return ok(req, { ...(hit as object), cached: true })
  }

  const res = await nexusGet<unknown>(`/event/${eventKey}`)
  if (!res.data) return fail(req, res.error ?? 'Upstream failed.', res.status)

  const payload = {
    event_key: eventKey,
    // The raw Nexus object, untouched — the source of truth the UI reads.
    nexus: res.data,
    // A small normalised view for a status pill; see summarise().
    summary: summarise(res.data),
    cached: false,
  }
  memoSet(cacheKey, { ...payload, cached: true })
  return ok(req, payload)
}

Deno.serve(async (req) => {
  const pre = preflight(req)
  if (pre) return pre
  if (req.method !== 'POST') return fail(req, 'Use POST.', 405)

  // member, exactly like tba-proxy: alumni and parents sit at viewer and have no
  // business spending the team's Nexus quota.
  const auth = await requireCaller(req, 'member')
  if (!auth.ok) return auth.response

  const parsed = await readJsonBody(req, MAX_BODY_BYTES)
  if ('error' in parsed) return fail(req, parsed.error, /too large/.test(parsed.error) ? 413 : 400)

  const { action, force, ...params } = parsed.body as Record<string, unknown>
  const forced = force === true

  try {
    switch (action) {
      case 'event_status':
        return await actionEventStatus(req, params, forced)
      default:
        // The whitelist is the control, so an unknown action is a hard 400.
        return fail(req, 'Unknown action. Expected: event_status.')
    }
  } catch (err) {
    logSafe('[nexus] unhandled:', err instanceof Error ? err.message : String(err))
    return fail(req, 'The Nexus lookup failed unexpectedly.', 500)
  }
})
