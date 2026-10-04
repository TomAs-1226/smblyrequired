import { NEXUS_KEY } from './config.js'
import { memoGet, memoSet } from './memo.js'
import { fail, logSafe, readBody, reason } from './safe.js'
import { asEventKey } from './validate.js'

// =============================================================================
// nexusProxy — Nexus for FRC live event status, without shipping the key.
//
// The sibling of tbaProxy, with the same security model on purpose: members and
// up, a whitelist of actions rather than a forwarded path, upstream error bodies
// never relayed, and a short memory cache so a pit full of scouts pressing
// "refresh" does not hammer Nexus over a saturated venue network.
//
// What Nexus is, and is not. Nexus is the queuing system many events run. It
// answers "what is happening on the field right now": which match is queuing,
// estimated against scheduled times, announcements, parts requests. It is not a
// results source; scores, OPR and rankings come from The Blue Alliance. TBA is
// the past, Nexus is the next ten minutes, and keeping them in separate
// functions keeps that boundary honest and the two keys apart.
//
// Pass-through by design. Nothing here is written to Firestore and nothing is
// reshaped: live status is useful for seconds, and storing it would only invite
// a stale read. The raw Nexus object is always returned, plus a small
// best-effort `summary` for a status pill, so a field this function guesses
// wrong about is fixed in the UI without a redeploy.
// =============================================================================

const BASE = 'https://frc.nexus/api/v1'
const MAX_BODY_BYTES = 4_000 // an action name and an event key, nothing more

// Live status moves every 15 to 30 seconds at the field. Thirty seconds keeps a
// scout's "now queuing" honest while absorbing thirty phones refreshing at once.
const TTL_STATUS = 30

// The header Nexus expects. A request with this header and a bad key is answered
// 403 (recognised, invalid); every other header name, and no header, is answered
// 401 (missing). That difference is how we know this is the right name.
const AUTH_HEADER = 'Nexus-Api-Key'

async function nexusGet(path, deps) {
  if (!deps.key) {
    return {
      data: null,
      status: 500,
      error:
        'NEXUS_KEY is not configured on the server. A lead sets it with ' +
        '`firebase functions:secrets:set NEXUS_KEY` from their Nexus account.',
    }
  }

  let res
  try {
    res = await deps.fetch(BASE + path, { headers: { [AUTH_HEADER]: deps.key } })
  } catch (err) {
    return { data: null, status: 502, error: `Could not reach Nexus: ${reason(err)}` }
  }

  if (!res.ok) {
    // The status is passed along; the upstream body is not. An auth error page
    // from a service we send a key to can echo that key back.
    logSafe('[nexus]', path, '->', String(res.status))
    if (res.status === 401 || res.status === 403) {
      return { data: null, status: 502, error: 'Nexus rejected our API key. A lead needs to check NEXUS_KEY.' }
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
    return { data: await res.json(), status: 200 }
  } catch {
    return { data: null, status: 502, error: 'Nexus returned something unreadable.' }
  }
}

// A small, defensive read of the fields a status pill needs. Everything falls
// back to null: the raw payload rides along regardless, so a wrong guess here
// degrades the pill, never the feature.
function summarise(payload) {
  const p = payload && typeof payload === 'object' ? payload : {}
  const matches = Array.isArray(p.matches) ? p.matches : []

  // "Now queuing" appears either as a top-level label or as a per-match status.
  // The cheap top-level form first, then a scan.
  let nowQueuing = p.nowQueuing ?? null
  if (!nowQueuing) {
    const q = matches.find((m) => String(m?.status ?? '').toLowerCase().includes('queu'))
    nowQueuing = q?.label ?? null
  }

  return {
    now_queuing: nowQueuing,
    match_count: matches.length,
    announcement_count: Array.isArray(p.announcements) ? p.announcements.length : 0,
    parts_request_count: Array.isArray(p.partsRequests) ? p.partsRequests.length : 0,
    data_as_of: p.dataAsOfTime ?? null,
  }
}

async function actionEventStatus(params, force, deps) {
  const eventKey = asEventKey(params.eventKey)
  if (!eventKey) throw fail('eventKey must look like 2026casd.')

  const cacheKey = `status:${eventKey}`
  if (!force) {
    const hit = memoGet(cacheKey, TTL_STATUS)
    if (hit) return { ...hit, cached: true }
  }

  const res = await nexusGet(`/event/${eventKey}`, deps)
  if (!res.data) throw fail(res.error ?? 'Upstream failed.', res.status)

  const payload = {
    event_key: eventKey,
    // The raw Nexus object, untouched: the source of truth the UI reads.
    nexus: res.data,
    summary: summarise(res.data),
    cached: false,
  }
  memoSet(cacheKey, { ...payload, cached: true })
  return payload
}

/** The callable's body, after the role check. `deps` lets the tests stand in for Nexus. */
export async function handleNexus(data, deps = {}) {
  const { action, force, ...params } = readBody(data, MAX_BODY_BYTES)
  const d = {
    fetch: deps.fetch ?? globalThis.fetch,
    // Read only when an upstream call is about to be made.
    get key() {
      return deps.key ?? NEXUS_KEY.value()
    },
  }

  switch (action) {
    case 'event_status':
      return actionEventStatus(params, force === true, d)
    default:
      // The whitelist is the control, so an unknown action is refused outright.
      throw fail('Unknown action. Expected: event_status.')
  }
}
