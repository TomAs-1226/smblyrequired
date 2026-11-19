// Cycle Rush 3D — three.js view of a sim. It reads positions out of the Rapier
// bodies every frame and owns nothing about the rules.
import * as THREE from 'three'
import { FIELD, FUEL, HUB, TRENCH, BUMP, LANES, TOWER, DEPOT, OUTPOST } from './config.js'
import { hubActive } from './rules.js'

const UP = new THREE.Vector3(0, 1, 0)

export function createScene(canvas, pal, { loadHub } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(pal.void)
  scene.fog = new THREE.Fog(pal.void, 22, 48)

  const camera = new THREE.PerspectiveCamera(50, 2, 0.1, 120)
  camera.position.set(-4, 6, FIELD.W / 2)

  // ---- light: a bright arena, one key light for shadows
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x1a1c20, 1.1))
  const key = new THREE.DirectionalLight(0xffffff, 2.2)
  key.position.set(FIELD.L / 2 - 4, 14, FIELD.W / 2 - 6)
  key.target.position.set(FIELD.L / 2, 0, FIELD.W / 2)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  Object.assign(key.shadow.camera, { left: -11, right: 11, top: 8, bottom: -8, near: 1, far: 40 })
  key.shadow.bias = -0.0005
  scene.add(key, key.target)

  const blue = new THREE.Color(pal.blue)
  const red = new THREE.Color(pal.red)
  const teamColor = (t) => (t === 'blue' ? blue : red)
  const mat = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.1, ...opts })
  const alu = mat(0xb9bec6, { roughness: 0.35, metalness: 0.8 })
  const dark = mat(0x23262b, { roughness: 0.8 })
  const add = (mesh, shadow = true) => {
    mesh.castShadow = shadow
    mesh.receiveShadow = true
    scene.add(mesh)
    return mesh
  }
  const boxAt = (w, h, d, material, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material)
    m.position.set(x, y, z)
    return m
  }

  // ---- floor
  const outside = new THREE.Mesh(new THREE.PlaneGeometry(80, 60), mat(0x0b0c0e, { roughness: 1 }))
  outside.rotation.x = -Math.PI / 2
  outside.position.set(FIELD.L / 2, -0.01, FIELD.W / 2)
  outside.receiveShadow = true
  scene.add(outside)
  const carpet = new THREE.Mesh(new THREE.PlaneGeometry(FIELD.L, FIELD.W), new THREE.MeshStandardMaterial({ map: carpetTexture(pal), roughness: 0.95 }))
  carpet.rotation.x = -Math.PI / 2
  carpet.position.set(FIELD.L / 2, 0, FIELD.W / 2)
  carpet.receiveShadow = true
  scene.add(carpet)

  // ---- perimeter: clear panels on an aluminium rail
  const panel = new THREE.MeshStandardMaterial({ color: 0xcfe3ff, transparent: true, opacity: 0.12, roughness: 0.1, depthWrite: false })
  const H = 0.5
  for (const [w, d, x, z] of [
    [FIELD.L, 0.04, FIELD.L / 2, -0.02],
    [FIELD.L, 0.04, FIELD.L / 2, FIELD.W + 0.02],
  ]) {
    scene.add(boxAt(w, H, d, panel, x, H / 2, z))
    add(boxAt(w, 0.05, 0.07, alu, x, H, z))
  }
  for (const [team, x] of [['blue', -0.05], ['red', FIELD.L + 0.05]]) {
    add(boxAt(0.1, 0.9, FIELD.W, mat(teamColor(team), { roughness: 0.5 }), x, 0.45, FIELD.W / 2))
    add(boxAt(0.12, 0.06, FIELD.W, alu, x, 0.92, FIELD.W / 2))
  }

  // ---- hubs, bumps, trenches, towers, depots
  const hubRims = {}
  for (const team of ['blue', 'red']) {
    const h = HUB[team]
    const c = teamColor(team)
    const shell = mat(c.clone().multiplyScalar(0.35), { roughness: 0.6 })
    const hs = HUB.size / 2
    const t = HUB.wall
    add(boxAt(t, HUB.top, HUB.size, shell, h.x - hs + t / 2, HUB.top / 2, h.z))
    add(boxAt(t, HUB.top, HUB.size, shell, h.x + hs - t / 2, HUB.top / 2, h.z))
    add(boxAt(HUB.size, HUB.top, t, shell, h.x, HUB.top / 2, h.z - hs + t / 2))
    add(boxAt(HUB.size, HUB.top, t, shell, h.x, HUB.top / 2, h.z + hs - t / 2))
    // the lit rim: bright when the hub counts, dim when it does not
    const rim = new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 1.5, roughness: 0.4 })
    for (const [w, d, dx, dz] of [[HUB.size, 0.09, 0, -hs], [HUB.size, 0.09, 0, hs], [0.09, HUB.size, -hs, 0], [0.09, HUB.size, hs, 0]]) {
      add(boxAt(w, 0.07, d, rim, h.x + dx, HUB.top + 0.035, h.z + dz), false)
    }
    hubRims[team] = rim
    // the inside, so the opening reads as a hole
    const inside = new THREE.Mesh(new THREE.PlaneGeometry(HUB.size - 2 * t, HUB.size - 2 * t), mat(0x050506, { roughness: 1 }))
    inside.rotation.x = -Math.PI / 2
    inside.position.set(h.x, HUB.top - 0.25, h.z)
    scene.add(inside)

    // bumps
    const flip = team === 'red'
    const zs = (z) => (flip ? FIELD.W - z : z)
    const bumpMat = mat(0x3a3e45, { roughness: 0.9 })
    const shape = new THREE.Shape()
    shape.moveTo(-BUMP.depth / 2, 0)
    shape.lineTo(-BUMP.top / 2, BUMP.height)
    shape.lineTo(BUMP.top / 2, BUMP.height)
    shape.lineTo(BUMP.depth / 2, 0)
    shape.closePath()
    for (const [a, b] of BUMP.spans) {
      const z0 = Math.min(zs(a), zs(b))
      const len = Math.abs(b - a)
      const g = new THREE.ExtrudeGeometry(shape, { depth: len, bevelEnabled: false })
      const m = add(new THREE.Mesh(g, bumpMat))
      m.position.set(h.x, 0, z0)
      add(boxAt(0.05, 0.012, len, mat(c, { emissive: c, emissiveIntensity: 0.3 }), h.x, BUMP.height + 0.006, z0 + len / 2), false)
    }
    // trenches: a 12 in wall, and a roof over the lane
    const trenchH = TRENCH.clearance + TRENCH.roof
    for (const side of [0, 1]) {
      const wallZ = zs(side ? FIELD.W - TRENCH.wall.z : TRENCH.wall.z)
      const laneZ = zs(side ? LANES.trench[1] : LANES.trench[0])
      add(boxAt(TRENCH.depth, trenchH, TRENCH.wall.t, dark, h.x, trenchH / 2, wallZ))
      add(boxAt(TRENCH.depth, 0.04, TRENCH.wall.t + 0.01, mat(c, { emissive: c, emissiveIntensity: 0.25 }), h.x, trenchH + 0.02, wallZ), false)
      add(boxAt(TRENCH.depth, TRENCH.roof, TRENCH.width, alu, h.x, TRENCH.clearance + TRENCH.roof / 2, laneZ))
      add(boxAt(0.06, 0.05, TRENCH.width, mat(c, { emissive: c, emissiveIntensity: 0.25 }), h.x + (team === 'blue' ? 1 : -1) * (TRENCH.depth / 2 - 0.03), TRENCH.clearance - 0.025, laneZ), false)
    }

    // tower: two uprights, three rungs between them, a base plate to the wall
    const tw = TOWER[team]
    const s = team === 'blue' ? 1 : -1
    const u = TOWER.upright
    for (const dz of [-TOWER.gap / 2, TOWER.gap / 2]) add(boxAt(u.x, u.h, u.z, alu, tw.x, u.h / 2, tw.z + dz))
    add(boxAt(tw.x * 2 - 0.1, 0.02, TOWER.gap + 0.1, dark, tw.x / 2, 0.01, tw.z))
    TOWER.rungs.forEach((y, i) => {
      const rung = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, TOWER.gap, 12), i === 2 ? mat(c, { metalness: 0.5 }) : alu)
      rung.rotation.x = Math.PI / 2
      rung.position.set(tw.x + s * 0.02, y, tw.z)
      add(rung)
    })
    // depot frame
    const d = DEPOT[team]
    const frame = mat(0x4a4f57, { roughness: 0.6 })
    const fx = Math.min(Math.max(d.x, DEPOT.w / 2), FIELD.L - DEPOT.w / 2)
    add(boxAt(DEPOT.w, 0.08, 0.04, frame, fx, 0.04, d.z - DEPOT.d / 2))
    add(boxAt(DEPOT.w, 0.08, 0.04, frame, fx, 0.04, d.z + DEPOT.d / 2))
    add(boxAt(0.04, 0.08, DEPOT.d, frame, fx + s * DEPOT.w / 2, 0.04, d.z))
    // outpost: the human player's chute in the corner, with its fuel showing
    const o = OUTPOST[team]
    add(boxAt(0.3, 1.1, 0.9, mat(c.clone().multiplyScalar(0.4)), o.x - s * 0.1, 0.55, o.z))
    add(boxAt(0.12, 0.08, 0.6, alu, o.x + s * 0.06, 0.25, o.z))
  }

  // ---- the real hub model (cut from FIRST's field CAD), dressed in each alliance's colour
  const hubBoxes = []
  const boxYs = [HUB.top / 2, HUB.top + 0.035, HUB.top - 0.25]
  scene.traverse((o) => {
    const nearHub = ['blue', 'red'].some((t) => Math.abs(o.position.x - HUB[t].x) < 0.7 && Math.abs(o.position.z - HUB[t].z) < 0.7)
    if (o.isMesh && nearHub && boxYs.some((y) => Math.abs(o.position.y - y) < 1e-6)) hubBoxes.push(o)
  })
  let hubModel = false
  loadHub?.()
    .then((model) => {
      for (const team of ['blue', 'red']) {
        const h = HUB[team]
        const hub = model.clone(true)
        hub.traverse((o) => {
          if (!o.isMesh) return
          o.castShadow = true
          o.receiveShadow = true
          const box = new THREE.Box3().setFromObject(o)
          o.material = box.min.y > 1.3 ? hubRims[team] : mat(0x3a3f47, { metalness: 0.5, roughness: 0.5 })
        })
        hub.position.set(h.x, 0, h.z)
        if (team === 'red') hub.rotation.y = Math.PI
        scene.add(hub)
      }
      for (const m of hubBoxes) m.visible = false
      hubModel = true
    })
    .catch(() => { /* keep the plain boxes */ })

  // ---- fuel
  const MAX_FUEL = 640
  const fuelMesh = new THREE.InstancedMesh(
    new THREE.SphereGeometry(FUEL.r, 14, 10),
    new THREE.MeshStandardMaterial({ color: pal.fuel, roughness: 0.55, emissive: pal.fuel, emissiveIntensity: 0.05 }),
    MAX_FUEL,
  )
  fuelMesh.castShadow = true
  fuelMesh.receiveShadow = true
  fuelMesh.frustumCulled = false
  scene.add(fuelMesh)

  // ---- robots, built when a sim is attached
  let robotViews = []
  const robotRoot = new THREE.Group()
  scene.add(robotRoot)
  const marker = new THREE.Mesh(
    new THREE.RingGeometry(0.62, 0.7, 48),
    new THREE.MeshBasicMaterial({ color: pal.gold, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
  )
  marker.rotation.x = -Math.PI / 2
  marker.position.y = 0.012
  scene.add(marker)

  // ---- floating "+1"s
  const popups = []
  const popupTex = {}
  const popupTexture = (text, color) => {
    const k = `${text}|${color}`
    if (!popupTex[k]) popupTex[k] = labelTexture(text, color, 64)
    return popupTex[k]
  }

  function attach(sim) {
    for (const v of robotViews) robotRoot.remove(v.group)
    robotViews = sim.robots.map((r) => {
      const v = buildRobot(r, teamColor(r.team), pal)
      robotRoot.add(v.group)
      return v
    })
    for (const p of popups) scene.remove(p.sprite)
    popups.length = 0
  }

  // ---- camera
  let camMode = 'driver'
  const camPos = new THREE.Vector3(-4, 6, FIELD.W / 2)
  const camLook = new THREE.Vector3(FIELD.L / 2, 0, FIELD.W / 2)
  const tmpPos = new THREE.Vector3()
  const tmpLook = new THREE.Vector3()

  function aimCamera(sim, dt, focus) {
    const r = focus
    if (camMode === 'broadcast' || !r) {
      const a = (sim?.clock || 0) * 0.04
      tmpPos.set(FIELD.L / 2 + Math.sin(a) * 4, 9.5, FIELD.W / 2 + 11)
      tmpLook.set(FIELD.L / 2, 0, FIELD.W / 2 - 0.5)
    } else if (camMode === 'chase') {
      const c = Math.cos(r.psi)
      const s = Math.sin(r.psi)
      tmpPos.set(r.x - c * 3.4, 2.6, r.z - s * 3.4)
      tmpLook.set(r.x + c * 2.5, 0.4, r.z + s * 2.5)
    } else if (camMode === 'overhead') {
      tmpPos.set(r.x - 2.2, 11, r.z)
      tmpLook.set(r.x + 0.8, 0, r.z)
    } else {
      // driver station: behind our wall, high, sliding a little with the robot
      const lookX = Math.min(Math.max(r.x + 3, 5), 12.5)
      tmpLook.set(lookX, 0, FIELD.W / 2 + (r.z - FIELD.W / 2) * 0.55)
      tmpPos.set(-3.6, 6.4, FIELD.W / 2 + (r.z - FIELD.W / 2) * 0.35)
    }
    const k = 1 - Math.exp(-dt * (camMode === 'chase' ? 8 : 4))
    camPos.lerp(tmpPos, k)
    camLook.lerp(tmpLook, k)
    camera.position.copy(camPos)
    camera.lookAt(camLook)
  }

  // ---- per-frame
  const m4 = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const p3 = new THREE.Vector3()
  const one = new THREE.Vector3(1, 1, 1)

  function render(sim, dt, { focus = null, snap = false } = {}) {
    // fuel
    let n = 0
    for (const b of sim.balls) {
      if (!b.alive || n >= MAX_FUEL) continue
      const t = b.body.translation()
      const r = b.body.rotation()
      m4.compose(p3.set(t.x, t.y, t.z), q.set(r.x, r.y, r.z, r.w), one)
      fuelMesh.setMatrixAt(n++, m4)
    }
    fuelMesh.count = n
    fuelMesh.instanceMatrix.needsUpdate = true

    // robots
    sim.robots.forEach((r, i) => {
      const v = robotViews[i]
      if (!v) return
      const t = r.body.translation()
      const rot = r.body.rotation()
      v.group.position.set(t.x, t.y - r.a.height / 2, t.z)
      v.group.quaternion.set(rot.x, rot.y, rot.z, rot.w)
      if (v.turret) v.turret.rotation.y = -(r.turretYaw - r.psi)
      if (v.fill) {
        const f = r.carry / r.a.capacity
        v.fill.scale.y = Math.max(0.001, f)
        v.fill.position.y = v.fillBase + (v.fillH * f) / 2
      }
    })
    const me = focus
    marker.visible = Boolean(me && me.isPlayer)
    if (me) marker.position.set(me.x, 0.012, me.z)

    // hub rims
    for (const team of ['blue', 'red']) {
      const on = sim.clock >= 0 && hubActive(sim.clock, team, sim.autoWinner)
      const peak = hubModel ? 0.55 : 1.8 // the model's funnel is a far bigger lit surface than the rim
      const target = on ? peak * (1 + Math.sin(performance.now() / 180) * 0.14) : 0.03
      hubRims[team].emissiveIntensity += (target - hubRims[team].emissiveIntensity) * Math.min(1, dt * 10)
    }

    // popups
    for (const e of sim.events) {
      const text = e.kind === 'climb' ? `L${e.level}` : e.active ? '+1' : '0'
      const color = e.kind === 'score' && !e.active ? pal.muted : e.team === 'blue' ? pal.blue : pal.red
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: popupTexture(text, color), transparent: true, depthWrite: false }))
      sprite.scale.set(0.6, 0.3, 1)
      sprite.position.set(e.x, e.y, e.z)
      scene.add(sprite)
      popups.push({ sprite, life: e.kind === 'climb' ? 2.5 : 0.9 })
    }
    sim.events.length = 0
    for (let i = popups.length - 1; i >= 0; i--) {
      const p = popups[i]
      p.life -= dt
      p.sprite.position.y += dt * 0.7
      p.sprite.material.opacity = Math.min(1, p.life * 2)
      if (p.life <= 0) {
        scene.remove(p.sprite)
        p.sprite.material.dispose()
        popups.splice(i, 1)
      }
    }

    aimCamera(sim, snap ? 10 : dt, me)
    renderer.render(scene, camera)
  }

  function resize(w, h, dpr) {
    renderer.setPixelRatio(dpr)
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.fov = w / h < 1.2 ? 62 : 50
    camera.updateProjectionMatrix()
  }

  /** Ground-plane point under a screen position (normalised device coords), or null. */
  const ray = new THREE.Raycaster()
  const ground = new THREE.Plane(UP, 0)
  const hit = new THREE.Vector3()
  function pick(ndcX, ndcY) {
    ray.setFromCamera({ x: ndcX, y: ndcY }, camera)
    return ray.ray.intersectPlane(ground, hit) ? { x: hit.x, z: hit.z } : null
  }

  /** The camera's forward and right along the floor, for camera-relative driving. */
  function basis() {
    const f = new THREE.Vector3()
    camera.getWorldDirection(f)
    f.y = 0
    if (f.lengthSq() < 1e-6) f.set(1, 0, 0)
    f.normalize()
    return { fx: f.x, fz: f.z, rx: -f.z, rz: f.x }
  }

  function setCamera(mode) { camMode = mode }

  function dispose() {
    renderer.dispose()
    scene.traverse((o) => {
      o.geometry?.dispose?.()
      const m = o.material
      if (Array.isArray(m)) m.forEach((x) => x.dispose())
      else m?.dispose?.()
    })
    for (const t of Object.values(popupTex)) t.dispose()
  }

  return { attach, render, resize, pick, basis, setCamera, dispose }
}

// ------------------------------------------------------------------ pieces
function buildRobot(r, color, pal) {
  const a = r.a
  const g = new THREE.Group()
  const m = (c, o = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.6, metalness: 0.2, ...o })
  const box = (w, h, d, material, x, y, z) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material)
    mesh.position.set(x, y, z)
    mesh.castShadow = true
    mesh.receiveShadow = true
    g.add(mesh)
    return mesh
  }
  const L = a.len
  const W = a.wid
  const bh = 0.14 // bumper height
  const by = 0.035 + bh / 2
  const bumper = m(color, { roughness: 0.85, metalness: 0 })
  const label = labelTexture(r.label, '#ffffff', 48, color.getStyle())
  const labelMat = new THREE.MeshStandardMaterial({ map: label, roughness: 0.85 })
  // bumpers: sides carry the number
  const t = 0.09
  box(L, bh, t, labelMat, 0, by, W / 2 - t / 2)
  box(L, bh, t, labelMat, 0, by, -W / 2 + t / 2)
  box(t, bh, W - 2 * t, bumper, L / 2 - t / 2, by, 0)
  box(t, bh, W - 2 * t, bumper, -L / 2 + t / 2, by, 0)
  // chassis
  const frame = m(0x2b2f36, { metalness: 0.6, roughness: 0.4 })
  const metal = m(0xaeb4bd, { metalness: 0.8, roughness: 0.3 })
  box(L - 2 * t, 0.06, W - 2 * t, frame, 0, 0.07, 0)
  // swerve modules
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.04, 14), m(0x111214, { roughness: 0.9 }))
    wheel.rotation.x = Math.PI / 2
    wheel.position.set(sx * (L / 2 - 0.17), 0.05, sz * (W / 2 - 0.17))
    g.add(wheel)
  }
  // intake roller on the front
  const roller = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, a.intake, 14), m(pal.gold, { roughness: 0.5 }))
  roller.rotation.x = Math.PI / 2
  roller.position.set(L / 2 + 0.05, 0.06, 0)
  roller.castShadow = true
  g.add(roller)

  const H = a.height
  const view = { group: g, turret: null, fill: null }
  const hopper = (w, d, x) => {
    // a see-through hopper with the fuel level showing
    const glass = new THREE.MeshStandardMaterial({ color: 0xcfe3ff, transparent: true, opacity: 0.18, roughness: 0.1, depthWrite: false })
    const hh = H - 0.2
    const shell = new THREE.Mesh(new THREE.BoxGeometry(w, hh, d), glass)
    shell.position.set(x, 0.1 + hh / 2, 0)
    g.add(shell)
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) box(0.03, hh, 0.03, metal, x + (sx * w) / 2, 0.1 + hh / 2, (sz * d) / 2)
    const fill = box(w - 0.04, hh, d - 0.04, m(pal.fuel, { roughness: 0.7 }), x, 0.1 + hh / 2, 0)
    view.fill = fill
    view.fillBase = 0.1
    view.fillH = hh
  }

  if (r.arch === 'turret') {
    hopper(L * 0.55, W * 0.7, -L * 0.12)
    const turret = new THREE.Group()
    turret.position.set(0, H - 0.08, 0)
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.08, 24), metal)
    base.castShadow = true
    turret.add(base)
    const hood = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.14, 0.26), m(0x1d2025))
    hood.position.set(0.08, 0.1, 0)
    hood.rotation.z = (28 * Math.PI) / 180
    hood.castShadow = true
    turret.add(hood)
    g.add(turret)
    view.turret = turret
  } else if (r.arch === 'trench') {
    hopper(L * 0.5, W * 0.72, -L * 0.1)
    const hood = box(0.26, 0.1, W * 0.6, m(0x1d2025), L * 0.2, H - 0.06, 0)
    hood.rotation.z = (30 * Math.PI) / 180
  } else if (r.arch === 'hopper') {
    hopper(L * 0.7, W * 0.78, -L * 0.04)
    const chute = box(0.18, 0.12, W * 0.7, m(0x1d2025), L * 0.33, H - 0.02, 0)
    chute.rotation.z = (40 * Math.PI) / 180
  } else {
    hopper(L * 0.36, W * 0.55, -L * 0.18)
    // armour plates and a climbing hook
    box(L * 0.8, 0.05, W - 2 * t, frame, 0, 0.18, 0)
    box(0.05, H - 0.12, 0.05, metal, -L * 0.05, (H - 0.12) / 2 + 0.06, W * 0.22)
    box(0.05, H - 0.12, 0.05, metal, -L * 0.05, (H - 0.12) / 2 + 0.06, -W * 0.22)
    box(0.22, 0.05, W * 0.5, metal, 0.04, H - 0.04, 0)
    const hood = box(0.2, 0.08, W * 0.4, m(0x1d2025), L * 0.18, 0.32, 0)
    hood.rotation.z = (30 * Math.PI) / 180
  }
  return view
}

function labelTexture(text, color, size, bg = null) {
  const c = document.createElement('canvas')
  c.width = size * 4
  c.height = size * 2
  const ctx = c.getContext('2d')
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height) }
  ctx.font = `700 ${size * 1.1}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  if (!bg) { ctx.lineWidth = size * 0.12; ctx.strokeStyle = 'rgba(0,0,0,0.65)'; ctx.strokeText(text, c.width / 2, c.height / 2) }
  ctx.fillStyle = color
  ctx.fillText(text, c.width / 2, c.height / 2)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

function carpetTexture(pal) {
  const s = 120 // px per metre
  const c = document.createElement('canvas')
  c.width = Math.round(FIELD.L * s / 2) * 2
  c.height = Math.round(FIELD.W * s / 2) * 2
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#2b2f35'
  ctx.fillRect(0, 0, c.width, c.height)
  // a faint weave
  ctx.globalAlpha = 0.05
  for (let i = 0; i < 9000; i++) {
    ctx.fillStyle = Math.random() < 0.5 ? '#000' : '#fff'
    ctx.fillRect(Math.random() * c.width, Math.random() * c.height, 2, 2)
  }
  ctx.globalAlpha = 1
  const X = (x) => x * s
  const Z = (z) => z * s
  // alliance zones, lightly tinted
  const zone = (x0, x1, color) => {
    ctx.fillStyle = color
    ctx.globalAlpha = 0.09
    ctx.fillRect(X(x0), 0, X(x1 - x0), c.height)
    ctx.globalAlpha = 1
  }
  zone(0, HUB.blue.x, pal.blue)
  zone(HUB.red.x, FIELD.L, pal.red)
  // tape
  const line = (x0, z0, x1, z1, color, w = 0.05) => {
    ctx.strokeStyle = color
    ctx.lineWidth = w * s
    ctx.beginPath()
    ctx.moveTo(X(x0), Z(z0))
    ctx.lineTo(X(x1), Z(z1))
    ctx.stroke()
  }
  line(FIELD.L / 2, 0, FIELD.L / 2, FIELD.W, '#e9ecef')
  const start = 3.978
  line(start, 0, start, FIELD.W, pal.blue)
  line(FIELD.L - start, 0, FIELD.L - start, FIELD.W, pal.red)
  line(HUB.blue.x, 0, HUB.blue.x, FIELD.W, pal.blue, 0.03)
  line(HUB.red.x, 0, HUB.red.x, FIELD.W, pal.red, 0.03)
  // climb zones in front of the towers
  for (const team of ['blue', 'red']) {
    const tw = TOWER[team]
    const sgn = team === 'blue' ? 1 : -1
    const x0 = tw.x + sgn * TOWER.zone.from
    const x1 = x0 + sgn * TOWER.zone.depth
    ctx.strokeStyle = team === 'blue' ? pal.blue : pal.red
    ctx.lineWidth = 0.04 * s
    ctx.setLineDash([0.15 * s, 0.1 * s])
    ctx.strokeRect(X(Math.min(x0, x1)), Z(tw.z - TOWER.zone.width / 2), X(Math.abs(x1 - x0)), Z(TOWER.zone.width))
    ctx.setLineDash([])
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  return tex
}
