// Shot solving with gravity and quadratic air drag — the same drag the physics
// world applies to every ball in flight, so a solved shot really lands.
import { FUEL } from './config.js'

const G = 9.81
// The physics world's own step, and its own order of work (gravity, move, then
// drag): flown the same way, a solved shot lands where the world will put it.
const DT = 1 / 60

/**
 * Fly a ball in the vertical plane of the shot. Returns the height, vertical
 * speed and time when it has travelled `dist` horizontally, or null if it
 * hits the floor first.
 */
export function heightAt(speed, hoodRad, dist, y0) {
  let r = 0
  let y = y0
  let vr = speed * Math.cos(hoodRad)
  let vy = speed * Math.sin(hoodRad)
  let t = 0
  while (t < 5) {
    vy -= G * DT
    const r1 = r + vr * DT
    const y1 = y + vy * DT
    if (r1 >= dist) {
      // Somewhere inside this step: the part of it that gets there.
      const u = (dist - r) / (r1 - r)
      return { y: y + (y1 - y) * u, vy, t: t + DT * u }
    }
    r = r1
    y = y1
    t += DT
    if (y < 0 || vr <= 0.05) return null
    const k = 1 - FUEL.K * Math.hypot(vr, vy) * DT
    vr *= k
    vy *= k
  }
  return null
}

/**
 * The exit speed that drops a ball through a point `dist` away and `h` high,
 * coming down. Null if the shooter cannot reach it (or only on the way up).
 * `near` is a speed it is known to be close to (the last answer, for a shot
 * being re-solved a moment later): the search starts there.
 */
export function solveSpeed(dist, h, hoodDeg, y0, maxSpeed, near = null) {
  const hood = (hoodDeg * Math.PI) / 180
  const f = (s) => {
    const r = heightAt(s, hood, dist, y0)
    return r ? r.y - h : -Infinity
  }
  let lo = 1
  let hi = maxSpeed
  let steps = 18 // to a tenth of a millimetre a second
  if (near != null && near - 0.6 > lo && near + 0.6 < hi && f(near - 0.6) < 0 && f(near + 0.6) >= 0) {
    lo = near - 0.6
    hi = near + 0.6
    steps = 12
  } else if (f(hi) < 0) {
    return null
  }
  for (let i = 0; i < steps; i++) {
    const mid = (lo + hi) / 2
    if (f(mid) < 0) lo = mid
    else hi = mid
  }
  const end = heightAt(hi, hood, dist, y0)
  if (!end || end.vy > -0.5) return null // would clip the rim on the way up
  return { speed: hi, tof: end.t }
}

/**
 * A full aim: where to point and how fast to throw, from a shooter at `from`
 * (x, y, z) moving at `vel` (x, z), at a target `to` (x, y, z).
 *
 * `moving: true` leads the target by the robot's own velocity (shooting on the
 * move); without it the shot ignores the robot's motion, as a fixed shooter
 * that just ranges off distance would. `near` is the speed of the last
 * solution, if this is the same shot a moment later.
 */
export function solveShot(from, to, vel, hoodDeg, maxSpeed, moving, near = null) {
  let tx = to.x
  let tz = to.z
  let sol = null
  // A robot that is not moving has nothing to lead.
  const leads = moving && Math.hypot(vel.x, vel.z) > 0.02 ? 4 : 1
  for (let i = 0; i < leads; i++) {
    const dist = Math.hypot(tx - from.x, tz - from.z)
    sol = solveSpeed(dist, to.y, hoodDeg, from.y, maxSpeed, sol ? sol.speed : near)
    if (!sol) return null
    if (leads === 1) break
    tx = to.x - vel.x * sol.tof
    tz = to.z - vel.z * sol.tof
  }
  return { ...sol, yaw: Math.atan2(tz - from.z, tx - from.x), dist: Math.hypot(to.x - from.x, to.z - from.z) }
}

/** Launch velocity (world x, y, z) for a solved shot, adding the robot's own motion. */
export function launchVelocity(speed, yaw, hoodDeg, vel) {
  const hood = (hoodDeg * Math.PI) / 180
  const h = speed * Math.cos(hood)
  return {
    x: Math.cos(yaw) * h + (vel?.x || 0),
    y: speed * Math.sin(hood),
    z: Math.sin(yaw) * h + (vel?.z || 0),
  }
}
