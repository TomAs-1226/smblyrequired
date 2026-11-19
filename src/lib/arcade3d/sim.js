// Cycle Rush 3D — the physics match. Rapier does the rigid-body physics (robots
// pushing each other and plowing through fuel, fuel bouncing off hub rims and
// rolling over bumps); this file adds what a physics engine does not know:
// swerve drive with traction limits, intakes, shooters, air drag, scoring, the
// hub shifts, and climbing.
//
// Rapier is passed in, already initialised, so the browser and the Node tests
// can each load it their own way. Nothing here touches the DOM.
import {
  FIELD, FUEL, HUB, TRENCH, BUMP, LANES, TOWER, LAYOUT, OUTPOST, MATCH, POINTS,
  ARCHETYPES, ARCHETYPE_IDS, PRELOAD, DIFFICULTY, PARTNER, PLAYER_SPREAD, mirror,
} from './config.js'
import { periodOf, hubActive } from './rules.js'
import { solveShot, launchVelocity } from './ballistics.js'
import { think } from './ai.js'

export const DT = 1 / 60

export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

// Field heading ψ is measured in the floor plane from +x toward +z. Rapier's
// yaw θ is a right-handed turn about +y, which runs the other way: ψ = -θ.
const quatFromPsi = (psi) => ({ x: 0, y: Math.sin(-psi / 2), z: 0, w: Math.cos(-psi / 2) })
const psiFromQuat = (q) => -2 * Math.atan2(q.y, q.w)

// ------------------------------------------------------------------ world
function buildField(R, world) {
  const fixed = (desc, x, y, z) => {
    const body = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(x, y, z))
    world.createCollider(desc.setFriction(0.8), body)
  }
  const box = (hx, hy, hz) => R.ColliderDesc.cuboid(hx, hy, hz)

  // carpet and walls (walls are tall and invisible above the rail, so fuel stays in)
  fixed(box(FIELD.L / 2 + 1, 0.05, FIELD.W / 2 + 1), FIELD.L / 2, -0.05, FIELD.W / 2)
  const wallH = 1.5
  fixed(box(0.05, wallH, FIELD.W / 2), -0.05, wallH, FIELD.W / 2)
  fixed(box(0.05, wallH, FIELD.W / 2), FIELD.L + 0.05, wallH, FIELD.W / 2)
  fixed(box(FIELD.L / 2, wallH, 0.05), FIELD.L / 2, wallH, -0.05)
  fixed(box(FIELD.L / 2, wallH, 0.05), FIELD.L / 2, wallH, FIELD.W + 0.05)

  for (const team of ['blue', 'red']) {
    const h = HUB[team]
    // Hub: four walls round an open top. Fuel that drops inside is scored.
    const hs = HUB.size / 2
    const t = HUB.wall / 2
    fixed(box(t, HUB.top / 2, hs), h.x - hs + t, HUB.top / 2, h.z)
    fixed(box(t, HUB.top / 2, hs), h.x + hs - t, HUB.top / 2, h.z)
    fixed(box(hs, HUB.top / 2, t), h.x, HUB.top / 2, h.z - hs + t)
    fixed(box(hs, HUB.top / 2, t), h.x, HUB.top / 2, h.z + hs - t)

    // Bumps either side of the hub, a trench wall, then the trench lane.
    const flip = team === 'red'
    const zs = (z) => (flip ? FIELD.W - z : z)
    for (const [a, b] of BUMP.spans) {
      const z0 = Math.min(zs(a), zs(b))
      const z1 = Math.max(zs(a), zs(b))
      const pts = []
      for (const z of [z0, z1]) {
        pts.push(-BUMP.depth / 2, 0, z, BUMP.depth / 2, 0, z, -BUMP.top / 2, BUMP.height, z, BUMP.top / 2, BUMP.height, z)
      }
      const body = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(h.x, 0, 0))
      world.createCollider(R.ColliderDesc.convexHull(new Float32Array(pts)).setFriction(0.9), body)
    }
    const trenchH = TRENCH.clearance + TRENCH.roof
    for (const side of [0, 1]) {
      const wallZ = zs(side ? FIELD.W - TRENCH.wall.z : TRENCH.wall.z)
      const laneZ = zs(side ? LANES.trench[1] : LANES.trench[0])
      fixed(box(TRENCH.depth / 2, trenchH / 2, TRENCH.wall.t / 2), h.x, trenchH / 2, wallZ)
      fixed(box(TRENCH.depth / 2, TRENCH.roof / 2, TRENCH.width / 2), h.x, TRENCH.clearance + TRENCH.roof / 2, laneZ)
    }

    // The tower's two uprights.
    const tw = TOWER[team]
    const u = TOWER.upright
    for (const dz of [-TOWER.gap / 2, TOWER.gap / 2]) {
      fixed(box(u.x / 2, u.h / 2, u.z / 2), tw.x, u.h / 2, tw.z + dz)
    }
  }
}

function makeRobot(R, world, spec) {
  const a = ARCHETYPES[spec.arch]
  const body = world.createRigidBody(
    R.RigidBodyDesc.dynamic()
      .setTranslation(spec.x, a.height / 2 + 0.005, spec.z)
      .setRotation(quatFromPsi(spec.psi))
      .setLinearDamping(0.3)
      .setAngularDamping(2)
      .setCanSleep(false)
      .setCcdEnabled(true),
  )
  body.setEnabledRotations(false, true, false, true)
  world.createCollider(
    // No contact friction: the chassis is not what grips. Traction is the drive's
    // acceleration limit, and a frictionless box slides up a bump the way wheels roll.
    R.ColliderDesc.cuboid(a.len / 2, a.height / 2, a.wid / 2)
      .setMass(a.mass)
      .setFriction(0)
      .setFrictionCombineRule(R.CoefficientCombineRule.Min)
      .setRestitution(0.05),
    body,
  )
  return {
    ...spec,
    a,
    body,
    restY: a.height / 2 + 0.005,
    carry: PRELOAD,
    cooldown: 0,
    intakeBudget: 2,
    turretYaw: spec.psi,
    climb: { state: 'none', level: 0, t: 0, from: null },
    x: spec.x, z: spec.z, vx: 0, vz: 0, psi: spec.psi,
    ai: { slot: spec.slot },
    cmd: null,
  }
}

// ------------------------------------------------------------------ setup
export function createSim(R, { difficulty = 'regional', arch = 'turret', seed = (Date.now() & 0x7fffffff), demo = false } = {}) {
  const rng = mulberry32(seed)
  const world = new R.World({ x: 0, y: -9.81, z: 0 })
  world.timestep = DT
  buildField(R, world)

  const redCfg = DIFFICULTY[difficulty] || DIFFICULTY.regional
  const pick = (exclude = []) => {
    const pool = ARCHETYPE_IDS.filter((id) => !exclude.includes(id))
    return pool[Math.floor(rng() * pool.length)]
  }
  const playerArch = ARCHETYPES[arch] ? arch : 'turret'
  const blueArchs = [playerArch, pick([playerArch]), pick()]
  const redArchs = [pick(), pick(), redCfg.defend ? 'bruiser' : pick()]

  const startX = 3.45
  const slots = [2.35, 0.75, 5.75]
  const robots = []
  blueArchs.forEach((id, i) => {
    robots.push(makeRobot(R, world, {
      id: `b${i}`, team: 'blue', label: i === 0 ? '5805' : `B${i + 1}`, arch: id,
      isPlayer: i === 0 && !demo, cfg: i === 0 ? { ...PARTNER, ...PLAYER_SPREAD } : PARTNER,
      x: startX, z: slots[i], psi: 0, slot: [-0.75, 0, 0.75][i],
    }))
  })
  redArchs.forEach((id, i) => {
    const p = mirror({ x: startX, z: slots[i] })
    const r = makeRobot(R, world, {
      id: `r${i}`, team: 'red', label: `R${i + 1}`, arch: id, isPlayer: false, cfg: redCfg,
      x: p.x, z: p.z, psi: Math.PI, slot: [-0.75, 0, 0.75][i],
    })
    if (redCfg.defend && i === 2) r.ai.role = 'defender'
    robots.push(r)
  })

  const sim = {
    R, world, rng, difficulty, demo,
    clock: -MATCH.countdown,
    period: 'countdown',
    autoFuel: { blue: 0, red: 0 },
    autoWinner: null,
    robots,
    balls: [],
    queue: [],
    score: {
      blue: { total: 0, fuel: 0, auto: 0, climb: 0, wasted: 0 },
      red: { total: 0, fuel: 0, auto: 0, climb: 0, wasted: 0 },
    },
    stats: { fired: 0, made: 0 },
    events: [],
    outpost: { blue: OUTPOST.holds, red: OUTPOST.holds },
    outpostTimer: { blue: 0, red: 0 },
    over: false,
  }

  // Fuel where the field crew sets it: the midfield block and both depots.
  const { pitch, centre, depots } = LAYOUT
  const lay = (g) => {
    for (let i = 0; i < g.nx; i++) {
      for (let j = 0; j < g.nz; j++) {
        const x = clamp(g.x + i * pitch.x, FUEL.r + 0.005, FIELD.L - FUEL.r - 0.005)
        const z = clamp(g.z + j * pitch.z, FUEL.r + 0.005, FIELD.W - FUEL.r - 0.005)
        addBall(sim, x, FUEL.r + 0.001, z, null, null, true)
      }
    }
  }
  lay(centre)
  lay(depots.blue)
  lay(depots.red)
  return sim
}

function addBall(sim, x, y, z, vel, shooter, resting = false) {
  const { R, world } = sim
  // Starting fuel begins asleep: 400 touching balls settle instantly that way,
  // and wake the moment a robot or another ball touches them.
  const desc = R.RigidBodyDesc.dynamic().setTranslation(x, y, z).setAngularDamping(1.2).setCcdEnabled(true)
  if (resting) desc.setSleeping(true)
  const body = world.createRigidBody(desc)
  world.createCollider(
    R.ColliderDesc.ball(FUEL.r).setMass(FUEL.mass).setRestitution(0.45).setFriction(0.7),
    body,
  )
  if (vel) body.setLinvel(vel, true)
  const ball = { body, alive: true, shooter: shooter || null, air: Boolean(vel) }
  sim.balls.push(ball)
  return ball
}

function removeBall(sim, ball) {
  ball.alive = false
  sim.world.removeRigidBody(ball.body)
  ball.body = null
}

// ------------------------------------------------------------------ step
/**
 * Advance one physics step. `input` drives the player's robot:
 * { vx, vz } field-relative (length ≤ 1), `aim` a target heading or null,
 * `turn` −1..1, `fire`, `climb`.
 */
export function step(sim, input = {}) {
  if (sim.over) return sim
  const before = sim.clock
  sim.clock += DT
  sim.period = periodOf(sim.clock)
  if (before < MATCH.auto && sim.clock >= MATCH.auto) {
    sim.autoWinner = sim.autoFuel.blue >= sim.autoFuel.red ? 'blue' : 'red'
  }
  if (sim.period === 'over') return finish(sim)

  for (const r of sim.robots) sample(r)

  const live = sim.period !== 'countdown'
  for (const r of sim.robots) {
    r.cooldown = Math.max(0, r.cooldown - DT)
    r.intakeBudget = Math.min(2, r.intakeBudget + 16 * DT)
    // The player's robot runs its own auto routine; the driver takes over at teleop.
    r.autopilot = !r.isPlayer || sim.period === 'auto'
    let cmd
    if (!live) cmd = { vx: 0, vz: 0, aim: null, fire: false }
    else if (!r.autopilot) cmd = input
    else cmd = think(sim, r, DT)
    r.cmd = cmd
    if (r.a.turret) {
      // The turret tracks its hub all the time; it fires only once it is on target.
      const h = HUB[r.team]
      const want = Math.atan2(h.z - r.z, h.x - r.x)
      r.turretYaw = wrap(r.turretYaw + clamp(wrap(want - r.turretYaw), -10 * DT, 10 * DT))
    }
    if (r.climb.state !== 'none') { climbStep(sim, r, cmd); continue }
    drive(r, cmd)
    if (live && cmd.fire) shoot(sim, r)
    if (live && cmd.climb) startClimb(sim, r)
  }

  sim.world.step()
  afterStep(sim)
  return sim
}

function sample(r) {
  const t = r.body.translation()
  const v = r.body.linvel()
  r.x = t.x; r.z = t.z; r.y = t.y
  r.vx = v.x; r.vz = v.z
  r.psi = psiFromQuat(r.body.rotation())
}

function drive(r, cmd) {
  const { a, body } = r
  let vx = cmd.vx || 0
  let vz = cmd.vz || 0
  const m = Math.hypot(vx, vz)
  if (m > 1) { vx /= m; vz /= m }
  const max = a.speed * (r.autopilot ? r.cfg.speed : 1)
  // Traction- and motor-limited: the change in velocity per step is capped.
  let dvx = vx * max - r.vx
  let dvz = vz * max - r.vz
  const dl = Math.hypot(dvx, dvz)
  const lim = a.accel * DT
  if (dl > lim) { dvx *= lim / dl; dvz *= lim / dl }
  const mass = body.mass()
  body.applyImpulse({ x: dvx * mass, y: 0, z: dvz * mass }, true)

  let w = 0
  if (cmd.aim != null) w = clamp(wrap(cmd.aim - r.psi) * 10, -a.yawRate, a.yawRate)
  else if (cmd.turn) w = clamp(cmd.turn, -1, 1) * a.yawRate * 0.7
  body.setAngvel({ x: 0, y: -w, z: 0 }, true)
}

function gauss(rng) {
  const u = Math.max(rng(), 1e-9)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())
}

export function shooterOrigin(r) {
  const fwd = r.a.turret ? 0 : r.a.len * 0.2
  return { x: r.x + Math.cos(r.psi) * fwd, y: r.a.height + 0.12, z: r.z + Math.sin(r.psi) * fwd }
}
export const shotTarget = (team) => ({ x: HUB[team].x, y: HUB.top + 0.05, z: HUB[team].z })

/** What this robot's shooter would do right now, without firing. */
export function aimNow(r) {
  const from = shooterOrigin(r)
  const vel = { x: r.vx, z: r.vz }
  const sol = solveShot(from, shotTarget(r.team), vel, r.a.hood, r.a.exit, r.a.turret)
  return { from, vel, sol }
}

function shoot(sim, r) {
  if (r.carry <= 0 || r.cooldown > 0) return
  const { from, vel, sol } = aimNow(r)
  let speed
  let yaw
  if (r.a.turret) {
    if (!sol) return // a turret only fires when it has a solution
    const turn = wrap(sol.yaw - r.turretYaw)
    r.turretYaw = wrap(r.turretYaw + clamp(turn, -10 * DT, 10 * DT))
    if (Math.abs(wrap(sol.yaw - r.turretYaw)) > 0.06) return
    speed = sol.speed
    yaw = sol.yaw
  } else {
    // A fixed shooter ranges off distance but throws wherever the robot faces.
    speed = sol ? sol.speed : r.a.exit * 0.75
    yaw = r.psi
  }
  speed *= 1 + gauss(sim.rng) * r.cfg.spreadSpeed
  yaw += gauss(sim.rng) * r.cfg.spreadYaw
  const v = launchVelocity(speed, yaw, r.a.hood, vel)
  addBall(sim, from.x, from.y, from.z, v, r)
  r.carry--
  r.cooldown = 1 / r.a.fireRate
  if (r.isPlayer) sim.stats.fired++
}

// ------------------------------------------------------------------ climbing
export function inClimbZone(r) {
  const tw = TOWER[r.team]
  const s = r.team === 'blue' ? 1 : -1
  const d = s * (r.x - tw.x) - TOWER.zone.from
  return d > 0 && d < TOWER.zone.depth && Math.abs(r.z - tw.z) < TOWER.zone.width / 2
}

function startClimb(sim, r) {
  if (r.climb.state !== 'none' || r.a.climb === 0) return
  if (sim.period !== 'endgame' || !inClimbZone(r)) return
  r.climb = { state: 'climbing', level: r.a.climb, t: 0, from: { x: r.x, y: r.y, z: r.z } }
  r.body.setBodyType(sim.R.RigidBodyType.KinematicPositionBased, true)
}

function climbStep(sim, r) {
  const c = r.climb
  if (c.state === 'climbing') {
    c.t += DT
    if (c.t >= r.a.climbTime) c.state = 'done'
  }
  const u = Math.min(1, c.t / r.a.climbTime)
  const lift = TOWER.rungs[c.level - 1] * 0.62 * (u * u * (3 - 2 * u))
  r.body.setNextKinematicTranslation({ x: c.from.x, y: c.from.y + lift, z: c.from.z })
}

// ------------------------------------------------------------------ after physics
function afterStep(sim) {
  const ro = sim.robots
  const inner = HUB.inner / 2
  for (const ball of sim.balls) {
    if (!ball.alive) continue
    const b = ball.body
    const p = b.translation()
    const v = b.linvel()
    const speed = Math.hypot(v.x, v.y, v.z)

    // Air drag in flight; rolling resistance on the carpet.
    if (p.y > FUEL.r + 0.03) {
      const k = FUEL.K * speed * DT
      b.setLinvel({ x: v.x * (1 - k), y: v.y * (1 - k), z: v.z * (1 - k) }, true)
    } else {
      const f = Math.exp(-1.1 * DT)
      b.setLinvel({ x: v.x * f, y: v.y, z: v.z * f }, true)
      if (ball.air && speed < 2) ball.air = false
    }

    // Scored: inside a hub's opening, on the way down.
    let scored = false
    for (const team of ['blue', 'red']) {
      const h = HUB[team]
      if (Math.abs(p.x - h.x) < inner && Math.abs(p.z - h.z) < inner && p.y < HUB.top - 0.12 && p.y > 0.25) {
        award(sim, team, ball, p)
        removeBall(sim, ball)
        scored = true
        break
      }
    }
    if (scored) continue

    // Intakes: fuel on the floor, just in front of a robot, inside its intake width.
    if (p.y < 0.22) {
      for (const r of ro) {
        if (r.carry >= r.a.capacity || r.climb.state !== 'none' || r.intakeBudget < 1) continue
        const dx = p.x - r.x
        const dz = p.z - r.z
        if (dx * dx + dz * dz > 1.2) continue
        const c = Math.cos(r.psi)
        const s = Math.sin(r.psi)
        const fwd = dx * c + dz * s
        const side = -dx * s + dz * c
        if (fwd > r.a.len / 2 - 0.06 && fwd < r.a.len / 2 + 0.2 && Math.abs(side) < r.a.intake / 2) {
          r.carry++
          r.intakeBudget -= 1
          removeBall(sim, ball)
          break
        }
      }
    }
  }
  if (sim.balls.length > 700) sim.balls = sim.balls.filter((b) => b.alive)

  // Scored fuel comes back out of the hub's four exits into the neutral zone.
  for (const q of sim.queue) q.t -= DT
  while (sim.queue.length && sim.queue[0].t <= 0) {
    const q = sim.queue.shift()
    const h = HUB[q.team]
    const s = q.team === 'blue' ? 1 : -1
    const ex = HUB.exits[Math.floor(sim.rng() * HUB.exits.length)]
    const yaw = ((ex.yaw + (sim.rng() - 0.5) * 15) * Math.PI) / 180
    const pitch = ((-15 + (sim.rng() - 0.5) * 5) * Math.PI) / 180
    const speed = 2 + (sim.rng() - 0.5) * 0.2
    addBall(
      sim,
      h.x + s * HUB.exitOut,
      HUB.exitY,
      h.z + s * ex.dz,
      { x: s * Math.cos(yaw) * Math.cos(pitch) * speed, y: Math.sin(pitch) * speed, z: s * Math.sin(yaw) * Math.cos(pitch) * speed },
    )
  }

  // Outposts: a robot parked at the chute, intake to the wall, gets fed by the human player.
  for (const team of ['blue', 'red']) {
    sim.outpostTimer[team] = Math.max(0, sim.outpostTimer[team] - DT)
    if (sim.outpost[team] <= 0 || sim.outpostTimer[team] > 0) continue
    const o = OUTPOST[team]
    const toWall = team === 'blue' ? Math.PI : 0
    const r = ro.find((x) =>
      x.team === team && x.carry < x.a.capacity && x.climb.state === 'none' &&
      Math.hypot(x.x - o.x, x.z - o.z) < OUTPOST.reach && Math.cos(x.psi - toWall) > 0.7)
    if (!r) continue
    r.carry++
    sim.outpost[team]--
    sim.outpostTimer[team] = OUTPOST.feedEvery
  }
}

function award(sim, team, ball, p) {
  const active = hubActive(sim.clock, team, sim.autoWinner)
  const sc = sim.score[team]
  if (active) {
    sc.total += POINTS.fuel
    sc.fuel += 1
    if (sim.period === 'auto') { sc.auto += POINTS.fuel; sim.autoFuel[team]++ }
    if (ball.shooter?.isPlayer && ball.shooter.team === team) sim.stats.made++
  } else {
    sc.wasted += 1
  }
  sim.events.push({ kind: 'score', team, active, x: p.x, y: HUB.top + 0.3, z: p.z, at: sim.clock })
  sim.queue.push({ t: 1.4 + sim.rng() * 0.6, team })
}

function finish(sim) {
  sim.clock = MATCH.total
  sim.period = 'over'
  for (const r of sim.robots) {
    if (r.climb.state === 'done') {
      const pts = POINTS.climb[r.climb.level - 1]
      sim.score[r.team].climb += pts
      sim.score[r.team].total += pts
      sim.events.push({ kind: 'climb', team: r.team, level: r.climb.level, x: r.x, y: 2.2, z: r.z, at: sim.clock })
    }
  }
  sim.over = true
  return sim
}

export function result(sim) {
  const b = sim.score.blue.total
  const r = sim.score.red.total
  const player = sim.robots.find((x) => x.id === 'b0')
  return {
    outcome: b > r ? 'win' : b < r ? 'loss' : 'tie',
    blue: { ...sim.score.blue },
    red: { ...sim.score.red },
    fired: sim.stats.fired,
    made: sim.stats.made,
    climb: player.climb.state === 'done' ? player.climb.level : 0,
    autoWinner: sim.autoWinner,
  }
}

export function countFuel(sim) {
  return (
    sim.balls.filter((b) => b.alive).length +
    sim.queue.length +
    sim.outpost.blue + sim.outpost.red +
    sim.robots.reduce((n, r) => n + r.carry, 0)
  )
}

export function destroySim(sim) {
  sim.world.free()
}
