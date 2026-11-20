// Mechanism rigs: bind a robot model's moving parts to live gameplay state.
//
// Imported robots carry a `part:<joint>` node for every joint in their descriptor,
// sitting on the joint's pivot with an identity rest rotation, in the descriptor's
// parent hierarchy. So a revolute joint is `rest × rotate(axis, value)` and a
// prismatic one `rest + axis × value`, clamped to the joint's range.
//
// What drives each joint:
//   swerve_*_steer / _wheel   the robot's velocity and turn rate (swerve kinematics)
//   descriptor `spin`         rollers, at their source's speed (intake, feed, shooter)
//   shooter.hood.part         the shot table's hood angle for the current distance
//   shooter.turret.part       the turret's live aim (and its twin, if it has one)
//   hopper.net.part           how full the hopper is
//   climb.part                climb progress
//   intake deployment         the joints the robot's own recorded capture moves in its
//                             "Deploy intake" phase, from the far end of each joint's range
//                             (stowed) to the captured value (deployed): no direction is guessed
// 5805's Numbers uses the site's own rig (robotRig.js) through the same interface.
import * as THREE from 'three'
import { hoodFor, rpmFor, numbersHoodDeg } from './robots.js'
import { HUB } from './config.js'

const CAPTURE = 'Simulator capture - freeplay controls'
const STOWED_T = 0 // the capture's first frame: some robots deploy within the first 0.3 s
const DEPLOYED_T = 1.66 // s: the end of the capture's "Deploy intake" phase (tick 100)
const SKIP_DEPLOY = /^(chassis|bumpers|swerve_|hood|turret|net)/

const _q = new THREE.Quaternion()
const _v = new THREE.Vector3()
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))
const clampTo = (v, range) => {
  if (!range) return v
  const lo = Number(range[0])
  const hi = Number(range[1])
  return Math.min(Math.max(v, Math.min(lo, hi)), Math.max(lo, hi))
}

/** A linkage's value where the slide is `t` of the way out: its curve is [t, value] pairs. */
function alongCurve(curve, t) {
  if (t <= curve[0][0]) return curve[0][1]
  for (let i = 1; i < curve.length; i++) {
    if (t > curve[i][0]) continue
    const [t0, v0] = curve[i - 1]
    const [t1, v1] = curve[i]
    return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0 || 1)
  }
  return curve[curve.length - 1][1]
}

function sampleTrack(track, t) {
  const interp = track.createInterpolant()
  return Array.from(interp.evaluate(t))
}

/** Rig an imported robot. `clips` are the GLB's animations (for the deploy poses). */
export function rigDescriptorRobot(root, spec, clips = []) {
  // three's GLTFLoader strips ':' from object names (it is reserved in animation
  // paths) but keeps the authored name in userData.name: find parts by that.
  const parts = new Map()
  root.traverse((o) => {
    const n = o.userData?.name ?? o.name
    if (n?.startsWith('part:') && !parts.has(n)) parts.set(n, o)
  })
  const joints = {}
  for (const j of spec.joints || []) {
    const node = parts.get(`part:${j.name}`)
    if (!node || !j.joint || j.joint.type === 'fixed') continue
    joints[j.name] = {
      node,
      type: j.joint.type,
      axis: new THREE.Vector3(...j.joint.axis).normalize(),
      range: j.joint.range && Number.isFinite(Number(j.joint.range[0])) && Number.isFinite(Number(j.joint.range[1])) ? j.joint.range.map(Number) : null,
      restPos: node.position.clone(),
      restQuat: node.quaternion.clone(),
      value: 0,
    }
  }
  const set = (name, value) => {
    const j = joints[name]
    if (!j) return
    const v = clampTo(value, j.range)
    j.value = v
    if (j.type === 'prismatic') j.node.position.copy(j.restPos).addScaledVector(j.axis, v)
    else j.node.quaternion.copy(j.restQuat).multiply(_q.setFromAxisAngle(j.axis, v))
  }
  const get = (name) => joints[name]?.value ?? 0

  // Read the deploy poses out of the capture: each joint's value, projected onto its own axis.
  const deploy = []
  const capture = clips.find((c) => c.name === CAPTURE)
  if (capture) {
    for (const [name, j] of Object.entries(joints)) {
      if (SKIP_DEPLOY.test(name) || !j.range) continue
      const path = j.type === 'prismatic' ? 'position' : 'quaternion'
      const track = capture.tracks.find((tr) => tr.name === `${j.node.name}.${path}`)
      if (!track) continue
      const val = (t) => {
        const s = sampleTrack(track, t)
        if (j.type === 'prismatic') return _v.set(s[0], s[1], s[2]).sub(j.restPos).dot(j.axis)
        const q = new THREE.Quaternion(s[0], s[1], s[2], s[3]).premultiply(j.restQuat.clone().invert())
        return 2 * Math.atan2(_v.set(q.x, q.y, q.z).dot(j.axis), q.w)
      }
      const a = val(STOWED_T)
      const b = val(DEPLOYED_T)
      const moved = j.type === 'prismatic' ? Math.abs(b - a) > 0.01 : Math.abs(wrap(b - a)) > 0.06
      if (!moved) continue
      // The capture tells which joints deploy, and which way. It can start with the
      // intake already part-way out, so stowed is the far end of the joint's own range.
      const deployed = clampTo(b, j.range)
      const [lo, hi] = j.range
      const stowed = Math.abs(deployed - lo) > Math.abs(deployed - hi) ? lo : hi
      deploy.push({ name, stowed, deployed })
    }
    // A robot with an intake on each side was recorded using one: the other is its mirror.
    for (const d of [...deploy]) {
      const twin = d.name.replace(/_(pz|nz)$/, (m, side) => (side === 'pz' ? '_nz' : '_pz'))
      if (twin !== d.name && joints[twin] && !deploy.some((x) => x.name === twin)) deploy.push({ ...d, name: twin })
    }
  }

  // Parts that ride with the intake but did not show in the recording (it used one
  // side of a two-sided robot, and is never asked about nets): the frames that
  // fold a net out over a drawer, a kicker. Each follows its own linkage curve.
  const linked = []
  for (const link of spec.slide?.links || []) {
    if (!joints[link.part] || link.part === spec.net?.part || deploy.some((d) => d.name === link.part)) continue
    const curve = link.curve?.length > 1 ? link.curve : [[0, Number(link.range?.[0] ?? 0)], [1, Number(link.range?.[1] ?? 0)]]
    linked.push({ name: link.part, curve })
  }

  const modules = ['FL', 'FR', 'BL', 'BR']
    .map((k) => ({ steer: `swerve_${k}_steer`, wheel: `swerve_${k}_wheel` }))
    .filter((m) => joints[m.steer] && joints[m.wheel])
    .map((m) => ({ ...m, pos: joints[m.steer].restPos.clone(), angle: 0, roll: 0 }))
  const wheelR = spec.wheelRadius || 0.0508
  const spin = (spec.spin || []).filter((s) => joints[s.part])
  const climbPart = spec.climbSpec?.part
  const turret = spec.shot.turret
  const hoodPart = spec.shot.hood?.part
  const speeds = { intake: 0, feed: 0, shooter: 0 }

  return {
    kind: 'descriptor',
    parts,
    joints,
    deploy,
    set,
    get,
    update(r, dt) {
      // --- swerve: each module steers to v + ω × r and rolls at that speed
      const c = Math.cos(r.psi)
      const s = Math.sin(r.psi)
      const vx = r.vx * c + r.vz * s // robot frame: x forward
      const vz = -r.vx * s + r.vz * c // z right
      const wy = -r.om // ω about the model's +y
      for (const m of modules) {
        const mx = vx + wy * m.pos.z
        const mz = vz - wy * m.pos.x
        const sp = Math.hypot(mx, mz)
        if (sp > 0.05) {
          let want = Math.atan2(-mz, mx)
          // Swerve optimisation: never turn a module more than 90°; roll it backward instead.
          let dir = 1
          if (Math.abs(wrap(want - m.angle)) > Math.PI / 2) { want = wrap(want + Math.PI); dir = -1 }
          m.angle += wrap(want - m.angle) * Math.min(1, dt * 18)
          m.roll -= ((sp * dir) / wheelR) * dt
        }
        set(m.steer, m.angle)
        set(m.wheel, m.roll)
      }

      // --- rollers: the intake runs while it is picking up and while it agitates the
      // hopper for a shot; the feeder runs while firing; the shooter follows its wheel
      const dist = Math.hypot(HUB[r.team].x - r.x, HUB[r.team].z - r.z)
      const rpm = rpmFor(r.a, dist)
      const intaking = (r.intakeOn && r.carry < r.a.capacity) || r.firing > 0
      speeds.intake += ((intaking ? 40 : 0) - speeds.intake) * Math.min(1, dt * 6)
      speeds.feed += ((r.firing > 0 ? 50 : 0) - speeds.feed) * Math.min(1, dt * 10)
      speeds.shooter = ((r.spin ?? 0) * rpm * 2 * Math.PI) / 60
      for (const sp of spin) {
        const w = (speeds[sp.source] ?? 0) * (sp.mul ?? 1) / (sp.div || 1)
        set(sp.part, get(sp.part) + w * dt)
      }

      // --- intake deployment, along the recorded deploy
      for (const d of deploy) set(d.name, d.stowed + (d.deployed - d.stowed) * r.intakeOut)
      for (const l of linked) set(l.name, alongCurve(l.curve, r.intakeOut))

      // --- hood from the shot table; turret from the live aim
      if (hoodPart) {
        const h = hoodFor(r.a, dist)
        const range = r.a.shot.hood.range
        const target = h ?? (range[0] + range[1]) / 2
        set(hoodPart, get(hoodPart) + (target - get(hoodPart)) * Math.min(1, dt * 8))
      }
      if (turret) {
        const rel = wrap(r.turretYaw - r.psi - r.a.shot.yaw)
        const sign = joints[turret.part]?.axis.y < 0 ? 1 : -1
        set(turret.part, sign * rel)
        if (turret.twin?.part) set(turret.twin.part, sign * rel)
      }

      // --- the climber reaches and pulls (the hopper's net is the scene's: it drapes over the pile)
      if (climbPart && joints[climbPart]) {
        const range = joints[climbPart].range || [0, 1]
        const u = r.climb.state === 'none' ? 0 : Math.min(1, r.climb.t / r.a.climbTime)
        set(climbPart, range[0] + (range[1] - range[0]) * u)
      }
    },
  }
}

/** Numbers, through the site's own rig (robotRig.rigRobot). */
export function rigNumbers(rig) {
  const travel = rig.manifest?.intake?.travel ?? 0.3
  return {
    kind: 'numbers',
    deploy: [{ name: 'intake' }],
    update(r, dt) {
      const c = Math.cos(r.psi)
      const s = Math.sin(r.psi)
      rig.steer({ vx: r.vx * c + r.vz * s, vz: -r.vx * s + r.vz * c, om: -r.om }, dt)
      const intaking = r.intakeOn || r.firing > 0
      rig.rollers({ fly: r.spin ?? 0, feed: r.firing > 0 ? 1 : 0, intake: intaking ? 1 : 0, conveyor: r.firing > 0 || r.intakeOn ? 1 : 0 }, dt)
      const dist = Math.hypot(HUB[r.team].x - r.x, HUB[r.team].z - r.z)
      rig.setHood(numbersHoodDeg(dist))
      rig.setExtension(r.intakeOut * travel)
    },
  }
}
