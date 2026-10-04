// Deterministic document ids.
//
// Firestore has no unique indexes, so the portal's "only one of these may exist"
// rules are carried by the document id: two writes for the same thing address the
// same document. firebase/firestore.rules recomputes each id from the document's
// own fields and refuses a mismatch, so these functions and the rules must agree
// — firebase/test/rules.test.mjs holds them to it. Pure: no Firebase imports, so
// Node tests and Cloud Functions can share the logic.

/** files/{id}: one row per stored object. */
export function fileId(bucket, path) {
  return `${bucket}~${String(path).replace(/\//g, '~')}`
}

/** The UTC calendar day of a time, as the integer YYYYMMDD the rules compare. */
export function recordedDay(date) {
  const d = date instanceof Date ? date : new Date(date)
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate()
}

const eventPart = (eventKey) => (eventKey == null ? 'none' : eventKey)

/**
 * scout_entries/{id}.
 *   match, with a match key   m:{event}:{team}:{match}:{scout}        one per scout per match
 *   match, no match key       u:{client_uuid}                         (no event chosen)
 *   pit / strategy            p:{event}:{team}:{kind}:{scout}:{day}:{slot}   slot 1 or 2: two a day
 */
export function entryId(e) {
  if (e.kind === 'match') {
    return e.match_key != null && e.scout_id != null
      ? `m:${eventPart(e.event_key)}:${e.team_number}:${e.match_key}:${e.scout_id}`
      : `u:${e.client_uuid}`
  }
  return `p:${eventPart(e.event_key)}:${e.team_number}:${e.kind}:${e.scout_id}:${e.recorded_day}:${e.slot}`
}

/** How many pit or strategy passes one scout may record on one team in one UTC day. */
export const PASSES_PER_DAY = 2

/** event_teams/{id} */
export const eventTeamId = (eventKey, teamNumber) => `${eventKey}_${teamNumber}`

/** team_event_stats/{id} */
export const teamStatId = (eventKey, teamNumber) => `${eventKey}_${teamNumber}`

/** scout_form_active/{id}: names the one active form for a season and kind. */
export const activeFormId = (season, kind) => `${season}_${kind}`

/** team_collaboration/{id}: one note per observer per team per event. */
export const collabId = (eventKey, teamNumber, observer) => `${eventPart(eventKey)}:${teamNumber}:${observer}`

/** Minutes after local midnight for 'HH:MM'. */
export function minutesOf(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number)
  return h * 60 + m
}

/**
 * A time zone's offset from UTC right now, in minutes, east positive
 * (America/Los_Angeles is -420 or -480). The rules have no time-zone database, so
 * the lead's browser records this beside the scouting window when it saves it.
 */
export function utcOffsetMinutes(timeZone, at = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at)
  const v = Object.fromEntries(parts.map((p) => [p.type, Number(p.value)]))
  const asUtc = Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute, v.second)
  return Math.round((asUtc - at.getTime()) / 60000)
}
