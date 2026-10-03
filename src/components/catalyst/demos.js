// Live demos for the Catalyst page, run on the season's robot.
//
// Two stages, each the real robot from its CAD on the shared rig (../robot/robotRig.js):
//
//   Autonomy   the same behaviour the landing page ends on (../spine/autonomy.js), on its own field,
//              reporting what it decided and why — the way Catalyst's autonomy cores do.
//   States     a close-up of the robot run by a whole-robot state machine: STOW, INTAKE, AIM, SHOOT,
//              a request it refuses because that transition was never declared, and arrival measured
//              from the mechanisms rather than assumed from a timer.
//
// Framework-free like the spine: React renders the words and reads the state these report through
// `onState`; nothing here re-renders React per frame.

import * as THREE from 'three'
import { createStudio, blob, loadRobot, loadHub, rigRobot, profiled, lag } from '../robot/robotRig'
import { createAutonomy } from '../spine/autonomy'
import { HUB_AT, FUEL_START, FUEL_ROWS, SHOT_SPOTS } from '../spine/shots'

const FOV = 30
const TAN = Math.tan((FOV * Math.PI) / 360)

/* What every demo stage shares: sizing, pausing off-screen, the loop, and teardown. */
function stage(canvas, { onFrame, fit }) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const studio = createStudio(canvas, { fov: FOV })
  const { renderer, camera } = studio
  let W = 1
  let H = 1
  let visible = false
  let disposed = false
  const resize = () => {
    const r = canvas.getBoundingClientRect()
    if (!r.width) return
    W = r.width
    H = r.height
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    renderer.setSize(W, H, false)
    camera.aspect = W / H
    camera.updateProjectionMatrix()
    fit?.(W, H, camera)
  }
  addEventListener('resize', resize)
  resize()
  /* Only draws while on screen: two WebGL stages on one page must not both run all the time. */
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting }, { rootMargin: '120px' })
  io.observe(canvas)
  const clock = new THREE.Clock()
  renderer.setAnimationLoop(() => {
    const dt = Math.min(0.05, clock.getDelta())
    if (!visible || disposed) return
    onFrame(reduced ? 0 : dt)
    renderer.render(studio.scene, camera)
  })
  return {
    ...studio,
    get size() { return { W, H } },
    dispose() {
      disposed = true
      renderer.setAnimationLoop(null)
      removeEventListener('resize', resize)
      io.disconnect()
      studio.scene.traverse((o) => {
        o.geometry?.dispose?.()
        const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : []
        ms.forEach((m) => { m.map?.dispose?.(); m.dispose?.() })
      })
      studio.scene.environment?.dispose?.()
      renderer.dispose()
    },
  }
}

/* Frame a world point and radius: the camera backs off until a sphere of that radius fits both the
   height and the width, at `fill` of whichever is tighter. */
function frameCamera(camera, W, H, { look, R, el, az = 0, fill = 0.9 }) {
  const d = Math.max(R / TAN, R / (TAN * (W / H))) / fill
  camera.position.set(look[0] + Math.sin(az) * Math.cos(el) * d, look[1] + Math.sin(el) * d, look[2] + Math.cos(az) * Math.cos(el) * d)
  camera.lookAt(look[0], look[1], look[2])
}

/* ── Autonomy ─────────────────────────────────────────────────────────── */

/**
 * The robot collecting and scoring on its own. `onState({ mode, reason, held, capacity, shot })` is
 * called a few times a second with what it decided.
 */
export function createAutonomyDemo({ canvas, models, onState }) {
  const HOME_YAW = -0.72
  const view = { look: [1.0, 0.3, -2.05], R: 2.3, el: 0.6, az: 0.12, fill: 0.98 }
  const s = stage(canvas, {
    fit: (W, H, cam) => frameCamera(cam, W, H, view),
    onFrame: (dt) => frame(dt),
  })
  frameCamera(s.camera, s.size.W, s.size.H, view)
  const { scene } = s
  const body = new THREE.Group()
  scene.add(body)
  const shadow = blob(scene, 1.35, 0.75)
  blob(scene, 2.1, 0.6).position.set(HUB_AT[0], 0.001, HUB_AT[2])
  let robot = null
  let auto = null
  let cmd = null
  const deployP = profiled(0.42, 0.55)
  const hoodP = profiled(40, 0.45)
  let t = 0
  let lastReport = 0
  let disposed = false

  Promise.all([loadRobot(models), loadHub(models)]).then(([{ root, manifest }, hub]) => {
    if (disposed) return
    body.add(root)
    robot = rigRobot(root, manifest)
    hub.position.set(...HUB_AT)
    scene.add(hub)
    auto = createAutonomy({ scene, manifest, hubAt: HUB_AT, spots: FUEL_START, rows: FUEL_ROWS, shots: SHOT_SPOTS })
    body.rotation.y = HOME_YAW
    s.renderer.compile(scene, s.camera)
  }).catch((e) => console.warn('catalyst demo: the robot did not load', e))

  function frame(dt) {
    if (!robot || !auto) return
    t += dt
    /* This frame's pose first, so the behaviour measures against where the robot really is. */
    if (cmd) {
      body.position.set(cmd.pose.x, 0, cmd.pose.z)
      body.rotation.y = cmd.pose.yaw
    }
    shadow.position.set(body.position.x, 0.001, body.position.z)
    body.updateMatrixWorld(true)
    const deploy = deployP.at((cmd?.intake ?? 1) * (robot.manifest?.intake?.travel ?? 0.3), t)
    robot.setExtension(deploy)
    cmd = auto.update(dt, { top: robot.top, deploy, baseYaw: HOME_YAW, active: dt > 0, visible: true })
    const c = Math.cos(body.rotation.y)
    const sn = Math.sin(body.rotation.y)
    robot.steer({ vx: cmd.vel.vx * c - cmd.vel.vz * sn, vz: cmd.vel.vx * sn + cmd.vel.vz * c, om: cmd.vel.w }, dt)
    robot.rollers({ fly: cmd.fly, feed: cmd.feed, intake: cmd.rollers, conveyor: Math.max(cmd.feed, cmd.rollers * 0.6) }, dt)
    robot.setHood(hoodP.at(cmd.hood, t))
    if (t - lastReport > 0.15) {
      lastReport = t
      onState?.({ mode: cmd.mode, reason: cmd.reason, held: cmd.held, capacity: cmd.capacity, shot: cmd.shot })
    }
  }

  return () => { disposed = true; s.dispose() }
}

/* ── States ───────────────────────────────────────────────────────────── */

/* The declared graph. A request for anything else is refused, with the reason. */
export const STATES = ['STOW', 'INTAKE', 'AIM', 'SHOOT']
export const TRANSITIONS = [
  ['STOW', 'INTAKE'], ['INTAKE', 'STOW'], ['INTAKE', 'AIM'], ['STOW', 'AIM'],
  ['AIM', 'SHOOT'], ['SHOOT', 'AIM'], ['AIM', 'STOW'], ['SHOOT', 'STOW'],
]
const declared = (a, b) => TRANSITIONS.some(([x, y]) => x === a && y === b)

/* What each state asks of the mechanisms. */
const GOALS = {
  STOW: { extend: 0, hood: 15, fly: 0, feed: 0, intake: 0 },
  INTAKE: { extend: 1, hood: 15, fly: 0, feed: 0, intake: 1 },
  AIM: { extend: 1, hood: 27, fly: 1, feed: 0, intake: 0 },
  SHOOT: { extend: 1, hood: 27, fly: 1, feed: 1, intake: 0 },
}
/* The script of requests: what a driver presses, and when. SHOOT from INTAKE is refused — the graph
   only reaches SHOOT through AIM. */
const SCRIPT = [
  { at: 0.8, want: 'INTAKE', by: 'Driver: collect' },
  { at: 4.2, want: 'SHOOT', by: 'Driver: shoot' },
  { at: 5.6, want: 'AIM', by: 'Driver: aim' },
  { at: 'arrived', want: 'SHOOT', by: 'Superstructure: aimed, so shoot' },
  { at: 2.2, after: 'SHOOT', want: 'STOW', by: 'Hopper empty' },
]
const LOOP_REST = 2.4

/**
 * The robot run by a whole-robot state machine. `onState({ state, target, arrived, refused, log })`
 * is called whenever any of those change.
 */
export function createStatesDemo({ canvas, models, onState }) {
  const view = { look: [0.02, 0.36, 0], R: 0.62, el: 0.3, az: 0.0, fill: 0.95 }
  const s = stage(canvas, {
    fit: (W, H, cam) => frameCamera(cam, W, H, view),
    onFrame: (dt) => frame(dt),
  })
  frameCamera(s.camera, s.size.W, s.size.H, view)
  const { scene } = s
  const body = new THREE.Group()
  scene.add(body)
  blob(scene, 1.35, 0.75)
  let robot = null
  let disposed = false

  /* FUEL leaving the shooter, drawn as far as the frame shows it — no target in this shot. */
  const R = 0.075
  const fuel = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(R, 2),
    new THREE.MeshStandardMaterial({ color: 0xd4b13f, roughness: 0.62, metalness: 0, envMapIntensity: 0.7 }),
    24,
  )
  fuel.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  fuel.frustumCulled = false
  fuel.count = 0
  scene.add(fuel)
  const shots = []
  const exitWorld = new THREE.Vector3()
  let exitNode = null

  Promise.all([loadRobot(models)]).then(([{ root, manifest }]) => {
    if (disposed) return
    body.add(root)
    robot = rigRobot(root, manifest)
    body.rotation.y = 0.42
    const ex = manifest?.shooter?.exit?.point
    if (robot.hoodNode && ex) {
      exitNode = new THREE.Object3D()
      root.updateMatrixWorld(true)
      exitNode.position.copy(robot.hoodNode.worldToLocal(new THREE.Vector3(ex[0], ex[1], 0)))
      robot.hoodNode.add(exitNode)
    }
    s.renderer.compile(scene, s.camera)
  }).catch((e) => console.warn('catalyst demo: the robot did not load', e))

  const extendP = profiled(0.42, 0.55)
  const hoodP = profiled(40, 0.45)
  let t = 0
  let clock = 0
  let state = 'STOW'
  let target = 'STOW'
  let arrived = true
  let refused = null
  let step = 0
  let stepClock = 0
  let feedLeft = 0
  let feedClock = 0
  let fly = 0
  const log = []

  function report() {
    onState?.({ state, target, arrived, refused, log: log.slice(-4) })
  }
  function request(want, by) {
    if (want === target) return
    if (!declared(target, want)) {
      refused = { from: target, to: want, reason: `${target} → ${want} was never declared. SHOOT is reached through AIM.` }
      log.push(`Refused ${target} → ${want} — not a declared transition`)
      report()
      return
    }
    refused = null
    log.push(`${target} → ${want} · ${by}`)
    target = want
    arrived = false
    if (want === 'SHOOT') feedLeft = 8
    report()
  }

  function frame(dt) {
    if (!robot) return
    t += dt
    clock += dt
    stepClock += dt
    body.rotation.y = 0.42 + Math.sin(t * 0.25) * 0.18

    /* Run the script of requests. */
    const cur = SCRIPT[step]
    if (cur) {
      const due = cur.at === 'arrived' ? arrived && target === 'AIM' : cur.after ? target === cur.after && arrived && stepClock >= cur.at : clock >= cur.at
      if (due) { request(cur.want, cur.by); step++; stepClock = 0 }
    } else if (target === 'STOW' && arrived && stepClock > LOOP_REST) {
      step = 0
      clock = 0
      stepClock = 0
      log.length = 0
      refused = null
      report()
    }

    /* Drive the mechanisms toward the target's goals. */
    const g = GOALS[target]
    const travel = robot.manifest?.intake?.travel ?? 0.3
    const ext = extendP.at(g.extend * travel, t)
    robot.setExtension(ext)
    const hood = hoodP.at(g.hood, t)
    robot.setHood(hood)
    fly = lag(fly, g.fly, 0.8, dt)
    const feeding = target === 'SHOOT' && arrived && feedLeft > 0
    robot.rollers({ fly: g.fly, feed: feeding ? 1 : 0, intake: g.intake, conveyor: Math.max(feeding ? 1 : 0, g.intake * 0.6) }, dt)
    robot.steer(null, dt, { rawFor: () => 0, weight: 1, speed: 0 })

    /* Arrival is measured, not assumed: the hopper and hood at their goals, the flywheel at speed. */
    if (!arrived) {
      const atExt = Math.abs(ext - g.extend * travel) < 0.004
      const atHood = Math.abs(hood - g.hood) < 0.5
      const atFly = g.fly ? fly > 0.95 : true
      if (atExt && atHood && atFly) {
        arrived = true
        state = target
        log.push(`Arrived at ${target} — measured`)
        if (refused) refused = null
        report()
      } else if (state !== target) {
        state = target
        report()
      }
    }

    /* Fire, one ball at a time, while SHOOT holds. */
    if (feeding) {
      feedClock -= dt
      if (feedClock <= 0 && exitNode) {
        feedClock = 0.17
        feedLeft--
        exitNode.getWorldPosition(exitWorld)
        const th = ((88.44 - hood) * Math.PI) / 180
        const back = new THREE.Vector3(-Math.cos(body.rotation.y), 0, Math.sin(body.rotation.y))
        shots.push({ p0: exitWorld.clone().addScaledVector(new THREE.Vector3(-back.z, 0, back.x), (Math.random() - 0.5) * 0.3), v: back.multiplyScalar(6.2 * Math.cos(th)).setY(6.2 * Math.sin(th)), t: 0 })
        if (shots.length > 24) shots.shift()
      }
    }
    const m = new THREE.Matrix4()
    const p = new THREE.Vector3()
    const q = new THREE.Quaternion()
    let n = 0
    for (let i = shots.length - 1; i >= 0; i--) { shots[i].t += dt; if (shots[i].t > 1.2) shots.splice(i, 1) }
    for (const b of shots) {
      p.copy(b.p0).addScaledVector(b.v, b.t)
      p.y -= 0.5 * 9.81 * b.t * b.t
      m.compose(p, q, new THREE.Vector3(1, 1, 1))
      fuel.setMatrixAt(n++, m)
    }
    fuel.count = n
    fuel.instanceMatrix.needsUpdate = true
  }

  report()
  return () => { disposed = true; s.dispose() }
}
