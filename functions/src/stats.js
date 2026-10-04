// The maths behind team_event_stats.
//
// Pure: no Firebase imports, so `node --test` can check it without an emulator.
// It reproduces the SQL view it replaced, including the two fixes that view
// needed the hard way:
//
// - Scoring is match-only. A pit crew's estimate of what a robot scores is not a
//   scored match, and averaging the two together made every team look like its
//   own sales pitch. The pit figure is reported separately as `pit_estimate`.
// - One bad answer is skipped, not fatal. Forms are free-form, so a `total_score`
//   of "lots" does arrive; it must cost that one entry its place in the average,
//   not break the statistics for the whole event.

/** A number, or a string that is plainly a number; anything else is null. */
export function tryNumeric(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && /^\s*-?[0-9]+(\.[0-9]+)?\s*$/.test(v)) return Number(v.trim())
  return null
}

/** true/false, or 'true'/'yes'/'false'/'no' in any case; anything else is null. */
export function tryBool(v) {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (s === 'true' || s === 'yes') return true
    if (s === 'false' || s === 'no') return false
  }
  return null
}

// A stored time in milliseconds. Firestore hands back a Timestamp (toMillis), the
// tests pass ISO strings and Dates; all three are the same instant.
function toMillis(v) {
  if (v == null) return null
  if (typeof v.toMillis === 'function') return v.toMillis()
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime()
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : t
  }
  return null
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

/**
 * The sample standard deviation (n - 1), null under two values.
 *
 * Sample, not population: a handful of scouted matches is a sample of how a team
 * plays, and the population formula understates the spread exactly when the
 * sample is small. With one match there is no spread to report, and null says
 * that; 0 would claim perfect consistency.
 */
export function sampleStdDev(xs) {
  if (xs.length < 2) return null
  const m = mean(xs)
  return Math.sqrt(xs.reduce((sum, x) => sum + (x - m) ** 2, 0) / (xs.length - 1))
}

const distinct = (values) => new Set(values.filter((v) => v != null)).size

/**
 * The team_event_stats document for one team at one event, without
 * `updated_at`. Null when the team has no entries and no photos, which is when
 * the document should not exist.
 *
 * @param {string} eventKey
 * @param {number} teamNumber
 * @param {Array<object>} entries  that team's scout_entries at that event
 * @param {number} photos          how many robot_photos it has there
 */
export function computeTeamEventStats(eventKey, teamNumber, entries, photos = 0) {
  if (!entries.length && !photos) return null

  const matches = entries.filter((e) => e.kind === 'match')
  const pits = entries.filter((e) => e.kind === 'pit')
  const strategy = entries.filter((e) => e.kind === 'strategy')

  const score = (e) => tryNumeric(e.data?.total_score)
  const scores = matches.map(score).filter((s) => s != null)
  const pitScores = pits.map(score).filter((s) => s != null)

  const seen = entries.map((e) => toMillis(e.recorded_at)).filter((t) => t != null)

  return {
    event_key: eventKey,
    team_number: teamNumber,
    matches_scouted: matches.length,
    pit_visits: pits.length,
    notes_logged: strategy.length,
    scouts_contributing: distinct(matches.map((e) => e.scout_id)),
    scouts: distinct(entries.map((e) => e.scout_id)),
    last_seen: seen.length ? new Date(Math.max(...seen)) : null,
    // The true denominator of avg_score: matches whose score could be read.
    scored_matches: scores.length,
    avg_score: mean(scores),
    score_stddev: sampleStdDev(scores),
    min_score: scores.length ? Math.min(...scores) : null,
    max_score: scores.length ? Math.max(...scores) : null,
    pit_estimate: mean(pitScores),
    breakdowns: matches.filter((e) => tryBool(e.data?.broke) === true).length,
    no_shows: matches.filter((e) => tryBool(e.data?.no_show) === true).length,
    photos,
  }
}

// An event key ends up inside a document id, so one that could not be a path
// segment is not a pair to keep statistics for.
const usableEventKey = (k) => typeof k === 'string' && k.length > 0 && k.length <= 64 && !/[/\s]/.test(k) && !/^\.+$/.test(k)

/**
 * The (event, team) pairs a change touches: the one the document was about
 * before, and the one it is about after. An edit that moves an entry to another
 * team has to refresh both, or the old team keeps a match it no longer has.
 * A document with no event has no statistics, so it names no pair.
 */
export function affectedPairs(before, after) {
  const pairs = new Map()
  for (const d of [before, after]) {
    if (!d) continue
    if (!usableEventKey(d.event_key)) continue
    if (!Number.isInteger(d.team_number) || d.team_number <= 0) continue
    pairs.set(`${d.event_key}_${d.team_number}`, { eventKey: d.event_key, teamNumber: d.team_number })
  }
  return [...pairs.values()]
}
