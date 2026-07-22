// =============================================================================
// Catalyst — the team's scouting statistics engine.
//
// A TRANSPARENT model over your own scouting data (enriched with TBA/Statbotics
// where available, never dependent on them). Not a black box: every number it
// produces is derived, right here, from inputs the UI also puts on screen. The
// point is a strategy lead can defend a pick with it, which means they have to be
// able to see why it says what it says.
//
// The one non-obvious idea is SHRINKAGE. A team scouted once, in a match where
// everything went right, should not top the board over a team with eight solid
// matches. So a team's rating is pulled toward the field average until it has
// enough of its own evidence to stand on — a standard Bayesian move, and the
// difference between a ranking that survives contact with a real event and one
// that gets a rookie scout laughed out of an alliance meeting.
// =============================================================================

// Prior strength for shrinkage, in "matches". A team's own average only outweighs
// the field average once it has more than this many scored matches. Four is a
// deliberate middle: high enough to tame a single fluke, low enough that a genuine
// powerhouse separates from the pack by qualification match six or so.
const K_PRIOR = 4

// PostgREST serialises `numeric` columns as strings, so every value that feeds a
// calculation goes through here first — `"42.5" * 1` is fine but `"42.5" + 1` is
// "42.51", and a rating engine that does the second is worse than none.
const num = (v) => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10)

// The event's own centre of gravity: the mean and spread of team averages, over
// teams that have actually played. Everything else is measured against this, so
// the engine is calibrated to THIS event rather than to a constant that assumes a
// scoring range from some other season.
export function fieldBaseline(stats = []) {
  const vals = stats
    .filter((s) => (num(s.scored_matches) ?? 0) > 0)
    .map((s) => num(s.avg_score))
    .filter((v) => v != null)
  if (!vals.length) return { mean: 0, std: 0, n: 0 }
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length
  const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length
  return { mean, std: Math.sqrt(variance), n: vals.length }
}

// Improving, sliding, or steady — from a team's match scores over time. Needs a
// real handful of matches before it will claim a direction; below that it says so
// rather than reading noise as a trend.
export function teamTrend(matchEntries = []) {
  const scores = matchEntries
    .map((e) => ({ t: new Date(e.recorded_at).getTime(), s: num(e.data?.total_score) }))
    .filter((x) => Number.isFinite(x.s) && Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t)

  const points = scores.map((x) => x.s)
  if (scores.length < 4) return { dir: 'flat', delta: 0, enough: false, points }

  const mid = Math.floor(scores.length / 2)
  const mean = (arr) => arr.reduce((a, b) => a + b.s, 0) / arr.length
  const delta = mean(scores.slice(mid)) - mean(scores.slice(0, mid))
  // A few points of drift is noise; only a real swing earns an arrow.
  const dir = delta > 3 ? 'up' : delta < -3 ? 'down' : 'flat'
  return { dir, delta: round1(delta), enough: true, points }
}

// Build the whole picture: one enriched row per team, ranked by Catalyst Rating.
export function buildCatalyst({ stats = [], entries = [] } = {}) {
  const base = fieldBaseline(stats)

  // Group match entries by team once, for trend lines.
  const byTeam = new Map()
  for (const e of entries) {
    if (e.kind && e.kind !== 'match') continue
    const arr = byTeam.get(e.team_number) ?? []
    arr.push(e)
    byTeam.set(e.team_number, arr)
  }

  const teams = stats.map((s) => {
    const avg = num(s.avg_score)
    const n = num(s.scored_matches) ?? 0
    const std = num(s.score_stddev) ?? 0

    // Catalyst Rating: shrinkage-adjusted expected points per match. With no
    // matches it is null (unrated) rather than a fabricated zero.
    const cr =
      n > 0 && avg != null ? (n * avg + K_PRIOR * base.mean) / (n + K_PRIOR) : null
    const crDelta = cr != null ? cr - base.mean : null

    // Consistency 0–100 from the coefficient of variation: a team that puts up
    // the same number every match is worth more to an alliance than one that
    // averages the same on a coin flip.
    const cv = avg && avg > 0 ? std / avg : null
    const consistency = cv == null ? null : Math.max(0, Math.min(100, Math.round(100 * (1 - cv))))

    const trend = teamTrend(byTeam.get(s.team_number) ?? [])
    const confidence = n >= 6 ? 'high' : n >= 3 ? 'medium' : n > 0 ? 'low' : 'none'

    return {
      team_number: s.team_number,
      cr: round1(cr),
      crDelta: round1(crDelta),
      avg: round1(avg),
      consistency,
      trend,
      ceiling: num(s.max_score),
      floor: num(s.min_score),
      samples: n,
      observers: num(s.scouts_contributing) ?? 0,
      noShows: num(s.no_shows) ?? 0,
      pitEstimate: num(s.pit_estimate),
      confidence,
    }
  })

  const ranked = [...teams].sort((a, b) => (b.cr ?? -Infinity) - (a.cr ?? -Infinity))
  ranked.forEach((t, i) => {
    t.rank = t.cr == null ? null : i + 1
  })

  return { base, teams: ranked }
}

// A handful of one-line reads a strategy lead actually asks between matches.
// Each returns a team row or null, so the UI can skip the ones an early event
// cannot answer yet.
export function insights(cat) {
  const rated = cat.teams.filter((t) => t.cr != null)
  if (!rated.length) return {}
  const bestBy = (fn) => rated.reduce((a, b) => (fn(b) > fn(a) ? b : a))
  return {
    topRated: rated[0], // already CR-sorted
    mostConsistent: rated.some((t) => t.consistency != null)
      ? bestBy((t) => t.consistency ?? -1)
      : null,
    biggestRiser: rated.some((t) => t.trend.enough)
      ? bestBy((t) => (t.trend.enough ? t.trend.delta : -Infinity))
      : null,
    // A "sleeper": a high ceiling that its rank does not reflect — someone who
    // can win you a match on their day and might slide in the draft.
    sleeper: rated.some((t) => t.ceiling != null)
      ? bestBy((t) => (t.ceiling ?? 0) - (t.cr ?? 0))
      : null,
  }
}

// Alliance prediction from Catalyst Ratings. Sum the three CRs a side; the win
// probability is a logistic on the gap, SCALED BY THE FIELD'S OWN SPREAD so it is
// calibrated to this event instead of a magic constant. Unrated teams contribute
// the field mean (an honest "we don't know them, assume average") rather than
// zero, which would slander a team the scouts simply haven't reached yet.
export function predictMatch(redCRs, blueCRs, base) {
  const fill = (arr) =>
    (arr ?? []).map((v) => (Number.isFinite(v) ? v : base.mean)).reduce((a, b) => a + b, 0)
  const red = fill(redCRs)
  const blue = fill(blueCRs)
  // A one-alliance-sigma gap (three teams, so ~std·√3) should read around 70–75%.
  const scale = Math.max(1, (base.std || 10) * Math.sqrt(3))
  const p = 1 / (1 + Math.exp(-(red - blue) / (0.55 * scale)))
  return {
    red: round1(red),
    blue: round1(blue),
    redWinProb: Math.round(p * 100),
    blueWinProb: Math.round((1 - p) * 100),
  }
}
