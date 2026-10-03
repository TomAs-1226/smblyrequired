#!/usr/bin/env node
/**
 * The numbers Compare and Analytics put in front of a strategy lead.
 *
 * Each case pins a bug that produced a plausible, wrong number:
 *   - Compare re-corrected score_stddev from population to sample, but the view
 *     has been stddev_samp since 0009, so every spread came out ~22% too wide
 *     at n = 3;
 *   - Compare counted pit/strategy entries carrying total_score into the n
 *     behind a match-only average;
 *   - Catalyst scored a one-match team as perfectly consistent (null SD -> 0);
 *   - the predictor dropped empty slots and called two-vs-nobody ~99%, and its
 *     logistic put a one-sigma gap at ~86% where its own comment says 70-75%.
 */

import { deriveColumn } from '../../src/components/portal/compare/stats.js'
import { buildCatalyst, predictMatch } from '../../src/lib/catalyst.js'

let passed = 0
function check(name, cond, detail = '') {
  if (cond) {
    passed += 1
    console.log(`ok    ${name}`)
  } else {
    console.error(`FAIL  ${name} ${detail}`)
    process.exitCode = 1
  }
}

// --- Compare columns -----------------------------------------------------------

const stats = { matches_scouted: 3, scored_matches: 3, avg_score: 20, score_stddev: 5, scouts_contributing: 2 }
const col = deriveColumn({ team: 4414, stats, entries: [], loaded: true })
check('score_stddev (already stddev_samp) is used as-is', col.sd === 5, `sd=${col.sd}`)
check('n comes from the view’s scored_matches', col.scoredN === 3, `n=${col.scoredN}`)

const mixed = [
  { kind: 'match', data: { total_score: 10 } },
  { kind: 'match', data: { total_score: 12 } },
  { kind: 'pit', data: { total_score: 40 } },
  { kind: 'strategy', data: { total_score: 35 } },
]
const fallback = deriveColumn({ team: 4414, stats: { matches_scouted: 2 }, entries: mixed, loaded: true })
check('without the view count, only match entries are counted', fallback.scoredN === 2, `n=${fallback.scoredN}`)

// --- Catalyst -------------------------------------------------------------------

const cat = buildCatalyst({
  stats: [
    { team_number: 1, avg_score: 30, scored_matches: 1, score_stddev: null, max_score: 30, min_score: 30 },
    { team_number: 2, avg_score: 25, scored_matches: 6, score_stddev: 5, max_score: 32, min_score: 18 },
  ],
})
const one = cat.teams.find((t) => t.team_number === 1)
const six = cat.teams.find((t) => t.team_number === 2)
check('one match gives no consistency score', one.consistency == null, `got ${one.consistency}`)
check('six matches give a consistency score', six.consistency === 80, `got ${six.consistency}`)

// --- predictor ------------------------------------------------------------------

const base = { mean: 20, std: 10 }
const p = predictMatch([30, 30, null], [null, null, null], base)
check('empty slots count as field-average teams, not zero', p.blue === 60, `blue=${p.blue}`)
const sigma = 10 * Math.sqrt(3)
const one_sigma = predictMatch([20 + sigma, 20, 20], [20, 20, 20], base)
check('a one-alliance-sigma gap reads ~73%', one_sigma.redWinProb >= 70 && one_sigma.redWinProb <= 75, `got ${one_sigma.redWinProb}%`)

console.log(`\n${passed} analytics case(s) passed`)
if (process.exitCode) console.error('ANALYTICS TESTS FAILED')
