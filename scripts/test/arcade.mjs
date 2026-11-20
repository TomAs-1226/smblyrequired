// Cycle Rush 3D, headless, on the imported field and robots (public/arcade) and
// 5805's Numbers (public/models/robot.json): the match timeline, the field's
// layout, driving, turning, intakes, auto-aim and shooting for every kind of
// shooter, nets, passing, climbing, the outpost, each game mode, the realism
// faults, and whole AI matches.
// Run: node scripts/test/arcade.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
// Rapier's CommonJS build does not load under Node's ESM resolver; its ES build does.
import * as R from '@dimforge/rapier3d-compat/rapier.es.js'
import { periodOf, shiftOf, hubActive, untilHubChange } from '../../src/lib/arcade3d/rules.js'
import { solveShot, launchVelocity } from '../../src/lib/arcade3d/ballistics.js'
import { createSim, step, result, countFuel, destroySim, endNow, hubLive, groundAt, rayField, DT } from '../../src/lib/arcade3d/sim.js'
import { specFromDescriptor, numbersSpec, hopperX, hopperZ, hopperHoldsOpen, hopperRim } from '../../src/lib/arcade3d/robots.js'
import { createHopper } from '../../src/lib/arcade3d/hopper.js'
import { MATCH, HUB, FUEL, LANES, FIELD, TOWER, OUTPOST, DEPOT } from '../../src/lib/arcade3d/config.js'
import { noteShot } from '../../src/lib/arcade3d/faults.js'

await R.init()
const read = (p) => JSON.parse(readFileSync(new URL(`../../public/${p}`, import.meta.url), 'utf8'))
const field = read('arcade/field.json')
const index = read('arcade/index.json').robots
const SPECS = index.map((e) => specFromDescriptor(read(`arcade/${e.descriptor}`), e))
SPECS.push(numbersSpec(read('models/robot.json')))
const byNum = (n) => SPECS.find((s) => s.number === n)

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
const solo = (spec, opts = {}) => createSim(R, { field, lineup: { blue: [spec], red: [] }, mode: 'practice', seed: 1, ...opts })
function place(sim, r, x, z, psi = 0) {
  r.body.setTranslation({ x, y: 0.01, z }, true)
  r.body.setRotation({ x: 0, y: Math.sin(-psi / 2), z: 0, w: Math.cos(-psi / 2) }, true)
  r.body.setLinvel({ x: 0, y: 0, z: 0 }, true)
  r.body.setAngvel({ x: 0, y: 0, z: 0 }, true)
  sim.clock = Math.max(sim.clock, 0.5)
}
// The heading that puts a robot's intake (its first, if it has two) toward +x.
const intakeFirst = (spec, toward = 0) => toward - spec.intake.dirs[0]
const run = (sim, seconds, input) => { for (let i = 0; i < seconds / DT; i++) step(sim, typeof input === 'function' ? input(i) : input) }
// A stretch of plain alliance wall: clear of the depot, the tower and the outpost.
const WALL_Z = 5.9

// ------------------------------------------------------------------ rules
await t('the match runs auto, transition, four shifts, endgame', () => {
  assert.equal(periodOf(-1), 'countdown')
  assert.equal(periodOf(5), 'auto')
  assert.equal(periodOf(25), 'transition')
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
  assert.ok(Math.abs(untilHubChange(25, 'blue', 'blue') - 5) < 1e-6)
})

await t('a solved shot passes through the opening in the physics world, drag and all', () => {
  const target = { x: 0, y: HUB.top + 0.05, z: 0 }
  for (const dist of [2, 3, 4.5, 6]) {
    const from = { x: -dist, y: 0.6, z: 0 }
    const sol = solveShot(from, target, { x: 0, z: 0 }, 62, 15, false)
    assert.ok(sol, `no solution at ${dist} m`)
    const world = new R.World({ x: 0, y: -9.81, z: 0 })
    world.timestep = DT
    const body = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(from.x, from.y, from.z))
    world.createCollider(R.ColliderDesc.ball(FUEL.r).setMass(FUEL.mass), body)
    body.setLinvel(launchVelocity(sol.speed, sol.yaw, 62, null), true)
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

// ------------------------------------------------------------------ the field
await t('the field builds from field.json, and every robot has a spec', () => {
  assert.ok(field.colliders.length > 300, `${field.colliders.length} colliders`)
  assert.equal(SPECS.length, 22, '21 imported robots and Numbers')
  for (const s of SPECS) {
    assert.ok(s.len > 0.6 && s.len < 1.1 && s.wid > 0.6 && s.wid < 1.1, `${s.label} footprint ${s.len}×${s.wid}`)
    assert.ok(s.height > 0.4 && s.height < 0.8, `${s.label} height ${s.height}`)
    assert.ok(s.capacity > 0 && s.fireRate > 0 && s.speed > 3, `${s.label} stats`)
    assert.ok(s.shot.exits.length >= 1, `${s.label} has somewhere for fuel to leave`)
    assert.equal(s.hopper.slots.length, s.capacity, `${s.label} has a place for every ball it can carry`)
    // Every carried ball sits inside the robot's footprint (give or take the intake's reach).
    // and under its lid: the roof, or as far up as its net stretches.
    const lid = (s.hopper.netMax ?? s.hopper.roof) + 0.02
    for (const slot of s.hopper.slots) {
      const x = hopperX(s, slot, 1)
      const z = hopperZ(s, slot, 1)
      assert.ok(Math.abs(x) < s.len / 2 + 0.45 && Math.abs(z) < s.wid / 2 + s.hopper.wide, `${s.label} slot outside the robot`)
      assert.ok(slot.y + FUEL.r <= lid, `${s.label}: a ball at ${(slot.y + FUEL.r).toFixed(2)} m, lid at ${lid.toFixed(2)}`)
    }
  }
  const sim = solo(SPECS[0])
  assert.ok(sim.colliderCount === field.colliders.length, 'every collider made it into the world')
  destroySim(sim)
})

await t('the field is the real one, not its mirror image', () => {
  // Seen from the blue driver station (looking along +x, z to the right): the
  // depot is on the left, then the tower, and the outpost is in the right corner.
  assert.ok(DEPOT.blue.z < TOWER.blue.z && TOWER.blue.z < OUTPOST.blue.z, 'blue: depot, tower, outpost from left to right')
  assert.ok(DEPOT.red.z > TOWER.red.z && TOWER.red.z > OUTPOST.red.z, 'red is the same, turned round')
  // The colliders agree with the layout the game is written against.
  const towerBase = field.colliders.find((c) => c.name === 'tower base' && c.alliance === 'blue')
  assert.ok(Math.abs(towerBase.center[2] - TOWER.blue.z) < 0.05, `tower collider z ${towerBase.center[2]} vs ${TOWER.blue.z}`)
  const depot = field.colliders.filter((c) => c.element === 'depot-blue').map((c) => c.center[2])
  assert.ok(Math.min(...depot) < DEPOT.blue.z && DEPOT.blue.z < Math.max(...depot), 'depot collider around the depot fuel')
  // And the physics world has a bump where the layout says, and carpet beside it.
  const sim = solo(SPECS[0])
  step(sim, {})
  assert.ok(groundAt(sim, HUB.blue.x, LANES.bump[0]) > 0.12, 'bump under the bump lane')
  assert.ok(groundAt(sim, HUB.blue.x + 2, LANES.bump[0]) < 0.01, 'carpet past it')
  destroySim(sim)
})

await t('fuel dropped into the funnel rolls through the throat and scores', () => {
  const sim = solo(byNum(254))
  sim.clock = 1 // after the countdown, when the hub counts
  const before = sim.score.blue.fuel
  // Off-centre, onto the funnel's slope, so it has to roll in.
  const h = HUB.blue
  const body = sim.world.createRigidBody(sim.R.RigidBodyDesc.dynamic().setTranslation(h.x + 0.3, HUB.top + 0.3, h.z + 0.2))
  const collider = sim.world.createCollider(sim.R.ColliderDesc.ball(FUEL.r).setMass(FUEL.mass).setCollisionGroups((4 << 16) | (1 | 2 | 4 | 8)), body)
  sim.balls.push({ body, collider, alive: true, shooter: null, air: true, grace: 0 })
  run(sim, 3, {})
  assert.equal(sim.score.blue.fuel, before + 1)
  destroySim(sim)
})

await t('the net behind the hub stops a ball that overshoots', () => {
  const sim = solo(byNum(254))
  sim.clock = 1
  const h = HUB.blue
  // Level with the middle of the net, flying flat and fast over the rim toward midfield.
  const body = sim.world.createRigidBody(sim.R.RigidBodyDesc.dynamic().setTranslation(h.x - 1.5, 2.45, h.z).setCcdEnabled(true))
  const collider = sim.world.createCollider(sim.R.ColliderDesc.ball(FUEL.r).setMass(FUEL.mass).setCollisionGroups((4 << 16) | (1 | 4 | 8 | 16)), body)
  body.setLinvel({ x: 9, y: 1.2, z: 0 }, true)
  const ball = { body, collider, alive: true, shooter: null, air: true, grace: 0 }
  sim.balls.push(ball)
  let far = -Infinity
  for (let i = 0; i < 2 / DT && ball.alive; i++) {
    step(sim, {})
    if (ball.alive) far = Math.max(far, body.translation().x)
  }
  // Without the net it would land four metres past the hub.
  assert.ok(far < h.x + 1.2, `the ball got to x=${far.toFixed(2)}, past the net at ${(h.x + 0.86).toFixed(2)}`)
  destroySim(sim)
})

// ------------------------------------------------------------------ driving
await t('every robot drives over a bump', () => {
  const stuck = []
  for (const spec of SPECS) {
    const sim = solo(spec)
    const p = sim.robots[0]
    place(sim, p, 3.3, LANES.bump[0], 0)
    let peak = 0
    for (let i = 0; i < 3 / DT; i++) {
      step(sim, { vx: 1, vz: 0, aim: 0 })
      peak = Math.max(peak, p.y)
    }
    if (!(p.x > HUB.blue.x + 0.9 && peak > 0.08)) stuck.push(`${spec.label} x=${p.x.toFixed(2)} peak=${peak.toFixed(2)}`)
    destroySim(sim)
  }
  assert.deepEqual(stuck, [])
})

await t('robots short enough fit under the trench, the rest are stopped by it', () => {
  const wrong = []
  for (const spec of SPECS) {
    const sim = solo(spec)
    const p = sim.robots[0]
    place(sim, p, 3.2, LANES.trench[0], 0)
    run(sim, 2.5, { vx: 1, vz: 0, aim: 0 })
    const through = p.x > HUB.blue.x + 0.8
    if (through !== spec.trench) wrong.push(`${spec.label} (${spec.height.toFixed(3)} m) through=${through}`)
    destroySim(sim)
  }
  assert.deepEqual(wrong, [])
})

await t('turning eases in and out: no snapping to a speed or an angle', () => {
  const sim = solo(byNum(254))
  const p = sim.robots[0]
  place(sim, p, 3, WALL_Z, 0)
  step(sim, { turn: 1 })
  step(sim, { turn: 1 })
  assert.ok(Math.abs(p.om) < 1.2, `spun up to ${p.om.toFixed(2)} rad/s in one step`)
  run(sim, 0.6, { turn: 1 })
  const cruise = p.om
  assert.ok(cruise > 3 && cruise < 6, `turn rate ${cruise.toFixed(2)} rad/s`)
  step(sim, {})
  step(sim, {})
  assert.ok(p.om > cruise * 0.6, 'does not stop dead when the key is released')
  run(sim, 0.5, {})
  assert.ok(Math.abs(p.om) < 0.05, `still turning at ${p.om.toFixed(2)} rad/s`)
  // Right is clockwise seen from above: toward +z from +x.
  assert.ok(Math.sin(p.psi) > 0 || p.psi > 1, 'turn +1 is a right turn')
  destroySim(sim)
})

await t('the player drives from the first second of auto', () => {
  const lineup = { blue: [byNum(254), byNum(1690), byNum(5805)], red: [byNum(2910), byNum(971), byNum(1678)] }
  const sim = createSim(R, { field, lineup, mode: 'match', seed: 2 })
  const p = sim.robots[0]
  run(sim, MATCH.countdown + 0.05, { vx: 1 })
  const x0 = p.x
  assert.equal(sim.period, 'auto')
  run(sim, 1, { vx: 0, vz: -1 })
  assert.ok(p.z < sim.robots[0].z + 1e-9 && Math.abs(p.x - x0) < 0.6, 'the robot went where it was told')
  run(sim, 1, {})
  assert.ok(Math.hypot(p.vx, p.vz) < 0.2, 'and stopped when told nothing: no routine of its own')
  assert.equal(sim.stats.fired, 0, 'it did not shoot by itself')
  destroySim(sim)
})

// ------------------------------------------------------------------ intake and hopper
await t('the intake collects on its own side, only while it is held', () => {
  for (const spec of [byNum(254), byNum(1690), byNum(5805), byNum(5000)]) {
    for (const held of [true, false]) {
      const sim = solo(spec)
      const p = sim.robots[0]
      p.carry = 0
      // Drive intake-first into the midfield block.
      const psi = intakeFirst(spec)
      place(sim, p, 6.2, 3.0, psi)
      run(sim, 2.5, { vx: 1, vz: 0, aim: psi, intake: held })
      if (held) {
        assert.ok(p.carry >= 4, `${spec.label}: collected ${p.carry}`)
        assert.ok(p.intakeOut > 0.95, 'the intake is out')
        assert.ok(sim.events.some((e) => e.kind === 'intake' && e.robot === 0), 'each pickup is announced, for the view to animate')
      } else {
        assert.equal(p.carry, 0, `${spec.label}: collected without the intake`)
        assert.ok(p.intakeOut < 0.05, 'the intake stays in')
      }
      destroySim(sim)
    }
  }
})

await t('the intake agitates the hopper while the robot shoots', () => {
  const sim = solo(byNum(254))
  const p = sim.robots[0]
  p.carry = 60
  place(sim, p, HUB.blue.x - 3, HUB.blue.z, 0)
  let lo = 1
  let hi = 0
  let turns = 0
  let prev = 0
  let rising = true
  for (let i = 0; i < 2.5 / DT; i++) {
    step(sim, { fire: true }) // intake not held
    if (sim.stats.fired > 0) {
      lo = Math.min(lo, p.intakeOut)
      hi = Math.max(hi, p.intakeOut)
      const up = p.intakeOut > prev
      if (up !== rising) { turns++; rising = up }
    }
    prev = p.intakeOut
  }
  assert.ok(hi > 0.9 && lo < 0.45, `intake moved between ${lo.toFixed(2)} and ${hi.toFixed(2)}`)
  assert.ok(turns >= 4, `it changed direction ${turns} times`)
  run(sim, 1.5, {})
  assert.ok(p.intakeOut < 0.05, 'and stows again afterwards')
  destroySim(sim)
})

await t('every robot starts intake-first: hold forward and intake from the kickoff and it collects', () => {
  const report = []
  for (const spec of SPECS) {
    const sim = createSim(R, { field, lineup: { blue: [spec], red: [] }, mode: 'solo', seed: 1 })
    const p = sim.robots[0]
    while (sim.clock < 0) step(sim, {})
    assert.ok(Math.cos(p.psi + spec.intake.dirs[0]) > 0.99, `${spec.label} starts with its intake away from the fuel`)
    const had = p.carry
    run(sim, 5, { vx: 1, vz: 0, intake: true })
    report.push(`${spec.label} +${p.carry - had}`)
    assert.ok(p.carry - had >= 12, `${spec.label} collected ${p.carry - had}`)
    destroySim(sim)
  }
  console.log('      ', report.join('  '))
})

await t('a robot with an intake on each side collects out of either', () => {
  const spec = byNum(5000)
  assert.equal(spec.intake.dirs.length, 2)
  assert.ok(spec.hopper.wide > 0.2, 'its hopper widens with the drawers')
  for (const dir of spec.intake.dirs) {
    const sim = solo(spec)
    const p = sim.robots[0]
    p.carry = 0
    place(sim, p, 6.2, 3.0, -dir)
    run(sim, 2.5, { vx: 1, vz: 0, aim: -dir, intake: true })
    assert.ok(p.carry >= 10, `side ${dir.toFixed(2)}: collected ${p.carry}`)
    destroySim(sim)
  }
})

await t('a full hopper holds its intake open, and lets it close as it empties', () => {
  const spec = byNum(254)
  assert.equal(hopperHoldsOpen(spec, 0), 0)
  assert.equal(hopperHoldsOpen(spec, spec.capacity), 1)
  const sim = solo(spec)
  const p = sim.robots[0]
  place(sim, p, 2.4, WALL_Z, 0)
  p.carry = spec.capacity
  run(sim, 1, {})
  assert.ok(p.intakeOut > 0.7, `full: the intake is ${p.intakeOut.toFixed(2)} out`)
  assert.equal(p.intakeOn, false, 'held open is not running: it picks nothing up')
  p.carry = 8
  run(sim, 1, {})
  assert.ok(p.intakeOut < 0.05, `nearly empty: the intake is ${p.intakeOut.toFixed(2)} out`)
  destroySim(sim)
})

await t('the fuel on board is a real pile: every full load fits in its hopper, settles and stays in', () => {
  for (const spec of SPECS) {
    const h = spec.hopper
    const hop = createHopper(R, spec)
    hop.step(1, 0, 0, 0, DT) // intake out
    hop.fill(spec.capacity)
    for (let i = 0; i < 150; i++) hop.step(1, 0, 0, 0, DT)
    assert.equal(hop.count(), spec.capacity, `${spec.label} holds ${hop.count()} of ${spec.capacity}`)
    const rim = hopperRim(spec, 1)
    const before = []
    hop.each((x, y, z) => before.push([x, y, z]))
    hop.step(1, 0, 0, 0, DT)
    let speed = 0
    let i = 0
    hop.each((x, y, z) => {
      assert.ok(Number.isFinite(x + y + z), `${spec.label}: a ball is nowhere`)
      assert.ok(x > Math.min(rim.x0, rim.x1) - 0.02 && x < Math.max(rim.x0, rim.x1) + 0.02, `${spec.label}: a ball at x ${x.toFixed(2)}`)
      assert.ok(Math.abs(z) < rim.half + 0.02, `${spec.label}: a ball at z ${z.toFixed(2)}`)
      assert.ok(y > 0.05 && y + hop.radius < hop.lid + 0.04, `${spec.label}: a ball at ${y.toFixed(2)} m, lid at ${hop.lid.toFixed(2)}`)
      speed += Math.hypot(x - before[i][0], y - before[i][1], z - before[i][2]) / DT
      i++
    })
    assert.ok(speed / spec.capacity < 0.15, `${spec.label}: the pile is still moving at ${(speed / spec.capacity).toFixed(2)} m/s`)
    hop.free()
  }
})

await t('the pile comes in through the intake, is left behind when the robot pulls away, and drains at the feeder', () => {
  const spec = byNum(254)
  const hop = createHopper(R, spec)
  const rim = hopperRim(spec, 1)
  hop.step(1, 0, 0, 0, DT)
  // In through the open end, thrown toward the board.
  hop.add(0, 0.1)
  let first = null
  hop.each((x) => { first = x })
  assert.ok(Math.abs(first - rim.x1) < 0.12, `it comes in at the open end (${first.toFixed(2)} of ${rim.x1.toFixed(2)})`)
  for (let i = 0; i < 20; i++) hop.step(1, 0, 0, 0, DT)
  hop.each((x) => assert.ok(Math.abs(x - rim.x1) > 0.2, 'and rolls in'))
  for (let k = 0; k < 29; k++) {
    hop.add(0, ((k % 5) - 2) * 0.12)
    for (let i = 0; i < 6; i++) hop.step(1, 0, 0, 0, DT)
  }
  for (let i = 0; i < 90; i++) hop.step(1, 0, 0, 0, DT)
  assert.equal(hop.count(), 30)
  const centre = () => { let s = 0; hop.each((x) => { s += x }); return s / hop.count() }
  const rest = centre()
  // At rest it lies against the board, where the floor slopes to. Pulling away
  // hard, the robot goes and the pile stays: it heaps toward the open end.
  for (let i = 0; i < 30; i++) hop.step(1, 9, 0, 0, DT)
  assert.ok(rest - centre() > 0.04, `the pile moved ${(rest - centre()).toFixed(3)} m back`)
  // and lies still again once the robot is steady (where it was shoved to: foam does not flow).
  for (let i = 0; i < 90; i++) hop.step(1, 0, 0, 0, DT)
  const lay = centre()
  for (let i = 0; i < 10; i++) hop.step(1, 0, 0, 0, DT)
  assert.ok(Math.abs(centre() - lay) < 0.004, `the pile is still creeping: ${Math.abs(centre() - lay).toFixed(4)} m in a sixth of a second`)
  // No two piles alike: it is not a grid.
  const ys = new Set()
  hop.each((x, y) => ys.add(y.toFixed(3)))
  assert.ok(ys.size > 12, `${ys.size} different heights among 30 balls`)
  // Shooting takes the ball nearest the feeder each time.
  const board = rim.x0
  let near = Infinity
  hop.each((x) => { near = Math.min(near, Math.abs(x - board)) })
  hop.take(0)
  assert.equal(hop.count(), 29)
  let after = Infinity
  hop.each((x) => { after = Math.min(after, Math.abs(x - board)) })
  assert.ok(after >= near - 1e-6, 'the nearest one went')
  while (hop.count()) hop.take(0)
  hop.step(1, 0, 0, 0, DT)
  assert.equal(hop.count(), 0)
  hop.free()
})

// ------------------------------------------------------------------ shooting
await t('every robot scores from point-blank and from an angle', () => {
  const h = HUB.blue
  const report = []
  for (const spec of SPECS) {
    const made = []
    for (const [x, z] of [[h.x - 1.75, h.z + 0.2], [h.x - 2.2, h.z - 2.2]]) {
      const sim = solo(spec)
      const p = sim.robots[0]
      p.carry = 12
      place(sim, p, x, z, 2.0) // pointed well away: holding fire has to bring it round
      run(sim, 4, { fire: true })
      run(sim, 2, {})
      assert.equal(sim.stats.fired, 12, `${spec.label} fired ${sim.stats.fired} from (${x.toFixed(1)}, ${z.toFixed(1)})`)
      assert.ok(sim.stats.made >= 10, `${spec.label} made ${sim.stats.made}/12 from (${x.toFixed(1)}, ${z.toFixed(1)})`)
      made.push(sim.stats.made)
      destroySim(sim)
    }
    report.push(`${spec.label} ${made.join('+')}`)
  }
  console.log('      ', report.join('  '))
})

await t('auto-aim: turret, wide, back-shooting and dumper robots all score from range', () => {
  const report = []
  for (const spec of [byNum(1690), byNum(254), byNum(5805), byNum(2481), byNum(1114), byNum(971)]) {
    const sim = solo(spec)
    const p = sim.robots[0]
    p.carry = 12
    const h = HUB.blue
    // Start pointing well away from the hub: holding fire has to bring it round.
    place(sim, p, h.x - 3, h.z + 0.6, 2.0)
    run(sim, 5, { fire: true })
    run(sim, 2, {})
    report.push(`${spec.label} ${sim.stats.made}/${sim.stats.fired}`)
    assert.ok(sim.stats.fired >= 10, `${spec.label} fired ${sim.stats.fired}`)
    assert.ok(sim.stats.made >= sim.stats.fired * 0.6, `${spec.label} made ${sim.stats.made}/${sim.stats.fired}`)
    destroySim(sim)
  }
  console.log('      ', report.join('  '))
})

await t('a wide shooter feeds each lane on its own: a ragged stream across its width, never a row at a time', () => {
  for (const [num, lanes] of [[254, 4], [2481, 4], [5805, 3], [1690, 1]]) {
    const spec = byNum(num)
    assert.equal(spec.shot.exits.length, lanes, `${num} exits`)
    const sim = solo(spec)
    const p = sim.robots[0]
    p.carry = spec.capacity
    place(sim, p, HUB.blue.x - 3, HUB.blue.z, -spec.shot.yaw) // shooter along +x: across the shooter is z
    const seen = new Set(sim.balls)
    const places = new Set()
    let most = 0
    let height = null
    let since = null
    for (let i = 0; i < 2 / DT; i++) {
      step(sim, { fire: true })
      let now = 0
      for (const b of sim.balls) {
        if (seen.has(b)) continue
        seen.add(b)
        now++
        const at = b.body.translation()
        places.add(Math.round((at.z - p.z) / 0.06))
        if (height == null) height = at.y
      }
      most = Math.max(most, now)
      if (now && since == null) since = sim.clock
    }
    assert.ok(sim.stats.fired >= 8, `${num} fired ${sim.stats.fired}`)
    // Together the lanes make the shooter's rate.
    const rate = (sim.stats.fired - 1) / (sim.clock - since)
    assert.ok(Math.abs(rate - spec.fireRate) < spec.fireRate * 0.3, `${num}: ${rate.toFixed(1)} a second, built for ${spec.fireRate}`)
    if (lanes > 1) {
      assert.ok(most < lanes, `${num}: ${most} balls left at the same instant`)
      assert.ok(places.size >= lanes, `${num}: fuel left from ${places.size} places across the shooter`)
    } else {
      assert.equal(most, 1, `${num}: one at a time`)
    }
    // They leave from the shooter, not from above the middle of the robot.
    assert.ok(Math.abs(height - (spec.shot.origin.y + 0.04)) < 0.15, `${num}: released at ${height.toFixed(2)} m, shooter at ${spec.shot.origin.y.toFixed(2)}`)
    destroySim(sim)
  }
})

await t('robots differ at shooting on the move: one built for it scores at a run, one that is not has to slow down', () => {
  const h = HUB.blue
  // Drive across the front of the hub at `speed`, holding fire the whole way.
  const pass = (spec, speed) => {
    const sim = solo(spec)
    const p = sim.robots[0]
    p.carry = spec.capacity
    place(sim, p, h.x - 2.6, h.z - 2.0, -spec.shot.yaw)
    run(sim, 4 / speed, { vx: 0, vz: speed / spec.speed, fire: true })
    run(sim, 2.5, {})
    const out = { made: sim.stats.made, fired: sim.stats.fired, share: sim.stats.made / Math.max(1, sim.stats.fired) }
    destroySim(sim)
    return out
  }
  const limits = new Set(SPECS.map((s) => s.shot.moveSpeed))
  assert.ok(limits.size >= 12, `only ${limits.size} different limits among ${SPECS.length} robots`)
  const report = []
  for (const num of [2481, 1690]) {
    const r = pass(byNum(num), 2)
    report.push(`${num} at 2 m/s ${r.made}/${r.fired}`)
    assert.ok(r.fired >= 12 && r.share >= 0.7, `${num} (good to ${byNum(num).shot.moveSpeed} m/s) made ${r.made}/${r.fired} at 2 m/s`)
  }
  for (const num of [254, 9785]) {
    const fast = pass(byNum(num), 2)
    const slow = pass(byNum(num), 0.25)
    report.push(`${num} at 2 m/s ${fast.made}/${fast.fired}, at 0.25 m/s ${slow.made}/${slow.fired}`)
    assert.ok(fast.share <= 0.35, `${num} (good to ${byNum(num).shot.moveSpeed} m/s) made ${fast.made}/${fast.fired} at 2 m/s`)
    assert.ok(slow.share >= 0.8, `${num} made ${slow.made}/${slow.fired} creeping`)
  }
  console.log('      ', report.join('  '))
})

await t('a fixed shooter has to face the hub; a turret leaves the chassis alone', () => {
  // Fixed: the chassis ends up pointing its shooter at the hub.
  const a = solo(byNum(254))
  const pa = a.robots[0]
  pa.carry = 4
  place(a, pa, HUB.blue.x - 3, HUB.blue.z + 1, 2.5)
  run(a, 2, { fire: true })
  const bearing = Math.atan2(HUB.blue.z - pa.z, HUB.blue.x - pa.x)
  assert.ok(Math.abs(Math.atan2(Math.sin(bearing - pa.psi), Math.cos(bearing - pa.psi))) < 0.08, 'the robot turned to the hub')
  destroySim(a)
  // Turret (one with all-round travel): the chassis keeps the heading it had.
  const b = solo(byNum(1323))
  const pb = b.robots[0]
  pb.carry = 6
  place(b, pb, HUB.blue.x - 3, HUB.blue.z + 1, 2.5)
  run(b, 2.5, { fire: true })
  assert.ok(Math.abs(pb.psi - 2.5) < 0.05, `the chassis turned to ${pb.psi.toFixed(2)}`)
  assert.ok(b.stats.fired >= 6, `the turret fired ${b.stats.fired}`)
  destroySim(b)
})

await t('out of range it lines up but holds fire', () => {
  const sim = solo(byNum(254))
  const p = sim.robots[0]
  place(sim, p, HUB.blue.x - 1.05, HUB.blue.z, 0) // bumper against the hub: too close
  run(sim, 1.5, { fire: true })
  assert.equal(sim.stats.fired, 0)
  assert.equal(p.aim.state, 'near')
  destroySim(sim)
})

await t('special: passes fuel home from midfield, climbs when it can', () => {
  // A robot with no climber, in the neutral zone.
  const sim = solo(byNum(254))
  const p = sim.robots[0]
  p.carry = 16
  place(sim, p, 9.5, 2.2, 1)
  const before = new Set(sim.balls)
  run(sim, 2.5, { special: true })
  run(sim, 2.5, {})
  const thrown = sim.balls.filter((b) => !before.has(b) && b.alive)
  const home = thrown.filter((b) => b.body.translation().x < HUB.blue.x - 0.3)
  assert.ok(sim.stats.passed >= 12, `passed ${sim.stats.passed}`)
  assert.equal(sim.stats.fired, 0, 'a pass is not a shot at the hub')
  assert.ok(home.length >= thrown.length * 0.6, `${home.length} of ${thrown.length} passes ended up in the alliance zone`)
  destroySim(sim)
  // A climber, in front of its tower in the endgame.
  const spec = SPECS.find((s) => s.climb > 0)
  const c = createSim(R, { field, lineup: { blue: [spec], red: [] }, mode: 'solo', seed: 4 })
  const q = c.robots[0]
  place(c, q, TOWER.blue.x + TOWER.zone.from + 0.6, TOWER.blue.z, Math.PI)
  c.clock = MATCH.endgame + 1
  run(c, 0.2, { special: true })
  assert.equal(q.climb.state, 'climbing')
  destroySim(c)
})

await t('a climber climbs in the endgame, in front of its tower', () => {
  const spec = SPECS.find((s) => s.climb > 0)
  const sim = createSim(R, { field, lineup: { blue: [spec], red: [] }, mode: 'solo', seed: 4 })
  const p = sim.robots[0]
  const zoneX = TOWER.blue.x + TOWER.zone.from + 0.6
  place(sim, p, zoneX, TOWER.blue.z, Math.PI)
  sim.clock = MATCH.auto + 1
  run(sim, 0.2, { climb: true })
  assert.equal(p.climb.state, 'none', 'no climbing before the endgame')
  sim.clock = MATCH.endgame + 1
  run(sim, 0.2, { climb: true })
  assert.equal(p.climb.state, 'climbing')
  while (!sim.over) step(sim, {})
  assert.equal(result(sim).climb, spec.climb)
  destroySim(sim)
})

await t('starting fuel is the real layout: 360 at midfield, 24 per depot and outpost', () => {
  const sim = solo(byNum(254))
  const alive = sim.balls.filter((b) => b.alive).map((b) => b.body.translation())
  const mid = alive.filter((p) => p.x > 7 && p.x < 9.5)
  assert.equal(mid.length, 360)
  assert.equal(alive.length, 408)
  assert.equal(sim.outpost.blue + sim.outpost.red, 48)
  // The block sits on the centre line, and the depots inside their frames.
  const cx = mid.reduce((s, p) => s + p.x, 0) / mid.length
  assert.ok(Math.abs(cx - FIELD.L / 2) < 0.02, `midfield block centred at x=${cx.toFixed(3)}`)
  const depot = alive.filter((p) => p.x < 1)
  assert.equal(depot.length, 24)
  assert.ok(depot.every((p) => Math.abs(p.z - DEPOT.blue.z) < 0.5), 'blue depot fuel in the blue depot')
  destroySim(sim)
})

await t('the outpost feeds a robot parked intake-first at its chute, intake running', () => {
  const spec = byNum(1690)
  const sim = solo(spec)
  const p = sim.robots[0]
  p.carry = 0
  const psi = intakeFirst(spec, Math.PI) // toward the alliance wall
  place(sim, p, 0.65, OUTPOST.blue.z, psi)
  run(sim, 1, { aim: psi })
  assert.equal(p.carry, 0, 'nothing without the intake running')
  run(sim, 2, { aim: psi, intake: true })
  assert.ok(p.carry >= 10, `fed ${p.carry}`)
  destroySim(sim)
})

await t('rays: the hub and walls are solid, nets only block a view, the invisible box blocks nothing', () => {
  const sim = solo(byNum(254))
  step(sim, {})
  const h = HUB.blue
  // Straight at the hub's body from the alliance side.
  const hit = rayField(sim, h.x - 3, 0.6, h.z, 1, 0, 0, 6)
  assert.ok(hit != null && Math.abs(hit - (3 - HUB.size / 2)) < 0.1, `hub at ${hit}`)
  // Through the net behind the hub, above its rim: nothing solid, but it does block a view.
  assert.equal(rayField(sim, h.x + 0.2, 2.6, h.z, 1, 0, 0, 3), null)
  assert.ok(rayField(sim, h.x + 0.2, 2.6, h.z, 1, 0, 0, 3, true) != null, 'a camera would be looking through the net')
  // Up and out over the field: the invisible box does not stop it.
  assert.equal(rayField(sim, 3, 3.2, WALL_Z, -1, 0, 0, 6), null)
  destroySim(sim)
})

// ------------------------------------------------------------------ modes
await t('skills ends at 60 s with the hub always live; practice runs until stopped', () => {
  const sk = createSim(R, { field, lineup: { blue: [byNum(5805)], red: [] }, mode: 'skills', seed: 9 })
  assert.equal(sk.robots.length, 1)
  while (!sk.over) step(sk, {})
  assert.ok(Math.abs(sk.clock - 60) < 1e-6)
  destroySim(sk)
  const pr = createSim(R, { field, lineup: { blue: [byNum(5805)], red: [] }, mode: 'practice', seed: 9 })
  run(pr, 400, {})
  assert.ok(!pr.over && hubLive(pr, 'blue'))
  endNow(pr)
  assert.ok(pr.over)
  destroySim(pr)
})

// ------------------------------------------------------------------ realism
await t('with realism off nothing breaks and there is no battery', () => {
  const sim = solo(byNum(254))
  const p = sim.robots[0]
  assert.equal(p.health.on, false)
  place(sim, p, 1.2, WALL_Z, Math.PI)
  run(sim, 4, { vx: -1, vz: 0, aim: Math.PI, intake: true }) // into the wall
  assert.equal(sim.faultLog.length, 0)
  destroySim(sim)
})

await t('pushing a wall while shooting browns a brutal battery out', () => {
  const sim = solo(byNum(254), { realism: 'brutal', seed: 3 })
  const p = sim.robots[0]
  p.carry = 60
  place(sim, p, 1.2, WALL_Z, 0)
  let cut = 0
  for (let i = 0; i < 6 / DT; i++) {
    step(sim, { vx: -1, vz: 0, intake: true, fire: true })
    if (p.limits.disabled) cut++
  }
  assert.ok(p.health.brownouts > 0, `min ${p.health.minVolts.toFixed(2)} V, no brownout`)
  assert.ok(p.health.minVolts < 6.8)
  assert.ok(cut > 0, 'the motors were cut')
  assert.ok(p.health.soc < 1)
  destroySim(sim)
})

await t('cruising does not brown out a realistic battery', () => {
  const sim = solo(byNum(254), { realism: 'real', seed: 5 })
  const p = sim.robots[0]
  place(sim, p, 2.6, 5, 0)
  for (let k = 0; k < 4; k++) {
    run(sim, 1, { vx: 0, vz: 1, aim: 0 })
    run(sim, 1, { vx: 0, vz: -1, aim: 0 })
  }
  assert.equal(p.health.brownouts, 0, `min ${p.health.minVolts.toFixed(2)} V`)
  destroySim(sim)
})

await t('hard hits can break a deployed intake, and a broken intake picks nothing up', () => {
  const sim = solo(byNum(1690), { realism: 'brutal', seed: 7 })
  const p = sim.robots[0]
  p.health.resistance = 0.01 // a fresh battery, so it is the hits that matter here
  let hits = 0
  while (!p.health.intakeBroken && hits < 40) {
    place(sim, p, 2.4, WALL_Z, Math.PI)
    run(sim, 1, { vx: -1, vz: 0, aim: Math.PI, intake: true }) // slam the wall, intake out
    hits++
  }
  assert.ok(p.health.intakeBroken, 'never broke')
  assert.ok(sim.faultLog.some((f) => f.type === 'intake' && f.player))
  p.carry = 0
  const psi = intakeFirst(p.a)
  place(sim, p, 6.2, 3.0, psi)
  run(sim, 2.5, { vx: 1, vz: 0, aim: psi, intake: true })
  assert.equal(p.carry, 0)
  destroySim(sim)
})

await t('a jam stops the shooter for a while, a radio drop stops the robot', () => {
  const sim = solo(byNum(254), { realism: 'brutal', seed: 8 })
  const p = sim.robots[0]
  p.health.cfg = { ...p.health.cfg, jamPerShot: 1, commsPerMin: 0, breakPerMin: 0 }
  noteShot(sim, p)
  assert.ok(p.health.jam > 1)
  step(sim, {})
  assert.equal(p.limits.shoot, false)
  p.health.jam = 0
  p.health.comms = 2
  step(sim, { vx: 1 })
  assert.equal(p.limits.disabled, true)
  destroySim(sim)
})

await t('a brutal AI match still runs clean', () => {
  const lineup = { blue: [byNum(254), byNum(1690), byNum(5805)], red: [byNum(2910), byNum(971), byNum(1678)] }
  const sim = createSim(R, { field, lineup, mode: 'match', realism: 'brutal', demo: true, seed: 21 })
  const total = countFuel(sim)
  while (!sim.over) step(sim)
  assert.equal(countFuel(sim), total)
  const kinds = [...new Set(sim.faultLog.map((f) => f.type))]
  console.log('      ', `${sim.score.blue.total}-${sim.score.red.total}, faults: ${sim.faultLog.length} (${kinds.join(', ')})`)
  assert.ok(sim.faultLog.length > 0, 'brutal produced no faults')
  destroySim(sim)
})

// ------------------------------------------------------------------ whole matches
function playMatch(opts) {
  const sim = createSim(R, { field, ...opts })
  const total = countFuel(sim)
  while (!sim.over) {
    step(sim)
    if (sim.clock > 0 && Math.round(sim.clock / DT) % 120 === 0) {
      for (const r of sim.robots) {
        assert.ok(Number.isFinite(r.x + r.z + r.psi), 'robot NaN')
        assert.ok(r.x > -0.3 && r.x < FIELD.L + 0.3 && r.z > -0.3 && r.z < FIELD.W + 0.3, `${r.label} left the field`)
      }
      assert.equal(countFuel(sim), total, 'fuel is conserved')
    }
  }
  const res = result(sim)
  const climbs = sim.robots.filter((r) => r.climb.state === 'done').map((r) => `${r.label}:L${r.climb.level}`)
  destroySim(sim)
  return { res, climbs }
}

const pickSix = (seed) => {
  const pool = [...SPECS]
  let a = seed
  const rnd = () => ((a = (a * 1103515245 + 12345) >>> 0) / 2 ** 32)
  pool.sort(() => rnd() - 0.5)
  return { blue: pool.slice(0, 3), red: pool.slice(3, 6) }
}

for (const [difficulty, seed] of [['rookie', 11], ['regional', 12], ['einstein', 13]]) {
  await t(`AI-only ${difficulty} match with real robots: both alliances score`, () => {
    const lineup = pickSix(seed)
    const started = performance.now()
    const { res, climbs } = playMatch({ difficulty, seed, demo: true, lineup, mode: 'match' })
    console.log(
      '      ',
      `${lineup.blue.map((s) => s.label).join(',')} v ${lineup.red.map((s) => s.label).join(',')}: ` +
        `${res.blue.total}-${res.red.total} (fuel ${res.blue.fuel}/${res.red.fuel}, wasted ${res.blue.wasted}/${res.red.wasted}) ` +
        `${climbs.join(' ')} ${((performance.now() - started) / 1000).toFixed(1)} s`,
    )
    assert.ok(res.blue.fuel >= 15 && res.red.fuel >= 15, `too little fuel scored: ${res.blue.fuel}/${res.red.fuel}`)
  })
}

if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall arcade tests passed')
