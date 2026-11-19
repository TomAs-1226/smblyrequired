// Cycle Rush 3D, headless: the match timeline, the shot solver against the real
// physics world, a robot over a bump and under a trench, and whole AI matches.
// Run: node scripts/test/arcade.mjs   (add --verbose for per-match detail)
import assert from 'node:assert/strict'
// Rapier's CommonJS build does not load under Node's ESM resolver; its ES build does.
import * as R from '@dimforge/rapier3d-compat/rapier.es.js'
import { periodOf, shiftOf, hubActive, untilHubChange } from '../../src/lib/arcade3d/rules.js'
import { solveShot, launchVelocity } from '../../src/lib/arcade3d/ballistics.js'
import { createSim, step, result, countFuel, destroySim, DT } from '../../src/lib/arcade3d/sim.js'
import { MATCH, HUB, FUEL, LANES, FIELD, TOWER, OUTPOST } from '../../src/lib/arcade3d/config.js'

const verbose = process.argv.includes('--verbose')
await R.init()

let failed = 0
async function t(name, fn) {
  try {
    await fn()
    console.log('ok   ', name)
  } catch (e) {
    failed++
    console.log('FAIL ', name, '\n     ', e.message)
  }
}

// ------------------------------------------------------------------ rules
await t('the match runs auto, transition, four shifts, endgame', () => {
  assert.equal(periodOf(-1), 'countdown')
  assert.equal(periodOf(5), 'auto')
  assert.equal(periodOf(25), 'transition')
  assert.equal(periodOf(40), 'shift')
  assert.equal(shiftOf(40), 1)
  assert.equal(shiftOf(104), 3)
  assert.equal(shiftOf(106), 4)
  assert.equal(periodOf(150), 'endgame')
  assert.equal(periodOf(160), 'over')
})

await t('the auto winner sits out shifts 1 and 3', () => {
  for (const [time, winner, loser] of [[40, false, true], [60, true, false], [90, false, true], [110, true, false]]) {
    assert.equal(hubActive(time, 'blue', 'blue'), winner, `t=${time} winner`)
    assert.equal(hubActive(time, 'red', 'blue'), loser, `t=${time} loser`)
  }
  for (const time of [5, 25, 140]) {
    assert.ok(hubActive(time, 'blue', 'red') && hubActive(time, 'red', 'red'), `both live at ${time}`)
  }
  assert.ok(Math.abs(untilHubChange(25, 'blue', 'blue') - 5) < 1e-6)
})

// ------------------------------------------------------------------ shots in the physics world
function shotWorld() {
  const world = new R.World({ x: 0, y: -9.81, z: 0 })
  world.timestep = DT
  return world
}
function fly(world, from, vel) {
  const body = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(from.x, from.y, from.z).setCcdEnabled(true))
  world.createCollider(R.ColliderDesc.ball(FUEL.r).setMass(FUEL.mass), body)
  body.setLinvel(vel, true)
  return body
}

await t('a solved shot passes through the opening in the physics world, drag and all', () => {
  const target = { x: 0, y: HUB.top + 0.05, z: 0 }
  for (const dist of [2, 3, 4.5, 6]) {
    const from = { x: -dist, y: 0.8, z: 0 }
    const sol = solveShot(from, target, { x: 0, z: 0 }, 62, 12.5, false)
    assert.ok(sol, `no solution at ${dist} m`)
    const world = shotWorld()
    const body = fly(world, from, launchVelocity(sol.speed, sol.yaw, 62, null))
    let best = Infinity
    for (let i = 0; i < 400; i++) {
      const v = body.linvel()
      const k = FUEL.K * Math.hypot(v.x, v.y, v.z) * DT
      body.setLinvel({ x: v.x * (1 - k), y: v.y * (1 - k), z: v.z * (1 - k) }, true)
      world.step()
      const p = body.translation()
      if (Math.abs(p.y - target.y) < 0.08 && body.linvel().y < 0) best = Math.min(best, Math.abs(p.x))
      if (p.y < 0) break
    }
    world.free()
    assert.ok(best < 0.12, `${dist} m: missed the centre by ${best.toFixed(3)} m`)
  }
})

await t('shooting on the move leads the target', () => {
  const from = { x: -3, y: 0.8, z: -1 }
  const vel = { x: 0, z: 2.5 }
  const still = solveShot(from, { x: 0, y: 1.88, z: 0 }, vel, 62, 12.5, false)
  const moving = solveShot(from, { x: 0, y: 1.88, z: 0 }, vel, 62, 12.5, true)
  assert.ok(moving.yaw < still.yaw, 'aims behind the target to cancel the sideways drift')
})

// ------------------------------------------------------------------ driving over the field
function driveTo(sim, r, goal, seconds, input) {
  for (let i = 0; i < seconds / DT; i++) {
    const dx = goal.x - r.x
    const dz = goal.z - r.z
    const d = Math.hypot(dx, dz)
    step(sim, { vx: d > 0.1 ? dx / d : 0, vz: d > 0.1 ? dz / d : 0, aim: 0, fire: false, ...input })
  }
}
function startTeleop(sim) {
  // Skip to teleop with every robot but the player parked out of the way.
  sim.clock = MATCH.auto + 0.5
  for (const o of sim.robots) {
    if (!o.isPlayer) {
      o.body.setTranslation({ x: o.team === 'blue' ? 1 : FIELD.L - 1, y: o.restY, z: 0.6 + sim.robots.indexOf(o) * 1.2 }, true)
      o.ai.role = 'parked'
    }
  }
}

await t('every archetype drives over a bump', () => {
  for (const arch of ['turret', 'trench', 'hopper', 'bruiser']) {
    const sim = createSim(R, { arch, seed: 1 })
    startTeleop(sim)
    const p = sim.robots[0]
    p.body.setTranslation({ x: 3.4, y: p.restY, z: LANES.bump[0] }, true)
    let peak = 0
    for (let i = 0; i < 3 / DT; i++) {
      step(sim, { vx: 1, vz: 0, aim: 0 })
      peak = Math.max(peak, p.y - p.restY)
    }
    assert.ok(p.x > HUB.blue.x + 0.9, `${arch} stopped at x=${p.x.toFixed(2)}`)
    assert.ok(peak > 0.1, `${arch} never rode up the bump (peak ${peak.toFixed(3)})`)
    destroySim(sim)
  }
})

await t('short robots fit under the trench, tall ones do not', () => {
  for (const [arch, fits] of [['trench', true], ['bruiser', true], ['turret', false], ['hopper', false]]) {
    const sim = createSim(R, { arch, seed: 2 })
    startTeleop(sim)
    const p = sim.robots[0]
    p.body.setTranslation({ x: 3.3, y: p.restY, z: LANES.trench[0] }, true)
    for (let i = 0; i < 2.5 / DT; i++) step(sim, { vx: 1, vz: 0, aim: 0 })
    const through = p.x > HUB.blue.x + 0.8
    assert.equal(through, fits, `${arch}: x=${p.x.toFixed(2)}`)
    destroySim(sim)
  }
})

await t('the intake picks fuel up off the floor', () => {
  const sim = createSim(R, { arch: 'trench', seed: 3 })
  startTeleop(sim)
  const p = sim.robots[0]
  p.body.setTranslation({ x: 6.0, y: p.restY, z: 2.6 }, true)
  const before = p.carry
  driveTo(sim, p, { x: 10, z: 2.6 }, 2.5)
  assert.ok(p.carry > before + 4, `carry ${before} → ${p.carry}`)
  destroySim(sim)
})

await t('the player can climb in the endgame, and only in the zone', () => {
  const sim = createSim(R, { arch: 'bruiser', seed: 4 })
  startTeleop(sim)
  const p = sim.robots[0]
  const zoneX = TOWER.blue.x + TOWER.zone.from + 0.6
  p.body.setTranslation({ x: zoneX, y: p.restY, z: TOWER.blue.z }, true)
  for (let i = 0; i < 30; i++) step(sim, { vx: 0, vz: 0, aim: Math.PI, climb: true })
  assert.equal(p.climb.state, 'none', 'no climbing before the endgame')
  sim.clock = MATCH.endgame + 1
  p.body.setTranslation({ x: 6, y: p.restY, z: 2 }, true)
  for (let i = 0; i < 10; i++) step(sim, { climb: true })
  assert.equal(p.climb.state, 'none', 'no climbing away from the tower')
  p.body.setTranslation({ x: zoneX, y: p.restY, z: TOWER.blue.z }, true)
  for (let i = 0; i < 10; i++) step(sim, { climb: true })
  assert.equal(p.climb.state, 'climbing')
  while (!sim.over) step(sim, {})
  assert.equal(p.climb.state, 'done')
  assert.ok(result(sim).climb === 3, 'bruiser reaches L3')
  destroySim(sim)
})

await t('starting fuel is the real layout: 360 at midfield, 24 per depot and outpost', () => {
  const sim = createSim(R, { seed: 5 })
  const alive = sim.balls.filter((b) => b.alive).map((b) => b.body.translation())
  const mid = alive.filter((p) => p.x > 7 && p.x < 9.5)
  assert.equal(mid.length, 360)
  assert.equal(alive.length - mid.length, 48)
  assert.equal(sim.outpost.blue + sim.outpost.red, 48)
  destroySim(sim)
})

await t('the outpost feeds a robot parked at its chute', () => {
  const sim = createSim(R, { arch: 'trench', seed: 6 })
  startTeleop(sim)
  const p = sim.robots[0]
  p.carry = 0
  p.body.setTranslation({ x: 0.6, y: p.restY, z: OUTPOST.blue.z }, true)
  p.body.setRotation({ x: 0, y: 1, z: 0, w: 0 }, true) // facing the wall
  for (let i = 0; i < 2 / DT; i++) step(sim, { vx: 0, vz: 0, aim: Math.PI })
  assert.ok(p.carry >= 10, `fed ${p.carry}`)
  assert.equal(sim.outpost.blue, 24 - p.carry)
  destroySim(sim)
})

// ------------------------------------------------------------------ whole matches
function playMatch(opts) {
  const sim = createSim(R, opts)
  const total = countFuel(sim)
  let maxSpeed = 0
  while (!sim.over) {
    step(sim)
    if (sim.clock > 0 && Math.round(sim.clock / DT) % 120 === 0) {
      for (const r of sim.robots) {
        assert.ok(Number.isFinite(r.x + r.z + r.psi), 'robot NaN')
        assert.ok(r.x > -0.2 && r.x < FIELD.L + 0.2 && r.z > -0.2 && r.z < FIELD.W + 0.2, `${r.label} left the field`)
        maxSpeed = Math.max(maxSpeed, Math.hypot(r.vx, r.vz))
      }
      assert.equal(countFuel(sim), total, 'fuel is conserved')
    }
  }
  const res = result(sim)
  const climbs = sim.robots.filter((r) => r.climb.state === 'done').map((r) => `${r.label}:L${r.climb.level}`)
  destroySim(sim)
  return { res, climbs, maxSpeed }
}

for (const difficulty of ['rookie', 'regional', 'einstein']) {
  await t(`AI-only ${difficulty} match: both alliances score and climb`, () => {
    const lines = []
    for (const seed of [11, 12]) {
      const started = performance.now()
      const { res, climbs, maxSpeed } = playMatch({ difficulty, seed, demo: true })
      const ms = performance.now() - started
      lines.push(
        `${res.blue.total}-${res.red.total} (fuel ${res.blue.fuel}/${res.red.fuel}, wasted ${res.blue.wasted}/${res.red.wasted}, ` +
          `climb ${res.blue.climb}/${res.red.climb}, auto ${res.blue.auto}/${res.red.auto}) ${climbs.join(' ')} ` +
          `max ${maxSpeed.toFixed(1)} m/s, ${(ms / 1000).toFixed(1)} s to run`,
      )
      assert.ok(res.blue.fuel >= 15 && res.red.fuel >= 15, `too little fuel scored: ${res.blue.fuel}/${res.red.fuel}`)
      assert.ok(res.blue.climb + res.red.climb > 0, 'nobody climbed')
      assert.ok(res.autoWinner, 'auto winner decided')
    }
    for (const l of lines) console.log('      ', l)
  })
}

if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall arcade tests passed')
