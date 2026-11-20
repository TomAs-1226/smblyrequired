// Cycle Rush 3D — three.js view of a sim. It reads the Rapier bodies every frame
// and owns nothing about the rules.
//
// Models come in through `assets` (built by the page, so this file has no URLs):
//   assets.field()      → GLTF of public/arcade/field.glb (field-centred, right-handed)
//   assets.fuel()       → GLTF of public/arcade/fuel.glb (a unit sphere)
//   assets.robot(spec)  → { root, clips, rig } for one robot, a fresh copy each call
//   assets.environment  → something for metal to reflect
// Until each arrives a plain stand-in is drawn, so the game is playable at once.
//
// What is drawn that the physics does not hold as bodies:
//   the fuel a robot carries, piled in its hopper (robots.js gives the places),
//   a ball on its way in through the intake, the lean of a robot on a bump, and
//   the arc of the shot being lined up.
import * as THREE from 'three'
import { FIELD, FUEL, HUB, TOWER } from './config.js'
import { hubLive, rayField, groundAt, aimArc } from './sim.js'
import { hopperRim } from './robots.js'
import { createHopper } from './hopper.js'

const UP = new THREE.Vector3(0, 1, 0)
const CAMERAS = {
  // arm length, resting elevation (radians above the floor), how far ahead of the robot to look
  follow: { len: 5.6, elev: 0.6, ahead: 1.7 },
  chase: { len: 4.4, elev: 0.5, ahead: 1.4 },
}
const MAX_ELEV = 1.38
const AIM_COLOR = { ready: '#7be3a4', aiming: '#d9c68a', near: '#f06363', far: '#f06363' }

export function createScene(canvas, pal, assets) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.0
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(pal.void)
  scene.fog = new THREE.Fog(pal.void, 34, 80)
  // Metal is only ever what it reflects: without an environment every aluminium
  // part of a robot renders near black.
  try {
    scene.environment = assets.environment(renderer)
    scene.environmentIntensity = 0.6
  } catch (err) {
    console.warn('[arcade] environment', err)
  }

  const camera = new THREE.PerspectiveCamera(48, 2, 0.08, 220)

  // ---- light: arena lights from above, one of them casting the shadows
  scene.add(new THREE.HemisphereLight(0xe2ebff, 0x1b1e24, 0.75))
  const key = new THREE.DirectionalLight(0xfff3e0, 2.3)
  key.position.set(FIELD.L / 2 - 5, 16, FIELD.W / 2 - 7)
  key.target.position.set(FIELD.L / 2, 0, FIELD.W / 2)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  Object.assign(key.shadow.camera, { left: -11.5, right: 11.5, top: 8.5, bottom: -8.5, near: 1, far: 48 })
  key.shadow.bias = -0.0004
  key.shadow.normalBias = 0.02
  scene.add(key, key.target)
  const fill = new THREE.DirectionalLight(0x9db9ff, 0.7)
  fill.position.set(FIELD.L / 2 + 6, 9, FIELD.W / 2 + 9)
  fill.target.position.set(FIELD.L / 2, 0, FIELD.W / 2)
  scene.add(fill, fill.target)

  const blue = new THREE.Color(pal.blue)
  const red = new THREE.Color(pal.red)
  const teamColor = (t) => (t === 'blue' ? blue : red)

  // ---- the field: a stand-in carpet until the model arrives
  const standIn = new THREE.Group()
  const carpet = new THREE.Mesh(new THREE.PlaneGeometry(FIELD.L, FIELD.W), new THREE.MeshStandardMaterial({ color: 0x2b2f35, roughness: 0.95 }))
  carpet.rotation.x = -Math.PI / 2
  carpet.position.set(FIELD.L / 2, 0, FIELD.W / 2)
  carpet.receiveShadow = true
  standIn.add(carpet)
  for (const team of ['blue', 'red']) {
    const h = HUB[team]
    const box = new THREE.Mesh(new THREE.BoxGeometry(HUB.size, HUB.top, HUB.size), new THREE.MeshStandardMaterial({ color: teamColor(team), roughness: 0.6 }))
    box.position.set(h.x, HUB.top / 2, h.z)
    standIn.add(box)
  }
  scene.add(standIn)

  // Hub lights: the field model's diffusers glow in alliance colour while the hub counts.
  const hubGlow = { blue: [], red: [] }
  let fieldLoaded = false
  assets.field()
    .then((gltf) => {
      const wrapper = new THREE.Group()
      // The model's frame is the game's, moved to the middle of the field. No mirroring.
      wrapper.position.set(FIELD.L / 2, 0, FIELD.W / 2)
      const model = gltf.scene
      model.traverse((o) => {
        if (!o.isMesh) return
        o.castShadow = true
        o.receiveShadow = true
      })
      for (const team of ['blue', 'red']) {
        model.traverse((o) => {
          const n = o.userData?.name ?? o.name
          if (n !== `hub-${team}-diffuser`) return
          o.traverse((m) => {
            if (!m.isMesh) return
            const glow = new THREE.MeshStandardMaterial({ color: teamColor(team), emissive: teamColor(team), emissiveIntensity: 2, roughness: 0.5 })
            m.material = glow
            m.castShadow = false
            hubGlow[team].push(glow)
          })
        })
      }
      // The stands are scenery: dimmed, so the eye stays on the field.
      const stands = model.children[0]?.children?.[1]
      stands?.traverse((o) => {
        if (!o.isMesh) return
        o.material = o.material.clone()
        o.material.color.multiplyScalar(0.3)
        o.castShadow = false
      })
      wrapper.add(model)
      scene.add(wrapper)
      scene.remove(standIn)
      fieldLoaded = true
    })
    .catch((err) => console.warn('[arcade] field model', err))

  // Climb boxes in front of each tower, lit in the endgame.
  const climbBoxes = {}
  for (const team of ['blue', 'red']) {
    const tw = TOWER[team]
    const s = team === 'blue' ? 1 : -1
    const x0 = tw.x + s * TOWER.zone.from
    const x1 = x0 + s * TOWER.zone.depth
    const g = new THREE.PlaneGeometry(Math.abs(x1 - x0), TOWER.zone.width)
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: teamColor(team), transparent: true, opacity: 0, depthWrite: false }))
    m.rotation.x = -Math.PI / 2
    m.position.set((x0 + x1) / 2, 0.006, tw.z)
    scene.add(m)
    climbBoxes[team] = m
  }

  // ---- fuel: loose on the field, and aboard robots
  const MAX_FUEL = 700
  const MAX_CARRIED = 760
  const fuelMaterial = new THREE.MeshStandardMaterial({ color: pal.fuel, roughness: 0.6, map: foamTexture() })
  const fuelMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 18, 12), fuelMaterial, MAX_FUEL)
  const carriedMesh = new THREE.InstancedMesh(fuelMesh.geometry, fuelMaterial, MAX_CARRIED)
  for (const m of [fuelMesh, carriedMesh]) {
    m.castShadow = true
    m.receiveShadow = true
    m.frustumCulled = false
    m.count = 0
    scene.add(m)
  }
  let fuelModel = false
  assets.fuel()
    .then((gltf) => {
      let mesh = null
      gltf.scene.traverse((o) => { if (o.isMesh && !mesh) mesh = o })
      if (!mesh) return
      // The model's own colour and finish; its shape too, when it has the coordinates for the grain.
      fuelMaterial.color.copy(mesh.material.color)
      fuelMaterial.roughness = mesh.material.roughness ?? 0.6
      if (mesh.geometry.getAttribute('uv')) {
        const old = fuelMesh.geometry
        fuelMesh.geometry = mesh.geometry
        carriedMesh.geometry = mesh.geometry
        old.dispose()
      }
      fuelModel = true
    })
    .catch((err) => console.warn('[arcade] fuel model', err))

  // ---- robots
  // ---- hopper nets: a mesh pinned round the hopper's rim, pushed up by the pile under it
  const NET_U = 12
  const NET_V = 10
  const NET_CELL = 0.04 // m: one square of the mesh
  const netMap = netTexture()
  netMap.anisotropy = renderer.capabilities.getMaxAnisotropy()
  const netMaterial = new THREE.MeshBasicMaterial({ map: netMap, transparent: true, side: THREE.DoubleSide, depthWrite: false })

  function makeNet(spec) {
    if (spec.hopper.netMax == null) return null
    const geometry = new THREE.PlaneGeometry(1, 1, NET_U, NET_V)
    const uv = geometry.attributes.uv
    const rim = hopperRim(spec, 1)
    const along = new Float32Array(uv.count) // 0 at the board .. 1 at the open end
    const across = new Float32Array(uv.count) // -1 .. 1
    for (let n = 0; n < uv.count; n++) {
      const a = uv.getX(n)
      const b = uv.getY(n) * 2 - 1
      along[n] = a
      across[n] = b
      uv.setXY(n, (a * Math.abs(rim.x1 - rim.x0)) / NET_CELL, (b * rim.half) / NET_CELL)
    }
    const mesh = new THREE.Mesh(geometry, netMaterial)
    mesh.frustumCulled = false
    mesh.renderOrder = 2
    return { mesh, along, across }
  }

  /** Lay a robot's net over its pile: `pile` is x, y, z for each of `count` balls, in the robot's frame. */
  function drapeNet(r, v, pile, count) {
    const { mesh, along, across } = v.net
    const h = r.a.hopper
    const rim = hopperRim(r.a, r.intakeOut)
    const pos = mesh.geometry.attributes.position
    const reach = (FUEL.r + 0.012) ** 2
    for (let n = 0; n < pos.count; n++) {
      const a = along[n]
      const b = across[n]
      const x = rim.x0 + (rim.x1 - rim.x0) * a
      const z = b * rim.half
      let y = h.roof
      // The rim is where the net is tied down: nothing lifts it there.
      if (a > 1e-6 && a < 1 - 1e-6 && Math.abs(b) < 1 - 1e-6) {
        for (let k = 0; k < count * 3; k += 3) {
          if (pile[k + 1] + FUEL.r < y) continue
          const d2 = (pile[k] - x) ** 2 + (pile[k + 2] - z) ** 2
          if (d2 > 0.0196) continue
          // Over a ball the net sits on its crown; beside it, it slopes away.
          const top = pile[k + 1] + Math.sqrt(Math.max(0, reach - d2 * 0.42))
          if (top > y) y = top
        }
      }
      pos.setXYZ(n, x, y, z)
    }
    pos.needsUpdate = true
  }

  let robotViews = []
  let attachToken = 0
  const robotRoot = new THREE.Group()
  scene.add(robotRoot)
  const marker = new THREE.Mesh(
    new THREE.RingGeometry(0.68, 0.74, 56),
    new THREE.MeshBasicMaterial({ color: pal.gold, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }),
  )
  marker.rotation.x = -Math.PI / 2
  scene.add(marker)

  // The shot being lined up, drawn from the shooter to where it comes down.
  const ARC_N = 22
  const arcGeometry = new THREE.BufferGeometry()
  arcGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array((ARC_N + 1) * 3), 3))
  const arcMaterial = new THREE.LineBasicMaterial({ color: pal.gold, transparent: true, opacity: 0.85, depthWrite: false })
  const arc = new THREE.Line(arcGeometry, arcMaterial)
  arc.frustumCulled = false
  arc.visible = false
  scene.add(arc)

  const tagTex = new Map()
  const tagTexture = (text, color) => {
    const k = `${text}|${color}`
    if (!tagTex.has(k)) tagTex.set(k, labelTexture(text, color, 56))
    return tagTex.get(k)
  }

  function attach(sim) {
    const token = ++attachToken
    for (const v of robotViews) {
      robotRoot.remove(v.group)
      v.hopper.free()
    }
    robotViews = sim.robots.map((r) => {
      const group = new THREE.Group() // where the physics has the robot, turned to its heading
      const tilt = new THREE.Group() // its lean and height on whatever is under its wheels
      group.add(tilt)
      const spec = r.a
      // A stand-in the size of the robot until its model loads.
      const ph = new THREE.Mesh(
        new THREE.BoxGeometry(spec.len, spec.height, spec.wid),
        new THREE.MeshStandardMaterial({ color: teamColor(r.team), transparent: true, opacity: 0.55 }),
      )
      ph.position.y = spec.height / 2
      tilt.add(ph)
      const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tagTexture(spec.label, r.team === 'blue' ? pal.blue : pal.red), depthTest: false, transparent: true }))
      tag.scale.set(0.62, 0.31, 1)
      tag.position.y = spec.height + 0.5
      tag.renderOrder = 10
      group.add(tag)
      robotRoot.add(group)
      const xs = spec.modules.map((m) => m[0])
      const zs = spec.modules.map((m) => m[1])
      const view = {
        group, tilt, tag, model: null, rig: null,
        wheelbase: Math.max(0.2, Math.max(...xs) - Math.min(...xs)),
        track: Math.max(0.2, Math.max(...zs) - Math.min(...zs)),
        pitch: 0, roll: 0, lift: 0,
        incoming: [], // balls on their way in through the intake
        net: makeNet(spec),
        // The fuel on board: real balls, in a little world that rides with the robot.
        hopper: createHopper(sim.R, spec),
        pile: new Float32Array(spec.capacity * 3),
        lane: 0,
        was: null, // the robot's velocity last frame, for what its pile feels
      }
      assets.robot(spec)
        .then(({ root, rig }) => {
          if (token !== attachToken) return
          dressBumpers(root, spec, r.team, teamColor(r.team))
          root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
          tilt.add(root)
          tilt.remove(ph)
          if (view.net) {
            // The model's own net is a flat lid; ours takes its place.
            const lid = rig.joints?.[spec.net?.part]?.node
            if (lid) lid.visible = false
            tilt.add(view.net.mesh)
          }
          view.model = root
          view.rig = rig
        })
        .catch((err) => console.warn(`[arcade] robot ${spec.label}`, err))
      return view
    })
    for (const p of popups) scene.remove(p.sprite)
    popups.length = 0
    cam.snap = true
  }

  // ---- floating "+1"s
  const popups = []
  const popupTex = {}
  const popupTexture = (text, color) => {
    const k = `${text}|${color}`
    if (!popupTex[k]) popupTex[k] = labelTexture(text, color, 64)
    return popupTex[k]
  }

  // ---- camera
  // Follow keeps the field the same way up as the driver sees it and tracks the
  // robot. Its arm swings upward, never through things: over the alliance wall
  // when the robot backs up to it, over the hub when the robot is behind it.
  const cam = {
    mode: 'follow',
    focus: new THREE.Vector3(FIELD.L / 2, 0.5, FIELD.W / 2),
    elev: CAMERAS.follow.elev,
    dir: new THREE.Vector2(-1, 0), // from the robot back toward the camera, on the floor
    pos: new THREE.Vector3(-4, 6, FIELD.W / 2),
    look: new THREE.Vector3(FIELD.L / 2, 0, FIELD.W / 2),
    snap: true,
  }
  const tmpPos = new THREE.Vector3()
  const tmpLook = new THREE.Vector3()
  const tmpV2 = new THREE.Vector2()

  /**
   * The lowest elevation, from `rest` up, at which the camera sees the whole
   * robot: nothing between it and the robot's top, nor its wheels. Something
   * right over the robot (a trench roof it is driving under) does not count
   * for the wheels, or the camera would leap up for the half second it takes.
   */
  function clearElevation(sim, fx, fy, fz, dx, dz, len, rest) {
    for (let e = rest; e <= MAX_ELEV + 1e-6; e += 0.06) {
      const c = Math.cos(e)
      const sn = Math.sin(e)
      if (rayField(sim, fx, fy + 0.95, fz, dx * c, sn, dz * c, len, true) != null) continue
      const low = rayField(sim, fx, fy + 0.2, fz, dx * c, sn, dz * c, len, true)
      if (low == null || low < 1.3) return e
    }
    return MAX_ELEV
  }

  function aimCamera(sim, dt, r) {
    camera.up.copy(UP)
    const snap = cam.snap
    if (!r || cam.mode === 'broadcast') {
      const a = (sim?.clock || 0) * 0.04
      tmpPos.set(FIELD.L / 2 + Math.sin(a) * 4, 9.5, FIELD.W / 2 + 11)
      tmpLook.set(FIELD.L / 2, 0, FIELD.W / 2 - 0.5)
    } else if (cam.mode === 'top') {
      const s = r.team === 'blue' ? 1 : -1
      camera.up.set(s, 0, 0) // up the screen is up the field
      tmpPos.set(r.x, 11.5, r.z)
      tmpLook.set(r.x, 0, r.z)
    } else if (cam.mode === 'station') {
      // From the driver station: behind the alliance wall, high, the whole field in view.
      const s = r.team === 'blue' ? 1 : -1
      const wall = s > 0 ? 0 : FIELD.L
      tmpLook.set(wall + s * Math.min(Math.max(Math.abs(r.x - wall) + 3, 5), 12.5), 0, FIELD.W / 2 + (r.z - FIELD.W / 2) * 0.55)
      tmpPos.set(wall - s * 3.6, 6.4, FIELD.W / 2 + (r.z - FIELD.W / 2) * 0.35)
    } else {
      const set = CAMERAS[cam.mode] || CAMERAS.follow
      const s = r.team === 'blue' ? 1 : -1
      // Which way the arm points on the floor: fixed for follow, behind the robot for chase.
      if (cam.mode === 'chase') tmpV2.set(-Math.cos(r.psi), -Math.sin(r.psi))
      else tmpV2.set(-s, 0)
      if (snap) cam.dir.copy(tmpV2)
      else cam.dir.lerp(tmpV2, 1 - Math.exp(-dt * 5)).normalize()
      // Follow the robot closely, but not rigidly.
      tmpLook.set(r.x, r.y, r.z)
      if (snap) cam.focus.copy(tmpLook)
      else cam.focus.lerp(tmpLook, 1 - Math.exp(-dt * 12))
      const fy = cam.focus.y + 0.95
      const want = sim ? clearElevation(sim, cam.focus.x, cam.focus.y, cam.focus.z, cam.dir.x, cam.dir.y, set.len, set.elev) : set.elev
      // Rise quickly out of the way; settle back slowly, so a thin post does not make it bob.
      const k = want > cam.elev ? 9 : 1.4
      cam.elev = snap ? want : cam.elev + (want - cam.elev) * (1 - Math.exp(-dt * k))
      const c = Math.cos(cam.elev)
      tmpPos.set(cam.focus.x + cam.dir.x * c * set.len, fy + Math.sin(cam.elev) * set.len, cam.focus.z + cam.dir.y * c * set.len)
      // Look a little ahead of the robot; less so as the camera comes overhead.
      const ahead = set.ahead * Math.max(0, 1 - (cam.elev - set.elev) / (MAX_ELEV - set.elev))
      tmpLook.set(cam.focus.x - cam.dir.x * ahead, cam.focus.y + 0.4, cam.focus.z - cam.dir.y * ahead)
    }
    const direct = cam.mode === 'follow' || cam.mode === 'chase'
    if (snap || (direct && r)) {
      cam.pos.copy(tmpPos)
      cam.look.copy(tmpLook)
    } else {
      const k = 1 - Math.exp(-dt * 4)
      cam.pos.lerp(tmpPos, k)
      cam.look.lerp(tmpLook, k)
    }
    cam.snap = false
    camera.position.copy(cam.pos)
    camera.lookAt(cam.look)
  }

  // ---- per-frame
  const m4 = new THREE.Matrix4()
  const inv = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const qId = new THREE.Quaternion()
  const p3 = new THREE.Vector3()
  const p4 = new THREE.Vector3()
  const qTilt = new THREE.Quaternion()
  const qBall = new THREE.Quaternion()
  const scl = new THREE.Vector3(FUEL.r, FUEL.r, FUEL.r)

  function poseRobot(sim, r, v, dt) {
    const t = r.body.translation()
    const rot = r.body.rotation()
    v.group.quaternion.set(rot.x, rot.y, rot.z, rot.w)
    const k = 1 - Math.exp(-dt * 16)
    if (r.climb.state !== 'none') {
      // Hanging: the physics has the height; level out.
      v.group.position.set(t.x, t.y, t.z)
      v.pitch += (0 - v.pitch) * k
      v.roll += (0 - v.roll) * k
      v.lift += (0 - v.lift) * k
    } else {
      // On its wheels: lean and height from the ground under each module.
      v.group.position.set(t.x, 0, t.z)
      const c = Math.cos(r.psi)
      const s = Math.sin(r.psi)
      let front = 0, back = 0, left = 0, right = 0, nf = 0, nb = 0, nl = 0, nr = 0, sum = 0
      for (const [mx, mz] of r.a.modules) {
        const h = groundAt(sim, t.x + c * mx - s * mz, t.z + s * mx + c * mz)
        sum += h
        if (mx > 0) { front += h; nf++ } else { back += h; nb++ }
        if (mz > 0) { right += h; nr++ } else { left += h; nl++ }
      }
      const n = r.a.modules.length || 1
      const pitch = nf && nb ? Math.atan2(front / nf - back / nb, v.wheelbase) : 0
      const roll = nl && nr ? Math.atan2(right / nr - left / nl, v.track) : 0
      v.pitch += (pitch - v.pitch) * k
      v.roll += (roll - v.roll) * k
      v.lift += (sum / n - v.lift) * k
    }
    v.tilt.position.y = v.lift
    v.tilt.rotation.set(-v.roll, 0, v.pitch)
    if (v.rig) v.rig.update(r, dt)
  }

  /**
   * Keep a robot's pile to the fuel it holds, move it, and draw it (with any fuel
   * still on its way in through the intake). Returns the next free instance.
   */
  function drawCarried(r, v, dt, n) {
    const spec = r.a
    const hop = v.hopper
    v.tilt.updateWorldMatrix(true, false)
    const mw = v.tilt.matrixWorld
    const held = Math.min(spec.capacity, r.carry)
    // Fuel the intake has just taken is carried up to the hopper's mouth, then thrown in.
    while (v.incoming.length > held) v.incoming.shift()
    for (const b of v.incoming) {
      b.t += dt / 0.14
      if (b.t >= 1) hop.add(b.from.x, b.from.z)
    }
    v.incoming = v.incoming.filter((b) => b.t < 1)
    const want = held - v.incoming.length
    // Fuel that has been shot left through the feeder, lane by lane.
    const exits = spec.shot.exits
    while (hop.count() > want) hop.take(exits[v.lane++ % exits.length].z)
    // Fuel the robot simply has (its preload) is just there.
    if (hop.count() < want) hop.fill(want)

    // What the pile feels: the robot's acceleration and spin, in the robot's frame.
    let ax = 0
    let az = 0
    if (dt > 0 && v.was) {
      const c = Math.cos(r.psi)
      const s = Math.sin(r.psi)
      const wx = (r.vx - v.was.x) / dt
      const wz = (r.vz - v.was.z) / dt
      ax = wx * c + wz * s
      az = -wx * s + wz * c
    }
    v.was = { x: r.vx, z: r.vz }
    hop.step(r.intakeOut, ax, az, r.om, dt)

    qTilt.setFromRotationMatrix(mw)
    const pile = v.pile
    let count = 0
    hop.each((x, y, z, rot) => {
      if (count * 3 + 2 < pile.length) {
        pile[count * 3] = x
        pile[count * 3 + 1] = y
        pile[count * 3 + 2] = z
        count++
      }
      if (n >= MAX_CARRIED) return
      p3.set(x, y, z).applyMatrix4(mw)
      qBall.set(rot.x, rot.y, rot.z, rot.w).premultiply(qTilt)
      carriedMesh.setMatrixAt(n++, m4.compose(p3, qBall, scl))
    })
    for (let j = 0; j < v.incoming.length && n < MAX_CARRIED; j++) {
      const b = v.incoming[j]
      const e = hop.entry(b.from.x, b.from.z)
      const u = Math.min(1, b.t)
      p3.copy(b.from).lerp(p4.set(e.x, e.y, e.z), u * u * (3 - 2 * u))
      p3.applyMatrix4(mw)
      carriedMesh.setMatrixAt(n++, m4.compose(p3, qId, scl))
    }
    if (v.net && v.model) drapeNet(r, v, pile, count)
    return n
  }

  function render(sim, dt, { focus = null } = {}) {
    // loose fuel
    let n = 0
    for (const b of sim.balls) {
      if (!b.alive || n >= MAX_FUEL) continue
      const t = b.body.translation()
      const r = b.body.rotation()
      m4.compose(p3.set(t.x, t.y, t.z), q.set(r.x, r.y, r.z, r.w), scl)
      fuelMesh.setMatrixAt(n++, m4)
    }
    fuelMesh.count = n
    fuelMesh.instanceMatrix.needsUpdate = true

    // robots, their mechanisms, and what they carry
    sim.robots.forEach((r, i) => { if (robotViews[i]) poseRobot(sim, r, robotViews[i], dt) })

    // what happened since the last frame
    for (const e of sim.events) {
      if (e.kind === 'intake') {
        const v = robotViews[e.robot]
        if (!v || v.incoming.length > 14) continue
        v.tilt.updateWorldMatrix(true, false)
        inv.copy(v.tilt.matrixWorld).invert()
        v.incoming.push({ from: new THREE.Vector3(e.x, e.y, e.z).applyMatrix4(inv), t: 0 })
        continue
      }
      const text = e.kind === 'climb' ? `L${e.level}` : e.active ? '+1' : '0'
      const color = e.kind === 'score' && !e.active ? pal.muted : e.team === 'blue' ? pal.blue : pal.red
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: popupTexture(text, color), transparent: true, depthWrite: false }))
      sprite.scale.set(0.6, 0.3, 1)
      sprite.position.set(e.x, e.y, e.z)
      scene.add(sprite)
      popups.push({ sprite, life: e.kind === 'climb' ? 2.5 : 0.9 })
    }
    sim.events.length = 0

    let c = 0
    sim.robots.forEach((r, i) => { if (robotViews[i]) c = drawCarried(r, robotViews[i], dt, c) })
    carriedMesh.count = c
    carriedMesh.instanceMatrix.needsUpdate = true

    const me = focus
    marker.visible = Boolean(me && me.isPlayer)
    if (me) marker.position.set(me.x, groundAt(sim, me.x, me.z) + 0.014, me.z)
    for (const v of robotViews) v.tag.visible = cam.mode !== 'top'

    // the shot being lined up
    const aim = me?.aim
    if (aim?.sol && aim.state !== 'home') {
      const pts = aimArc(aim, ARC_N)
      const pos = arcGeometry.getAttribute('position')
      for (let i = 0; i <= ARC_N; i++) {
        const p = pts[Math.min(i, pts.length - 1)]
        pos.setXYZ(i, p.x, p.y, p.z)
      }
      pos.needsUpdate = true
      arcMaterial.color.set(AIM_COLOR[aim.state] || pal.gold)
      arc.visible = true
    } else {
      arc.visible = false
    }

    // hub lights and climb boxes
    for (const team of ['blue', 'red']) {
      const on = hubLive(sim, team)
      const target = on ? 2.2 * (1 + Math.sin(performance.now() / 180) * 0.12) : 0.04
      for (const g of hubGlow[team]) g.emissiveIntensity += (target - g.emissiveIntensity) * Math.min(1, dt * 10)
      const show = sim.period === 'endgame' ? 0.22 + 0.12 * Math.sin(performance.now() / 250) : 0
      climbBoxes[team].material.opacity += (show - climbBoxes[team].material.opacity) * Math.min(1, dt * 6)
    }

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

    aimCamera(sim, dt, me)
    renderer.render(scene, camera)
  }

  function resize(w, h, dpr) {
    renderer.setPixelRatio(dpr)
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.fov = w / h < 1.2 ? 60 : 48
    camera.updateProjectionMatrix()
  }

  /** The camera's forward and right along the floor, for camera-relative driving. */
  const fwd = new THREE.Vector3()
  function basis() {
    camera.getWorldDirection(fwd)
    fwd.y = 0
    // Looking straight down: forward is the top of the screen.
    if (fwd.lengthSq() < 1e-4) fwd.copy(camera.up).setY(0)
    if (fwd.lengthSq() < 1e-6) fwd.set(1, 0, 0)
    fwd.normalize()
    return { fx: fwd.x, fz: fwd.z, rx: -fwd.z, rz: fwd.x }
  }

  function setCamera(mode) {
    cam.mode = mode
    cam.snap = true
  }

  /** For the page's checks: what has loaded, each robot's rig, where the camera is. */
  function status() {
    return {
      fieldLoaded,
      fuelModel,
      loose: fuelMesh.count,
      carried: carriedMesh.count,
      camera: { mode: cam.mode, elev: cam.elev, x: camera.position.x, y: camera.position.y, z: camera.position.z },
      robots: robotViews.map((v) => ({
        loaded: Boolean(v.model), rig: v.rig?.kind ?? null, deploy: v.rig?.deploy?.map((d) => d.name) ?? [],
        pitch: v.pitch, roll: v.roll, lift: v.lift, incoming: v.incoming.length,
      })),
    }
  }

  /** One frame from a camera placed by hand: for looking a robot over, not for play. */
  function inspect(from, at) {
    camera.up.set(0, 1, 0)
    camera.position.set(from[0], from[1], from[2])
    camera.lookAt(at[0], at[1], at[2])
    renderer.render(scene, camera)
  }

  function dispose() {
    attachToken++
    for (const v of robotViews) v.hopper.free()
    robotViews = []
    renderer.dispose()
    scene.traverse((o) => {
      o.geometry?.dispose?.()
      const m = o.material
      if (Array.isArray(m)) m.forEach((x) => x.dispose())
      else m?.dispose?.()
    })
    scene.environment?.dispose?.()
    fuelMaterial.map?.dispose()
    netMap.dispose()
    netMaterial.dispose()
    for (const t of Object.values(popupTex)) t.dispose()
    for (const t of tagTex.values()) t.dispose()
  }

  return { attach, render, resize, basis, setCamera, status, inspect, dispose, robotViews: () => robotViews }
}

// ------------------------------------------------------------------ pieces
/** Bumpers in the alliance's colour: the imported models' `bumpers:cloth`, or new ones for Numbers. */
function dressBumpers(root, spec, team, color) {
  const cloth = spec.cloth?.[team] ? new THREE.Color(spec.cloth[team]) : color
  let found = false
  root.traverse((o) => {
    const n = o.userData?.name ?? o.name
    if (n !== 'bumpers:cloth') return
    o.traverse((m) => {
      if (!m.isMesh) return
      m.material = m.material.clone()
      m.material.color.copy(cloth)
      found = true
    })
  })
  if (found || spec.source !== 'numbers') return
  // Numbers' CAD has no bumpers: a ring of them around its frame, numbered.
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.85 })
  const t = 0.0825
  const h = spec.bumper.top - spec.bumper.bottom
  const y = spec.bumper.bottom + h / 2
  const L = spec.len
  const W = spec.wid
  const label = new THREE.MeshStandardMaterial({ map: labelTexture('5805', '#ffffff', 48, color.getStyle()), roughness: 0.85 })
  for (const [w, d, x, z, m] of [
    [L, t, 0, W / 2 - t / 2, label],
    [L, t, 0, -W / 2 + t / 2, label],
    [t, W - 2 * t, L / 2 - t / 2, 0, mat],
    [t, W - 2 * t, -L / 2 + t / 2, 0, mat],
  ]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m)
    b.position.set(x, y, z)
    root.add(b)
  }
}

/**
 * Foam, to multiply into the fuel's colour: an even, faint grain and nothing
 * else. A seam or a line reads as a cross on every ball at the size they are drawn.
 */
function foamTexture() {
  const W = 256
  const H = 128
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, W, H)
  let seed = 7
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
  for (let i = 0; i < 520; i++) {
    const x = rnd() * W
    const y = rnd() * H
    const r = 1.5 + rnd() * 2.5
    // Wrapped across the join so the grain has no edge either.
    for (const ox of [x, x - W, x + W]) {
      const dot = g.createRadialGradient(ox, y, 0, ox, y, r)
      dot.addColorStop(0, 'rgba(150, 110, 20, 0.1)')
      dot.addColorStop(1, 'rgba(150, 110, 20, 0)')
      g.fillStyle = dot
      g.fillRect(ox - r, y - r, r * 2, r * 2)
    }
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = THREE.RepeatWrapping
  return t
}

/** One square of a knotless net: a cord along two edges, so the tile repeats into a mesh. */
function netTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')
  g.clearRect(0, 0, 64, 64)
  // A faint veil, so the net reads as a surface across the top of an empty hopper
  // and not as a pattern on its floor; pale cord with a dark core shows against
  // a dark hopper and against fuel alike.
  g.fillStyle = 'rgba(190, 196, 206, 0.07)'
  g.fillRect(0, 0, 64, 64)
  g.fillStyle = 'rgba(214, 219, 228, 0.9)'
  g.fillRect(0, 0, 64, 10)
  g.fillRect(0, 0, 10, 64)
  g.fillStyle = 'rgba(22, 24, 28, 0.95)'
  g.fillRect(0, 3, 64, 4)
  g.fillRect(3, 0, 4, 64)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  return t
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
