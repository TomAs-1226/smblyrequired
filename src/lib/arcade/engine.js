// Cycle Rush — the game's rules and physics, with no DOM in it.
//
// Everything is in metres and seconds on a 16 × 8 field. `createGame` builds a
// match, `step` advances it. The page owns input and drawing; this file owns
// what is true. That split is what lets `scripts/test/arcade.mjs` play whole
// matches headless.

export const FIELD = { w: 16, h: 8 }
export const MATCH = { countdown: 3, auto: 15, total: 120, endgame: 20 }

export const R_ROBOT = 0.45
export const R_BALL = 0.12
export const CAPACITY = 5
export const SHOT_SPEED = 8
export const FLIGHT = 0.85 // seconds a shot stays in the air → ~6.8 m range
const MIN_SCORE_T = 0.1
const MAX_SPEED = 4.2
const ACCEL = 16
const TURN_RATE = 7
const FIRE_INTERVAL = 0.3
const HIT_SPEED = 2.6 // closing speed that knocks a ball loose
const DOCK_POINTS = 6
const BALL_COUNT = 16

export const HUBS = {
  blue: { x: 4.2, y: 4 },
  red: { x: 11.8, y: 4 },
}
export const HUB_SOLID = 0.7
export const HUB_SCORE = 0.6

export const DOCKS = {
  blue: { x: 0, y: 2.8, w: 1.3, h: 2.4 },
  red: { x: FIELD.w - 1.3, y: 2.8, w: 1.3, h: 2.4 },
}
export const CHUTES = [
  { x: FIELD.w / 2, y: 0.2, dir: 1 },
  { x: FIELD.w / 2, y: FIELD.h - 0.2, dir: -1 },
]

export const DIFFICULTY = {
  rookie: { speed: 0.62, aimErr: 0.16, carry: 2, defend: false },
  regional: { speed: 0.8, aimErr: 0.08, carry: 3, defend: false },
  einstein: { speed: 0.95, aimErr: 0.035, carry: 4, defend: true },
}
const PARTNER = { speed: 0.78, aimErr: 0.07, carry: 3, defend: false }

// ---------------------------------------------------------------- helpers
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
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))
const inRect = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h

// ---------------------------------------------------------------- setup
function makeRobot(id, team, label, x, y, cfg, isPlayer) {
  return {
    id, team, label, isPlayer, cfg,
    x, y, vx: 0, vy: 0,
    heading: team === 'blue' ? 0 : Math.PI,
    carry: 1, // every robot starts with a preload
    cooldown: 0,
    hitCooldown: 0,
    ai: { mode: 'collect', err: 0, stuck: 0, jitter: 0, jx: 0, jy: 0, lastX: x, lastY: y, dockDy: 0 },
  }
}

export function createGame({ difficulty = 'regional', seed = Date.now(), demo = false } = {}) {
  const rng = mulberry32(seed)
  const red = DIFFICULTY[difficulty] || DIFFICULTY.regional
  const robots = [
    makeRobot('p', 'blue', '5805', 1.6, 3.0, PARTNER, !demo),
    makeRobot('b2', 'blue', 'B2', 1.6, 5.0, PARTNER, false),
    makeRobot('r1', 'red', 'R1', FIELD.w - 1.6, 3.0, red, false),
    makeRobot('r2', 'red', 'R2', FIELD.w - 1.6, 5.0, red, false),
  ]
  robots[1].ai.dockDy = 0.6
  robots[3].ai.dockDy = 0.6
  robots[0].ai.dockDy = -0.6
  robots[2].ai.dockDy = -0.6
  if (red.defend) robots[3].ai.role = 'defender'

  // Balls in two mirrored diamonds around midfield, plus a line on the centre.
  const balls = []
  const add = (x, y) => balls.push({ x, y, vx: 0, vy: 0, air: false, t: 0, z: 0, team: null })
  for (let i = 0; i < 4; i++) {
    for (const side of [-1, 1]) {
      const cx = FIELD.w / 2 + side * 2.2
      add(cx + side * 0.5 * (i % 2), 1.4 + i * 1.75)
    }
  }
  for (let i = 0; i < BALL_COUNT - balls.length; i++) {
    add(FIELD.w / 2, 0.9 + i * 0.885)
  }

  return {
    difficulty, demo, rng,
    phase: 'countdown',
    clock: -MATCH.countdown, // match time; negative during the countdown
    robots,
    balls,
    queue: [], // scored balls waiting to come back out of a chute
    score: {
      blue: { total: 0, auto: 0, cells: 0, dock: 0 },
      red: { total: 0, auto: 0, cells: 0, dock: 0 },
    },
    popups: [],
    shotsFired: 0,
    shotsMade: 0,
  }
}

export function phaseOf(clock) {
  if (clock < 0) return 'countdown'
  if (clock < MATCH.auto) return 'auto'
  if (clock < MATCH.total - MATCH.endgame) return 'teleop'
  if (clock < MATCH.total) return 'endgame'
  return 'over'
}

export const player = (s) => s.robots[0]

// ---------------------------------------------------------------- step
/**
 * Advance the match by `dt` seconds. `input` drives the player robot:
 * { mx, my } move (field-relative, length ≤ 1), `aim` a target heading or null,
 * `turn` −1..1 when there is no aim target, `fire` held.
 */
export function step(s, dt, input = {}) {
  if (s.phase === 'over') return s
  s.clock += dt
  s.phase = phaseOf(s.clock)
  if (s.phase === 'over') return finish(s)

  const live = s.phase !== 'countdown'
  for (const r of s.robots) {
    r.cooldown = Math.max(0, r.cooldown - dt)
    r.hitCooldown = Math.max(0, r.hitCooldown - dt)
    let cmd
    if (!live) cmd = { mx: 0, my: 0, aim: null, turn: 0, fire: false }
    else if (r.isPlayer) cmd = input
    else cmd = think(s, r, dt)
    drive(r, cmd, dt)
    if (live && cmd.fire) shoot(s, r)
  }

  collideRobots(s)
  for (const r of s.robots) collideStatic(r)
  updateBalls(s, dt)
  updateQueue(s, dt)
  for (const p of s.popups) p.t += dt
  s.popups = s.popups.filter((p) => p.t < 1.1)
  return s
}

function drive(r, cmd, dt) {
  let mx = cmd.mx || 0
  let my = cmd.my || 0
  const m = Math.hypot(mx, my)
  if (m > 1) { mx /= m; my /= m }
  const max = MAX_SPEED * (r.isPlayer ? 1 : r.cfg.speed)
  let dvx = mx * max - r.vx
  let dvy = my * max - r.vy
  const dl = Math.hypot(dvx, dvy)
  const dmax = ACCEL * dt
  if (dl > dmax) { dvx *= dmax / dl; dvy *= dmax / dl }
  r.vx += dvx
  r.vy += dvy
  r.x += r.vx * dt
  r.y += r.vy * dt

  const rate = TURN_RATE * dt
  if (cmd.aim != null) r.heading = wrap(r.heading + clamp(wrap(cmd.aim - r.heading), -rate, rate))
  else if (cmd.turn) r.heading = wrap(r.heading + clamp(cmd.turn, -1, 1) * rate)
}

function shoot(s, r) {
  if (r.carry <= 0 || r.cooldown > 0) return
  r.carry--
  r.cooldown = FIRE_INTERVAL
  const c = Math.cos(r.heading)
  const sn = Math.sin(r.heading)
  // A shot carries the robot's own velocity: shooting on the move is a skill.
  s.balls.push({
    x: r.x + c * (R_ROBOT + 0.05), y: r.y + sn * (R_ROBOT + 0.05),
    vx: c * SHOT_SPEED + r.vx, vy: sn * SHOT_SPEED + r.vy,
    air: true, t: 0, z: 0, team: r.team, byPlayer: r.isPlayer,
  })
  if (r.isPlayer) s.shotsFired++
}

function collideStatic(r) {
  if (r.x < R_ROBOT) { r.x = R_ROBOT; r.vx = Math.max(0, r.vx) }
  if (r.x > FIELD.w - R_ROBOT) { r.x = FIELD.w - R_ROBOT; r.vx = Math.min(0, r.vx) }
  if (r.y < R_ROBOT) { r.y = R_ROBOT; r.vy = Math.max(0, r.vy) }
  if (r.y > FIELD.h - R_ROBOT) { r.y = FIELD.h - R_ROBOT; r.vy = Math.min(0, r.vy) }
  for (const h of Object.values(HUBS)) {
    const dx = r.x - h.x
    const dy = r.y - h.y
    const d = Math.hypot(dx, dy) || 1e-6
    const min = HUB_SOLID + R_ROBOT
    if (d < min) {
      const nx = dx / d
      const ny = dy / d
      r.x = h.x + nx * min
      r.y = h.y + ny * min
      const vn = r.vx * nx + r.vy * ny
      if (vn < 0) { r.vx -= vn * nx; r.vy -= vn * ny }
    }
  }
}

function collideRobots(s) {
  const rs = s.robots
  for (let i = 0; i < rs.length; i++) {
    for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i]
      const b = rs[j]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const d = Math.hypot(dx, dy) || 1e-6
      const min = R_ROBOT * 2
      if (d >= min) continue
      const nx = dx / d
      const ny = dy / d
      const push = (min - d) / 2
      a.x -= nx * push; a.y -= ny * push
      b.x += nx * push; b.y += ny * push
      const aIn = a.vx * nx + a.vy * ny // a's speed toward b
      const bIn = -(b.vx * nx + b.vy * ny) // b's speed toward a
      const closing = aIn + bIn
      if (closing <= 0) continue
      // Equal masses, inelastic along the normal.
      const j2 = closing / 2
      a.vx -= nx * j2; a.vy -= ny * j2
      b.vx += nx * j2; b.vy += ny * j2
      if (closing > HIT_SPEED && a.team !== b.team) {
        const victim = aIn >= bIn ? b : a
        const dir = victim === b ? 1 : -1
        if (victim.carry > 0 && victim.hitCooldown <= 0) {
          victim.carry--
          victim.hitCooldown = 1
          s.balls.push({
            x: victim.x + nx * dir * (R_ROBOT + 0.2), y: victim.y + ny * dir * (R_ROBOT + 0.2),
            vx: nx * dir * 2.5, vy: ny * dir * 2.5, air: false, t: 0, z: 0, team: null,
          })
        }
      }
    }
  }
}

function updateBalls(s, dt) {
  const keep = []
  const ground = []
  for (const b of s.balls) {
    b.x += b.vx * dt
    b.y += b.vy * dt
    if (b.air) {
      b.t += dt
      const u = b.t / FLIGHT
      b.z = 4 * u * (1 - u)
      if (b.t > MIN_SCORE_T) {
        let scored = false
        for (const [team, h] of Object.entries(HUBS)) {
          if (Math.hypot(b.x - h.x, b.y - h.y) < HUB_SCORE) {
            award(s, team, b, h)
            scored = true
            break
          }
        }
        if (scored) continue
      }
      bounceWalls(b, 0.4)
      if (b.t >= FLIGHT) { b.air = false; b.z = 0; b.vx *= 0.35; b.vy *= 0.35 }
      keep.push(b)
      continue
    }
    const f = Math.exp(-3 * dt)
    b.vx *= f
    b.vy *= f
    bounceWalls(b, 0.5)
    for (const h of Object.values(HUBS)) {
      const dx = b.x - h.x
      const dy = b.y - h.y
      const d = Math.hypot(dx, dy) || 1e-6
      const min = HUB_SOLID + R_BALL
      if (d < min) {
        const nx = dx / d
        const ny = dy / d
        b.x = h.x + nx * min; b.y = h.y + ny * min
        const vn = b.vx * nx + b.vy * ny
        if (vn < 0) { b.vx -= 1.5 * vn * nx; b.vy -= 1.5 * vn * ny }
      }
    }
    let taken = false
    for (const r of s.robots) {
      const dx = b.x - r.x
      const dy = b.y - r.y
      const d = Math.hypot(dx, dy) || 1e-6
      if (d > R_ROBOT + R_BALL + 0.08) continue
      const facing = Math.abs(wrap(Math.atan2(dy, dx) - r.heading)) < 0.9
      if (facing && r.carry < CAPACITY && s.phase !== 'countdown') {
        r.carry++
        taken = true
        break
      }
      const min = R_ROBOT + R_BALL
      if (d < min) {
        const nx = dx / d
        const ny = dy / d
        b.x = r.x + nx * min; b.y = r.y + ny * min
        const rel = (b.vx - r.vx) * nx + (b.vy - r.vy) * ny
        if (rel < 0) { b.vx -= 1.6 * rel * nx; b.vy -= 1.6 * rel * ny }
      }
    }
    if (taken) continue
    keep.push(b)
    ground.push(b)
  }
  // Ground balls push each other apart so they do not stack.
  for (let i = 0; i < ground.length; i++) {
    for (let j = i + 1; j < ground.length; j++) {
      const a = ground[i]
      const c = ground[j]
      const dx = c.x - a.x
      const dy = c.y - a.y
      const d = Math.hypot(dx, dy)
      if (d >= R_BALL * 2 || d === 0) continue
      const p = (R_BALL * 2 - d) / 2
      a.x -= (dx / d) * p; a.y -= (dy / d) * p
      c.x += (dx / d) * p; c.y += (dy / d) * p
    }
  }
  s.balls = keep
}

function bounceWalls(b, e) {
  if (b.x < R_BALL) { b.x = R_BALL; b.vx = Math.abs(b.vx) * e }
  if (b.x > FIELD.w - R_BALL) { b.x = FIELD.w - R_BALL; b.vx = -Math.abs(b.vx) * e }
  if (b.y < R_BALL) { b.y = R_BALL; b.vy = Math.abs(b.vy) * e }
  if (b.y > FIELD.h - R_BALL) { b.y = FIELD.h - R_BALL; b.vy = -Math.abs(b.vy) * e }
}

function award(s, hubTeam, ball, h) {
  const pts = s.phase === 'auto' ? 2 : 1
  const sc = s.score[hubTeam]
  sc.total += pts
  sc.cells += 1
  if (s.phase === 'auto') sc.auto += pts
  s.popups.push({ x: h.x, y: h.y - 0.9, text: `+${pts}`, team: hubTeam, t: 0 })
  if (ball.byPlayer && hubTeam === 'blue') s.shotsMade++
  s.queue.push({ t: 3.5 })
}

function updateQueue(s, dt) {
  for (const q of s.queue) q.t -= dt
  const ready = s.queue.filter((q) => q.t <= 0)
  s.queue = s.queue.filter((q) => q.t > 0)
  for (let i = 0; i < ready.length; i++) {
    const c = CHUTES[Math.floor(s.rng() * CHUTES.length)]
    s.balls.push({
      x: c.x + (s.rng() - 0.5) * 0.4, y: c.y,
      vx: (s.rng() - 0.5) * 4, vy: c.dir * (2 + s.rng() * 2),
      air: false, t: 0, z: 0, team: null,
    })
  }
}

function finish(s) {
  s.clock = MATCH.total
  for (const r of s.robots) {
    if (inRect(r, DOCKS[r.team])) {
      s.score[r.team].dock += DOCK_POINTS
      s.score[r.team].total += DOCK_POINTS
      const d = DOCKS[r.team]
      s.popups.push({ x: d.x + d.w / 2, y: r.y - 0.7, text: `+${DOCK_POINTS}`, team: r.team, t: 0 })
    }
  }
  s.phase = 'over'
  return s
}

export function result(s) {
  const b = s.score.blue.total
  const r = s.score.red.total
  return {
    outcome: b > r ? 'win' : b < r ? 'loss' : 'tie',
    blue: { ...s.score.blue },
    red: { ...s.score.red },
    shotsFired: s.shotsFired,
    shotsMade: s.shotsMade,
  }
}

// ---------------------------------------------------------------- AI
function think(s, r, dt) {
  const ai = r.ai
  const hub = HUBS[r.team]
  const remaining = MATCH.total - s.clock

  // Unstick: if we meant to move and did not, wander briefly.
  const moved = Math.hypot(r.x - ai.lastX, r.y - ai.lastY)
  ai.lastX = r.x
  ai.lastY = r.y
  if (ai.jitter > 0) {
    ai.jitter -= dt
    return { mx: ai.jx, my: ai.jy, aim: Math.atan2(ai.jy, ai.jx), fire: false }
  }

  // Endgame: head for the dock with enough time to get there.
  const dock = DOCKS[r.team]
  const dockPt = { x: dock.x + dock.w / 2, y: dock.y + dock.h / 2 + ai.dockDy }
  const toDock = Math.hypot(dockPt.x - r.x, dockPt.y - r.y)
  if (s.phase === 'endgame' && remaining < toDock / (MAX_SPEED * r.cfg.speed * 0.7) + 3) {
    if (r.carry > 0 && Math.hypot(r.x - hub.x, r.y - hub.y) < FLIGHT * SHOT_SPEED * 0.9) {
      // Dump what we carry on the way if the hub is in range.
      const aim = Math.atan2(hub.y - r.y, hub.x - r.x)
      const cmd = steer(s, r, dockPt, 0.2)
      return { ...cmd, aim, fire: Math.abs(wrap(aim - r.heading)) < 0.05 && Math.hypot(r.vx, r.vy) < 1 }
    }
    return { ...steer(s, r, dockPt, 0.15), aim: Math.atan2(dockPt.y - r.y, dockPt.x - r.x) }
  }

  if (ai.role === 'defender' && s.phase !== 'auto') {
    const p = player(s)
    if (p.carry >= 2) {
      const blue = HUBS.blue
      const dx = p.x - blue.x
      const dy = p.y - blue.y
      const d = Math.hypot(dx, dy) || 1
      const target = { x: blue.x + (dx / d) * 1.7, y: blue.y + (dy / d) * 1.7 }
      const ram = Math.hypot(p.x - r.x, p.y - r.y) < 2.2 ? p : target
      return { ...steer(s, r, ram, 0, [p]), aim: Math.atan2(p.y - r.y, p.x - r.x), fire: false }
    }
  }

  const ground = s.balls.filter((b) => !b.air)
  if (r.carry >= r.cfg.carry || (r.carry > 0 && ground.length === 0)) ai.mode = 'shoot'
  else if (r.carry === 0) ai.mode = 'collect'

  let cmd
  if (ai.mode === 'shoot') {
    const dx = r.x - hub.x
    const dy = r.y - hub.y
    const d = Math.hypot(dx, dy) || 1
    const spot = {
      x: clamp(hub.x + (dx / d) * 2.8, 0.8, FIELD.w - 0.8),
      y: clamp(hub.y + (dy / d) * 2.8, 0.8, FIELD.h - 0.8),
    }
    const dist = Math.hypot(spot.x - r.x, spot.y - r.y)
    if (dist < 0.4) {
      if (ai.err === 0) ai.err = (s.rng() - 0.5) * 2 * r.cfg.aimErr || 1e-6
      const aim = Math.atan2(hub.y - r.y, hub.x - r.x) + ai.err
      const ready = Math.abs(wrap(aim - r.heading)) < 0.06 && Math.hypot(r.vx, r.vy) < 0.6
      if (ready && r.cooldown <= 0) ai.err = 0 // new error for the next shot
      return { mx: -r.vx * 0.3, my: -r.vy * 0.3, aim, fire: ready }
    }
    cmd = { ...steer(s, r, spot, 0.4), aim: Math.atan2(hub.y - r.y, hub.x - r.x) }
  } else {
    let best = null
    let bestD = Infinity
    for (const b of ground) {
      // Prefer balls on our own half, and avoid ones a teammate is closer to.
      let d = Math.hypot(b.x - r.x, b.y - r.y)
      if ((r.team === 'blue') !== (b.x < FIELD.w / 2)) d += 2
      for (const o of s.robots) {
        if (o !== r && o.team === r.team && Math.hypot(b.x - o.x, b.y - o.y) < d * 0.7) d += 1.5
      }
      if (d < bestD) { bestD = d; best = b }
    }
    if (!best) return { mx: 0, my: 0, aim: null, fire: false }
    cmd = { ...steer(s, r, best, 0), aim: Math.atan2(best.y - r.y, best.x - r.x) }
  }

  const wants = Math.hypot(cmd.mx, cmd.my) > 0.4
  ai.stuck = wants && moved < 0.3 * dt ? ai.stuck + dt : 0
  if (ai.stuck > 1.2) {
    const a = s.rng() * Math.PI * 2
    ai.jx = Math.cos(a); ai.jy = Math.sin(a); ai.jitter = 0.6; ai.stuck = 0
  }
  return { ...cmd, fire: false }
}

function steer(s, r, target, arrive, ignore = []) {
  let dx = target.x - r.x
  let dy = target.y - r.y
  const d = Math.hypot(dx, dy) || 1e-6
  const k = Math.min(1, d / 1.2)
  let mx = (dx / d) * k
  let my = (dy / d) * k
  if (d < arrive) return { mx: 0, my: 0 }
  for (const h of Object.values(HUBS)) {
    const hx = r.x - h.x
    const hy = r.y - h.y
    const hd = Math.hypot(hx, hy)
    if (hd < 1.8) {
      const w = (1.8 - hd) / 1.8
      mx += (hx / hd) * w * 1.2
      my += (hy / hd) * w * 1.2
      // Slide round the hub rather than into it.
      const side = Math.sign(hx * dy - hy * dx) || 1
      mx += (-hy / hd) * side * w * -0.8
      my += (hx / hd) * side * w * -0.8
    }
  }
  for (const o of s.robots) {
    if (o === r || ignore.includes(o)) continue
    const ox = r.x - o.x
    const oy = r.y - o.y
    const od = Math.hypot(ox, oy)
    if (od < 1.3 && od > 0) {
      const w = (1.3 - od) / 1.3
      mx += (ox / od) * w * 0.9
      my += (oy / od) * w * 0.9
    }
  }
  const m = Math.hypot(mx, my)
  if (m > 1) { mx /= m; my /= m }
  return { mx, my }
}
