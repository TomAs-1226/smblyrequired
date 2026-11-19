// Shot solving with gravity and quadratic air drag — the same drag the physics
// world applies to every ball in flight, so a solved shot really lands.
import { FUEL } from './config.js'

const G = 9.81
const DT = 1 / 240

/**
 * Fly a ball in the vertical plane of the shot. Returns the height (and
 * vertical speed) when it has travelled `dist` horizontally, or null if it
 * hits the floor first.
 */
export function heightAt(speed, hoodRad, dist, y0) {
  let r = 0
  let y = y0
  let vr = speed * Math.cos(hoodRad)
  let vy = speed * Math.sin(hoodRad)
  let t = 0
  while (r < dist) {
    const v = Math.hypot(vr, vy)
    vr -= FUEL.K * v * vr * DT
    vy -= (G + FUEL.K * v * vy) * DT
    r += vr * DT
    y += vy * DT
    t += DT
    if (y < 0 || t > 5 || vr <= 0.05) return null
  }
  return { y, vy, t }
}

/**
 * The exit speed that drops a ball through a point `dist` away and `h` high,
 * coming down. Null if the shooter cannot reach it (or only on the way up).
 */
export function solveSpeed(dist, h, hoodDeg, y0, maxSpeed) {
  const hood = (hoodDeg * Math.PI) / 180
  const f = (s) => {
    const r = heightAt(s, hood, dist, y0)
    return r ? r.y - h : -Infinity
  }
  let lo = 1
  let hi = maxSpeed
  if (f(hi) < 0) return null
  for (let i = 0; i < 40; i++) {
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
 * that just ranges off distance would.
 */
export function solveShot(from, to, vel, hoodDeg, maxSpeed, moving) {
  let tx = to.x
  let tz = to.z
  let sol = null
  for (let i = 0; i < (moving ? 4 : 1); i++) {
    const dist = Math.hypot(tx - from.x, tz - from.z)
    sol = solveSpeed(dist, to.y, hoodDeg, from.y, maxSpeed)
    if (!sol) return null
    if (!moving) break
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
