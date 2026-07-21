// =============================================================================
// The maths behind the comparison.
//
// Split out of the component because this is the part that has to be RIGHT.
// The rest of the panel is layout; this file is what decides whether a student
// tells a drive team "take 4021, they're better" eight minutes before alliance
// selection. It is written to refuse that sentence far more often than it says
// it, because the failure mode is asymmetric: a comparison that declines to
// pick costs one conversation, and a comparison that picks wrongly costs the
// afternoon.
//
// THREE RULES, and every function below exists to serve one of them.
//
// 1. A DIFFERENCE SMALLER THAN ITS OWN UNCERTAINTY IS NOT A DIFFERENCE.
//    Two teams four matches apart on a 0.3-point average have not been
//    separated by the data; they have been separated by which matches happened
//    to get scouted. Every scoreable row therefore computes the standard error
//    of the gap between the top two and refuses to crown anyone unless the gap
//    clears SEPARATION times that error.
//
//    This is deliberately NOT a p-value. A p-value from scouting data would be
//    a lie with a decimal point on it — the samples are not random, the scouts
//    are not interchangeable instruments, and n is usually under ten. What is
//    computed here is an effect size: "the gap is 1.4x the wobble in the gap",
//    which is honest about being a rule of thumb and is reported to the user in
//    exactly those terms.
//
// 2. SAMPLE SIZE IS PART OF EVERY NUMBER, NOT A FOOTNOTE.
//    Nothing is decided from fewer than MIN_N observations, no matter how large
//    the gap looks. Two matches cannot beat twelve.
//
// 3. WHAT WE HAVE NOT MEASURED IS NOT A PROPERTY OF THE TEAM.
//    "Matches scouted", "photos taken", "pit done" describe OUR effort, not
//    their robot. They are marked `scored: false` and never contribute to an
//    overall verdict. A team we happened to watch more is not a better team,
//    and a comparison that quietly rewards them for it is worse than useless.
// =============================================================================

/**
 * Below this many observations, a row is not decided at all — the leader is
 * named as "ahead on the raw number" and nothing is crowned.
 *
 * Three is not a statistically respectable floor; it is the lowest number at
 * which a spread estimate means anything whatsoever. It is a floor on what is
 * worth arithmetic, not a threshold of confidence.
 */
export const MIN_N = 3

/**
 * Below this, an overall winner is downgraded to provisional. A team leading on
 * four matches is a lead worth going and watching, not a lead worth picking on.
 */
export const CONFIDENT_N = 5

/**
 * How many standard errors the gap must clear before a row is called.
 *
 * Two is the conventional rule-of-thumb line, and it is used here for exactly
 * that reason — it is a widely understood default rather than a threshold tuned
 * until this data set produced satisfying answers.
 */
export const SEPARATION = 2

/** Postgres numerics can arrive as strings. Anything unusable becomes null. */
export function num(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * `team_event_stats.score_stddev` is `stddev_pop` — it divides by n, not n-1.
 *
 * That is the right choice for describing a set you have all of, and the wrong
 * one for estimating the spread of a robot's performance from a handful of
 * matches, which is what we are doing. At n = 3 the population form understates
 * the true spread by about 22%, and understating spread is precisely the error
 * that makes noise look like a winner. Corrected on the way in.
 */
export function toSampleSd(popSd, n) {
  const s = num(popSd)
  if (s == null || !Number.isFinite(n) || n < 2) return null
  return s * Math.sqrt(n / (n - 1))
}

/** Mean, sample SD, min and max of whatever numbers are actually present. */
export function describe(values) {
  const xs = values.map(num).filter((v) => v != null)
  const n = xs.length
  if (!n) return { n: 0, mean: null, sd: null, min: null, max: null }
  const mean = xs.reduce((a, b) => a + b, 0) / n
  const sd =
    n < 2 ? null : Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1))
  return { n, mean, sd, min: Math.min(...xs), max: Math.max(...xs) }
}

/**
 * Variance of a proportion, Agresti–Coull adjusted.
 *
 * The naive formula p(1-p)/n returns ZERO variance for a team with zero
 * breakdowns, whatever n is — which would let "0 breakdowns in 2 matches" beat
 * "3 in 15" with infinite confidence. That is the single most dangerous number
 * this panel could produce, because breakdowns are the stat people act on
 * hardest. Adding two successes and two failures before estimating keeps the
 * zero cell honest: 0-for-2 comes out uncertain, which it is.
 */
function rateVariance(x, n) {
  if (!Number.isFinite(n) || n <= 0) return null
  const nAdj = n + 2
  const p = (x + 1) / nAdj
  return (p * (1 - p)) / nAdj
}

/**
 * Standard error of the gap between two cells.
 *
 * Returns null when the shape of the metric does not support one — a bare count
 * has no spread, and a row whose uncertainty cannot be estimated is never
 * allowed to crown anybody.
 */
function gapStandardError(a, b, kind) {
  if (kind === 'rate') {
    const va = rateVariance(a.count ?? 0, a.n)
    const vb = rateVariance(b.count ?? 0, b.n)
    if (va == null || vb == null) return null
    return Math.sqrt(va + vb)
  }

  if (kind === 'spread') {
    // Comparing two standard deviations. The standard error of an SD is
    // approximately s / sqrt(2(n-1)); n >= MIN_N is already guaranteed by the
    // caller, so the denominator cannot vanish.
    const va = a.value ** 2 / (2 * (a.n - 1))
    const vb = b.value ** 2 / (2 * (b.n - 1))
    return Math.sqrt(va + vb)
  }

  // Two means, unequal variances, unequal n — the Welch form.
  if (a.sd == null || b.sd == null) return null
  return Math.sqrt(a.sd ** 2 / a.n + b.sd ** 2 / b.n)
}

/** Better-first, with the better-evidenced column winning exact ties. */
function rank(cells, direction) {
  const sign = direction === 'lower' ? 1 : -1
  return [...cells].sort((x, y) => {
    const d = sign * (x.value - y.value)
    return d !== 0 ? d : (y.n ?? 0) - (x.n ?? 0)
  })
}

function extent(cells) {
  const xs = cells.map((c) => c.value).filter((v) => v != null && Number.isFinite(v))
  if (!xs.length) return { min: null, max: null }
  return { min: Math.min(...xs), max: Math.max(...xs) }
}

/**
 * Judge one metric row.
 *
 * @param cells [{ team, value, n, sd, count }] — one per compared team.
 *              `sd` is the sample SD for kind 'mean'; `count` is the numerator
 *              for kind 'rate'; `value` is the SD itself for kind 'spread'.
 * @param spec  { direction: 'higher'|'lower', kind: 'mean'|'rate'|'spread'|'count',
 *                scored: boolean }
 *
 * @returns {
 *   verdict: 'decisive' | 'close' | 'thin' | 'tie' | 'context' | 'none',
 *   leader,      // ahead on the raw number. NOT an endorsement.
 *   winner,      // crowned, and the only thing that counts toward the overall.
 *   gap, uncertainty, separation, range, thinTeams
 * }
 *
 * `leader` and `winner` are separate on purpose. Every verdict except 'tie' and
 * 'none' names who is in front, because hiding that would be its own dishonesty
 * — the numbers are right there on screen. Only 'decisive' fills in `winner`.
 */
export function judgeRow(cells, { direction = 'higher', kind = 'mean', scored = true } = {}) {
  const range = extent(cells)
  const base = {
    verdict: 'none',
    leader: null,
    winner: null,
    gap: null,
    uncertainty: null,
    separation: null,
    thinTeams: [],
    range,
  }

  const usable = cells.filter((c) => c.value != null && Number.isFinite(c.value))

  // Context rows are shown, ordered, and never scored. See rule 3 up top.
  if (!scored || kind === 'count') {
    return { ...base, verdict: 'context' }
  }
  if (usable.length < 2) return base

  const ranked = rank(usable, direction)
  const [best, second] = ranked
  const gap = Math.abs(best.value - second.value)

  if (gap === 0) return { ...base, verdict: 'tie', gap: 0 }

  // Rule 2, and it comes before any arithmetic: a gap computed from two matches
  // is not a small effect, it is an unknown one, and running it through a
  // standard error would dress that up as a measurement.
  const thinTeams = [best, second].filter((c) => (c.n ?? 0) < MIN_N).map((c) => c.team)
  if (thinTeams.length) {
    return { ...base, verdict: 'thin', leader: best.team, gap, thinTeams }
  }

  const uncertainty = gapStandardError(best, second, kind)
  if (uncertainty == null) return { ...base, verdict: 'close', leader: best.team, gap }

  // uncertainty === 0 means both columns were perfectly flat across at least
  // MIN_N observations each. With a non-zero gap that genuinely is a clean
  // separation, so it is allowed through rather than treated as a divide-by-zero
  // to be defended against.
  const separation = uncertainty > 0 ? gap / uncertainty : Infinity

  return separation >= SEPARATION
    ? { ...base, verdict: 'decisive', leader: best.team, winner: best.team, gap, uncertainty, separation }
    : { ...base, verdict: 'close', leader: best.team, gap, uncertainty, separation }
}

/**
 * The overall verdict, from the per-row ones.
 *
 * Counting decisive row wins rather than summing z-scores or weighting
 * categories, for one reason: a student has to be able to read the tally and
 * see where the answer came from. A weighted composite is more defensible in a
 * paper and completely unauditable in a pit, and an unauditable number is one
 * nobody can catch being wrong.
 *
 * Four conditions, all of which must hold:
 *   1. At least three categories were actually decided. Below that the teams
 *      simply have not been separated by anything.
 *   2. One team leads the tally outright.
 *   3. The lead is either two categories clear, or a clear majority (>= 60%) of
 *      everything that was decided. A 3-2 split is not a verdict.
 *   4. The leader has at least CONFIDENT_N observations. Failing only this
 *      returns 'provisional' — a real lead on a sample too thin to pick on.
 */
export function judgeOverall(rows, sampleSize) {
  const scorable = rows.filter((r) => r.spec.scored && r.judgment.verdict !== 'none')
  const decided = scorable.filter((r) => r.judgment.verdict === 'decisive')

  if (!scorable.length) {
    return {
      verdict: 'insufficient',
      winner: null,
      tally: [],
      decided: 0,
      scorable: 0,
      reason: 'Nothing here can be compared yet — no category has usable numbers for two teams.',
    }
  }

  const wins = new Map()
  for (const r of decided) {
    wins.set(r.judgment.winner, (wins.get(r.judgment.winner) ?? 0) + 1)
  }
  const tally = [...wins.entries()]
    .map(([team, count]) => ({ team, count }))
    .sort((a, b) => b.count - a.count)

  const shared = {
    tally,
    decided: decided.length,
    scorable: scorable.length,
  }

  if (decided.length < 3) {
    return {
      ...shared,
      verdict: 'too-close',
      winner: null,
      reason:
        `Only ${decided.length} of ${scorable.length} categories separated these teams by more ` +
        `than the noise in them. That is not enough to call an overall winner — the differences ` +
        `you can see in the table are mostly the sample talking.`,
    }
  }

  const [first, second] = tally
  if (!first || (second && first.count === second.count)) {
    return {
      ...shared,
      verdict: 'too-close',
      winner: null,
      reason: `${first?.count ?? 0} categories each. The data does not prefer either of them.`,
    }
  }

  const margin = first.count - (second?.count ?? 0)
  const share = first.count / decided.length
  if (margin < 2 && share < 0.6) {
    return {
      ...shared,
      verdict: 'too-close',
      winner: null,
      reason:
        `${first.team} leads ${first.count}–${second?.count ?? 0}, which is one category. ` +
        `A single-category lead across ${decided.length} decided categories flips on one more ` +
        `match being scouted.`,
    }
  }

  const n = sampleSize.get(first.team) ?? 0
  if (n < CONFIDENT_N) {
    return {
      ...shared,
      verdict: 'provisional',
      winner: first.team,
      reason:
        `${first.team} wins ${first.count} of ${decided.length} decided categories — but on ` +
        `${n} ${n === 1 ? 'match' : 'matches'}. That is a lead worth going to watch, not a lead ` +
        `worth picking on.`,
    }
  }

  return {
    ...shared,
    verdict: 'winner',
    winner: first.team,
    reason:
      `${first.team} wins ${first.count} of the ${decided.length} categories the data actually ` +
      `separates, on ${n} matches. The other ${scorable.length - decided.length} were too close ` +
      `to call.`,
  }
}

// --- dynamic fields ----------------------------------------------------------

/**
 * Keys the fixed rows already own. Aggregating them again as "form fields"
 * would put the same number on screen twice under two different names, which
 * reads as corroboration.
 */
export const RESERVED_KEYS = new Set(['total_score', 'broke', 'no_show'])

/**
 * Keys whose name says a higher number is worse.
 *
 * A GUESS, and treated as one everywhere it surfaces: the form schema
 * (migration 0005) records a field's type but never its polarity, so there is
 * no way to know from the data whether more `defense_played` is good. Every
 * dynamic row is therefore marked as assumed and can be flipped by the reader.
 *
 * Kept to words that are unambiguous in an FRC context. "Defense" is
 * deliberately absent — playing it is usually good, receiving it is usually
 * bad, and the key name rarely says which one it counted.
 */
const LOWER_IS_BETTER =
  /(foul|penalt|miss|drop|fail|broke|breakdown|tipp?ed|stuck|jam|dead|disabl|error|violat|card|died|lost)/i

export function guessDirection(key) {
  return LOWER_IS_BETTER.test(key) ? 'lower' : 'higher'
}

/** `auto_speaker_notes` -> `Auto speaker notes`, for keys the form no longer defines. */
export function prettifyKey(key) {
  const s = key.replace(/_/g, ' ').trim()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Roll a team's match entries up into per-key aggregates.
 *
 * Only `kind === 'match'` entries are passed in by the caller. Pit entries are
 * recorded once per team, and the mean of one observation is not a statistic —
 * putting it in the same table as a twelve-match average, formatted
 * identically, would invite exactly the comparison it cannot support.
 *
 * A key is numeric or boolean, never both. Strings and arrays (text, select,
 * multiselect) are skipped: they do not average, and a "most common answer"
 * column would be a different feature wearing this one's clothes.
 */
export function aggregateEntries(entries) {
  const numeric = new Map()
  const boolean = new Map()
  const mixed = new Set()

  for (const e of entries) {
    const data = e?.data
    if (!data || typeof data !== 'object') continue
    for (const [key, raw] of Object.entries(data)) {
      if (RESERVED_KEYS.has(key)) continue
      if (typeof raw === 'boolean') {
        if (numeric.has(key)) mixed.add(key)
        if (!boolean.has(key)) boolean.set(key, [])
        boolean.get(key).push(raw)
      } else if (typeof raw === 'number' && Number.isFinite(raw)) {
        if (boolean.has(key)) mixed.add(key)
        if (!numeric.has(key)) numeric.set(key, [])
        numeric.get(key).push(raw)
      }
    }
  }

  const out = new Map()
  for (const [key, values] of numeric) {
    if (mixed.has(key)) continue
    out.set(key, { kind: 'number', ...describe(values) })
  }
  for (const [key, values] of boolean) {
    if (mixed.has(key)) continue
    const count = values.filter(Boolean).length
    out.set(key, { kind: 'boolean', n: values.length, count, rate: count / values.length })
  }
  return { fields: out, mixed: [...mixed] }
}

// =============================================================================
// The model: what gets compared, and with what shape.
//
// Lives here rather than in the component because these are not layout choices.
// "Best single match is context, never scored" and "the score rows are backed by
// scoredN, not matches_scouted" are claims about the data, they are the claims
// most likely to be wrong, and keeping them next to the maths is what makes them
// reviewable as one thing instead of buried in JSX.
// =============================================================================

/** Columns thinner than this get visually held at arm's length by the view. */
export const THIN_N = MIN_N

export const fmt1 = (v) => (v == null ? '—' : v.toFixed(1))
export const fmtInt = (v) => (v == null ? '—' : String(Math.round(v)))
export const fmtPct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`)

// =============================================================================
// Column derivation
// =============================================================================

export function deriveColumn({ team, roster, stats, check, entries, loaded }) {
  const rows = entries ?? []
  const matchEntries = rows.filter((e) => e.kind === 'match')

  // The count that actually backs avg_score and score_stddev.
  //
  // `matches_scouted` counts entries where kind = 'match'. `avg_score` averages
  // (data->>'total_score')::numeric, and SQL's avg() skips nulls — so a match
  // entry where the scout never filled in a score is inside one number and
  // outside the other. They differ in real data, they differ in the direction
  // that flatters the average, and printing matches_scouted next to an average
  // computed from fewer rows is the quietest lie this panel could tell.
  const scoredN = rows.reduce((k, e) => k + (num(e?.data?.total_score) != null ? 1 : 0), 0)

  const matches = Number(stats?.matches_scouted ?? matchEntries.length) || 0
  const { fields } = aggregateEntries(matchEntries)

  return {
    team,
    nickname: roster?.nickname ?? null,
    loaded,
    matches,
    scoredN,
    scouts: Number(stats?.scouts_contributing ?? 0) || 0,
    lastSeen: stats?.last_seen ?? null,
    avg: num(stats?.avg_score),
    // Corrected from the view's population SD — see toSampleSd().
    sd: toSampleSd(stats?.score_stddev, scoredN),
    min: num(stats?.min_score),
    max: num(stats?.max_score),
    breakdowns: Number(stats?.breakdowns ?? 0) || 0,
    noShows: Number(stats?.no_shows ?? 0) || 0,
    photos: Number(check?.photos ?? 0) || 0,
    pitPasses: Number(check?.pit_passes ?? 0) || 0,
    fields,
    thin: matches > 0 && matches < THIN_N,
    light: matches >= THIN_N && matches < CONFIDENT_N,
    empty: matches === 0,
    unreliable: (Number(stats?.breakdowns ?? 0) || 0) > 0 || (Number(stats?.no_shows ?? 0) || 0) > 0,
  }
}

// =============================================================================
// Row construction
// =============================================================================

export function buildRows(columns, fieldMeta, flipped) {
  const rows = []

  const add = (row) => {
    rows.push({ ...row, judgment: judgeRow(row.cells, row.spec) })
  }

  // --- scoring --------------------------------------------------------------

  add({
    id: 'avg',
    group: 'Scoring',
    label: 'Average contribution',
    sub: 'mean score per match',
    spec: { direction: 'higher', kind: 'mean', scored: true },
    format: fmt1,
    cells: columns.map((c) => ({ team: c.team, value: c.avg, sd: c.sd, n: c.scoredN })),
  })

  const consistency = {
    id: 'consistency',
    group: 'Scoring',
    label: 'Consistency',
    sub: 'how much they vary match to match',
    help:
      'Spread of their match scores. A team that always scores 5 is usually a better partner ' +
      'than one alternating 0 and 10 — same average, completely different alliance.',
    spec: { direction: 'lower', kind: 'spread', scored: true },
    format: (v) => (v == null ? '—' : `±${v.toFixed(1)}`),
    cells: columns.map((c) => ({ team: c.team, value: c.sd, n: c.scoredN })),
  }
  // Raw spread is only comparable between teams scoring at the same level: a
  // robot averaging 5 has less room to vary than one averaging 40, and would
  // win this row for being small rather than for being reliable.
  const means = columns.map((c) => c.avg).filter((v) => v != null && v > 0)
  if (means.length > 1 && Math.max(...means) > Math.min(...means) * 2) {
    consistency.caveat =
      'These teams score at very different levels, so the smaller spread here may just be the ' +
      'smaller robot. Read it against each column’s own average.'
  }
  add(consistency)

  // Extremes are the most sample-dependent statistic on the page: watch a team
  // twice and you see a narrow band, watch them fifteen times and you have seen
  // their best day and their worst one. Comparing a 15-match maximum against a
  // 3-match maximum rewards having been scouted more. Shown, never scored.
  add({
    id: 'best',
    group: 'Scoring',
    label: 'Best single match',
    spec: { direction: 'higher', kind: 'count', scored: false },
    contextNote: 'Grows with the number of matches watched, so it favours well-scouted teams.',
    format: fmt1,
    cells: columns.map((c) => ({ team: c.team, value: c.max, n: c.scoredN })),
  })
  add({
    id: 'worst',
    group: 'Scoring',
    label: 'Worst single match',
    spec: { direction: 'higher', kind: 'count', scored: false },
    contextNote: 'Falls with the number of matches watched, for the same reason.',
    format: fmt1,
    cells: columns.map((c) => ({ team: c.team, value: c.min, n: c.scoredN })),
  })

  // --- reliability ----------------------------------------------------------

  add({
    id: 'breakdowns',
    group: 'Reliability',
    label: 'Breakdown rate',
    sub: 'matches where the robot broke',
    spec: { direction: 'lower', kind: 'rate', scored: true },
    format: fmtPct,
    detail: (cell) => (cell.n ? `${cell.count} of ${cell.n}` : null),
    cells: columns.map((c) => ({
      team: c.team,
      value: c.matches ? c.breakdowns / c.matches : null,
      count: c.breakdowns,
      n: c.matches,
    })),
  })
  add({
    id: 'noshows',
    group: 'Reliability',
    label: 'No-show rate',
    sub: 'matches they did not make',
    spec: { direction: 'lower', kind: 'rate', scored: true },
    format: fmtPct,
    detail: (cell) => (cell.n ? `${cell.count} of ${cell.n}` : null),
    cells: columns.map((c) => ({
      team: c.team,
      value: c.matches ? c.noShows / c.matches : null,
      count: c.noShows,
      n: c.matches,
    })),
  })

  // --- whatever this season's form actually asks -----------------------------
  //
  // The form is user-defined (scout_forms.fields, migration 0005) and changes
  // during build season, so there is no fixed metric list to hardcode. Every
  // numeric and boolean key that appears in the compared teams' match entries
  // becomes a row, labelled from the active form where it still defines the key.

  const keys = new Map()
  for (const c of columns) {
    for (const [key, agg] of c.fields) {
      if (!keys.has(key)) keys.set(key, agg.kind)
      else if (keys.get(key) !== agg.kind) keys.set(key, null) // classified two ways; drop it
    }
  }

  // Form order where the form still knows the key, then everything else by name.
  // A mentor's field ordering usually mirrors the order things happen in a
  // match, and preserving it is what makes the table skimmable in a pit.
  const order = new Map([...fieldMeta.keys()].map((k, i) => [k, i]))
  const dynamic = [...keys.entries()].filter(([, kind]) => kind != null)
  dynamic.sort((a, b) => {
    const ia = order.get(a[0]) ?? Number.MAX_SAFE_INTEGER
    const ib = order.get(b[0]) ?? Number.MAX_SAFE_INTEGER
    return ia !== ib ? ia - ib : a[0].localeCompare(b[0])
  })

  for (const [key, kind] of dynamic) {
    const meta = fieldMeta.get(key)
    const guessed = guessDirection(key)
    const direction = flipped.has(key) ? (guessed === 'higher' ? 'lower' : 'higher') : guessed

    add({
      id: key,
      group: 'From the scouting form',
      label: meta?.label ?? prettifyKey(key),
      sub: meta?.section ?? null,
      help: meta?.help ?? null,
      // The schema records a field's type but never whether more of it is good.
      // Guessed from the key name, marked as a guess, and flippable.
      assumed: true,
      orphan: !meta,
      spec: {
        direction,
        kind: kind === 'boolean' ? 'rate' : 'mean',
        scored: true,
      },
      format: kind === 'boolean' ? fmtPct : fmt1,
      detail:
        kind === 'boolean' ? (cell) => (cell.n ? `${cell.count} of ${cell.n}` : null) : null,
      cells: columns.map((c) => {
        const a = c.fields.get(key)
        if (!a) return { team: c.team, value: null, n: 0 }
        return kind === 'boolean'
          ? { team: c.team, value: a.rate, count: a.count, n: a.n }
          : { team: c.team, value: a.mean, sd: a.sd, n: a.n }
      }),
    })
  }

  // --- coverage -------------------------------------------------------------
  //
  // Every row below describes US. None of it is scored, and the group heading
  // says so — "we photographed them" is not a robot capability, and a table
  // that let it contribute to a verdict would reward teams for being convenient
  // to scout.

  add({
    id: 'matches',
    group: 'Coverage',
    label: 'Matches scouted',
    spec: { direction: 'higher', kind: 'count', scored: false },
    format: fmtInt,
    cells: columns.map((c) => ({ team: c.team, value: c.matches, n: c.matches })),
  })
  add({
    id: 'scouts',
    group: 'Coverage',
    label: 'Different scouts',
    sub: 'one person’s eye is one person’s bias',
    spec: { direction: 'higher', kind: 'count', scored: false },
    format: fmtInt,
    cells: columns.map((c) => ({ team: c.team, value: c.scouts, n: c.matches })),
  })
  add({
    id: 'pit',
    group: 'Coverage',
    label: 'Pit passes',
    spec: { direction: 'higher', kind: 'count', scored: false },
    format: fmtInt,
    cells: columns.map((c) => ({ team: c.team, value: c.pitPasses, n: c.matches })),
  })
  add({
    id: 'photos',
    group: 'Coverage',
    label: 'Robot photos',
    spec: { direction: 'higher', kind: 'count', scored: false },
    format: fmtInt,
    cells: columns.map((c) => ({ team: c.team, value: c.photos, n: c.matches })),
  })
  add({
    id: 'last',
    group: 'Coverage',
    label: 'Last seen',
    sub: 'stale data is a different robot',
    spec: { direction: 'higher', kind: 'count', scored: false },
    // Values here are timestamps. A magnitude bar drawn from epoch milliseconds
    // is full for every column no matter what the dates are, which looks like
    // agreement where there is none.
    noBar: true,
    format: (v) => (v == null ? '—' : new Date(v).toLocaleDateString()),
    cells: columns.map((c) => ({
      team: c.team,
      value: c.lastSeen ? Date.parse(c.lastSeen) : null,
      n: c.matches,
    })),
  })

  return rows
}
