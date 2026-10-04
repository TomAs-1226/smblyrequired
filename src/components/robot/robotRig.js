// The season's robot, ready to move: everything the landing spine and the Catalyst demos share.
//
// One way to load it, one set of materials (studio reflections, clear polycarbonate, black tread), and
// one model of each mechanism, all read from the bake's manifest (public/models/robot.json): swerve
// modules steered by a stiff loop and rolled at their real kinematics, rollers on their signed axes
// and belt ratios, the hood about its pivot, the hopper along its slide. A consumer decides what the
// robot does; this decides how it looks doing it.

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'

/* Per material class, how much of the studio it reflects. Polycarbonate is about a third of metal:
   clear plastic is mostly what is behind it plus a thin sheen. */
/* Every model on the site is meshopt-compressed (tools/compress-models.mjs), so every loader needs
   the decoder. One place makes them, so none is made without it. */
export const modelLoader = () => new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)

export const REFLECT = { aluminium: 1.0, steel: 0.95, motor: 0.8, poly: 0.35, print: 0.35, belt: 0.3, tread: 0.3, electronics: 0.55, black: 0.4, other: 0.5 }
/* Steering: a stiff loop with almost no overshoot. Detent duration 0.3 / bounce 0.1 → k 438.6,
   c 37.7 — our tuning for a tight azimuth PID, not a platform value. */
const K = 438.65
const C = 37.7
/* rad/s at full command — for the eye; true speeds strobe on screen. */
const SPEED = { fly: 30, feed: 18, conveyor: 14, intake: 16 }
const TAU = { fly: 0.8, feed: 0.15, intake: 0.3, conveyor: 0.25 }

export const clamp01 = (v) => Math.max(0, Math.min(1, v))
export const lag = (v, to, tau, dt) => v + (to - v) * (1 - Math.exp(-dt / tau))
export const minJerk = (u) => u * u * u * (10 - 15 * u + 6 * u * u)
/* A module may flip its wheel rather than turn past 90°. */
export const wrapNear = (target, cur) => {
  let t = target
  while (t - cur > Math.PI / 2) t -= Math.PI
  while (cur - t > Math.PI / 2) t += Math.PI
  return t
}
/* A profiled move — the S-curve Motion Magic makes (minimum jerk), timed from distance at a rate. */
export function profiled(rate, min) {
  return {
    v: null, from: 0, to: null, t0: 0, dur: 1,
    at(to, now) {
      if (this.v === null) this.v = this.to = to
      if (to !== this.to) {
        this.from = this.v
        this.to = to
        this.t0 = now
        this.dur = Math.max(min, Math.abs(to - this.from) / rate)
      }
      this.v = this.from + (this.to - this.from) * minJerk(clamp01((now - this.t0) / this.dur))
      return this.v
    },
  }
}

/* A studio to reflect: raw CAD under plain lights looks like grey plastic, because metal is only
   ever the room it reflects. Softboxes over a graded shell, baked once into an environment map. */
export function studioEnvironment(renderer) {
  const room = new THREE.Scene()
  const spent = []
  const add = (g, m) => { spent.push(g, m); const x = new THREE.Mesh(g, m); room.add(x); return x }
  const shell = new THREE.SphereGeometry(10, 48, 24)
  const pos = shell.getAttribute('position')
  const tone = new Float32Array(pos.count * 3)
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 10
    const v = y < 0 ? 0.03 + 0.27 * Math.pow(Math.max(0, 1 + y / 0.7), 1.6) : 0.2 + 0.25 * Math.pow(y, 0.8)
    tone[i * 3] = tone[i * 3 + 1] = tone[i * 3 + 2] = v
  }
  shell.setAttribute('color', new THREE.BufferAttribute(tone, 3))
  add(shell, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide }))
  const sb = (w, h, i, hex, x, y, z) => {
    const pl = add(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(i), side: THREE.DoubleSide }))
    pl.position.set(x, y, z)
    pl.lookAt(0, 0.4, 0)
  }
  sb(5, 2.5, 5.0, 0xffffff, -1, 7, 2)
  sb(9, 1.2, 2.6, 0xffffff, 0, 2.0, 8)
  sb(1.4, 6, 3.2, 0xf0f3f9, -8, 3, 0.5)
  sb(1.4, 6, 1.6, 0xf0f3f9, 8, 3, -1.5)
  sb(8, 1.2, 2.4, 0xe0e7f4, 0, 3.4, -8)
  const pm = new THREE.PMREMGenerator(renderer)
  const t = pm.fromScene(room, 0.04)
  pm.dispose()
  spent.forEach((s) => s.dispose())
  return t.texture
}

/* The renderer, scene, camera and key/rim lights every robot stage uses. */
export function createStudio(canvas, { fov = 30 } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' })
  /* NeutralToneMapping needs three r162+; on older builds the constant is undefined and every shader
     silently compiles with no tone mapping at all. */
  renderer.toneMapping = THREE.NeutralToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.outputColorSpace = THREE.SRGBColorSpace
  const scene = new THREE.Scene()
  scene.environment = studioEnvironment(renderer)
  const camera = new THREE.PerspectiveCamera(fov, 1, 0.05, 60)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x0b0b0c, 0.15))
  const key = new THREE.DirectionalLight(0xffffff, 1.6)
  key.position.set(-2.2, 5, 3.4)
  const rim = new THREE.DirectionalLight(0xdae3f4, 2.2)
  rim.position.set(2.4, 3.2, -5)
  scene.add(key, rim)
  return { renderer, scene, camera }
}

/* A soft contact shadow: a robot with nothing under it floats. */
export function blob(scene, size, alpha) {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const x = c.getContext('2d')
  const gr = x.createRadialGradient(64, 64, 0, 64, 64, 64)
  gr.addColorStop(0, `rgba(0,0,0,${alpha})`)
  gr.addColorStop(0.55, `rgba(0,0,0,${alpha * 0.55})`)
  gr.addColorStop(1, 'rgba(0,0,0,0)')
  x.fillStyle = gr
  x.fillRect(0, 0, 128, 128)
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, toneMapped: false }),
  )
  m.rotation.x = -Math.PI / 2
  m.renderOrder = -1
  scene.add(m)
  return m
}

/* Loaded once per page however many stages use it; each consumer gets its own copy of the scene graph
   (geometry is shared, materials are cloned by rigRobot). */
const cache = new Map()
export function loadRobot(models) {
  if (!cache.has(models)) {
    cache.set(models, Promise.all([
      modelLoader().loadAsync(`${models}robot.glb`),
      fetch(`${models}robot.json`).then((r) => r.json()),
    ]))
  }
  return cache.get(models).then(([gltf, manifest]) => ({ root: gltf.scene.clone(true), manifest }))
}
const hubCache = new Map()
/* The HUB, cut from FIRST's official field model (tools/hub-from-field.mjs). The cut loses the
   field's palette texture, so each part is painted here: the funnel — the only piece above 1.3 m — in
   the blue alliance's colour, the body in dark painted steel. */
export function loadHub(models) {
  if (!hubCache.has(models)) hubCache.set(models, modelLoader().loadAsync(`${models}hub.glb`))
  return hubCache.get(models).then((g) => {
    const hub = g.scene.clone(true)
    const box = new THREE.Box3()
    hub.traverse((o) => {
      if (!o.isMesh) return
      box.setFromObject(o)
      o.material = box.min.y > 1.3
        ? new THREE.MeshStandardMaterial({ color: 0x24589c, metalness: 0.35, roughness: 0.42 })
        : new THREE.MeshStandardMaterial({ color: 0x3a3f47, metalness: 0.5, roughness: 0.5 })
    })
    return hub
  })
}

/**
 * Dress and rig a loaded robot. `groupOf(name)` sorts its top-level assemblies into groups (the spine
 * dims and lifts them by group); `glassy` picks transmissive polycarbonate (desktop) or a faint
 * blended sheet (phones, where the transmission pass costs a second draw of the scene).
 */
export function rigRobot(root, manifest, { glassy = true, groupOf = () => 'all' } = {}) {
  const top = root.getObjectByName('robot_1') || root
  const groupMats = {}
  const groupNodes = {}
  const cache = new Map()
  /* Polycarbonate is clear. Transmission samples what is behind from the opaque pass instead of
     blending over it, so panels never cut across each other as draw order changes; polygonOffset keeps
     a sheet bolted flat to a plate from z-fighting with it. */
  const polycarb = () => {
    const m = glassy
      ? new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0, roughness: 0.01, transmission: 1, thickness: 0, ior: 1.585, specularIntensity: 0.55, side: THREE.DoubleSide })
      : new THREE.MeshStandardMaterial({ color: 0xeef2f8, metalness: 0, roughness: 0.08, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide })
    m.name = 'poly'
    m.polygonOffset = true
    m.polygonOffsetFactor = 1
    m.polygonOffsetUnits = 1
    return m
  }
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return
    let a = o
    while (a.parent && a.parent !== top) a = a.parent
    const g = groupOf(a.name)
    let inWheel = false
    for (let x = o; x; x = x.parent) if (x.name?.startsWith('wheel-')) inWheel = true
    const k = `${g}|${o.material.uuid}${inWheel ? '|w' : ''}`
    if (!cache.has(k)) {
      let m = o.material.clone()
      if (m.name === 'poly') m = polycarb()
      m.envMapIntensity = REFLECT[m.name] ?? 0.6
      m.dithering = true
      /* The CAD's tread is the vendor model's placeholder pale blue; real tread is black rubber. */
      if (inWheel && m.name === 'tread') { m.color.set(0x161719); m.roughness = 0.92; m.metalness = 0; m.envMapIntensity = 0.25 }
      m.userData.base = { color: m.color.clone(), env: m.envMapIntensity }
      cache.set(k, m)
      ;(groupMats[g] ??= []).push(m)
    }
    o.material = cache.get(k)
  })
  for (const c of top.children) if (c.name) (groupNodes[groupOf(c.name)] ??= []).push(c)

  /* Rollers turn about the manifest's signed axis, at its belt or gear ratio to the flywheel, on the
     channel the code drives them from. */
  const spin = []
  for (const r of manifest?.rollers ?? []) {
    const node = root.getObjectByName(r.node)
    if (!node) continue
    const ch = r.role === 'intake' ? 'intake' : r.role === 'feeder' ? 'feed' : r.role === 'conveyor' ? 'conveyor' : 'fly'
    spin.push({ node, ch, axis: new THREE.Vector3(...r.axis).normalize(), ratio: Math.abs(r.drivenBy?.ratio ?? 1), angle: 0, rest: node.quaternion.clone() })
  }
  const mods = []
  for (const m of manifest?.modules ?? []) {
    const node = root.getObjectByName(m.steerNode)
    const wheel = root.getObjectByName(m.wheelNode)
    if (node && wheel) mods.push({ node, wheel, axis: new THREE.Vector3(...m.wheelAxis).normalize(), cad: (m.cadSteerAngle * Math.PI) / 180, pos: m.position, angle: 0, vel: 0, roll: 0, dir: 1 })
  }
  const hoodNode = root.getObjectByName(manifest?.hood?.node ?? 'hood')
  const intakeNode = root.getObjectByName(manifest?.intake?.node ?? 'intake')
  const intakeAxis = new THREE.Vector3(...(manifest?.intake?.axis ?? [1, 0, 0]))
  const intakeHome = intakeNode?.position.clone()
  const cadHood = manifest?.hood?.cadAngle ?? 11
  const roll = { fly: 0, feed: 0, conveyor: 0, intake: 0 }
  const _q = new THREE.Quaternion()

  return {
    root, top, manifest, groupMats, groupNodes, mods, spin, hoodNode, intakeNode, intakeAxis, intakeHome, roll,

    /**
     * Steer and roll every module for one step. `drive` is the robot's own velocity and turn rate in
     * its frame — { vx, vz, om } — and each module steers to v + ω × r (swerve kinematics). Without
     * one, `rawFor(m)` gives each module's steer angle relative to its CAD pose and `speed` its wheel
     * speed. `weight` blends the steering in from the CAD pose.
     */
    steer(drive, dt, { weight = 1, rawFor = null, speed: fixedSpeed = 0 } = {}) {
      for (const m of mods) {
        let raw = m.lastRaw ?? 0
        let speed = fixedSpeed
        if (drive) {
          const vx = drive.vx + drive.om * m.pos[2]
          const vz = drive.vz - drive.om * m.pos[0]
          speed = Math.hypot(vx, vz)
          if (speed > 0.03) raw = Math.atan2(-vz, vx) - m.cad // WPILib angle, then relative to the CAD pose
        } else if (rawFor) raw = rawFor(m)
        m.lastRaw = raw
        const target = wrapNear(raw, m.angle)
        m.dir = Math.round((target - raw) / Math.PI) % 2 ? -1 : 1
        const n = 4
        const h = dt / n
        for (let i = 0; i < n; i++) { m.vel += (K * (target - m.angle) - C * m.vel) * h; m.angle += m.vel * h }
        m.node.rotation.y = m.angle * weight
        m.roll += ((dt * speed * m.dir) / 0.0508) * 0.35 // scaled down: true wheel speed strobes on screen
        m.wheel.quaternion.setFromAxisAngle(m.axis, m.roll)
      }
    },

    /* Rollers spin up and coast down per channel: `want` is { fly, feed, intake, conveyor }, 0..1. */
    rollers(want, dt) {
      for (const k in roll) roll[k] = lag(roll[k], want[k] ?? 0, TAU[k], dt)
      for (const q of spin) {
        q.angle += dt * roll[q.ch] * SPEED[q.ch] * q.ratio
        q.node.quaternion.copy(q.rest).multiply(_q.setFromAxisAngle(q.axis, q.angle))
      }
    },

    /* The hood at an angle in Hood.java's terms (13–45°); the CAD sits at its 11° stop. */
    setHood(deg) {
      if (hoodNode) hoodNode.rotation.z = ((deg - cadHood) * Math.PI) / 180
    },

    /* The hopper out along its slide, metres. Only for consumers that do not move the node themselves. */
    setExtension(m) {
      if (intakeNode && intakeHome) intakeNode.position.copy(intakeHome).addScaledVector(intakeAxis, m)
    },
  }
}
