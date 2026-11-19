// Robot AI for Cycle Rush 3D. Each robot decides once per physics step what
// it would tell its drivetrain, shooter and climber. It plays the game the way
// drive teams do: collect while its hub is dark, be in range and full when it
// lights up, and leave for the tower with just enough time to climb.
import { FIELD, HUB, TRENCH, LANES, TOWER, MATCH } from './config.js'
import { hubActive, untilHubChange } from './rules.js'
import { aimNow, inClimbZone, wrap } from './sim.js'

const PREFERRED_RANGE = { turret: 3.2, trench: 2.9, hopper: 2.1, bruiser: 2.7 }

// Which side of the two obstacle lines a point is on: 0 blue zone, 1 neutral, 2 red zone.
const region = (x) => (x < HUB.blue.x ? 0 : x > HUB.red.x ? 2 : 1)

export function think(sim, r, dt) {
  const ai = r.ai
  const t = sim.clock
  const remaining = MATCH.total - t

  // Wander briefly when stuck against something.
  if (ai.jitter > 0) {
    ai.jitter -= dt
    return { vx: ai.jx, vz: ai.jz, aim: Math.atan2(ai.jz, ai.jx), fire: false }
  }

  let cmd = null

  // --- endgame: go climb, leaving just enough time
  if (r.a.climb > 0 && t > MATCH.endgame - 10) {
    const tw = TOWER[r.team]
    const s = r.team === 'blue' ? 1 : -1
    const spot = { x: tw.x + s * (TOWER.zone.from + r.a.len / 2 + 0.2), z: tw.z + ai.slot * 1.2 }
    const dist = pathLength(r, spot)
    const needed = dist / (r.a.speed * r.cfg.speed * 0.55) + r.a.climbTime + 3
    if (sim.period === 'endgame' && remaining < needed + (r.carry > 0 ? 0 : 6)) {
      const atSpot = Math.hypot(spot.x - r.x, spot.z - r.z) < 0.3
      if (inClimbZone(r) && atSpot) return { vx: 0, vz: 0, aim: s > 0 ? Math.PI : 0, climb: true, fire: false }
      cmd = navigate(sim, r, spot, 0.1)
      // Empty the hopper on the way if the hub is live and in range.
      const fire = r.carry > 0 && wantsToFire(sim, r, true)
      return { ...cmd, aim: fire && !r.a.turret ? hubBearing(r) : travelHeading(r, cmd), fire }
    }
  }

  // --- defense (one Einstein red robot): sit between the player and their hub
  if (ai.role === 'defender' && sim.period !== 'auto') {
    const p = sim.robots.find((o) => o.isPlayer) || sim.robots[0]
    if (p.carry >= 4 && region(p.x) === 0) {
      const h = HUB.blue
      const dx = p.x - h.x
      const dz = p.z - h.z
      const d = Math.hypot(dx, dz) || 1
      const block = { x: h.x + (dx / d) * 1.6, z: h.z + (dz / d) * 1.6 }
      const goal = Math.hypot(p.x - r.x, p.z - r.z) < 2 ? { x: p.x, z: p.z } : block
      cmd = navigate(sim, r, goal, 0, [p])
      return { ...cmd, aim: Math.atan2(p.z - r.z, p.x - r.x), fire: false }
    }
  }

  // --- score or collect
  const active = hubActive(t, r.team, sim.autoWinner)
  const soon = !active && untilHubChange(t, r.team, sim.autoWinner) < 4
  const threshold = sim.period === 'auto' ? 1 : active ? Math.ceil(r.a.capacity * 0.5) : r.a.capacity
  if (r.carry === 0) ai.mode = 'collect'
  else if (r.carry >= threshold || (sim.period === 'auto' && ai.mode !== 'collect')) ai.mode = 'score'
  if (ai.mode === 'score' && r.carry === 0) ai.mode = 'collect'

  if (ai.mode === 'score' && (active || soon || r.carry >= r.a.capacity)) {
    cmd = scoreMove(sim, r)
  } else {
    cmd = collectMove(sim, r, dt)
  }

  // Stuck check.
  const moving = Math.hypot(r.vx, r.vz)
  const wants = Math.hypot(cmd.vx, cmd.vz) > 0.4
  ai.stuck = wants && moving < 0.25 ? (ai.stuck || 0) + dt : 0
  if (ai.stuck > 1.4) {
    const a = sim.rng() * Math.PI * 2
    ai.jx = Math.cos(a); ai.jz = Math.sin(a); ai.jitter = 0.7; ai.stuck = 0; ai.target = null
  }
  return cmd
}

function hubBearing(r) {
  const h = HUB[r.team]
  return Math.atan2(h.z - r.z, h.x - r.x)
}

function travelHeading(r, cmd) {
  if (Math.hypot(cmd.vx, cmd.vz) < 0.2) return null
  return Math.atan2(cmd.vz, cmd.vx)
}

function wantsToFire(sim, r, moving) {
  if (!hubActive(sim.clock, r.team, sim.autoWinner)) return false
  if (region(r.x) !== (r.team === 'blue' ? 0 : 2)) return false
  const { sol } = aimNow(r)
  if (!sol) return false
  if (r.a.turret) return true
  if (moving && Math.hypot(r.vx, r.vz) > 0.35) return false
  return Math.abs(wrap(sol.yaw - r.psi)) < 0.035
}

function scoreMove(sim, r) {
  const h = HUB[r.team]
  const s = r.team === 'blue' ? 1 : -1
  const range = PREFERRED_RANGE[r.archId || r.arch] || 2.8
  // A spot at the preferred range on our side of the hub, toward where we are.
  let dx = r.x - h.x
  let dz = r.z - h.z
  if (s * dx > -0.4) { dx = -s; dz = Math.sign(r.z - h.z || 1) * 0.9 }
  const d = Math.hypot(dx, dz) || 1
  const spot = {
    x: clampF(h.x + (dx / d) * range, 0.9, FIELD.L - 0.9),
    z: clampF(h.z + (dz / d) * range + r.ai.slot * 0.6, 0.7, FIELD.W - 0.7),
  }
  const there = Math.hypot(spot.x - r.x, spot.z - r.z) < 0.45 && region(r.x) === region(spot.x)
  if (r.a.turret) {
    const cmd = there ? { vx: 0, vz: 0 } : navigate(sim, r, spot, 0.3)
    return { ...cmd, aim: travelHeading(r, cmd) ?? hubBearing(r), fire: wantsToFire(sim, r, true) }
  }
  if (!there) {
    const cmd = navigate(sim, r, spot, 0.3)
    return { ...cmd, aim: travelHeading(r, cmd), fire: false }
  }
  return { vx: -r.vx * 0.2, vz: -r.vz * 0.2, aim: hubBearing(r), fire: wantsToFire(sim, r, false) }
}

function collectMove(sim, r, dt) {
  const ai = r.ai
  ai.retarget = (ai.retarget || 0) - dt
  if (!ai.target || !ai.target.alive || ai.retarget <= 0) {
    ai.retarget = 0.6
    ai.target = pickBall(sim, r)
  }
  const b = ai.target
  if (!b) return { vx: 0, vz: 0, aim: null, fire: false }
  const p = b.body.translation()
  const cmd = navigate(sim, r, { x: p.x, z: p.z }, 0)
  // Face the ball once on its side of the field, so the intake meets it.
  const aim = region(r.x) === region(p.x) && Math.hypot(p.x - r.x, p.z - r.z) < 2.5
    ? Math.atan2(p.z - r.z, p.x - r.x)
    : travelHeading(r, cmd)
  return { ...cmd, aim, fire: false }
}

function pickBall(sim, r) {
  const home = r.team === 'blue' ? 0 : 2
  const away = r.team === 'blue' ? 2 : 0
  let best = null
  let bestCost = Infinity
  for (const b of sim.balls) {
    if (!b.alive || b.air) continue
    const p = b.body.translation()
    if (p.y > 0.2) continue
    // Not inside a hub, under a trench roof's posts, or against a wall.
    if (Math.abs(p.x - HUB.blue.x) < 0.75 && Math.abs(p.z - HUB.blue.z) < 0.75) continue
    if (Math.abs(p.x - HUB.red.x) < 0.75 && Math.abs(p.z - HUB.red.z) < 0.75) continue
    if (p.z < 0.3 || p.z > FIELD.W - 0.3 || p.x < 0.3 || p.x > FIELD.L - 0.3) continue
    const reg = region(p.x)
    if (reg === away) continue
    let cost = Math.hypot(p.x - r.x, p.z - r.z)
    if (reg !== region(r.x)) cost += 3
    if (reg === home && sim.period !== 'auto') cost -= 0.5
    for (const o of sim.robots) {
      if (o !== r && o.team === r.team && o.ai.target === b) cost += 4
    }
    if (cost < bestCost) { bestCost = cost; best = b }
  }
  return best
}

// ------------------------------------------------------------------ navigation
function fitsTrench(r) {
  return r.a.height < TRENCH.clearance - 0.02
}

function lanesFor(r) {
  return [...LANES.bump, ...(fitsTrench(r) ? LANES.trench : [])]
}

function pathLength(r, goal) {
  let d = Math.hypot(goal.x - r.x, goal.z - r.z)
  if (region(r.x) !== region(goal.x)) d += 1.5
  return d
}

/** Drive toward `goal`, crossing an obstacle line through a bump or trench when one is in the way. */
function navigate(sim, r, goal, arrive, ignore = []) {
  const ai = r.ai
  const from = region(r.x)
  const to = region(goal.x)
  let target = goal
  let slow = 1
  if (from !== to) {
    const dir = to > from ? 1 : -1
    const lineX = dir > 0 ? (from === 0 ? HUB.blue.x : HUB.red.x) : from === 2 ? HUB.red.x : HUB.blue.x
    if (!ai.cross || ai.cross.lineX !== lineX) {
      let lane = null
      let best = Infinity
      for (const lz of lanesFor(r)) {
        const c = Math.abs(r.z - lz) + Math.abs(goal.z - lz)
        if (c < best) { best = c; lane = lz }
      }
      ai.cross = { lineX, lane, dir }
    }
    const { lane } = ai.cross
    const approach = { x: lineX - dir * 1.15, z: lane }
    const exit = { x: lineX + dir * 1.25, z: lane }
    const aligned = Math.abs(r.z - lane) < 0.22
    const before = dir * (r.x - (lineX - dir * 0.75)) < 0
    target = before && !aligned ? approach : exit
    if (Math.abs(r.x - lineX) < 1.2 && LANES.bump.some((b) => Math.abs(b - lane) < 0.01)) slow = 0.75
  } else {
    ai.cross = null
  }
  return steer(sim, r, target, arrive, ignore, slow)
}

function steer(sim, r, target, arrive, ignore, slow) {
  const dx = target.x - r.x
  const dz = target.z - r.z
  const d = Math.hypot(dx, dz) || 1e-6
  if (d < arrive) return { vx: 0, vz: 0 }
  const k = Math.min(1, d / 1.0)
  let vx = (dx / d) * k
  let vz = (dz / d) * k
  const crossing = r.ai.cross
  // Push off the hubs and towers, and away from other robots.
  for (const h of [HUB.blue, HUB.red, TOWER.blue, TOWER.red]) {
    const ox = r.x - h.x
    const oz = r.z - h.z
    const od = Math.hypot(ox, oz)
    const reach = h === TOWER.blue || h === TOWER.red ? 0.55 : 1.5
    if (od < reach && od > 0) {
      const w = (reach - od) / reach
      vx += (ox / od) * w * 1.4
      vz += (oz / od) * w * 1.4
    }
  }
  for (const o of sim.robots) {
    if (o === r || ignore.includes(o)) continue
    const ox = r.x - o.x
    const oz = r.z - o.z
    const od = Math.hypot(ox, oz)
    if (od < 1.25 && od > 0) {
      const w = (1.25 - od) / 1.25
      vx += (ox / od) * w * (crossing ? 0.4 : 0.9)
      vz += (oz / od) * w * (crossing ? 0.4 : 0.9)
    }
  }
  const m = Math.hypot(vx, vz)
  if (m > 1) { vx /= m; vz /= m }
  return { vx: vx * slow, vz: vz * slow }
}

const clampF = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
