// Plays whole Cycle Rush matches headless: AI on every robot, then the player
// standing still. Checks the rules hold — no NaN, balls conserved, a match ends,
// and the AI actually scores. Run: node scripts/test/arcade.mjs
import assert from 'node:assert/strict'
import { createGame, step, result, MATCH } from '../../src/lib/arcade/engine.js'

const DT = 1 / 60
function play(opts, input) {
  const s = createGame(opts)
  const total = s.balls.length + s.robots.reduce((n, r) => n + r.carry, 0)
  let steps = 0
  while (s.phase !== 'over') {
    step(s, DT, input ? input(s) : undefined)
    steps++
    for (const r of s.robots) assert.ok(Number.isFinite(r.x + r.y + r.vx + r.vy + r.heading), 'robot NaN')
    for (const b of s.balls) assert.ok(Number.isFinite(b.x + b.y), 'ball NaN')
    const now = s.balls.length + s.queue.length + s.robots.reduce((n, r) => n + r.carry, 0)
    assert.equal(now, total, 'balls are conserved')
    assert.ok(steps < (MATCH.total + MATCH.countdown + 1) * 60, 'match ends')
  }
  return result(s)
}

let failed = 0
function t(name, fn) {
  try { fn(); console.log('ok   ', name) } catch (e) { failed++; console.log('FAIL ', name, '\n     ', e.message) }
}

for (const difficulty of ['rookie', 'regional', 'einstein']) {
  t(`demo match on ${difficulty} scores for both alliances`, () => {
    const scores = []
    for (let seed = 1; seed <= 4; seed++) {
      const r = play({ difficulty, seed, demo: true })
      scores.push(`${r.blue.total}-${r.red.total}`)
      assert.ok(r.blue.cells > 3 && r.red.cells > 3, `too few cells: ${r.blue.cells}/${r.red.cells}`)
    }
    console.log('      ', scores.join('  '))
  })
}

t('an idle player still lets the partner score', () => {
  const r = play({ difficulty: 'rookie', seed: 7 }, () => ({ mx: 0, my: 0, aim: null, fire: false }))
  assert.ok(r.blue.cells > 0)
  assert.equal(r.shotsFired, 0)
})

t('red docks in the endgame', () => {
  const r = play({ difficulty: 'regional', seed: 3, demo: true })
  assert.ok(r.red.dock > 0, 'no red robot docked')
})

t('your shots count only the player own makes', () => {
  // The player stands still and aims at the blue hub, firing the preload.
  const r = play({ difficulty: 'rookie', seed: 11 }, (s) => {
    const p = s.robots[0]
    return { mx: 0, my: 0, aim: Math.atan2(4 - p.y, 4.2 - p.x), fire: true }
  })
  assert.ok(r.shotsMade <= r.shotsFired, `${r.shotsMade}/${r.shotsFired}`)
  assert.ok(r.blue.cells > r.shotsMade, 'partner makes are not the player own')
})

if (failed) { console.log(`\n${failed} failed`); process.exit(1) }
console.log('\nall arcade tests passed')
