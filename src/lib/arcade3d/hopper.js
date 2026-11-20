// The fuel a robot carries, as real balls in its hopper.
//
// Every robot gets a small physics world of its own, in its own frame (x forward,
// y up, z right): the hopper's floor, walls and lid, the end that slides out with
// the intake, and one ball for each fuel on board. Fuel comes in through the open
// end with the speed the intake gave it, piles up as it lands, and leaves from
// the feeder. The robot's own motion reaches the pile as gravity that leans: it
// heaps to the back under acceleration, climbs the walls in a spin, and settles
// when the robot stops.
//
// This is what the hopper looks like, not what it holds: how many fuel a robot
// carries is the sim's to say (`r.carry`), and the pile is kept to that number.
import { FUEL } from './config.js'
import { hopperX, hopperZ, hingedFloorAt } from './robots.js'

const STEP = 1 / 60
const WALL = 0.05 // half the thickness of a wall
const G = 9.81
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

export function createHopper(R, spec) {
  const h = spec.hopper
  const dir = Math.sign(h.front - h.board) || -1
  // Foam squashes in a pile: packed fuel takes a little less room than loose fuel.
  const pr = FUEL.r * (h.pack ?? 0.9)
  // The balls are drawn full size, so every wall, the floor and the lid are moved
  // in by the difference and a hair: a ball lying against one is inside the
  // robot's own panels, not showing through them.
  const skin = FUEL.r - pr + 0.004
  const board = h.board + dir * skin
  const len0 = Math.max(0.05, Math.abs(h.front - h.board) - 2 * skin)
  const halfWide = h.halfWide - skin
  const halfOut = halfWide + (h.wide || 0)

  /** The floor's height along the hopper: flat out to the open end, sloping down to the feeder. */
  let out = 0
  const floorAt = (x, at = out) => {
    // A hinged floor stands where the intake has put it.
    if (h.hinge) return hingedFloorAt(h.hinge, x, at) + skin
    const step = (h.floors || []).find((s) => x >= s.x0 && x < s.x1)
    if (step) return step.y + skin
    if (h.low && h.ridge != null && Math.abs(h.ridge - h.low.x) > 1e-3) {
      return h.low.y + (h.floor - h.low.y) * clamp((x - h.low.x) / (h.ridge - h.low.x), 0, 1) + skin
    }
    return h.floor + skin
  }
  const open = (out) => board + dir * (len0 + h.travel * out)
  const half = (out) => halfWide + (h.wide || 0) * out
  const lo = Math.min(board, open(1))
  const hi = Math.max(board, open(1))
  let base = Infinity
  for (let i = 0; i <= 10; i++) base = Math.min(base, floorAt(lo + ((hi - lo) * i) / 10, 0), floorAt(lo + ((hi - lo) * i) / 10, 1))
  const roof = h.netMax ?? h.roof ?? spec.height
  const lid = Math.max(roof - skin, base + 4 * pr)
  const midY = (lid + base) / 2
  // A lid bevelled down to the open end is part of what slides out: `bevel` is how
  // far back from that end it starts.
  const bevel = h.slope ? Math.abs(h.slope.to[0] - h.front) : 0
  const tall = (lid - base) / 2 + 0.15

  const world = new R.World({ x: 0, y: -G, z: 0 })
  world.timestep = STEP
  try { world.integrationParameters.numSolverIterations = 6 } catch { /* an older Rapier: its default will do */ }
  const fixed = world.createRigidBody(R.RigidBodyDesc.fixed())
  const kinematic = () => world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased())
  const solid = (desc, body = fixed) => world.createCollider(desc.setFriction(0.45).setRestitution(0.2), body)
  const box = (hx, hy, hz, x, y, z, body) => solid(R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z), body)

  // ---- the floor, in strips that follow its slope
  // A hinged floor moves, so each of its strips is a body that can be put where
  // the floor is now; and being steep, it gets finer strips to roll on.
  const STRIPS = h.hinge ? 32 : 12
  const span = hi - lo + 0.3
  const strips = []
  for (let i = 0; i < STRIPS; i++) {
    const x = lo - 0.15 + (span * (i + 0.5)) / STRIPS
    if (h.hinge) {
      const body = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(x, floorAt(clamp(x, lo, hi)) - WALL, 0))
      solid(R.ColliderDesc.cuboid(span / STRIPS / 2 + 0.002, WALL, halfOut + 0.2), body)
      strips.push({ x, body })
    } else {
      box(span / STRIPS / 2 + 0.002, WALL, halfOut + 0.2, x, floorAt(clamp(x, lo, hi)) - WALL, 0)
    }
  }
  // ---- the board in front of the shooter, and the lid
  box(WALL, tall, halfOut + 0.2, board - dir * WALL, midY, 0)
  box(span / 2, WALL, halfOut + 0.2, (lo + hi) / 2, lid + WALL, 0)
  // ---- the sides: fixed, or drawers that slide out with the intake
  const sides = h.wide ? [1, -1].map((sgn) => ({ sgn, body: kinematic() })) : null
  if (sides) {
    for (const s of sides) {
      box(span / 2, tall, WALL, (lo + hi) / 2, midY, 0, s.body)
      // The net over a drawer slopes from its hinge on the body down to the drawer's edge.
      const lidS = h.sideLid
      if (!lidS) continue
      const run = Math.hypot(halfOut - lidS.z, lidS.edgeY - lidS.y)
      if (run < 0.05) continue
      const angle = Math.atan2(lidS.edgeY - lidS.y, halfOut - lidS.z) // from the hinge out, about x
      const ny = Math.cos(angle)
      const nz = -Math.sin(angle)
      const cy = (lidS.y + lidS.edgeY) / 2 - skin + ny * WALL
      const cz = (lidS.z + halfOut) / 2 + nz * WALL
      const turn = s.sgn * angle
      solid(
        R.ColliderDesc.cuboid(span / 2, WALL, run / 2 + 0.03)
          .setTranslation((lo + hi) / 2, cy, s.sgn * (cz - (halfOut + WALL)))
          .setRotation({ x: Math.sin(turn / 2), y: 0, z: 0, w: Math.cos(turn / 2) }),
        s.body,
      )
    }
  }
  else for (const sgn of [1, -1]) box(span / 2, tall, WALL, (lo + hi) / 2, midY, sgn * (halfWide + WALL))
  // ---- the open end: the wall that rides out with the intake, and a lid that slopes down to it
  const end = kinematic()
  box(WALL, tall, halfOut + 0.2, 0, midY, 0, end)
  if (bevel >= 0.02) {
    // In the end wall's own frame: from where the bevel starts, down to the wall.
    const ax = -dir * (bevel + WALL)
    const ay = h.slope.to[1]
    const bx = -dir * WALL
    const by = h.slope.from
    const run = Math.hypot(bx - ax, by - ay)
    let nx = -(by - ay) / run
    let ny = (bx - ax) / run
    if (ny < 0) { nx = -nx; ny = -ny }
    const angle = Math.atan2(by - ay, bx - ax)
    solid(
      R.ColliderDesc.cuboid(run / 2 + 0.06, WALL, halfOut + 0.2)
        .setTranslation((ax + bx) / 2 + nx * (WALL - skin * 1.3), (ay + by) / 2 + ny * (WALL - skin * 1.3), 0)
        .setRotation({ x: 0, y: 0, z: Math.sin(angle / 2), w: Math.cos(angle / 2) }),
      end,
    )
  }
  // ---- what stands in the pile's way: gearboxes and rails along the sides, a turret's column
  for (const sh of h.shelves || []) {
    const x0 = Math.max(sh.x0, lo)
    const x1 = Math.min(sh.x1, hi)
    const inner = sh.half - skin
    const deep = halfOut - inner
    if (x1 - x0 < 0.02 || deep < 0.01) continue
    const top = Math.min(lid, Number.isFinite(sh.y0 + sh.y1) ? (sh.y0 + sh.y1) / 2 + skin : lid)
    if (top < floorAt((x0 + x1) / 2) + 0.01) continue
    for (const sgn of sh.side ? [sh.side] : [1, -1]) {
      box((x1 - x0) / 2, (top - base + 0.1) / 2, deep / 2 + 0.05, (x0 + x1) / 2, (top + base - 0.1) / 2, sgn * (inner + deep / 2 + 0.05))
    }
  }
  for (const p of h.pillars || []) {
    if (p.x < lo - p.radius || p.x > hi + p.radius || Math.abs(p.z) > halfOut + p.radius) continue
    const top = Math.min(lid, p.top ?? lid)
    if (top < base + 0.02) continue
    solid(R.ColliderDesc.cylinder((top - base + 0.1) / 2, p.radius + skin).setTranslation(p.x, (top + base - 0.1) / 2, p.z))
  }

  const bodies = []
  let stirred = true
  const gravity = { x: 0, z: 0 }
  let owed = 0
  let feeding = 0 // how hard the floor is running: 0 off .. 1 shooting

  const placeWalls = (snap) => {
    const e = { x: open(out) + dir * WALL, y: 0, z: 0 }
    if (snap) end.setTranslation(e, true)
    else end.setNextKinematicTranslation(e)
    for (const s of strips) {
      const t = { x: s.x, y: floorAt(clamp(s.x, lo, hi)) - WALL, z: 0 }
      if (snap) s.body.setTranslation(t, true)
      else s.body.setNextKinematicTranslation(t)
    }
    if (!sides) return
    for (const s of sides) {
      const t = { x: 0, y: 0, z: s.sgn * (half(out) + WALL) }
      if (snap) s.body.setTranslation(t, true)
      else s.body.setNextKinematicTranslation(t)
    }
  }
  placeWalls(true)

  function spawn(x, y, z, vx = 0, vy = 0, vz = 0) {
    const body = world.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(x, y, z).setLinvel(vx, vy, vz).setLinearDamping(0.5).setAngularDamping(1),
    )
    world.createCollider(R.ColliderDesc.ball(pr).setMass(FUEL.mass).setRestitution(0.3).setFriction(0.45), body)
    bodies.push(body)
    stirred = true
  }

  /** Where fuel picked up at (px, pz) in the robot's frame comes into the hopper. */
  function entry(px, pz) {
    let x
    let z
    if (sides) {
      const sgn = pz >= 0 ? 1 : -1
      x = clamp(px, lo + pr + 0.01, hi - pr - 0.01)
      z = sgn * (half(out) - pr - 0.012)
    } else {
      x = open(out) - dir * (pr + 0.012)
      z = clamp(pz, -(halfWide - pr - 0.01), halfWide - pr - 0.01)
    }
    // Always at the bottom: an intake feeds under the pile and shoves it up and back.
    return { x, y: floorAt(x) + pr + 0.004, z }
  }

  return {
    radius: pr,
    lid: roof,
    /** The point just outside the hopper that fuel bound for `entry` passes through: the throat of the intake. */
    throat(e) {
      return sides ? { x: e.x, y: e.y, z: e.z + Math.sign(e.z || 1) * 2.4 * pr } : { x: e.x + dir * 2.4 * pr, y: e.y, z: e.z }
    },
    count: () => bodies.length,
    entry,
    /** A ball in through the intake, from where it was picked up, at the speed the rollers throw it. */
    add(px, pz, speed = 2.6) {
      const e = entry(px, pz)
      if (sides) spawn(e.x, e.y, e.z, 0, 0.3, -Math.sign(e.z || 1) * speed)
      else spawn(e.x, e.y, e.z, -dir * speed, 0.3, 0)
    },
    /** A ball out through the shooter: the one nearest the feeder, in the lane at z. */
    take(z = 0) {
      if (!bodies.length) return
      const t0 = spec.shot.turret
      const fx = t0 ? t0.pivot[0] : board + dir * pr
      const fz = t0 ? t0.pivot[1] : z
      let best = 0
      let bestD = Infinity
      for (let i = 0; i < bodies.length; i++) {
        const t = bodies[i].translation()
        const d = (t.x - fx) ** 2 + (t.z - fz) ** 2 + 1.5 * (t.y - base) ** 2
        if (d < bestD) { bestD = d; best = i }
      }
      world.removeRigidBody(bodies[best])
      bodies.splice(best, 1)
      stirred = true
    },
    /** Fuel the robot simply has (its preload, a hand-fed load): placed, not thrown in. */
    fill(n) {
      for (let i = bodies.length; i < n; i++) {
        const slot = h.slots[Math.min(i, h.slots.length - 1)]
        if (!slot) break
        spawn(
          clamp(hopperX(spec, slot, out), lo + pr, hi - pr),
          clamp(slot.y, floorAt(hopperX(spec, slot, out)) + pr, lid - pr),
          hopperZ(spec, slot, out),
        )
      }
    },
    /**
     * Advance the pile by `dt`. `intakeOut` is how far the intake is out (0..1);
     * (ax, az) the robot's acceleration in its own frame and `om` its yaw rate.
     * At most `most` steps are taken: when frames run long the pile moves in slow
     * motion, and does not make them longer.
     */
    step(intakeOut, ax, az, om, dt, most = 2, feed = 0) {
      owed = Math.min(owed + Math.max(0, dt), most * STEP)
      if (feed !== feeding) { feeding = feed; stirred = true }
      while (owed >= STEP) {
        owed -= STEP
        if (Math.abs(intakeOut - out) > 1e-4) { out = intakeOut; stirred = true }
        placeWalls(false)
        // What the robot does, the pile feels the other way.
        const gx = clamp(gravity.x + (-ax - gravity.x) * 0.4, -14, 14)
        const gz = clamp(gravity.z + (-az - gravity.z) * 0.4, -14, 14)
        if (Math.abs(gx - world.gravity.x) + Math.abs(gz - world.gravity.z) > 0.25) stirred = true
        gravity.x = gx
        gravity.z = gz
        world.gravity = { x: gx, y: -G, z: gz }
        // A spin throws the pile outward.
        const w2 = Math.min(om * om, 50)
        if (w2 > 2) stirred = true
        if (stirred) {
          for (const b of bodies) {
            b.wakeUp()
            if (w2 > 2) {
              const t = b.translation()
              b.applyImpulse({ x: FUEL.mass * w2 * t.x * STEP, y: 0, z: FUEL.mass * w2 * t.z * STEP }, true)
            }
          }
          stirred = false
        }
        // The floor is driven: rollers or belts under the pile carry what lies on
        // them toward the feeder, hard while shooting, gently while collecting.
        if (feeding > 0) {
          const want = Math.min(1.4, (spec.floorSpeed || 3) * 0.4) * feeding
          for (const b of bodies) {
            const t = b.translation()
            if (t.y - floorAt(clamp(t.x, lo, hi)) > pr + 0.03) continue
            const v = b.linvel()
            const short = want - -dir * v.x // how far short of the floor's speed, toward the board
            if (short > 0) {
              b.wakeUp()
              b.applyImpulse({ x: -dir * FUEL.mass * Math.min(short, 14 * STEP), y: 0, z: 0 }, true)
            }
          }
        }
        world.step()
      }
      // Nothing gets out: a ball squeezed through a wall goes back on top of the pile.
      for (const b of bodies) {
        const t = b.translation()
        if (
          Number.isFinite(t.x + t.y + t.z) && t.y > base - 0.12 && t.y < lid + 0.12
          && t.x > lo - 0.12 && t.x < hi + 0.12 && Math.abs(t.z) < halfOut + 0.12
        ) continue
        b.setTranslation({ x: (board + open(out)) / 2, y: lid - pr - 0.01, z: 0 }, true)
        b.setLinvel({ x: 0, y: 0, z: 0 }, true)
      }
    },
    /** Call f(x, y, z, rotation) for every ball in the pile. */
    each(f) {
      for (const b of bodies) {
        const t = b.translation()
        f(t.x, t.y, t.z, b.rotation())
      }
    },
    free() {
      bodies.length = 0
      world.free()
    },
  }
}
