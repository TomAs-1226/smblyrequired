// The public-data merge, with stand-ins for both upstreams and for the cache.
// Nothing here contacts Statbotics, The Blue Alliance or Firestore.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handlePublicData, teamFromStatbotics, mergeOprs } from '../src/publicData.js'

const sbRow = (team, total, over = {}) => ({
  team, team_name: `Team ${team}`,
  epa: {
    total_points: total,
    breakdown: { total_points: total, auto_points: total * 0.2, teleop_points: total * 0.7, endgame_points: total * 0.1, auto_rp: 0.1, rp_1: 0.2, coral_l4: 1.25, tiebreaker_points: 0.3 },
    stats: { start: total - 2, mean: total, max: total + 3 },
  },
  record: { qual: { rank: 4, num_teams: 40 }, total: { wins: 6, losses: 3, ties: 0, count: 9 } },
  ...over,
})

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const upstream = (routes) => async (url) => {
  for (const [part, answer] of Object.entries(routes)) if (String(url).includes(part)) return answer()
  return json({}, 404)
}
const memoryCache = (initial = null) => {
  let doc = initial
  return { get: async () => doc, set: async (d) => { doc = d }, peek: () => doc }
}

test('a Statbotics row becomes one flat team row, with the game components separated from the phases', () => {
  const t = teamFromStatbotics(sbRow(254, 60))
  assert.equal(t.team_number, 254)
  assert.deepEqual([t.epa.total, t.epa.auto, t.epa.teleop, t.epa.endgame], [60, 12, 42, 6])
  assert.deepEqual(t.epa.components, { coral_l4: 1.25 })
  assert.deepEqual(t.record, { wins: 6, losses: 3, ties: 0, played: 9, rank: 4, num_teams: 40 })
  assert.equal(t.opr, null)
})

test('a row with nothing in it is all nulls, not NaN', () => {
  const t = teamFromStatbotics({ team: 9999 })
  assert.equal(t.epa.total, null)
  assert.equal(t.record.played, 0)
  assert.deepEqual(t.epa.components, {})
})

test('OPR is merged by team number, and a team only The Blue Alliance knows still gets a row', () => {
  const teams = mergeOprs([teamFromStatbotics(sbRow(254, 60))], {
    oprs: { frc254: 55.123, frc5805: 30 }, dprs: { frc254: 20 }, ccwms: { frc254: 35.5 },
  })
  assert.deepEqual(teams.map((t) => t.team_number), [254, 5805])
  assert.deepEqual([teams[0].opr, teams[0].dpr, teams[0].ccwm], [55.12, 20, 35.5])
  assert.equal(teams[1].epa, null)
  assert.equal(teams[1].opr, 30)
})

test('both sources answer: merged, cached, and reported as fresh', async () => {
  const cache = memoryCache()
  const out = await handlePublicData({ action: 'event', eventKey: '2026demo' }, {
    key: 'k', cache, now: 1_000_000,
    fetch: upstream({ statbotics: () => json([sbRow(5805, 40), sbRow(254, 60)]), '/oprs': () => json({ oprs: { frc254: 50 }, dprs: {}, ccwms: {} }) }),
  })
  assert.equal(out.cached, false)
  assert.deepEqual(out.teams.map((t) => t.team_number), [254, 5805])
  assert.equal(out.teams[0].opr, 50)
  assert.deepEqual(out.sources, { statbotics: { ok: true, error: null }, tba: { ok: true, error: null } })
  assert.equal(cache.peek().team_count, 2)
})

test('no Blue Alliance key: Statbotics alone answers and the result says OPR is missing', async () => {
  const out = await handlePublicData({ action: 'event', eventKey: '2026demo' }, {
    key: '', cache: memoryCache(), fetch: upstream({ statbotics: () => json([sbRow(5805, 40)]) }),
  })
  assert.equal(out.teams.length, 1)
  assert.equal(out.sources.tba.ok, false)
  assert.match(out.sources.tba.error, /TBA_KEY/)
})

test('a fresh cache is served without calling upstream; force bypasses it', async () => {
  const now = 2_000_000
  const cache = memoryCache({ event_key: '2026demo', teams: [], sources: {}, team_count: 0, synced_at: new Date(now - 60_000).toISOString() })
  let calls = 0
  const fetch = async () => { calls++; return json([sbRow(1, 10)]) }
  const a = await handlePublicData({ action: 'event', eventKey: '2026demo' }, { key: '', cache, now, fetch })
  assert.equal(a.cached, true)
  assert.equal(calls, 0)
  const b = await handlePublicData({ action: 'event', eventKey: '2026demo', force: true }, { key: '', cache, now, fetch })
  assert.equal(b.cached, false)
  assert.ok(calls >= 1)
})

test('Statbotics down: the last good copy is served and marked stale; with no copy it fails cleanly', async () => {
  const now = 9_000_000_000
  const old = { event_key: '2026demo', teams: [teamFromStatbotics(sbRow(5805, 40))], sources: { statbotics: { ok: true, error: null }, tba: { ok: false, error: null } }, team_count: 1, synced_at: new Date(now - 3_600_000).toISOString() }
  const down = upstream({ statbotics: () => json({}, 503) })
  const out = await handlePublicData({ action: 'event', eventKey: '2026demo' }, { key: '', cache: memoryCache(old), now, fetch: down })
  assert.equal(out.stale, true)
  assert.equal(out.teams.length, 1)
  assert.equal(out.sources.statbotics.ok, false)
  await assert.rejects(
    handlePublicData({ action: 'event', eventKey: '2026demo' }, { key: '', cache: memoryCache(), now, fetch: down }),
    /Statbotics is unavailable/
  )
})

test('a bad event key or action is refused before anything is fetched', async () => {
  const fetch = async () => { throw new Error('should not be called') }
  await assert.rejects(handlePublicData({ action: 'event', eventKey: 'not a key' }, { fetch, cache: memoryCache() }), /eventKey/)
  await assert.rejects(handlePublicData({ action: 'everything', eventKey: '2026demo' }, { fetch, cache: memoryCache() }), /Unknown action/)
})
