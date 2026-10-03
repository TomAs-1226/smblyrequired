// Numbers playing REBUILT on its own: one pass through the FUEL, score it, and go get it again.
//
// A behaviour, not a timeline. The robot has a velocity with acceleration limits and a heading that is
// profiled on its own, so it turns while it drives — lining up for the next pass on the way there,
// turning its shooter to the HUB while it is still moving, spinning up and solving the hood before it
// arrives, and firing on the move. Each decision carries a reason, the way Catalyst's autonomy cores
// report theirs.
//
// Collecting is one straight pass, intake first, along the row the FUEL lies in: lined up beforehand,
// heading held, never chasing ball by ball (that read as spinning on the spot). Scored FUEL drops out of
// the HUB's base and rolls, slowing on the carpet, into a row at a different spot each cycle — so the
// next pass always has somewhere new to go, and nothing ever teleports.
//
// Geometry comes from the bake's manifest (public/models/robot.json): the hopper slots
// (`hopper.ballCentres.deployed`, packed lowest first), the intake mouth, the shooter's release point,
// and `elevation = 88.44 − hood`. This is a marketing scene, not Catalyst Console — the balls are
// solved to go in.

import * as THREE from 'three'

const R = 0.075 // FUEL radius, m
const G = 9.81
/* Hood.java's range. */
const HOOD_MIN = 13
const HOOD_MAX = 45
const RIM_Y = 1.83 // the HUB's opening
const RIM_HALF = 0.6 // centre to the opening's edge, roughly
const AIM_Y = 1.55 // the arc is solved to pass this low inside the HUB's centre

/* Drive limits, scaled for the eye: real REBUILT robots are faster than reads well on a page. */
const V_MAX = 2.0 // m/s
const A_MAX = 3.0 // m/s²
const W_MAX = 3.2 // rad/s
const ALPHA_MAX = 8 // rad/s²
const V_SWEEP = 1.25 // along the row, intake first
const V_SHOOT = 0.55 // still moving while it fires
const LEAD_IN = 1.1 // m before the row starts: straight and lined up by then
const RUN_OUT = 0.45 // m past the row's end
const FEED_EVERY = 0.17 // s between balls
const ROLL_DECEL = 1.1 // m/s², carpet
const ROW_PITCH = 0.3 // m between rows of two in a landing row
const ROW_HALF = 0.12 // m either side of the row's line — well inside the 552 mm mouth

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a }
/* Robot yaw (three.js rotation.y) that points its +x along world direction (dx, dz). */
const yawFacing = (dx, dz) => Math.atan2(-dz, dx)

function mulberry32(seed) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* The lowest-energy shot in the hood's range that clears the rim: for each hood angle, the speed that
   puts the arc through the target; keep the slowest one whose ball is clear of the near edge. */
export function solveHood(exitY, D) {
  let best = null
  for (let hood = HOOD_MIN; hood <= HOOD_MAX; hood += 0.5) {
    const th = ((88.44 - hood) * Math.PI) / 180
    const den = 2 * Math.cos(th) ** 2 * (exitY + D * Math.tan(th) - AIM_Y)
    if (den <= 0) continue
    const v = Math.sqrt((G * D * D) / den)
    const x = D - RIM_HALF
    const yAtRim = exitY + x * Math.tan(th) - (G * x * x) / (2 * v * v * Math.cos(th) ** 2)
    if (yAtRim < RIM_Y + R + 0.05) continue
    if (!best || v < best.v) best = { hood, v }
  }
  return best ?? { hood: 30, v: 7 }
}

/**
 * hubAt   the HUB's centre on the carpet, world metres
 * home    where the robot starts, world [x, z]
 * spots   where the FUEL lies at the start, world [x, z] each
 * rows    where scored FUEL comes to rest, one per cycle in turn: [[x, z] start, [x, z] end] each
 * shots   where it fires from, one per cycle in turn: { bearing (radians about the HUB, as
 *         atan2(dz, dx)), range (m) }
 */
export function createAutonomy({ scene, manifest, hubAt, home = [0, 0], spots, rows, shots, seed = 5805 }) {
  const slots = (manifest?.hopper?.ballCentres?.deployed ?? []).map((p) => new THREE.Vector3(...p))
  /* `slots` are where the model draws FUEL in the hopper, not its capacity (it holds about 60).
     What the readouts report is how many of the FUEL in play the robot has aboard. */
  const mouth = manifest?.intakeMouth
  const exitLocal = manifest?.shooter?.exit?.point ?? [-0.17, 0.51, 0]
  const pivot = manifest?.hood?.pivot ?? [-0.2858, 0.4826, 0]
  const cadHood = manifest?.hood?.cadAngle ?? 11
  const hub = new THREE.Vector3(...hubAt)

  const mesh = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(R, 2),
    new THREE.MeshStandardMaterial({ color: 0xd4b13f, roughness: 0.62, metalness: 0, envMapIntensity: 0.7 }),
    spots.length,
  )
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.frustumCulled = false
  scene.add(mesh)

  const balls = spots.map(() => ({
    state: 'floor', pos: new THREE.Vector3(), v: new THREE.Vector3(), from: new THREE.Vector3(),
    land: new THREE.Vector3(), landCycle: -1, rollFrom: new THREE.Vector3(), rollDir: new THREE.Vector3(),
    rollV0: 0, rollT: 0, restAt: 0, spin: new THREE.Quaternion(), slot: -1, t: 0, dur: 0,
  }))
  let rng = mulberry32(seed)
  const bot = { x: 0, z: 0, vx: 0, vz: 0, yaw: 0, w: 0 }
  let mode = 'approach'
  let reason = ''
  let pass = null // { leadIn, start, end, dir, yaw }
  let cycle = 0
  let fired = 0
  let feeding = false
  let feedClock = 0
  let fly = 0 // flywheel readiness, 0..1
  let hood = 15
  let range = 0
  let started = false
  let clock = 0 // behaviour time, s

  const held = () => balls.filter((b) => b.state === 'held' || b.state === 'intake')
  const loose = () => balls.filter((b) => b.state === 'floor' || b.state === 'rolling' || b.state === 'flight')
  const settled = () => balls.every((b) => b.state !== 'rolling' && b.state !== 'flight')

  /* One pass through a set of points: their line (principal axis), run from the end nearer the robot,
     with a straight lead-in so the robot is lined up before the first ball. */
  function planPass(points) {
    if (!points.length) return null
    const c = points.reduce((a, p) => [a[0] + p[0] / points.length, a[1] + p[1] / points.length], [0, 0])
    let sxx = 0, sxz = 0, szz = 0
    for (const p of points) { const dx = p[0] - c[0], dz = p[1] - c[1]; sxx += dx * dx; sxz += dx * dz; szz += dz * dz }
    const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz)
    let dir = [Math.cos(ang), Math.sin(ang)]
    const proj = points.map((p) => (p[0] - c[0]) * dir[0] + (p[1] - c[1]) * dir[1])
    let lo = Math.min(...proj), hi = Math.max(...proj)
    const at = (s) => [c[0] + dir[0] * s, c[1] + dir[1] * s]
    /* Start from the end nearer the robot — unless that puts the lead-in inside the HUB. */
    const leadAt = (s, sign) => [at(s)[0] - dir[0] * sign * LEAD_IN, at(s)[1] - dir[1] * sign * LEAD_IN]
    const clear = (p) => Math.hypot(p[0] - hub.x, p[1] - hub.z) > 1.2
    const dLo = Math.hypot(at(lo)[0] - bot.x, at(lo)[1] - bot.z) + (clear(leadAt(lo, 1)) ? 0 : 100)
    const dHi = Math.hypot(at(hi)[0] - bot.x, at(hi)[1] - bot.z) + (clear(leadAt(hi, -1)) ? 0 : 100)
    if (dHi < dLo) { dir = [-dir[0], -dir[1]]; [lo, hi] = [-hi, -lo] }
    const start = at(lo)
    const end = at(hi)
    return {
      dir, start, end,
      leadIn: [start[0] - dir[0] * LEAD_IN, start[1] - dir[1] * LEAD_IN],
      runOut: [end[0] + dir[0] * RUN_OUT, end[1] + dir[1] * RUN_OUT],
      yaw: yawFacing(dir[0], dir[1]),
    }
  }

  /* Where the n-th ball of this cycle comes to rest: rows of two along this cycle's landing row. */
  function landingSpot(n, total) {
    const [a, b] = rows[cycle % rows.length]
    const L = Math.hypot(b[0] - a[0], b[1] - a[1])
    const ux = (b[0] - a[0]) / L
    const uz = (b[1] - a[1]) / L
    const nRows = Math.ceil(total / 2)
    const along = Math.min(L, ROW_PITCH * (nRows - 1)) * (nRows > 1 ? Math.floor(n / 2) / (nRows - 1) : 0.5)
    const s = (L - Math.min(L, ROW_PITCH * (nRows - 1))) / 2 + along + (rng() - 0.5) * 0.06
    const side = (n % 2 ? 1 : -1) * ROW_HALF + (rng() - 0.5) * 0.05
    return [a[0] + ux * s - uz * side, a[1] + uz * s + ux * side]
  }

  function reset(baseYaw = 0) {
    rng = mulberry32(seed)
    balls.forEach((b, i) => {
      b.state = 'floor'
      b.pos.set(spots[i][0], R, spots[i][1])
      b.spin.identity()
      b.slot = -1
      b.landCycle = -1
    })
    Object.assign(bot, { x: home[0], z: home[1], vx: 0, vz: 0, yaw: baseYaw, w: 0 })
    cycle = 0
    fired = 0
    feeding = false
    feedClock = 0
    fly = 0
    hood = 15
    mode = 'approach'
    pass = planPass(spots)
    clock = 0
    started = true
  }

  /* The release point for a hood angle, in the robot frame: the manifest's point turned about the hood
     pivot. `z` picks the lane across the 552 mm shooter. */
  function exitFor(hoodDeg, z) {
    const a = ((hoodDeg - cadHood) * Math.PI) / 180
    const dx = exitLocal[0] - pivot[0]
    const dy = exitLocal[1] - pivot[1]
    return new THREE.Vector3(pivot[0] + dx * Math.cos(a) - dy * Math.sin(a), pivot[1] + dx * Math.sin(a) + dy * Math.cos(a), z)
  }

  /* This cycle's firing spot, and the strafe either side of it the robot fires along: square to the
     line to the HUB, so the range barely changes while it moves. */
  function shotSpot() {
    const s = shots[cycle % shots.length]
    const x = hub.x + Math.cos(s.bearing) * s.range
    const z = hub.z + Math.sin(s.bearing) * s.range
    return { x, z, sx: -Math.sin(s.bearing), sz: Math.cos(s.bearing), range: s.range }
  }
  let strafe = 1

  /* Holonomic drive toward a point: speed falls off so it arrives at `vEnd`, accelerations are
     limited, and the heading is profiled on its own toward `yawTarget`. */
  function driveToward(px, pz, vCruise, vEnd, yawTarget, dt) {
    const dx = px - bot.x
    const dz = pz - bot.z
    const d = Math.hypot(dx, dz)
    const vWant = d < 1e-3 ? 0 : Math.min(vCruise, Math.sqrt(vEnd * vEnd + 2 * A_MAX * 0.8 * d))
    const tx = d < 1e-3 ? 0 : (dx / d) * vWant
    const tz = d < 1e-3 ? 0 : (dz / d) * vWant
    const ex = tx - bot.vx
    const ez = tz - bot.vz
    const e = Math.hypot(ex, ez)
    const step = Math.min(e, A_MAX * dt)
    if (e > 1e-6) { bot.vx += (ex / e) * step; bot.vz += (ez / e) * step }
    const sp = Math.hypot(bot.vx, bot.vz)
    if (sp > V_MAX) { bot.vx *= V_MAX / sp; bot.vz *= V_MAX / sp }
    bot.x += bot.vx * dt
    bot.z += bot.vz * dt
    /* Heading: a trapezoidal profile, independent of the translation. */
    const err = wrap(yawTarget - bot.yaw)
    /* A deadband once it is on heading, so holding a heading is still rather than a dither. */
    const wWant = Math.abs(err) < 0.004 ? 0 : Math.sign(err) * Math.min(W_MAX, Math.sqrt(2 * ALPHA_MAX * 0.8 * Math.abs(err)))
    bot.w += clamp(wWant - bot.w, -ALPHA_MAX * dt, ALPHA_MAX * dt)
    if (wWant === 0 && Math.abs(bot.w) <= ALPHA_MAX * dt) bot.w = 0
    bot.yaw += bot.w * dt
  }

  const _w = new THREE.Vector3()
  const _l = new THREE.Vector3()
  const _m = new THREE.Matrix4()
  const _q = new THREE.Quaternion()
  const _s = new THREE.Vector3()
  const _axis = new THREE.Vector3()
  const ONE = new THREE.Vector3(1, 1, 1)

  /**
   * Advance one step. `top` maps the robot frame to the world (it must already carry this frame's
   * pose); `deploy` is the hopper's current extension; `active` false holds the behaviour still (the
   * scene is between shots) while it is still drawn. Returns the pose, the velocity, the mechanism
   * commands and the current decision.
   */
  function update(dt, { top, deploy, baseYaw, active, visible, shift = 0 }) {
    if (!started) reset(baseYaw)
    if (active) think(dt, top, deploy)
    draw(dt, top, visible, shift, active)
    return {
      pose: { x: bot.x, z: bot.z, yaw: bot.yaw },
      vel: { vx: bot.vx, vz: bot.vz, w: bot.w },
      intake: 1,
      rollers: mode === 'sweep' || mode === 'approach' ? 1 : 0,
      fly: mode === 'score' ? 1 : 0,
      feed: mode === 'score' && feeding ? 1 : 0,
      hood: mode === 'score' ? hood : 15,
      mode,
      reason,
      shot: mode === 'score' ? { hood, range } : null,
      held: held().length,
      inPlay: balls.length,
    }
  }

  function think(dt, top, deploy) {
    const inHopper = held().length
    const along = pass ? (bot.x - pass.start[0]) * pass.dir[0] + (bot.z - pass.start[1]) * pass.dir[1] : 0
    const rowLen = pass ? Math.hypot(pass.end[0] - pass.start[0], pass.end[1] - pass.start[1]) : 0

    clock += dt
    if (mode === 'approach') {
      /* To the lead-in, turning onto the row on the way. Each ball's resting time is known from when it
         was fired, so the approach is paced to arrive just as the last one stops — no standing about. */
      const ready = settled()
      const d = Math.hypot(pass.leadIn[0] - bot.x, pass.leadIn[1] - bot.z)
      const restIn = Math.max(0, ...balls.map((b) => (b.state === 'rolling' || b.state === 'flight' ? b.restAt - clock : 0)))
      const pace = restIn > 0.25 ? clamp(d / restIn, 0.5, V_MAX) : V_MAX
      driveToward(pass.leadIn[0], pass.leadIn[1], pace, ready ? V_SWEEP : 0.35, pass.yaw, dt)
      reason = ready
        ? `${loose().length} FUEL in a row ${Math.hypot(pass.start[0] - bot.x, pass.start[1] - bot.z).toFixed(1)} m away — lining up one pass`
        : 'FUEL is rolling out of the HUB — lining up where it will stop'
      if (ready && d < 0.12 && Math.abs(wrap(pass.yaw - bot.yaw)) < 0.08) mode = 'sweep'
    } else if (mode === 'sweep') {
      /* Down the row's line itself, not at its end point: a lookahead on the line pulls the robot onto
         it, so a start a few centimetres off does not carry the mouth past the balls. */
      const t = clamp(along + 0.6, 0, rowLen + RUN_OUT)
      driveToward(pass.start[0] + pass.dir[0] * t, pass.start[1] + pass.dir[1] * t, V_SWEEP, V_SWEEP, pass.yaw, dt)
      reason = `One pass, intake first — ${inHopper} of ${inHopper + balls.filter((b) => b.state === 'floor').length} in`
      if (along > rowLen + RUN_OUT * 0.6) {
        if (inHopper) {
          mode = 'score'
          pass = null
        } else {
          pass = planPass(balls.filter((b) => b.state === 'floor').map((b) => [b.pos.x, b.pos.z]))
          mode = pass ? 'approach' : 'score'
        }
      }
    } else if (mode === 'score') {
      /* Turn the shooter (the robot's back) to the HUB, spin up and solve the hood from the live
         distance — all while driving to the arc — then fire on the move. */
      /* Drive to the spot, then strafe across it while firing — shooting on the move. */
      const spot = shotSpot()
      const toSpot = Math.hypot(spot.x - bot.x, spot.z - bot.z)
      const ex = spot.x + spot.sx * 0.45 * strafe
      const ez = spot.z + spot.sz * 0.45 * strafe
      if (feeding && Math.hypot(ex - bot.x, ez - bot.z) < 0.12) strafe = -strafe
      const aimYaw = yawFacing(-(hub.x - bot.x), -(hub.z - bot.z))
      if (feeding || toSpot < 0.3) driveToward(ex, ez, V_SHOOT, V_SHOOT, aimYaw, dt)
      else driveToward(spot.x, spot.z, V_MAX, V_SHOOT, aimYaw, dt)
      fly = Math.min(1, fly + dt / 0.9)
      top.localToWorld(_w.copy(exitFor(hood, 0)))
      range = Math.hypot(hub.x - _w.x, hub.z - _w.z)
      hood = solveHood(_w.y, range).hood
      const aimed = Math.abs(wrap(aimYaw - bot.yaw)) < 0.2
      feeding = fly > 0.95 && aimed && toSpot < 0.6
      reason = feeding
        ? `${inHopper} FUEL to go — firing on the move at ${range.toFixed(1)} m, hood ${hood.toFixed(1)}°`
        : `${inHopper} FUEL aboard — turning to the HUB and spinning up on the way`
      if (feeding) {
        feedClock -= dt
        if (feedClock <= 0) { feedClock = FEED_EVERY; fire(top) }
      }
      if (inHopper === 0) {
        /* Everything is in the air: the next pass is where it will land, so go there now. */
        feeding = false
        fly = 0
        /* Only the balls fired this cycle: their landing spots are known, and nothing else is in that
           row. Mixing in anything else (a ball with no landing spot yet) bent the row toward it. */
        const row = balls.filter((b) => b.landCycle === cycle).map((b) => [b.land.x, b.land.z])
        cycle++
        fired = 0
        pass = planPass(row)
        mode = pass ? 'approach' : 'score'
      }
    }

    /* Capture: a floor ball inside the mouth's footprint, in the robot's frame. */
    if ((mode === 'sweep' || mode === 'approach') && mouth) {
      const mouthX = mouth.center[0] - ((manifest?.intake?.travel ?? 0.3) - deploy)
      for (const b of balls) {
        if (b.state !== 'floor') continue
        top.worldToLocal(_l.copy(b.pos))
        if (_l.x > mouthX - 0.28 && _l.x < mouthX + 0.14 && Math.abs(_l.z) < mouth.width / 2) {
          b.state = 'intake'
          b.t = 0
          b.from.copy(_l)
          b.slot = held().length - 1
        }
      }
    }
  }

  /* One ball out of the lowest slot, on a solved arc to the HUB; the rest settle toward the feeder.
     Where it will come to rest afterwards is decided now, so the next pass can be planned before it
     lands. */
  function fire(top) {
    const queue = held().sort((a, b) => a.slot - b.slot)
    const b = queue[0]
    if (!b) return
    const lane = clamp(slots[b.slot]?.z ?? 0, -0.207, 0.207)
    top.localToWorld(_w.copy(exitFor(hood, lane)))
    const th = ((88.44 - hood) * Math.PI) / 180
    const tx = hub.x + (rng() - 0.5) * 0.2
    const tz = hub.z + (rng() - 0.5) * 0.2
    const D = Math.hypot(tx - _w.x, tz - _w.z)
    const den = 2 * Math.cos(th) ** 2 * (_w.y + D * Math.tan(th) - AIM_Y)
    if (den <= 0) return
    const v = Math.sqrt((G * D * D) / den)
    const vh = v * Math.cos(th)
    b.state = 'flight'
    b.t = 0
    b.from.copy(_w)
    b.v.set(((tx - _w.x) / D) * vh, v * Math.sin(th), ((tz - _w.z) / D) * vh)
    b.dur = D / vh
    const [lx, lz] = landingSpot(fired++, balls.length)
    b.land.set(lx, R, lz)
    b.landCycle = cycle
    /* When it will stop: the flight, its time inside the HUB, and the roll the carpet brings to rest. */
    const out = Math.atan2(lz - hub.z, lx - hub.x)
    const roll = Math.hypot(lx - (hub.x + Math.cos(out) * 0.72), lz - (hub.z + Math.sin(out) * 0.72))
    b.restAt = clock + b.dur + 0.55 + Math.sqrt((2 * roll) / ROLL_DECEL)
    queue.slice(1).forEach((x, i) => { x.slot = i })
    b.slot = -1
  }

  /* Out of the HUB's base toward its landing spot, at exactly the speed the carpet will stop it in. */
  function release(b) {
    const out = Math.atan2(b.land.z - hub.z, b.land.x - hub.x)
    b.rollFrom.set(hub.x + Math.cos(out) * 0.72, R, hub.z + Math.sin(out) * 0.72)
    const d = Math.hypot(b.land.x - b.rollFrom.x, b.land.z - b.rollFrom.z)
    b.rollDir.set((b.land.x - b.rollFrom.x) / d, 0, (b.land.z - b.rollFrom.z) / d)
    b.rollV0 = Math.sqrt(2 * ROLL_DECEL * d)
    b.rollT = 0
    b.state = 'rolling'
    b.pos.copy(b.rollFrom)
  }

  function draw(dt, top, visible, shift, active) {
    for (const b of balls) {
      if (active) b.t += dt
      if (b.state === 'intake' || b.state === 'held') {
        /* Up the intake and into its slot, carried with the robot; settling toward the feeder as balls
           leave. */
        const slot = slots[clamp(b.slot, 0, slots.length - 1)] ?? _l.set(0, 0.36, 0)
        if (b.state === 'intake') {
          const u = clamp(b.t / 0.5, 0, 1)
          const e = u * u * (3 - 2 * u)
          _l.copy(b.from).lerp(slot, e)
          _l.y += Math.sin(Math.PI * u) * 0.05
          if (u >= 1) { b.state = 'held'; b.from.copy(slot) }
        } else {
          b.from.lerp(slot, 1 - Math.exp(-dt * 10))
          _l.copy(b.from)
        }
        top.localToWorld(b.pos.copy(_l))
      } else if (b.state === 'flight') {
        b.pos.copy(b.from).addScaledVector(b.v, b.t)
        b.pos.y -= 0.5 * G * b.t * b.t
        if (b.t > b.dur + 0.55) release(b) // through the HUB and out of its base
      } else if (b.state === 'rolling' && active) {
        const tStop = b.rollV0 / ROLL_DECEL
        b.rollT = Math.min(tStop, b.rollT + dt)
        const s = b.rollV0 * b.rollT - 0.5 * ROLL_DECEL * b.rollT * b.rollT
        const prev = _w.copy(b.pos)
        b.pos.copy(b.rollFrom).addScaledVector(b.rollDir, s)
        /* If the robot is in the way, the ball runs round its frame instead of through it. */
        const rx = b.pos.x - bot.x
        const rz = b.pos.z - bot.z
        const rd = Math.hypot(rx, rz)
        if (rd < 0.6) {
          b.pos.x = bot.x + (rx / (rd || 1)) * 0.6
          b.pos.z = bot.z + (rz / (rd || 1)) * 0.6
          b.land.set(b.pos.x, R, b.pos.z)
        }
        const step = prev.distanceTo(b.pos)
        if (step > 1e-6) {
          _axis.set(b.rollDir.z, 0, -b.rollDir.x)
          b.spin.premultiply(_q.setFromAxisAngle(_axis, step / R))
        }
        if (b.rollT >= tStop) b.state = 'floor'
      }
    }
    let i = 0
    for (const b of balls) {
      /* Hidden only while it is inside the HUB, between going in and rolling out. */
      const inside = b.state === 'flight' && b.t > b.dur
      _w.copy(b.pos)
      if (b.state === 'floor' || b.state === 'rolling') _w.x += shift
      _s.copy(ONE).multiplyScalar(!visible || inside ? 0 : 1)
      _m.compose(_w, b.spin, _s)
      mesh.setMatrixAt(i++, _m)
    }
    mesh.instanceMatrix.needsUpdate = true
  }

  return { update, reset, mesh }
}
