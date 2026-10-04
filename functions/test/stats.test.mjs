// The maths behind team_event_stats, with no emulator and no network:
//   node --test functions/test/stats.test.mjs
//
// The cases are the ones the SQL view was tested with (supabase/local-test), plus
// the three it got wrong before it got them right: a pit estimate leaking into
// the match average, a population SD where a sample SD belongs, and one
// unreadable answer breaking the statistics for a whole event.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as siteIds from '../../src/lib/ids.js'
import * as ids from '../src/ids.js'
import { affectedPairs, computeTeamEventStats, sampleStdDev, tryBool, tryNumeric } from '../src/stats.js'

const EVENT = '2026test'
let n = 0
const match = (data, extra = {}) => ({
  kind: 'match',
  event_key: EVENT,
  team_number: 4414,
  data,
  scout_id: 'scout-a',
  recorded_at: `2026-03-0${(n++ % 9) + 1}T12:00:00.000Z`,
  ...extra,
})
const pit = (data, extra = {}) => match(data, { kind: 'pit', ...extra })
const strategy = (data, extra = {}) => match(data, { kind: 'strategy', ...extra })
const stats = (entries, photos = 0) => computeTeamEventStats(EVENT, 4414, entries, photos)

test('tryNumeric reads numbers and numeric strings, and nothing else', () => {
  assert.equal(tryNumeric(12), 12)
  assert.equal(tryNumeric(12.5), 12.5)
  assert.equal(tryNumeric('12'), 12)
  assert.equal(tryNumeric('12.5'), 12.5)
  assert.equal(tryNumeric('  7 '), 7)
  assert.equal(tryNumeric('-3'), -3)
  assert.equal(tryNumeric(0), 0)
  for (const bad of ['lots', '', ' ', '12abc', '1e3', '.5', '5.', '1,000', null, undefined, true, {}, [], NaN, Infinity]) {
    assert.equal(tryNumeric(bad), null, `tryNumeric(${JSON.stringify(bad)})`)
  }
})

test("tryBool reads booleans and 'true' / 'yes' / 'false' / 'no' in any case", () => {
  for (const yes of [true, 'true', 'TRUE', 'yes', 'Yes', '  YES ']) assert.equal(tryBool(yes), true)
  for (const no of [false, 'false', 'no', ' No ']) assert.equal(tryBool(no), false)
  for (const other of ['maybe', '', 'y', '1', 1, 0, null, undefined, {}]) assert.equal(tryBool(other), null)
})

test('a sample standard deviation: null under two values, n - 1 above', () => {
  assert.equal(sampleStdDev([]), null)
  assert.equal(sampleStdDev([12]), null)
  // Population SD of 10 and 14 is 2; the sample SD is sqrt(8).
  assert.ok(Math.abs(sampleStdDev([10, 14]) - Math.sqrt(8)) < 1e-12)
  assert.equal(sampleStdDev([5, 5, 5]), 0)
})

test('aggregates a team: counts by kind, match-only scoring', () => {
  const s = stats([
    match({ total_score: 12 }),
    match({ total_score: 8 }, { scout_id: 'scout-b' }),
    match({ total_score: 10 }),
    pit({ total_score: 40 }),
    strategy({}),
  ])
  assert.equal(s.event_key, EVENT)
  assert.equal(s.team_number, 4414)
  assert.equal(s.matches_scouted, 3)
  assert.equal(s.pit_visits, 1)
  assert.equal(s.notes_logged, 1)
  assert.equal(s.scored_matches, 3)
  assert.equal(s.avg_score, 10)
  assert.equal(s.min_score, 8)
  assert.equal(s.max_score, 12)
  assert.equal(s.score_stddev, 2)
  assert.equal(s.pit_estimate, 40)
  assert.equal(s.photos, 0)
})

test('a pit estimate never leaks into the match average', () => {
  const before = stats([match({ total_score: 12 }), match({ total_score: 8 })])
  const after = stats([match({ total_score: 12 }), match({ total_score: 8 }), pit({ total_score: 100 }), strategy({ total_score: 500 })])
  assert.equal(after.avg_score, before.avg_score)
  assert.equal(after.scored_matches, 2)
  assert.equal(after.max_score, 12)
  assert.equal(after.score_stddev, before.score_stddev)
  assert.equal(after.pit_estimate, 100)
  // A team seen only in the pits has an estimate and no match statistics at all.
  const pitOnly = stats([pit({ total_score: '30' })])
  assert.equal(pitOnly.avg_score, null)
  assert.equal(pitOnly.scored_matches, 0)
  assert.equal(pitOnly.pit_estimate, 30)
})

test('a malformed answer is skipped, not fatal', () => {
  const before = stats([match({ total_score: 12 })])
  const after = stats([match({ total_score: 12 }), match({ total_score: 'lots', broke: 'maybe' })])
  assert.equal(after.avg_score, before.avg_score)
  assert.equal(after.scored_matches, before.scored_matches)
  assert.equal(after.matches_scouted, 2)
  assert.equal(after.breakdowns, 0)
  // No answers at all, and an entry with no data map, are the same case.
  const empty = stats([match({}), match(undefined), match(null)])
  assert.equal(empty.matches_scouted, 3)
  assert.equal(empty.scored_matches, 0)
  assert.equal(empty.avg_score, null)
  assert.equal(empty.min_score, null)
  assert.equal(empty.score_stddev, null)
})

test('scored_matches is the denominator of avg_score', () => {
  const s = stats([match({ total_score: 10 }), match({ total_score: '20' }), match({ total_score: 'n/a' })])
  assert.equal(s.matches_scouted, 3)
  assert.equal(s.scored_matches, 2)
  assert.equal(s.avg_score, 15)
})

test('the spread is null with one scored match, and a sample SD with more', () => {
  assert.equal(stats([match({ total_score: 12 })]).score_stddev, null)
  assert.equal(stats([match({ total_score: 12 }), match({ total_score: 'lots' })]).score_stddev, null)
  const two = stats([match({ total_score: 10 }), match({ total_score: 14 })])
  assert.ok(Math.abs(two.score_stddev - Math.sqrt(8)) < 1e-12)
})

test("breakdowns and no-shows count true, 'true' and 'yes', on matches only", () => {
  const s = stats([
    match({ broke: true, no_show: 'yes' }),
    match({ broke: 'yes' }),
    match({ broke: 'YES', no_show: 'True' }),
    match({ broke: 'true' }),
    match({ broke: 'no', no_show: false }),
    match({ broke: 'maybe', no_show: 1 }),
    pit({ broke: true, no_show: true }),
  ])
  assert.equal(s.breakdowns, 4)
  assert.equal(s.no_shows, 2)
})

test('scouts: distinct, match entries for one count and every kind for the other', () => {
  const s = stats([
    match({}, { scout_id: 'a' }),
    match({}, { scout_id: 'a' }),
    match({}, { scout_id: 'b' }),
    match({}, { scout_id: null }),
    pit({}, { scout_id: 'c' }),
    strategy({}, { scout_id: 'a' }),
  ])
  assert.equal(s.scouts_contributing, 2)
  assert.equal(s.scouts, 3)
})

test('last_seen is the newest recorded_at, whatever shape the time arrives in', () => {
  const newest = new Date('2026-03-20T18:30:00.000Z')
  const s = stats([
    match({}, { recorded_at: '2026-03-19T10:00:00.000Z' }),
    pit({}, { recorded_at: { toMillis: () => newest.getTime() } }),
    match({}, { recorded_at: new Date('2026-03-18T10:00:00.000Z') }),
    match({}, { recorded_at: null }),
  ])
  assert.deepEqual(s.last_seen, newest)
})

test('no entries and no photos is no document; photos alone is one', () => {
  assert.equal(stats([], 0), null)
  const s = stats([], 3)
  assert.equal(s.photos, 3)
  assert.equal(s.matches_scouted, 0)
  assert.equal(s.pit_visits, 0)
  assert.equal(s.scouts, 0)
  assert.equal(s.avg_score, null)
  assert.equal(s.last_seen, null)
  assert.equal(stats([pit({})], 3).photos, 3)
})

test('every field docs/FIREBASE.md lists is present (the trigger adds updated_at)', () => {
  assert.deepEqual(Object.keys(stats([match({ total_score: 1 })])).sort(), [
    'avg_score', 'breakdowns', 'event_key', 'last_seen', 'matches_scouted', 'max_score', 'min_score', 'no_shows',
    'notes_logged', 'photos', 'pit_estimate', 'pit_visits', 'score_stddev', 'scored_matches', 'scouts',
    'scouts_contributing', 'team_number',
  ])
})

test('affectedPairs: both sides of an edit, once each, and nothing without an event', () => {
  const a = { event_key: EVENT, team_number: 4414 }
  const b = { event_key: EVENT, team_number: 5805 }
  assert.deepEqual(affectedPairs(null, a), [{ eventKey: EVENT, teamNumber: 4414 }])
  assert.deepEqual(affectedPairs(a, null), [{ eventKey: EVENT, teamNumber: 4414 }])
  assert.deepEqual(affectedPairs(a, { ...a, notes: 'edited' }), [{ eventKey: EVENT, teamNumber: 4414 }])
  assert.deepEqual(affectedPairs(a, b), [
    { eventKey: EVENT, teamNumber: 4414 },
    { eventKey: EVENT, teamNumber: 5805 },
  ])
  assert.deepEqual(affectedPairs(null, { event_key: null, team_number: 4414 }), [])
  assert.deepEqual(affectedPairs({ event_key: null, team_number: 4414 }, a), [{ eventKey: EVENT, teamNumber: 4414 }])
  // A key that could not be a document id, or a team that is not a number, names no pair.
  assert.deepEqual(affectedPairs(null, { event_key: 'a/b', team_number: 1 }), [])
  assert.deepEqual(affectedPairs(null, { event_key: EVENT, team_number: '4414' }), [])
  assert.deepEqual(affectedPairs(null, null), [])
})

test('document ids agree with src/lib/ids.js', () => {
  assert.equal(ids.teamStatId(EVENT, 4414), siteIds.teamStatId(EVENT, 4414))
  assert.equal(ids.eventTeamId(EVENT, 4414), siteIds.eventTeamId(EVENT, 4414))
  assert.equal(ids.teamStatId(EVENT, 4414), '2026test_4414')
})
