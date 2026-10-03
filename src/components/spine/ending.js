// The spine's last shot: Numbers runs a real scoring cycle.
//
// FUEL lies on the carpet. The robot deploys its intake and drives through it nose-first; a ball is
// taken only when it is actually inside the intake mouth's footprint, then rides into the next free
// hopper slot. It drives to range with its back to the HUB (Numbers shoots out of its back), solves the
// hood angle for that distance, spins up, and fires what it collected — lowest slot first, the rest
// settling toward the feeder. Scored FUEL drops out of the HUB's base and rolls back to where it lay,
// the way a REBUILT HUB returns it to the field, so the loop closes without anything appearing.
//
// Geometry comes from the bake's manifest (public/models/robot.json): the 13 hopper slots
// (`hopper.ballCentres.deployed`, packed lowest first), the intake mouth, the shooter's release point
// and `elevation = 88.44 − hood`. Unlike Catalyst Console, which only draws what telemetry knows, this
// is a marketing shot: the balls are solved to go in.

import * as THREE from 'three'

const R = 0.075 // FUEL radius, m
const G = 9.81
const PERIOD = 14.5
/* Seconds into the loop. */
const T = {
  deploy: 0.3, collect: [0.9, 4.0], toSpot: [4.0, 5.6], aim: 5.6, feed: [6.4, 8.0], stow: 8.6,
  home: [8.6, 11.6],
}
const FEED_EVERY = 0.2
/* Hood.java's range. */
const HOOD_MIN = 13
const HOOD_MAX = 45
/* Shot distances, one per loop, so the solved angle visibly changes. */
const RANGES = [2.7, 3.3, 2.4]
const RIM_Y = 1.83 // the HUB's opening
const RIM_HALF = 0.6 // centre to the opening's edge, roughly
const AIM_Y = 1.55 // the arc is solved to pass this low inside the HUB's centre

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const minJerk = (u) => { u = clamp01(u); return u * u * u * (10 - 15 * u + 6 * u * u) }
const easeOut = (u) => 1 - (1 - clamp01(u)) ** 3
const quad = (p0, c, p1, u) => [
  (1 - u) * (1 - u) * p0[0] + 2 * (1 - u) * u * c[0] + u * u * p1[0],
  (1 - u) * (1 - u) * p0[1] + 2 * (1 - u) * u * c[1] + u * u * p1[1],
]
const quadTan = (p0, c, p1, u) => [2 * (1 - u) * (c[0] - p0[0]) + 2 * u * (p1[0] - c[0]), 2 * (1 - u) * (c[1] - p0[1]) + 2 * u * (p1[1] - c[1])]
/* Robot yaw (three.js rotation.y) that points its +x along world direction (dx, dz). */
const yawFacing = (dx, dz) => Math.atan2(-dz, dx)
const nearestTurn = (to, from) => { let t = to; while (t - from > Math.PI) t -= 2 * Math.PI; while (from - t > Math.PI) t += 2 * Math.PI; return t }

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
    if (!best || v < best.v) best = { hood, v, th }
  }
  return best ?? { hood: 30, v: 7, th: ((88.44 - 30) * Math.PI) / 180 }
}

export function createEnding({ scene, manifest, hubAt }) {
  const slots = (manifest?.hopper?.ballCentres?.deployed ?? []).map((p) => new THREE.Vector3(...p))
  const mouth = manifest?.intakeMouth
  const travel = manifest?.intake?.travel ?? 0.3
  const exitLocal = manifest?.shooter?.exit?.point ?? [-0.17, 0.51, 0]
  const pivot = manifest?.hood?.pivot ?? [-0.2858, 0.4826, 0]
  const cadHood = manifest?.hood?.cadAngle ?? 11
  const hub = new THREE.Vector3(...hubAt)

  /* The path, in world metres on the carpet. Home is the origin. */
  const home = [0, 0]
  const collect = { p0: home, c: [1.5, -0.2], p1: [1.6, -1.6] }
  const toHub = new THREE.Vector2(-hub.x, -hub.z).normalize() // from the HUB back toward home
  const spotFor = (d) => [hub.x + toHub.x * d, hub.z + toHub.y * d]
  /* FUEL laid across the collect path: four rows, two abreast, all inside the mouth's 552 mm. */
  const spots = []
  for (const u of [0.5, 0.59, 0.68, 0.77]) {
    const [x, z] = quad(collect.p0, collect.c, collect.p1, u)
    const [tx, tz] = quadTan(collect.p0, collect.c, collect.p1, u)
    const L = Math.hypot(tx, tz)
    for (const side of [-0.13, 0.13]) spots.push(new THREE.Vector3(x - (tz / L) * side, R, z + (tx / L) * side))
  }
  /* Where scored FUEL leaves the HUB: its base, on the side facing home. */
  const hubExit = new THREE.Vector3(hub.x + toHub.x * 0.72, R, hub.z + toHub.y * 0.72)

  const mesh = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(R, 2),
    new THREE.MeshStandardMaterial({ color: 0xd4b13f, roughness: 0.62, metalness: 0, envMapIntensity: 0.7 }),
    spots.length,
  )
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.frustumCulled = false
  scene.add(mesh)

  const balls = spots.map((home) => ({ state: 'floor', pos: home.clone(), home, slot: -1, t: 0, from: new THREE.Vector3(), v: new THREE.Vector3(), spin: new THREE.Quaternion(), dur: 0 }))
  let loop = -1
  let shot = null // this loop's solved shot
  let lastFeed = -1

  function reset() {
    for (const b of balls) { b.state = 'floor'; b.pos.copy(b.home); b.slot = -1; b.spin.identity() }
    shot = null
    lastFeed = -1
  }

  /* The pose at loop time t: world x, z and absolute yaw. `baseYaw` is the shot's own yaw at home. */
  function pose(t, baseYaw, range) {
    const S = spotFor(range)
    const aimYaw = yawFacing(-(hub.x - S[0]), -(hub.z - S[1])) // back (−x) toward the HUB
    const collectYaw = (u) => { const [dx, dz] = quadTan(collect.p0, collect.c, collect.p1, u); return yawFacing(dx, dz) }
    const y0 = nearestTurn(collectYaw(0), baseYaw)
    const yEnd = nearestTurn(collectYaw(1), y0)
    const yAim = nearestTurn(aimYaw, yEnd)
    if (t < T.collect[0]) return { x: 0, z: 0, yaw: baseYaw }
    if (t < T.collect[1]) {
      const u = minJerk((t - T.collect[0]) / (T.collect[1] - T.collect[0]))
      const [x, z] = quad(collect.p0, collect.c, collect.p1, u)
      /* Turn onto the path in the first fifth — well before the first ball — then follow its tangent,
         nose first. */
      const lead = clamp01(u / 0.2)
      const yaw = lead < 1 ? baseYaw + (y0 - baseYaw) * minJerk(lead) : nearestTurn(collectYaw(u), y0)
      return { x, z, yaw }
    }
    if (t < T.toSpot[1]) {
      const u = minJerk((t - T.toSpot[0]) / (T.toSpot[1] - T.toSpot[0]))
      const [x, z] = quad(collect.p1, [collect.p1[0] - 0.1, (collect.p1[1] + S[1]) / 2 - 0.3], S, u)
      return { x, z, yaw: yEnd + (yAim - yEnd) * u }
    }
    if (t < T.home[0]) return { x: S[0], z: S[1], yaw: yAim }
    if (t < T.home[1]) {
      const u = minJerk((t - T.home[0]) / (T.home[1] - T.home[0]))
      const [x, z] = quad(S, [S[0] - 1.4, S[1] * 0.45], home, u)
      /* Home the long way: a full turn on the way back, which only a swerve drive does while driving. */
      const end = nearestTurn(baseYaw, yAim) + (yAim > baseYaw ? -2 * Math.PI : 2 * Math.PI)
      return { x, z, yaw: yAim + (end - yAim) * u }
    }
    return { x: 0, z: 0, yaw: baseYaw }
  }

  const _w = new THREE.Vector3()
  const _l = new THREE.Vector3()
  const _m = new THREE.Matrix4()
  const _q = new THREE.Quaternion()
  const _s = new THREE.Vector3()
  const _axis = new THREE.Vector3()
  const ONE = new THREE.Vector3(1, 1, 1)

  /* The release point for a hood angle, in the robot frame: the manifest's point turned about the hood
     pivot. `z` picks the lane across the 552 mm shooter. */
  function exitFor(hoodDeg, z) {
    const a = ((hoodDeg - cadHood) * Math.PI) / 180
    const dx = exitLocal[0] - pivot[0]
    const dy = exitLocal[1] - pivot[1]
    return new THREE.Vector3(pivot[0] + dx * Math.cos(a) - dy * Math.sin(a), pivot[1] + dx * Math.sin(a) + dy * Math.cos(a), z)
  }

  /**
   * Advance the cycle. `t` is loop time, `top` the robot's frame node (robot frame → world), `deploy`
   * the intake's current extension in metres, `shift` how far the field is still sliding in from the
   * right (0 once it is framed). Returns the mechanism commands for this moment.
   */
  function update(t, dt, endT, { top, deploy, shift, visible }) {
    const n = Math.floor(endT / PERIOD)
    if (n !== loop) { loop = n; reset() }
    const range = RANGES[((n % RANGES.length) + RANGES.length) % RANGES.length]

    /* Capture: a floor ball inside the mouth's footprint, in the robot's frame. */
    if (t > T.collect[0] && t < T.toSpot[0] && mouth) {
      const mouthX = mouth.center[0] - (travel - deploy)
      for (const b of balls) {
        if (b.state !== 'floor') continue
        top.worldToLocal(_l.copy(b.pos))
        if (_l.x > mouthX - 0.25 && _l.x < mouthX + 0.12 && Math.abs(_l.z) < mouth.width / 2) {
          b.state = 'intake'
          b.t = 0
          b.from.copy(_l)
          b.slot = balls.filter((x) => x.slot >= 0).length
        }
      }
    }

    /* Aim: solve the hood for this loop's distance, from the release point at that angle. */
    if (t >= T.aim && !shot) {
      let hood = 25
      for (let k = 0; k < 2; k++) {
        const e = exitFor(hood, 0)
        top.localToWorld(_w.copy(e))
        hood = solveHood(_w.y, Math.hypot(hub.x - _w.x, hub.z - _w.z)).hood
      }
      shot = { hood, range }
    }

    /* Feed: one ball every FEED_EVERY, lowest slot first. */
    if (shot && t >= T.feed[0] && t < T.feed[1]) {
      const k = Math.floor((t - T.feed[0]) / FEED_EVERY)
      if (k > lastFeed) {
        lastFeed = k
        const held = balls.filter((b) => b.state === 'held' || b.state === 'intake').sort((a, b) => a.slot - b.slot)
        const b = held[0]
        if (b) {
          const lane = Math.max(-0.207, Math.min(0.207, slots[b.slot]?.z ?? 0))
          const e = exitFor(shot.hood, lane)
          top.localToWorld(_w.copy(e))
          const th = ((88.44 - shot.hood) * Math.PI) / 180
          const tx = hub.x + (Math.random() - 0.5) * 0.2
          const tz = hub.z + (Math.random() - 0.5) * 0.2
          const D = Math.hypot(tx - _w.x, tz - _w.z)
          const den = 2 * Math.cos(th) ** 2 * (_w.y + D * Math.tan(th) - AIM_Y)
          if (den > 0) {
            const v = Math.sqrt((G * D * D) / den)
            const vh = v * Math.cos(th)
            b.state = 'flight'
            b.t = 0
            b.from.copy(_w)
            b.v.set(((tx - _w.x) / D) * vh, v * Math.sin(th), ((tz - _w.z) / D) * vh)
            b.dur = D / vh + 0.1
          }
          /* The rest settle toward the feeder: re-pack lowest first. */
          held.slice(1).forEach((x, i) => { x.slot = i })
          b.slot = -1
        }
      }
    }

    for (const b of balls) {
      b.t += dt
      if (b.state === 'floor') {
        _w.copy(b.home)
      } else if (b.state === 'intake' || b.state === 'held') {
        /* Up the intake and into its slot, carried with the robot. */
        const target = slots[Math.min(b.slot, slots.length - 1)] ?? _l.set(0, 0.36, 0)
        if (b.state === 'intake') {
          const u = minJerk(b.t / 0.55)
          _l.copy(b.from).lerp(target, u)
          _l.y += Math.sin(Math.PI * u) * 0.06
          if (u >= 1) { b.state = 'held'; b.from.copy(target) }
        } else {
          b.from.lerp(target, 1 - Math.exp(-dt * 10)) // settling toward the feeder as balls leave
          _l.copy(b.from)
        }
        top.localToWorld(_w.copy(_l))
      } else if (b.state === 'flight') {
        _w.copy(b.from).addScaledVector(b.v, b.t)
        _w.y -= 0.5 * G * b.t * b.t
        if (b.t > b.dur + 0.45) { b.state = 'return'; b.t = 0 } // through the HUB
      } else if (b.state === 'return') {
        /* Out of the HUB's base and rolling home, slowing as it goes. */
        const u = easeOut(b.t / 2.4)
        _w.copy(hubExit).lerp(b.home, u)
        const step = _w.distanceTo(b.pos)
        if (step > 1e-5) {
          _axis.set(_w.z - b.pos.z, 0, -(_w.x - b.pos.x)).normalize()
          b.spin.premultiply(_q.setFromAxisAngle(_axis, step / R))
        }
        if (u >= 1) b.state = 'floor'
      }
      if (b.state !== 'flight' || b.t > 0) b.pos.copy(_w)
    }

    let i = 0
    for (const b of balls) {
      const hidden = !visible || (b.state === 'flight' && b.t > b.dur) // inside the HUB
      _w.copy(b.pos)
      if (b.state === 'floor' || b.state === 'return') _w.x += shift
      _s.copy(ONE).multiplyScalar(hidden ? 0 : 1)
      _m.compose(_w, b.spin, _s)
      mesh.setMatrixAt(i++, _m)
    }
    mesh.instanceMatrix.needsUpdate = true

    const carrying = balls.some((b) => b.state === 'held' || b.state === 'intake')
    return {
      intake: t >= T.deploy && t < T.stow ? 1 : 0,
      hood: shot && t < T.stow ? shot.hood : 15,
      fly: shot && t >= T.aim - 0.4 && t < T.feed[1] + 0.3 ? 1 : 0,
      feed: shot && t >= T.feed[0] && t < T.feed[1] ? 1 : 0,
      rollers: t > T.collect[0] && t < T.toSpot[0] ? 1 : 0, // intake and conveyor while collecting
      carrying,
      shot,
      /* The pose at any loop time, for this loop's range — pure, so the drive can differentiate it. */
      poseAt: (tt, baseYaw) => pose(tt, baseYaw, range),
    }
  }

  return { update, reset, period: PERIOD, mesh }
}
