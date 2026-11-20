// Cycle Rush 3D — the physics match. Rapier does the rigid-body physics (robots
// pushing each other and plowing through fuel, fuel rolling down the hub funnel,
// off the nets and over bumps); this file adds what a physics engine does not
// know: swerve drive with traction limits, intakes, shooters, air drag, scoring,
// the hub shifts, climbing and the game modes.
//
// Inputs, all passed in so the browser and the Node tests can each load them
// their own way:
//   R       Rapier, already initialised
//   field   public/arcade/field.json (colliders in the game frame, plus constants)
//   lineup  { blue: [spec…], red: [spec…] } from robots.js; blue[0] is the player
// Nothing here touches the DOM.
//
// A robot is told what to do with a command, the same shape for the player and
// the computer:
//   vx, vz    drive, in the field's frame, length ≤ 1
//   turn      −1..1, spin left or right (eased in and out, never a snap)
//   aim       a heading to hold instead (the computer uses this)
//   fire      hold: aim at the hub and shoot when lined up, in range and spun up
//   special   hold: the robot's special. Climb if it can right now, else pass
//             fuel back to its own zone
//   intake    hold: intake out and running
//   climb, pass   the two halves of `special`, for callers that want one
import {
  FIELD, FUEL, HUB, TOWER, LAYOUT, OUTPOST, MATCH, POINTS,
  PRELOAD, DIFFICULTY, PARTNER, PLAYER_SPREAD, MODES, mirror,
} from './config.js'
import { periodOf, hubActive } from './rules.js'
import { solveShot, launchVelocity } from './ballistics.js'
import { tableElevation, hopperHoldsOpen } from './robots.js'
import { think } from './ai.js'
import { initHealth, faultStep, noteImpact, noteShot } from './faults.js'

export const DT = 1 / 60
const MAX_EXIT = 18 // m/s, the fastest any shooter here throws
const TURN_ACCEL = 55 // rad/s², how hard a robot can start or stop spinning
const BRAKE = 1.7 // a swerve stops and reverses harder than it gets going
const ROLL_DRAG = 1.1 // m/s²: foam on carpet. A ball shoved at 2 m/s rolls under two metres
const PASS_ELEVATION = 46

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

// Heading ψ is measured in the floor plane from +x toward +z (clockwise seen from
// above, in this right-handed frame). Rapier's yaw θ is a right-handed turn about
// +y, which runs the other way: ψ = -θ.
const quatFromPsi = (psi) => ({ x: 0, y: Math.sin(-psi / 2), z: 0, w: Math.cos(-psi / 2) })
const psiFromQuat = (q) => -2 * Math.atan2(q.y, q.w)

// Collision groups: membership in the high 16 bits, what it collides with in the low 16.
const G = { FIELD: 1, ROBOT: 2, FUEL: 4, FUEL_ONLY: 8, BOUND: 16 }
const groups = (member, filter) => (member << 16) | filter
const GROUP_FIELD = groups(G.FIELD, G.ROBOT | G.FUEL)
const GROUP_BOUND = groups(G.BOUND, G.ROBOT | G.FUEL) // the invisible box round the field
const GROUP_FUEL_ONLY = groups(G.FUEL_ONLY, G.FUEL) // nets: fuel hits them, robots do not
const GROUP_ROBOT = groups(G.ROBOT, G.FIELD | G.BOUND | G.ROBOT | G.FUEL)
const GROUP_FUEL = groups(G.FUEL, G.FIELD | G.BOUND | G.FUEL_ONLY | G.ROBOT | G.FUEL)
// A ball just leaving a shooter passes through robots: it starts inside one.
const GROUP_SHOT = groups(G.FUEL, G.FIELD | G.BOUND | G.FUEL_ONLY | G.FUEL)
// What a wheel stands on: the real field, not the nets or the invisible box.
const RAY_SOLID = groups(G.ROBOT, G.FIELD)
// What blocks a view: that, and the nets (see-through, but a camera behind one sees mostly net).
const RAY_SIGHT = groups(G.ROBOT | G.FUEL, G.FIELD | G.FUEL_ONLY)

// ------------------------------------------------------------------ world
function buildField(R, world, field) {
  const body = world.createRigidBody(R.RigidBodyDesc.fixed())
  const add = (desc, group = GROUP_FIELD) => world.createCollider(desc.setFriction(0.8).setCollisionGroups(group), body)

  // Carpet, and a tall invisible box so nothing leaves the field.
  add(R.ColliderDesc.cuboid(FIELD.L / 2 + 2, 0.05, FIELD.W / 2 + 2).setTranslation(FIELD.L / 2, -0.05, FIELD.W / 2))
  const H = 2.5
  add(R.ColliderDesc.cuboid(0.05, H, FIELD.W / 2 + 0.1).setTranslation(-0.06, H, FIELD.W / 2), GROUP_BOUND)
  add(R.ColliderDesc.cuboid(0.05, H, FIELD.W / 2 + 0.1).setTranslation(FIELD.L + 0.06, H, FIELD.W / 2), GROUP_BOUND)
  add(R.ColliderDesc.cuboid(FIELD.L / 2 + 0.1, H, 0.05).setTranslation(FIELD.L / 2, H, -0.06), GROUP_BOUND)
  add(R.ColliderDesc.cuboid(FIELD.L / 2 + 0.1, H, 0.05).setTranslation(FIELD.L / 2, H, FIELD.W + 0.06), GROUP_BOUND)

  let n = 0
  for (const c of field.colliders) {
    let desc
    if (c.kind === 'box') {
      desc = R.ColliderDesc.cuboid(c.size[0] / 2, c.size[1] / 2, c.size[2] / 2).setTranslation(...c.center)
    } else if (c.kind === 'hull') {
      desc = R.ColliderDesc.convexHull(new Float32Array(c.points))
      if (!desc) continue
    } else if (c.kind === 'cylinder') {
      desc = R.ColliderDesc.cylinder(c.length / 2, c.radius).setTranslation(...c.center)
      const [ax, ay, az] = c.axis
      const len = Math.hypot(ax, ay, az) || 1
      // Rapier's cylinder runs along +y; turn +y onto the axis.
      const ux = ax / len, uy = ay / len, uz = az / len
      const w = 1 + uy
      if (w < 1e-6) desc.setRotation({ x: 1, y: 0, z: 0, w: 0 })
      else {
        const q = { x: uz, y: 0, z: -ux, w }
        const m = Math.hypot(q.x, q.y, q.z, q.w)
        desc.setRotation({ x: q.x / m, y: 0, z: q.z / m, w: q.w / m })
      }
    } else continue
    if (c.fuelOnly) {
      // A net catches a ball: it kills the bounce and the ball drops.
      desc.setRestitution(0.02).setRestitutionCombineRule(R.CoefficientCombineRule.Min)
      add(desc, GROUP_FUEL_ONLY)
    } else {
      add(desc)
    }
    n++
  }
  return n
}

function makeRobot(R, world, spec, place) {
  const body = world.createRigidBody(
    R.RigidBodyDesc.dynamic()
      .setTranslation(place.x, 0.01, place.z)
      .setRotation(quatFromPsi(place.psi))
      .setLinearDamping(0.3)
      .setAngularDamping(2)
      .setCanSleep(false)
      .setCcdEnabled(true),
  )
  body.setEnabledRotations(false, true, false, true)
  // No contact friction: the chassis is not what grips. Traction is the drive's
  // acceleration limit, and a frictionless box slides up a bump the way wheels roll.
  const shape = (desc, mass) =>
    world.createCollider(
      desc.setMass(mass).setFriction(0).setFrictionCombineRule(R.CoefficientCombineRule.Min)
        .setRestitution(0.05).setCollisionGroups(GROUP_ROBOT),
      body,
    )
  // The robot stands on its wheels: a sphere at each swerve module rolls over the
  // field's lips and seams the way a wheel does. The bumper box above them carries
  // the mass and does the pushing.
  const wr = spec.wheelRadius
  for (const [mx, mz] of spec.modules) shape(R.ColliderDesc.ball(wr).setTranslation(mx, wr, mz), 0.5)
  const bb = Math.max(spec.bumper.bottom, 0.02)
  const bt = spec.bumper.top
  shape(R.ColliderDesc.cuboid(spec.len / 2, (bt - bb) / 2, spec.wid / 2).setTranslation(0, (bt + bb) / 2, 0), spec.mass)
  // The superstructure: what hits a trench roof or another robot up high.
  for (const h of spec.hull) {
    if (h.centre[1] + h.half[1] <= bt + 0.01) continue
    shape(R.ColliderDesc.cuboid(h.half[0], h.half[1], h.half[2]).setTranslation(h.centre[0], h.centre[1], h.centre[2]), 0.01)
  }
  return {
    ...place,
    a: spec,
    spec,
    body,
    carry: PRELOAD,
    cooldown: 0,
    lanes: spec.shot.exits.map(() => 0), // s until each feed lane has its next ball at the wheel
    fedAt: -1,
    shake: 0, // 0..1: how far a knock has thrown its aim off
    intakeBudget: 2,
    intakeOut: 0, // where the intake is: 0 stowed .. 1 out
    intakeOn: false, // rollers running, picking up
    agit: 0,
    turretYaw: place.psi + spec.shot.yaw,
    spin: 0, // shooter wheel, 0..1 of the speed the shot needs
    firing: 0,
    aim: null,
    climb: { state: 'none', level: 0, t: 0, from: null },
    x: place.x, z: place.z, y: 0, vx: 0, vz: 0, psi: place.psi, om: 0,
    ai: { slot: place.slot },
    cmd: null,
  }
}

// ------------------------------------------------------------------ setup
/** The heading that points a robot's intake down the field, at the fuel. Most carry it on the back. */
const intakeForward = (spec) => -spec.intake.dirs[0]

/**
 * mode: 'match' (3v3, the full rules) · 'solo' (your alliance only, the full rules)
 *       'skills' (just you, 60 s, hub always live) · 'practice' (just you, no clock)
 */
export function createSim(R, { field, lineup, difficulty = 'regional', mode = 'match', realism = 'off', seed = (Date.now() & 0x7fffffff), demo = false } = {}) {
  const rules = MODES[mode] || MODES.match
  const rng = mulberry32(seed)
  const world = new R.World({ x: 0, y: -9.81, z: 0 })
  world.timestep = DT
  const colliderCount = buildField(R, world, field)

  const redCfg = DIFFICULTY[difficulty] || DIFFICULTY.regional
  const startX = (field.startingLine ?? 3.978) - 0.6
  const slots = [5.75, 7.3, 2.35] // across the field: clear of the tower, the hub and each other
  const robots = []
  const blue = (lineup.blue || []).slice(0, rules.blueRobots)
  const red = rules.redRobots ? (lineup.red || []).slice(0, rules.redRobots) : []
  blue.forEach((spec, i) => {
    robots.push(makeRobot(R, world, spec, {
      id: `b${i}`, team: 'blue', label: spec.label, key: spec.key, arch: spec.key,
      isPlayer: i === 0 && !demo, cfg: i === 0 && !demo ? { ...PARTNER, ...PLAYER_SPREAD } : PARTNER,
      x: startX - (spec.len / 2 - 0.4), z: slots[i], psi: intakeForward(spec), slot: [0, 0.75, -0.75][i],
    }))
  })
  red.forEach((spec, i) => {
    const p = mirror({ x: startX - (spec.len / 2 - 0.4), z: slots[i] })
    const r = makeRobot(R, world, spec, {
      id: `r${i}`, team: 'red', label: spec.label, key: spec.key, arch: spec.key, isPlayer: false, cfg: redCfg,
      x: p.x, z: p.z, psi: intakeForward(spec) + Math.PI, slot: [0, 0.75, -0.75][i],
    })
    if (redCfg.defend && i === red.length - 1) r.ai.role = 'defender'
    robots.push(r)
  })

  const sim = {
    R, world, rng, difficulty, demo, mode, rules, colliderCount, realism,
    faultLog: [],
    clock: -MATCH.countdown,
    period: 'countdown',
    autoFuel: { blue: 0, red: 0 },
    autoWinner: rules.shifts ? null : 'blue',
    robots,
    balls: [],
    queue: [],
    score: {
      blue: { total: 0, fuel: 0, auto: 0, climb: 0, wasted: 0 },
      red: { total: 0, fuel: 0, auto: 0, climb: 0, wasted: 0 },
    },
    stats: { fired: 0, made: 0, intaken: 0, distance: 0, topSpeed: 0, passed: 0 },
    events: [],
    outpost: { blue: OUTPOST.holds, red: OUTPOST.holds },
    outpostTimer: { blue: 0, red: 0 },
    over: false,
  }

  for (const r of robots) r.health = initHealth(realism, rng)

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

function addBall(sim, x, y, z, vel, shooter, resting = false, shot = false) {
  const { R, world } = sim
  // Starting fuel begins asleep: 400 touching balls settle instantly that way,
  // and wake the moment a robot or another ball touches them.
  const desc = R.RigidBodyDesc.dynamic().setTranslation(x, y, z).setAngularDamping(0.8).setCcdEnabled(true)
  if (resting) desc.setSleeping(true)
  const body = world.createRigidBody(desc)
  const collider = world.createCollider(
    R.ColliderDesc.ball(FUEL.r).setMass(FUEL.mass).setRestitution(0.55).setFriction(0.6)
      .setCollisionGroups(shot ? GROUP_SHOT : GROUP_FUEL),
    body,
  )
  if (vel) body.setLinvel(vel, true)
  const ball = {
    body, collider, alive: true, shooter: shooter || null, air: Boolean(vel), grace: shot ? 0.3 : 0,
    // Where it is and where it was a step ago (and how it is turned), kept here so
    // the view can draw between the two without asking the physics for every ball.
    x, y, z, x0: x, y0: y, z0: z, qx: 0, qy: 0, qz: 0, qw: 1,
  }
  sim.balls.push(ball)
  return ball
}

function removeBall(sim, ball) {
  ball.alive = false
  sim.world.removeRigidBody(ball.body)
  ball.body = null
  ball.collider = null
}

// ------------------------------------------------------------------ rules per mode
/** Is `team`'s hub scoring right now, in this mode? */
export function hubLive(sim, team, t = sim.clock) {
  if (t < 0) return false
  if (!sim.rules.shifts) return true
  return hubActive(t, team, sim.autoWinner)
}

function periodFor(sim, t) {
  const r = sim.rules
  if (t < 0) return 'countdown'
  if (r.total == null) return 'practice'
  if (t >= r.total) return 'over'
  if (!r.shifts) return t >= r.total - 15 ? 'endgame' : 'teleop'
  return periodOf(t)
}

// ------------------------------------------------------------------ step
const IDLE = Object.freeze({ vx: 0, vz: 0, turn: 0, aim: null, fire: false, special: false, intake: false })

/** Advance one physics step. `input` is the player's command (see the top of this file). */
export function step(sim, input = {}) {
  if (sim.over) return sim
  const before = sim.clock
  sim.clock += DT
  sim.period = periodFor(sim, sim.clock)
  if (sim.rules.shifts && before < MATCH.auto && sim.clock >= MATCH.auto) {
    sim.autoWinner = sim.autoFuel.blue >= sim.autoFuel.red ? 'blue' : 'red'
  }
  if (sim.period === 'over') return finish(sim)

  for (const r of sim.robots) sample(sim, r)

  const live = sim.period !== 'countdown'
  for (const r of sim.robots) {
    r.cooldown = Math.max(0, r.cooldown - DT)
    for (let i = 0; i < r.lanes.length; i++) r.lanes[i] = Math.max(0, r.lanes[i] - DT)
    r.shake *= Math.exp(-DT / SHAKE_TIME)
    if (r.shake < 0.01) r.shake = 0
    r.firing = Math.max(0, r.firing - DT)
    r.intakeBudget = Math.min(2, r.intakeBudget + r.a.intakeRate * DT)
    // The player drives from the first second, auto included; everyone else is the computer.
    r.autopilot = !r.isPlayer
    let cmd = !live ? IDLE : r.autopilot ? think(sim, r, DT) : input
    // Battery, heat, radio and breakages (when realism is on) decide what the robot may do.
    const lim = faultStep(sim, r, DT, r.driveLoad || { cmd: 0, speed: 0, accel: 0 })
    r.limits = lim
    if (lim.disabled) cmd = IDLE
    r.cmd = cmd

    if (r.climb.state !== 'none') {
      r.aim = null
      r.intakeOn = false
      climbStep(sim, r)
      continue
    }

    // --- what the shooter is being asked to do
    const wantClimb = Boolean(cmd.climb) || (Boolean(cmd.special) && canClimbNow(sim, r))
    const wantPass = !wantClimb && Boolean(cmd.pass || cmd.special) && !cmd.fire
    const shooting = live && lim.shoot && r.carry > 0 && (Boolean(cmd.fire) || wantPass)
    const aim = shooting ? solveAim(sim, r, wantPass ? 'pass' : 'hub') : null

    // The wheel idles while there is fuel aboard, and runs up for a shot.
    const spinTo = aim && aim.state !== 'home' ? 1 : r.carry > 0 ? 0.6 : 0
    r.spin += clamp(spinTo - r.spin, -DT / 1.2, DT / 0.5)

    // --- where to point: a fixed shooter turns the whole robot, a turret turns itself
    let heading = cmd.aim ?? null
    let err = Math.PI
    if (aim && aim.state !== 'home') {
      const s = r.a.shot
      if (s.turret) {
        const rel = wrap(aim.yaw - r.psi - s.yaw)
        const lims = turretLimits(r)
        // Out of the turret's travel: bring the chassis round so it can reach.
        if (lims && (rel < lims[0] + 0.15 || rel > lims[1] - 0.15)) heading = aim.yaw - s.yaw
      } else {
        heading = aim.yaw - s.yaw
      }
    }
    // A target that swings past as the robot drives: turn at the rate it does, and
    // correct from there, or the robot is always a little behind it.
    const swing = heading != null && r.headingWas != null ? clamp(wrap(heading - r.headingWas) / DT, -5, 5) : 0
    r.headingWas = heading
    trackTurret(r, aim && aim.state !== 'home' ? aim.yaw : null)
    if (aim && aim.state === 'aiming') {
      err = r.a.shot.turret ? wrap(aim.yaw - r.turretYaw) : wrap(aim.yaw - r.a.shot.yaw - r.psi)
      const steady = r.a.shot.turret || Math.abs(r.om) < 2.5
      if (Math.abs(err) < r.a.shot.headingTol && steady && r.spin >= 0.97) aim.state = 'ready'
    }
    r.aim = aim

    // --- intake: out and running while asked for; it agitates the hopper while shooting
    r.intakeOn = Boolean(r.autopilot ? cmd.intake !== false : cmd.intake) && lim.intake
    // A hopper that grows with its intake cannot close on a full load: the fuel
    // on board holds it open, most of the way (the pile gives a little).
    const held = hopperHoldsOpen(r.a, r.carry) * 0.8
    let out = Math.max(r.intakeOn ? 1 : 0, held)
    if (r.firing > 0 && lim.intake) {
      r.agit += DT
      out = agitate(r.a.agitation, r.agit, held)
    } else {
      r.agit = 0
    }
    // A broken intake hangs where it broke. A working one moves at its own speed.
    const most = DT / r.a.intakeTime
    if (!r.health.intakeBroken) r.intakeOut = clamp(r.intakeOut + clamp(out - r.intakeOut, -most, most), 0, 1)
    // And none comes out through a wall: against one it only comes out as far as
    // there is room, and driven into one it is pushed back in.
    if (r.intakeOut > 0.02) r.intakeOut = Math.min(r.intakeOut, intakeRoom(sim, r))

    drive(r, cmd, lim.drive, heading, swing)
    if (aim && aim.state === 'ready') fire(sim, r, aim)
    if (live && wantClimb) startClimb(sim, r)
    if (r.isPlayer) {
      const sp = Math.hypot(r.vx, r.vz)
      sim.stats.distance += sp * DT
      sim.stats.topSpeed = Math.max(sim.stats.topSpeed, sp)
    }
  }

  sim.world.step()
  afterStep(sim)
  return sim
}

function sample(sim, r) {
  const t = r.body.translation()
  const v = r.body.linvel()
  const w = r.body.angvel()
  // A sudden change in velocity that the drive could not have made is a collision.
  if (sim.clock > 0 && r.climb.state === 'none') {
    const jump = Math.hypot(v.x - r.vx, v.z - r.vz) - r.a.accel * DT
    if (jump > 0.5) {
      noteImpact(sim, r, jump)
      // A hit throws the aim off and takes speed out of the shooter wheel: less, the steadier the robot.
      const knock = Math.min(1, jump * 0.55 * (1 - r.a.shot.steady))
      r.shake = Math.min(1, r.shake + knock)
      r.spin = Math.min(r.spin, 1 - knock * 0.6)
    }
  }
  r.x = t.x; r.z = t.z; r.y = t.y
  r.vx = v.x; r.vz = v.z
  r.om = -w.y
  r.psi = psiFromQuat(r.body.rotation())
}

function drive(r, cmd, power = 1, heading = null, swing = 0) {
  const { a, body } = r
  let vx = cmd.vx || 0
  let vz = cmd.vz || 0
  const m = Math.hypot(vx, vz)
  if (m > 1) { vx /= m; vz /= m }
  const max = a.speed * (r.autopilot ? r.cfg.speed : 1) * power
  // Traction- and motor-limited: the change in velocity per step is capped.
  let dvx = vx * max - r.vx
  let dvz = vz * max - r.vz
  const dl = Math.hypot(dvx, dvz)
  // Slowing down or turning back on itself, the wheels grip harder than when pulling away.
  const lim = a.accel * DT * (dvx * r.vx + dvz * r.vz < 0 ? BRAKE : 1)
  // How hard the drive worked this step, for the battery: asked, achieved, accelerating.
  r.driveLoad = { cmd: Math.min(1, m) * power, speed: Math.hypot(r.vx, r.vz) / a.speed, accel: Math.min(1, dl / Math.max(lim, 1e-6)) * Math.min(1, m) }
  if (dl > lim) { dvx *= lim / dl; dvz *= lim / dl }
  const mass = body.mass()
  body.applyImpulse({ x: dvx * mass, y: 0, z: dvz * mass }, true)

  // Turning is eased: the robot spins up and slows down at TURN_ACCEL, so nothing
  // snaps. Holding a heading aims for the fastest stop that does not overshoot.
  let want = 0
  if (heading != null) {
    const e = wrap(heading - r.psi)
    want = clamp(swing + Math.sign(e) * Math.min(a.yawRate, 10 * Math.abs(e), Math.sqrt(1.6 * TURN_ACCEL * Math.abs(e))), -a.yawRate, a.yawRate)
  } else if (cmd.turn) {
    want = clamp(cmd.turn, -1, 1) * (a.turn ?? Math.min(a.yawRate * 0.6, 5))
  }
  const w = power > 0 ? r.om + clamp(want - r.om, -TURN_ACCEL * DT, TURN_ACCEL * DT) : 0
  body.setAngvel({ x: 0, y: -w, z: 0 }, true)
}

function gauss(rng) {
  const u = Math.max(rng(), 1e-9)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())
}

/**
 * Where a robot's intake should be `t` seconds into a shot: every robot works
 * its pile toward the shooter its own way (robots.js, agitationOf). `held` is
 * how far out the fuel still on board keeps it.
 */
function agitate(a, t, held) {
  const lo = Math.max(a.to, held)
  const u = t - (a.delay || 0)
  if (a.kind === 'pump' || a.kind === 'beat') {
    // Starts out, strokes in to `lo` and back.
    return u < 0 ? 1 : (1 + lo) / 2 + ((1 - lo) / 2) * Math.cos((2 * Math.PI * u) / a.period)
  }
  if (a.kind === 'hold' && a.ramp && u > a.ramp.delay) return Math.max(held, Math.min(a.ramp.to, a.to + (u - a.ramp.delay) * a.ramp.rate))
  return lo
}

/**
 * How far out (0..1) a robot's intake has room to be: the clear distance beyond
 * its bumper on each side that has one, as a share of the intake's reach.
 */
function intakeRoom(sim, r) {
  const z = r.a.intake
  const c = Math.cos(r.psi)
  const s = Math.sin(r.psi)
  let room = 1
  for (const [cd, sd] of z.faces) {
    // Out along this face, in the field's frame, and across it.
    const ox = c * cd - s * sd
    const oz = s * cd + c * sd
    const edge = Math.abs(cd) > 0.5 ? r.a.len / 2 : r.a.wid / 2
    const reach = z.far - edge
    if (reach < 0.03) continue
    for (const side of [-0.85, 0, 0.85]) {
      const px = r.x + ox * (edge - 0.06) - oz * side * z.half
      const pz = r.z + oz * (edge - 0.06) + ox * side * z.half
      const hit = rayField(sim, px, 0.14, pz, ox, 0, oz, reach + 0.1)
      if (hit != null) room = Math.min(room, clamp((hit - 0.08) / reach, 0, 1))
    }
  }
  return room
}

// ------------------------------------------------------------------ shooting
/** A point in the robot's frame (x forward, z right), out in the field. */
function toField(r, x, z) {
  const c = Math.cos(r.psi)
  const s = Math.sin(r.psi)
  return { x: r.x + c * x - s * z, z: r.z + s * x + c * z }
}

/** Where a ball leaves exit `e` when thrown along `yaw`. */
function exitPoint(r, e, yaw) {
  const p = toField(r, e.x, e.z)
  const reach = r.a.shot.barrel + 0.12
  return { x: p.x + Math.cos(yaw) * reach, y: r.y + r.a.shot.origin.y + 0.04, z: p.z + Math.sin(yaw) * reach }
}

/** The middle of the shooter's exits: where aiming is measured from. */
export function shooterOrigin(r) {
  const ex = r.a.shot.exits
  let x = 0
  let z = 0
  for (const e of ex) { x += e.x; z += e.z }
  const p = toField(r, x / ex.length, z / ex.length)
  return { x: p.x, y: r.y + r.a.shot.origin.y + 0.04, z: p.z }
}
export const shotTarget = (team) => ({ x: HUB[team].x, y: HUB.top + 0.05, z: HUB[team].z })

/**
 * Where a pass lands: in the robot's own zone, clear of the hub, its net and the
 * trenches. Null when the robot is already home.
 */
function passTarget(r) {
  const s = r.team === 'blue' ? 1 : -1
  const h = HUB[r.team]
  if (s * (r.x - h.x) < 0.6) return null
  let z = clamp(r.z, 1.9, FIELD.W - 1.9)
  if (Math.abs(z - h.z) < 1.25) z = h.z + (r.z >= h.z ? 1 : -1) * 1.6
  return { x: h.x - s * 2.4, y: 0.4, z }
}

/**
 * The shot this robot would take now: where to point, how fast to throw, and
 * whether it can. state: 'aiming' (lining up), 'near' / 'far' (out of range),
 * 'home' (a pass from its own zone: nothing to do). step() turns 'aiming' into
 * 'ready' once the robot is lined up and the wheel is at speed.
 */
// How good a shot is, is the robot's, and it is a roll of the dice. Every ball
// still flies for real; what a robot's skill decides is whether it was thrown
// right. Standing still and left alone, it was. On the move, each shot may miss:
// seldom at the speed the robot was built to shoot at, nearly always at three
// times it. Knocked by another robot, the same, until its aim settles.
const MISS_AT_LIMIT = 0.12
const STILL = Object.freeze({ x: 0, z: 0 })
const SHAKE_TIME = 0.55 // s for a knock to wear off, to a third
export function missChance(r, speed) {
  const moving = speed < 0.15 ? 0 : MISS_AT_LIMIT * (speed / Math.max(r.a.shot.moveSpeed, 0.15)) ** 2
  return Math.min(0.95, moving + r.shake * 0.9)
}

// A shot has to get over the hub's near rim before it comes down into the opening.
// From close in, a shooter's usual angle is still climbing when it gets there and
// clips the lip, so the arc is steepened until it clears. Drag-free: the parabola
// from the shooter through the target, asked to pass RIM_CLEAR above the rim.
const RIM_OUT = 0.68 // from the hub's centre to just outside its rim
const RIM_CLEAR = FUEL.r + 0.25
function steepEnough(elev, dist, fromY) {
  const run = dist - RIM_OUT
  if (run < 0.05) return 80
  const rise = HUB.top + 0.05 - fromY
  const k = run / dist
  const slope = (HUB.top + RIM_CLEAR - fromY - rise * k * k) / (run * (1 - k))
  return Math.max(elev, Math.min(80, (Math.atan(slope) * 180) / Math.PI))
}

function solveAim(sim, r, kind) {
  const s = r.a.shot
  const from = shooterOrigin(r)
  let target
  let elev
  let lo
  let hi
  if (kind === 'pass') {
    target = passTarget(r)
    if (!target) return { kind, state: 'home' }
    elev = PASS_ELEVATION
    lo = 1.5
    hi = 12
  } else {
    target = shotTarget(r.team)
    lo = s.minRange - 0.25
    hi = s.maxRange + 0.15
  }
  const dist = Math.hypot(target.x - from.x, target.z - from.z)
  if (kind !== 'pass') elev = steepEnough(tableElevation(r.a, clamp(dist, s.minRange, s.maxRange), from.y), dist, from.y)
  const vel = { x: r.vx, z: r.vz }
  const speed = Math.hypot(vel.x, vel.z)
  const bearing = Math.atan2(target.z - from.z, target.x - from.x)
  // The shot from here as if the robot stood still. The same one as a moment ago
  // (a robot at its spot) is not worked out again.
  const key = `${kind}|${Math.round(from.x * 100)}|${Math.round(from.z * 100)}|${Math.round(from.y * 200)}|${Math.round(elev * 20)}`
  const last = r.solved
  const still = last && last.key === key ? last.sol : solveShot(from, target, STILL, elev, MAX_EXIT, false, last?.sol?.speed ?? null)
  r.solved = { key, sol: still }
  // On the move, the ball keeps the velocity of the robot that threw it. So the
  // shooter throws what is left: the standing shot's velocity less the robot's
  // own. Over the ground the ball then flies the standing shot's arc exactly, no
  // higher and no further. (Solving for a target moved downrange instead, at a
  // fixed steep angle, ran away with itself at speed: shots at 15 m/s, ten metres up.)
  let sol = still
  let rush = false
  if (still && speed > 0.02) {
    const pitch = (elev * Math.PI) / 180
    const flat = still.speed * Math.cos(pitch)
    const up = still.speed * Math.sin(pitch)
    const hx = Math.cos(bearing) * flat - vel.x
    const hz = Math.sin(bearing) * flat - vel.z
    const mine = Math.hypot(hx, hz)
    const yaw = Math.atan2(hz, hx)
    // Driving at the target faster than the shot itself travels, or needing to
    // throw well off to one side: no shooter does that. It waits.
    rush = mine < flat * 0.3 || Math.abs(wrap(yaw - bearing)) > 1.05
    elev = (Math.atan2(up, Math.max(mine, 0.05)) * 180) / Math.PI
    sol = { speed: Math.min(MAX_EXIT, Math.hypot(mine, up)), yaw, tof: still.tof, dist: still.dist }
  }
  const state = dist < lo ? 'near' : dist > hi || !sol ? 'far' : rush ? 'rush' : 'aiming'
  // A pass has a whole zone to land in: it does not miss.
  const miss = kind === 'pass' ? 0 : missChance(r, speed)
  return { kind, state, sol, elev, from, vel, speed, miss, fast: miss >= 0.35 && r.shake < 0.3, knocked: r.shake >= 0.3, dist, target, yaw: sol ? sol.yaw : bearing }
}

/**
 * Whether this robot's shooter could take a shot at its hub from where it is:
 * 'aiming' in range, 'near' or 'far' out of it. Range alone, nothing solved:
 * the computer's robots ask this every step.
 */
export function aimNow(r) {
  const s = r.a.shot
  const from = shooterOrigin(r)
  const target = shotTarget(r.team)
  const dist = Math.hypot(target.x - from.x, target.z - from.z)
  return { kind: 'hub', dist, state: dist < s.minRange - 0.25 ? 'near' : dist > s.maxRange + 0.15 ? 'far' : 'aiming' }
}

function turretLimits(r) {
  const t = r.a.shot.turret
  if (!t) return null
  const [lo, hi] = t.range
  return hi - lo >= 2 * Math.PI - 1e-3 ? null : [lo, hi]
}

/** Turn the turret toward `yaw` (its hub, when it has nothing else to aim at), inside its travel. */
function trackTurret(r, yaw) {
  const s = r.a.shot
  if (!s.turret) {
    r.turretYaw = r.psi + s.yaw
    return
  }
  let want = yaw
  if (want == null) {
    const h = HUB[r.team]
    const o = shooterOrigin(r)
    want = Math.atan2(h.z - o.z, h.x - o.x)
  }
  let rel = wrap(want - r.psi - s.yaw)
  const lims = turretLimits(r)
  if (lims) rel = clamp(rel, lims[0], lims[1])
  const cur = wrap(r.turretYaw - r.psi - s.yaw)
  // Follow the shorter way round unless a hard stop is in the way.
  const d = lims ? rel - cur : wrap(rel - cur)
  r.turretYaw = r.psi + s.yaw + cur + clamp(d, -10 * DT, 10 * DT)
}

/**
 * Shoot: a ball from each feed lane that has one at the wheel. The lanes feed on
 * their own, so a wide shooter throws a ragged stream across its width, one ball
 * here and one there, and not a row at a time. Together they make its fire rate.
 */
function fire(sim, r, aim) {
  if (r.carry <= 0 || r.cooldown > 0) return
  const s = r.a.shot
  const lanes = s.exits.length
  const every = lanes / r.a.fireRate // s between balls in one lane
  // Starting up, the lanes do not all have a ball waiting at once.
  if (sim.clock - r.fedAt > 0.25) for (let i = 0; i < lanes; i++) r.lanes[i] = Math.max(r.lanes[i], every * sim.rng() * 0.9)
  r.fedAt = sim.clock
  const base = s.turret ? aim.sol.yaw : r.psi + s.yaw
  const sp = s.spread
  const k = r.autopilot ? r.cfg.spreadScale ?? 1 : 1
  let n = 0
  for (let i = 0; i < lanes && r.carry > 0; i++) {
    if (r.lanes[i] > 0) continue
    r.lanes[i] = every * (0.7 + 0.6 * sim.rng())
    const speed = aim.sol.speed * (1 + gauss(sim.rng) * ((sp.speedPct ?? 1) / 100) * k + gauss(sim.rng) * r.cfg.spreadSpeed * 0.5)
    const yaw = base + gauss(sim.rng) * (((sp.yawDeg ?? 0.5) * Math.PI) / 180) * k + gauss(sim.rng) * r.cfg.spreadYaw * 0.5
    const pitch = aim.elev + gauss(sim.rng) * (sp.pitchDeg ?? 0.5) * k
    const p = exitPoint(r, s.exits[i], yaw)
    // A miss is a ball thrown as if the robot were moving some other way: it comes
    // down most of a metre from where it was meant to, in whatever direction.
    let carried = aim.vel
    if (aim.miss > 0 && sim.rng() < aim.miss) {
      const off = 0.75 + 0.6 * sim.rng()
      const way = 2 * Math.PI * sim.rng()
      carried = { x: aim.vel.x + Math.cos(way) * off, z: aim.vel.z + Math.sin(way) * off }
    }
    addBall(sim, p.x, p.y, p.z, launchVelocity(speed, yaw, pitch, carried), aim.kind === 'hub' ? r : null, false, true)
    noteShot(sim, r)
    r.carry--
    n++
  }
  if (!n) return
  r.firing = 0.35
  if (r.isPlayer) {
    if (aim.kind === 'hub') sim.stats.fired += n
    else sim.stats.passed += n
  }
}

/** Points along the flight of the shot `aim` describes, for drawing it. */
export function aimArc(aim, n = 22) {
  if (!aim?.sol) return []
  const v = launchVelocity(aim.sol.speed, aim.sol.yaw, aim.elev, aim.vel)
  const p = { ...aim.from }
  const pts = [{ ...p }]
  const h = (aim.sol.tof * 1.02) / n
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 4; k++) {
      const q = h / 4
      const sp = Math.hypot(v.x, v.y, v.z)
      v.x -= FUEL.K * sp * v.x * q
      v.y -= (9.81 + FUEL.K * sp * v.y) * q
      v.z -= FUEL.K * sp * v.z * q
      p.x += v.x * q; p.y += v.y * q; p.z += v.z * q
    }
    pts.push({ ...p })
  }
  return pts
}

// ------------------------------------------------------------------ climbing
export function inClimbZone(r) {
  const tw = TOWER[r.team]
  const s = r.team === 'blue' ? 1 : -1
  const d = s * (r.x - tw.x) - TOWER.zone.from
  return d > 0 && d < TOWER.zone.depth && Math.abs(r.z - tw.z) < TOWER.zone.width / 2
}

export function canClimbNow(sim, r) {
  return r.a.climb > 0 && r.climb.state === 'none' && (sim.period === 'endgame' || sim.period === 'practice') && inClimbZone(r)
}

function startClimb(sim, r) {
  if (!canClimbNow(sim, r)) return
  r.climb = { state: 'climbing', level: r.a.climb, t: 0, from: { x: r.x, y: r.y, z: r.z } }
  r.body.setBodyType(sim.R.RigidBodyType.KinematicPositionBased, true)
}

const CLIMB_LIFT = [0.16, 0.55, 0.95]

function climbStep(sim, r) {
  const c = r.climb
  if (c.state === 'climbing') {
    c.t += DT
    if (c.t >= r.a.climbTime) c.state = 'done'
  }
  const u = Math.min(1, c.t / r.a.climbTime)
  const lift = CLIMB_LIFT[c.level - 1] * (u * u * (3 - 2 * u))
  r.body.setNextKinematicTranslation({ x: c.from.x, y: c.from.y + lift, z: c.from.z })
}

// ------------------------------------------------------------------ after physics
function afterStep(sim) {
  const ro = sim.robots
  const throat = HUB.throat / 2 + 0.12
  // Inside the hub a ramp under the throat carries fuel to the exits; anything
  // through the throat and down to that ramp has scored.
  const scoreBelow = HUB.throatY + 0.15
  for (const ball of sim.balls) {
    if (!ball.alive) continue
    const b = ball.body
    const p = b.translation()
    const v = b.linvel()
    const speed = Math.hypot(v.x, v.y, v.z)
    ball.x0 = ball.x; ball.y0 = ball.y; ball.z0 = ball.z
    ball.x = p.x; ball.y = p.y; ball.z = p.z
    if (speed > 0.02) {
      const q = b.rotation()
      ball.qx = q.x; ball.qy = q.y; ball.qz = q.z; ball.qw = q.w
    }

    // Clear of the robot that threw it: from here on it hits robots like any other ball.
    if (ball.grace > 0) {
      ball.grace -= DT
      if (ball.grace <= 0) ball.collider.setCollisionGroups(GROUP_FUEL)
    }

    if (p.y > FUEL.r + 0.03) {
      // In the air: drag, as the square of its speed.
      const k = FUEL.K * speed * DT
      b.setLinvel({ x: v.x * (1 - k), y: v.y * (1 - k), z: v.z * (1 - k) }, true)
    } else if (speed > 1e-3) {
      // Rolling on carpet: a steady drag, so a ball coasts to a stop instead of creeping for ever.
      const flat = Math.hypot(v.x, v.z)
      const f = flat > ROLL_DRAG * DT ? (flat - ROLL_DRAG * DT) / flat : 0
      b.setLinvel({ x: v.x * f, y: v.y, z: v.z * f }, true)
      if (ball.air && speed < 2) ball.air = false
    }

    // Scored: through the funnel's throat and into the hub.
    let scored = false
    for (const team of ['blue', 'red']) {
      const h = HUB[team]
      if (Math.abs(p.x - h.x) < throat && Math.abs(p.z - h.z) < throat && p.y < scoreBelow && p.y > HUB.boxTop) {
        award(sim, team, ball, p)
        removeBall(sim, ball)
        scored = true
        break
      }
    }
    if (scored) continue

    // Intakes: fuel on the floor inside the mouth of an intake that is out and running.
    if (p.y < 0.24) {
      for (let i = 0; i < ro.length; i++) {
        const r = ro[i]
        if (!r.intakeOn || r.intakeOut < 0.25 || r.carry >= r.a.capacity || r.climb.state !== 'none' || r.intakeBudget < 1) continue
        const dx = p.x - r.x
        const dz = p.z - r.z
        if (dx * dx + dz * dz > 1.6) continue
        const c = Math.cos(r.psi)
        const s = Math.sin(r.psi)
        const fwd = dx * c + dz * s
        const side = -dx * s + dz * c
        const z = r.a.intake
        let mouth = false
        for (const [cd, sd] of z.faces) {
          // The mouth is where the intake has got to: against a wall it is part-way
          // out, and still takes the fuel lying between the bumper and the wall.
          const edge = Math.abs(cd) > 0.5 ? r.a.len / 2 : r.a.wid / 2
          const far = edge + (z.far - edge) * r.intakeOut
          const near = Math.min(z.near, far - 0.12)
          const reach = fwd * cd + side * sd
          if (reach > near - 0.03 && reach < far + 0.03 && Math.abs(side * cd - fwd * sd) < z.half) { mouth = true; break }
        }
        if (mouth) {
          r.carry++
          r.intakeBudget -= 1
          if (r.isPlayer) sim.stats.intaken++
          sim.events.push({ kind: 'intake', robot: i, x: p.x, y: p.y, z: p.z })
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

  // Outposts: a robot parked at the chute, intake running and toward the wall, is fed by the human player.
  for (const team of ['blue', 'red']) {
    sim.outpostTimer[team] = Math.max(0, sim.outpostTimer[team] - DT)
    if (sim.outpost[team] <= 0 || sim.outpostTimer[team] > 0) continue
    const o = OUTPOST[team]
    const toWall = team === 'blue' ? Math.PI : 0
    const i = ro.findIndex((x) => {
      if (x.team !== team || !x.intakeOn || x.carry >= x.a.capacity || x.climb.state !== 'none') return false
      if (Math.hypot(x.x - o.x, x.z - o.z) > OUTPOST.reach) return false
      return x.a.intake.dirs.some((d) => Math.cos(x.psi + d - toWall) > 0.7)
    })
    if (i < 0) continue
    const r = ro[i]
    r.carry++
    sim.outpost[team]--
    sim.outpostTimer[team] = OUTPOST.feedEvery
    sim.events.push({ kind: 'intake', robot: i, x: o.x + (team === 'blue' ? 0.15 : -0.15), y: 0.75, z: o.z })
  }
}

function award(sim, team, ball, p) {
  const active = hubLive(sim, team)
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
  sim.clock = sim.rules.total
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

/** End a practice session on demand. */
export function endNow(sim) {
  if (!sim.over) finish(sim)
}

export function result(sim) {
  const b = sim.score.blue.total
  const r = sim.score.red.total
  const player = sim.robots.find((x) => x.id === 'b0')
  return {
    mode: sim.mode,
    outcome: sim.rules.redRobots ? (b > r ? 'win' : b < r ? 'loss' : 'tie') : 'solo',
    blue: { ...sim.score.blue },
    red: { ...sim.score.red },
    fired: sim.stats.fired,
    made: sim.stats.made,
    passed: sim.stats.passed,
    intaken: sim.stats.intaken,
    distance: sim.stats.distance,
    topSpeed: sim.stats.topSpeed,
    climb: player?.climb.state === 'done' ? player.climb.level : 0,
    autoWinner: sim.autoWinner,
    realism: sim.realism,
    health: player?.health.on
      ? {
          brownouts: player.health.brownouts,
          minVolts: player.health.minVolts,
          intakeBroken: player.health.intakeBroken,
          faults: sim.faultLog.filter((f) => f.player).length,
        }
      : null,
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

// ------------------------------------------------------------------ looking at the world
/**
 * How far a ray travels before it hits the field (never robots, fuel or the
 * invisible box), or null if it is clear for `max` metres. With `sight`, the
 * nets count too: for a camera, which should not end up looking through one.
 */
export function rayField(sim, ox, oy, oz, dx, dy, dz, max, sight = false) {
  const hit = sim.world.castRay(new sim.R.Ray({ x: ox, y: oy, z: oz }, { x: dx, y: dy, z: dz }), max, true, undefined, sight ? RAY_SIGHT : RAY_SOLID)
  if (!hit) return null
  return hit.timeOfImpact ?? hit.toi ?? null
}

/** The height of the field's surface under a point: the carpet, a bump, a ramp. */
export function groundAt(sim, x, z) {
  const t = rayField(sim, x, 0.5, z, 0, -1, 0, 0.7)
  return t == null || t < 0.02 ? 0 : Math.max(0, 0.5 - t)
}

export function destroySim(sim) {
  sim.world.free()
}
