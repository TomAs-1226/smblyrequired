// Robot specs: one shape for every playable robot, whatever it was built from.
//
// The 21 imported robots each come with a descriptor (public/arcade/robots/<slug>.json,
// written by tools/arcade-assets.mjs). 5805's own Numbers comes from the site's CAD
// bake (public/models/robot.json). Both turn into the same `spec`, which the sim
// drives and the scene animates. Everything is in the robot's own frame: x forward,
// y up, z right, origin on the floor under the middle of the drivetrain.
import { HUB, FUEL } from './config.js'

const TRENCH_CLEAR = 0.56515

// ------------------------------------------------------------------ hopper
// Where carried fuel sits, so it can be drawn. The hopper runs from the board in
// front of the shooter to its open end, which moves out with the intake (a few
// robots widen instead: drawers out both sides). Balls stack in columns from the
// floor, lowest first, as a pile settles, and never higher than the hopper lets
// them: flat under a roof, domed under a net that is pinned round the rim, lower
// where the lid slopes down to the open end. Shelves along the sides (gearboxes,
// rails, a narrower end) raise the floor there, or leave no room for a ball at all.
//
// A slot is { u, y, z }: u is 0 at the board and 1 at the open end, so the pile
// stretches and squeezes with the intake (hopperX and hopperZ place it).
const PACK = 2 * FUEL.r * 0.86 // foam balls squash a little in a pile
const LAYER = PACK * 0.8
const NET_SLACK = 0.14 // how far in from the rim a net reaches its full height

/** How high the top of a ball may sit at `edge` metres in from the hopper's rim. */
export function hopperCeiling(h, edge) {
  if (h.roof == null) return Infinity
  const rise = Math.max(0, (h.netMax ?? h.roof) - h.roof)
  return h.roof + rise * Math.min(1, Math.max(0, (edge - FUEL.r * 0.5) / NET_SLACK))
}

function hopperSlots(h, capacity) {
  const lenOut = Math.abs(h.front - h.board) + h.travel
  const halfOut = h.halfWide + (h.wide || 0)
  const nx = Math.max(1, Math.floor((lenOut - 2 * FUEL.r) / PACK) + 1)
  const span = 2 * halfOut - 2 * FUEL.r
  const nz = Math.max(1, Math.floor(span / PACK) + 1)
  const dir = Math.sign(h.front - h.board) || -1
  const cols = []
  for (let i = 0; i < nx; i++) {
    for (let k = 0; k < nz; k++) {
      const u = nx === 1 ? 0.5 : i / (nx - 1)
      const z = nz === 1 ? 0 : -span / 2 + (k * span) / (nz - 1)
      const along = FUEL.r + u * (lenOut - 2 * FUEL.r) // from the board, with the intake out
      const x = h.board + dir * along
      if ((h.pillars || []).some((p) => Math.hypot(x - p.x, z - p.z) < p.radius + FUEL.r * 0.6)) continue
      let floor = (h.floors || []).find((f) => x >= f.x0 && x < f.x1)?.y ?? h.floor
      for (const sh of h.shelves || []) {
        if (x < sh.x0 || x > sh.x1 || (sh.side && Math.sign(z) !== sh.side) || Math.abs(z) + FUEL.r * 0.6 <= sh.half) continue
        const t = Number.isFinite(sh.x1) && sh.x1 > sh.x0 ? (x - sh.x0) / (sh.x1 - sh.x0) : 0
        floor = Math.max(floor, sh.y0 + (sh.y1 - sh.y0) * t)
      }
      // A fixed scatter per column, so the pile does not look like a grid.
      const j = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453
      const jit = (j - Math.floor(j) - 0.5) * 0.02
      const edge = Math.min(along, lenOut - along, halfOut - Math.abs(z))
      let cap = hopperCeiling(h, edge)
      if (h.slope && (x - h.slope.to[0]) * dir > 0) {
        const open = h.board + dir * lenOut
        cap = Math.min(cap, h.slope.to[1] + ((h.slope.from - h.slope.to[1]) * (x - h.slope.to[0])) / (open - h.slope.to[0]))
      }
      cap -= 0.006
      if (floor + 2 * FUEL.r > cap) continue // no room for a ball here
      cols.push({ u, z: z + jit, floor: floor + FUEL.r, cap, order: i + Math.abs(jit) })
    }
  }
  const fill = (step, capped) => {
    const slots = []
    for (const c of cols) c.next = c.floor
    while (slots.length < capacity) {
      let best = null
      for (const c of cols) {
        if (capped && c.next + FUEL.r > c.cap) continue
        if (!best || c.next < best.next - 1e-6 || (Math.abs(c.next - best.next) <= 1e-6 && c.order < best.order)) best = c
      }
      if (!best) break
      slots.push({ u: best.u, y: best.next, z: best.z })
      best.next += step
    }
    return slots
  }
  // A full hopper is a tight one: press the layers together before giving up on the lid.
  for (const squash of [1, 0.92, 0.84, 0.76, 0.68, 0.6]) {
    const slots = fill(LAYER * squash, true)
    if (slots.length >= capacity || !cols.length) return slots
  }
  return fill(LAYER * 0.6, false)
}

const hopperLength = (h, out) => Math.abs(h.front - h.board) + h.travel * out

/** A slot's x in the robot's frame, with the intake `out` (0 stowed .. 1 deployed). */
export function hopperX(spec, slot, out) {
  const h = spec.hopper
  const dir = Math.sign(h.front - h.board) || -1
  return h.board + dir * (FUEL.r + slot.u * Math.max(0.01, hopperLength(h, out) - 2 * FUEL.r))
}

/** A slot's z: fixed, unless the hopper is one that widens as it deploys. */
export function hopperZ(spec, slot, out) {
  const h = spec.hopper
  if (!h.wide) return slot.z
  return (slot.z * (h.halfWide + h.wide * out - FUEL.r)) / (h.halfWide + h.wide - FUEL.r)
}

/**
 * How far out the intake has to stay for the fuel on board to fit: a hopper that
 * grows with its intake cannot close on a full load.
 */
export function hopperHoldsOpen(spec, carry) {
  const h = spec.hopper
  const stowed = h.wide ? h.halfWide / (h.halfWide + h.wide) : hopperLength(h, 0) / hopperLength(h, 1)
  if (stowed >= 0.999) return 0
  return Math.min(1, Math.max(0, (carry / spec.capacity - stowed) / (1 - stowed)))
}

/** The rim of the hopper's top opening in the robot's frame, for the net: x from the board to the open end. */
export function hopperRim(spec, out) {
  const h = spec.hopper
  const dir = Math.sign(h.front - h.board) || -1
  return { x0: h.board, x1: h.board + dir * hopperLength(h, out), half: h.halfWide + (h.wide || 0) * out }
}

const lerpTable = (xs, ys, x) => {
  if (!xs?.length || !ys?.length) return null
  if (x <= xs[0]) return ys[0]
  for (let i = 1; i < xs.length; i++) {
    if (x <= xs[i]) {
      const u = (x - xs[i - 1]) / (xs[i] - xs[i - 1])
      return ys[i - 1] + (ys[i] - ys[i - 1]) * u
    }
  }
  return ys[ys.length - 1]
}

/** Launch angle (degrees) that a robot's shot table implies for a hub shot at `dist`. */
export function tableElevation(spec, dist, launchHeight) {
  const t = spec.shot.table
  if (!t) return spec.shot.elevation
  const tof = lerpTable(t.distance, t.tof, dist)
  if (!tof) return spec.shot.elevation
  // Drag-free elevation from the time of flight the team measured; the sim's
  // drag-aware solver then finds the exit speed at that angle.
  const dh = HUB.top + 0.05 - launchHeight
  const vx = dist / tof
  const vy = (dh + 0.5 * 9.81 * tof * tof) / tof
  return (Math.atan2(vy, vx) * 180) / Math.PI
}

export function hoodFor(spec, dist) {
  const t = spec.shot.table
  const deg = t ? lerpTable(t.distance, t.hoodDeg, dist) : null
  return deg == null ? null : (deg * Math.PI) / 180
}

export function rpmFor(spec, dist) {
  const t = spec.shot.table
  return (t && lerpTable(t.distance, t.rpm, dist)) || 2000
}

/**
 * Where an intake picks up: `near`..`far` out from the middle of the robot and
 * `half` either side, for each way a mouth faces (`dirs`, in the robot's frame:
 * 0 ahead, pi behind, +-pi/2 out the sides).
 */
function intakeZone(a, b, half, top, dirs) {
  return { near: Math.min(a, b), far: Math.max(a, b), half, top, dirs, faces: dirs.map((d) => [Math.cos(d), Math.sin(d)]) }
}

/** A spec from an imported descriptor and its index entry. */
export function specFromDescriptor(d, entry) {
  const top = Math.max(d.bumper.top, ...d.hull.map((h) => h.centre[1] + h.half[1]))
  const feel = d.drive.feel || {}
  const zone = d.intake?.zone
  const sh = d.shooter || {}
  const brain = d.brain || {}
  const turret = sh.turret
    ? { part: sh.turret.part, pivot: sh.turret.pivot, range: sh.turret.range.map(Number), twin: sh.turret.twin || null }
    : null
  const climb = d.climb
    ? { level: d.climb.level || 1, part: d.climb.part, time: (d.climb.reachSeconds || 1) + (d.climb.seconds || 2), lift: d.climb.lift || 0.12 }
    : null
  const capacity = d.hopper?.capacity ?? 40
  const hop = d.hopper || {}
  // Intakes out both sides (drawers): the hopper widens with them instead of lengthening.
  const sides = Boolean(d.intake?.sides)
  let wide = 0
  let sideLid = null
  if (sides) {
    for (const link of hop.slide?.links || []) {
      const j = link.wall && (d.joints || []).find((x) => x.name === link.part)?.joint
      if (!j) continue
      const reach = Math.abs(Number(j.range[1]) - Number(j.range[0]))
      wide = Math.max(wide, reach * Math.abs(j.axis[2]))
      // A net folds out over each drawer, from a hinge on the body down to the drawer's outer edge.
      if (link.roofNet) sideLid = { z: link.roofNet.hinge[0], y: link.roofNet.hinge[1], edgeY: link.roofNet.edge[1] + reach * j.axis[1] }
    }
  }
  const shelves = (hop.insets || []).map((s) => {
    const flip = s.x[0] > s.x[1]
    return { half: s.half, x0: Math.min(...s.x), x1: Math.max(...s.x), y0: s.top[flip ? 1 : 0], y1: s.top[flip ? 0 : 1], side: s.side || 0 }
  })
  if (hop.narrow) {
    // Narrower from here to the board: a step up at first, then no room at all.
    const n = hop.narrow
    shelves.push({ half: n.half, x0: n.from, x1: Infinity, y0: n.top, y1: n.top, side: 0 })
    if (n.tallFrom != null) shelves.push({ half: n.half, x0: n.tallFrom, x1: Infinity, y0: Infinity, y1: Infinity, side: 0 })
  }
  const hopper = {
    board: hop.boardTop?.[0] ?? 0.03,
    front: hop.front ?? -d.bumper.length / 2,
    travel: hop.slide?.travel ?? 0,
    wide,
    sideLid,
    halfWide: hop.halfWide ?? d.bumper.width / 2 - 0.08,
    floor: hop.flatY ?? 0.2,
    // The floor slopes from the ridge down to the low point by the feeder.
    low: hop.lowX != null && hop.lowY != null ? { x: hop.lowX, y: hop.lowY } : null,
    ridge: hop.ridgeX ?? null,
    // Packed foam takes less room than loose: the fraction of a ball's radius it keeps.
    pack: hop.packRadius ?? 0.9,
    pillars: hop.pillars || [],
    shelves,
    // A lid that slopes from `to` ([x, height]) down to `from` at the open end.
    slope: hop.chamfer ? { from: hop.chamfer.from, to: hop.chamfer.to } : null,
    // The lid: a roof, or a net that stretches up to netMax over a full load.
    roof: typeof hop.roof === 'number' ? hop.roof : top,
    netMax: hop.net?.max ?? null,
  }
  hopper.slots = hopperSlots(hopper, capacity)
  // Where fuel leaves the robot. A wide shooter throws a row of balls, one per
  // lane; a turret throws from its pivot (two of them, for twin turrets).
  const axisX = sh.axis?.[0] ?? 0
  const lanes = d.feed?.lanes?.length ? d.feed.lanes : [0]
  const exits = turret
    ? [turret.pivot, ...(turret.twin?.pivot ? [turret.twin.pivot] : [])].map(([x, z]) => ({ x, z }))
    : lanes.map((z) => ({ x: axisX, z }))
  return {
    key: entry.slug,
    source: 'descriptor',
    number: entry.number,
    label: String(entry.number),
    team: entry.team,
    robot: entry.robot,
    colors: d.colors,
    cloth: d.cloth || null,
    len: d.bumper.length,
    wid: d.bumper.width,
    height: top,
    bumper: { bottom: d.bumper.bottom, top: d.bumper.top },
    hull: d.hull,
    // WPILib (x, y) with +y to the left; the robot frame's z is to the right.
    modules: (d.drive.modules || []).map((m) => [m[0], -m[1]]),
    wheelRadius: d.drive.wheelRadius ?? 0.0508,
    mass: d.mass?.mass ?? 55,
    speed: feel.maxSpeed ?? d.drive.maxSpeed ?? 4.2,
    accel: feel.accel ?? 9,
    yawRate: Math.min(feel.turnRate ?? 7, 9),
    capacity,
    hopper,
    fireRate: sh.fireRate ?? 10,
    intake: zone
      ? intakeZone(Math.abs(zone.x0), Math.abs(zone.x1), zone.half, zone.top ?? 0.22, sides ? [Math.PI / 2, -Math.PI / 2] : [zone.x0 + zone.x1 < 0 ? Math.PI : 0])
      : intakeZone(d.bumper.length / 2 - 0.05, d.bumper.length / 2 + 0.2, 0.3, 0.22, [0]),
    intakeRate: d.intake?.rate ?? 15,
    shot: {
      yaw: ((sh.yawDeg ?? 0) * Math.PI) / 180,
      origin: { x: axisX, y: sh.axis?.[1] ?? top },
      exits,
      // How far the barrel sits ahead of a turret's pivot.
      barrel: turret ? Math.max(0, axisX - turret.pivot[0]) : 0,
      turret,
      table: brain.hubShot || null,
      elevation: 62,
      minRange: brain.minRange ?? 1.3,
      maxRange: brain.maxRange ?? 5.6,
      // How fast the robot can be going and still put its shots in: what its own code
      // allows. Past this it falls behind its own motion and the shots trail.
      moveSpeed: brain.maxShotSpeed ?? (turret ? 3 : 0.5),
      spread: sh.spread || { pitchDeg: 0.5, yawDeg: 0.5, speedPct: 1 },
      hood: sh.hood ? { part: sh.hood.part, range: sh.hood.range.map(Number) } : null,
      headingTol: ((brain.headingToleranceDeg ?? 2.5) * Math.PI) / 180,
    },
    special: climb ? 'climb' : 'pass',
    turret: Boolean(turret),
    climb: climb ? climb.level : 0,
    climbSpec: climb,
    climbTime: climb ? climb.time : 0,
    trench: top < TRENCH_CLEAR - 0.004 || Boolean(d.trenchCut),
    joints: d.joints,
    spin: d.spin || [],
    slide: d.hopper?.slide || null,
    net: d.hopper?.net || null,
    model: entry.model,
  }
}

/** 5805's Numbers, from the site's CAD manifest (public/models/robot.json). */
export function numbersSpec(manifest) {
  const frame = manifest.framePerimeter || { length: 0.6858, width: 0.7239 }
  const t = manifest.bumpers?.thickness ?? 0.0825
  const mouth = manifest.intakeMouth || { center: [0.6192, 0.075, 0], width: 0.5525 }
  const exit = manifest.shooter?.exit || { point: [-0.1723, 0.5079, 0] }
  const top = manifest.bounds?.max?.[1] ?? 0.556
  const capacity = manifest.hopper?.capacity?.byVolume?.deployed ?? 42
  // The hopper's boxes from the CAD: three fixed steps behind a part that rides out with the intake.
  const boxes = manifest.hopper?.boxes || []
  const fixed = boxes.filter((b) => b.movesWith === 'static')
  const moving = boxes.find((b) => b.movesWith !== 'static')
  const travel = manifest.intake?.travel ?? 0.3
  const hopper = {
    board: fixed.length ? Math.min(...fixed.map((b) => b.min[0])) : -0.07,
    front: fixed.length ? Math.max(...fixed.map((b) => b.max[0])) : 0.34,
    travel,
    wide: 0,
    halfWide: 0.345,
    floor: 0.26,
    roof: top + 0.03,
    netMax: null,
    floors: [
      ...fixed.map((b) => ({ x0: b.min[0], x1: b.max[0], y: b.min[1] })),
      ...(moving ? [{ x0: moving.min[0], x1: moving.max[0] + 0.05, y: moving.min[1] }] : []),
    ],
    pillars: [],
  }
  hopper.slots = hopperSlots(hopper, capacity)
  const exitX = exit.point[0]
  const width = manifest.shooter?.exit?.width ?? 0.55
  return {
    key: '5805-numbers',
    source: 'numbers',
    number: 5805,
    label: '5805',
    team: 'SMbly Required',
    robot: 'Numbers',
    colors: { primary: '#144781', secondary: '#cbb87b', accent: '#ffffff' },
    cloth: null,
    len: manifest.bumpers?.length ?? frame.length + 2 * t,
    wid: frame.width + 2 * t,
    height: top,
    bumper: { bottom: 0.0254, top: 0.0254 + 0.127 },
    hull: [
      {
        name: 'body',
        centre: [0, (top + 0.07) / 2, 0],
        half: [frame.length / 2, (top - 0.07) / 2, frame.width / 2],
      },
    ],
    modules: (manifest.modules || []).map((m) => [m.position[0], m.position[2]]),
    wheelRadius: manifest.modules?.[0]?.wheelRadius ?? 0.0508,
    mass: 54,
    speed: 4.5,
    accel: 10,
    yawRate: 7.5,
    capacity,
    hopper,
    fireRate: 12,
    // The intake deploys out the front; the mouth is its lowest roller.
    intake: intakeZone(mouth.center[0] - 0.16, mouth.center[0] + 0.1, mouth.width / 2, 0.22, [0]),
    intakeRate: 14,
    shot: {
      // Numbers shoots out its back.
      yaw: Math.PI,
      origin: { x: exitX, y: exit.point[1] },
      // One flywheel roller the width of the robot: three balls abreast.
      exits: [-1, 0, 1].map((k) => ({ x: exitX, z: (k * (width - 2 * FUEL.r)) / 2 })),
      barrel: 0,
      turret: null,
      table: null,
      elevation: 60,
      minRange: 1.4,
      maxRange: 6,
      // A fixed wide shooter: it shoots straightest close to still.
      moveSpeed: 1,
      spread: { pitchDeg: 0.5, yawDeg: 0.5, speedPct: 1 },
      hood: { range: [13, 45] },
      headingTol: (2.5 * Math.PI) / 180,
    },
    special: 'pass',
    turret: false,
    climb: 0,
    climbSpec: null,
    climbTime: 0,
    trench: top < TRENCH_CLEAR - 0.004,
    joints: null,
    spin: [],
    slide: null,
    net: null,
    model: 'numbers',
  }
}

/** The blue alliance's elevation for Numbers' hood visual: steeper close, flatter far. */
export function numbersHoodDeg(dist) {
  const u = Math.min(1, Math.max(0, (dist - 1.4) / 4.6))
  return 13 + u * 32
}
