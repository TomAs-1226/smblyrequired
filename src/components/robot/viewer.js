import * as THREE from 'three'
import { createStudio, blob, REFLECT, modelLoader } from './robotRig'
import { buildDrivebase, X1 } from './drivebase'

/* A robot on a turntable, for the Robots pages. Framework-free like the spine: React hands it a canvas
 * and gets back dispose().
 *
 * It turns slowly on its own. Drag sideways and it follows the pointer one to one, keeps the flick's
 * momentum when let go, and picks its slow turn back up a moment later; drag up or down and it tilts,
 * then settles back to the rest angle. Vertical swipes on a phone still scroll the page (touch-action:
 * pan-y on the canvas). It renders only while on screen, and not at all once it has stopped moving.
 *
 *   model: { file: 'genesis.glb' }   a display bake (tools/display-cad.mjs), materials named by class
 *          { kind: 'drivebase' }     Catalyst X1, built like Catalyst Console builds it
 */

const REST_EL = 0.42 // radians above the horizon
const EL_MIN = 0.08
const EL_MAX = 1.1
const SPIN = 0.16 // rad/s, the idle turn
const RESUME_S = 2.2 // after a drag, how long before the idle turn comes back
const DRAG = 0.0085 // rad per px

const glbCache = new Map()
function loadGlb(url, onProgress) {
  if (!glbCache.has(url)) {
    glbCache.set(url, modelLoader().loadAsync(url, (e) => e.total && onProgress?.(e.loaded / e.total)))
  }
  return glbCache.get(url).then((g) => g.scene.clone(true))
}

/* Restyle a baked model by material class (see REFLECT): clear polycarbonate, black tread, and how much
   of the studio each surface reflects. */
function restyle(root, glassy) {
  const done = new Map()
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return
    const src = o.material
    if (!done.has(src.uuid)) {
      let m = src.clone()
      const name = (src.name || '').toLowerCase()
      if (name.includes('poly')) {
        m = glassy
          ? new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0, roughness: 0.01, transmission: 1, thickness: 0, ior: 1.585, specularIntensity: 0.55, side: THREE.DoubleSide })
          : new THREE.MeshStandardMaterial({ color: 0xeef2f8, metalness: 0, roughness: 0.08, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide })
        m.polygonOffset = true
        m.polygonOffsetFactor = 1
        m.polygonOffsetUnits = 1
      }
      if (name.includes('tread')) { m.color.set(0x161719); m.roughness = 0.92; m.metalness = 0 }
      m.envMapIntensity = REFLECT[name] ?? REFLECT[Object.keys(REFLECT).find((k) => name.includes(k))] ?? 0.6
      m.dithering = true
      done.set(src.uuid, m)
    }
    o.material = done.get(src.uuid)
  })
}

export function createViewer({ canvas, models, model, onProgress, onReady, onError, onInteract, glassy = true, reduced = false, az = 0.7 }) {
  const { renderer, scene, camera } = createStudio(canvas, { fov: 26 })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75))
  const turntable = new THREE.Group()
  scene.add(turntable)
  let disposed = false
  let ready = false
  /* Loop state first: adopt() and fit() wake the loop before the rest of this function has run. */
  let visible = false
  let raf = 0
  let prev = 0
  let still = 0
  let frame = { centre: new THREE.Vector3(0, 0.4, 0), radius: 0.8 }
  let modules = []

  const view = { yaw: az, el: REST_EL, vYaw: 0, idle: reduced ? 0 : SPIN, since: 99, dragging: false }
  let drive = 0 // X1's demo clock

  function adopt(root) {
    turntable.add(root)
    root.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(root)
    const sphere = box.getBoundingSphere(new THREE.Sphere())
    frame = { centre: new THREE.Vector3(0, (box.min.y + box.max.y) * 0.45, 0), radius: sphere.radius, height: box.max.y }
    const foot = Math.max(box.max.x - box.min.x, box.max.z - box.min.z)
    blob(scene, foot * 1.9, 0.7)
    renderer.compile(scene, camera)
    ready = true
    onReady?.()
    wake()
  }

  if (model?.kind === 'drivebase') {
    const db = buildDrivebase(X1)
    modules = db.modules
    adopt(db.group)
  } else if (model?.file) {
    loadGlb(`${models}${model.file}`, onProgress)
      .then((root) => {
        if (disposed) return
        restyle(root, glassy)
        adopt(root)
      })
      .catch((e) => { console.warn('robot viewer: no model', e); onError?.(e) })
  }

  /* ── sizing and framing ─────────────────────────────────────────────── */
  let W = 1
  let H = 1
  function fit() {
    const r = canvas.getBoundingClientRect()
    W = Math.max(1, Math.round(r.width))
    H = Math.max(1, Math.round(r.height))
    renderer.setSize(W, H, false)
    camera.aspect = W / H
    camera.updateProjectionMatrix()
    wake()
  }
  const ro = new ResizeObserver(fit)
  ro.observe(canvas)
  fit()

  function place() {
    const tan = Math.tan((camera.fov * Math.PI) / 360)
    const d = Math.max(frame.radius / tan, frame.radius / (tan * camera.aspect)) * 0.95
    const c = frame.centre
    camera.position.set(c.x + d * Math.cos(view.el) * Math.sin(0), c.y + d * Math.sin(view.el), c.z + d * Math.cos(view.el))
    camera.lookAt(c)
    turntable.rotation.y = view.yaw
  }

  /* ── input ───────────────────────────────────────────────────────────── */
  let last = null
  let samples = []
  function down(e) {
    if (e.button !== undefined && e.button !== 0) return
    view.dragging = true
    last = { x: e.clientX, y: e.clientY, t: performance.now() }
    samples = []
    canvas.setPointerCapture?.(e.pointerId)
    onInteract?.()
    wake()
  }
  function move(e) {
    if (!view.dragging || !last) return
    const now = performance.now()
    const dx = e.clientX - last.x
    const dy = e.clientY - last.y
    view.yaw += dx * DRAG
    view.el = Math.min(EL_MAX, Math.max(EL_MIN, view.el + dy * DRAG * 0.6))
    samples.push({ t: now, dx })
    samples = samples.filter((s) => now - s.t < 100)
    last = { x: e.clientX, y: e.clientY, t: now }
    wake()
  }
  function up() {
    if (!view.dragging) return
    view.dragging = false
    /* The flick's speed over the last 100 ms carries on and decays. */
    const span = samples.length > 1 ? samples[samples.length - 1].t - samples[0].t : 0
    const px = samples.reduce((a, s) => a + s.dx, 0)
    view.vYaw = span > 8 ? Math.max(-9, Math.min(9, (px * DRAG) / (span / 1000))) : 0
    view.since = 0
    wake()
  }
  canvas.addEventListener('pointerdown', down)
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)

  /* ── the loop ───────────────────────────────────────────────────────── */
  const io = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting
    if (visible) wake()
  })
  io.observe(canvas)

  function wake() {
    still = 0
    if (!raf && visible && !disposed) {
      prev = performance.now()
      raf = requestAnimationFrame(tick)
    }
  }

  function tick(now) {
    raf = 0
    if (disposed || !visible) return
    const dt = Math.min(0.05, (now - prev) / 1000)
    prev = now
    let moving = view.dragging

    if (!view.dragging) {
      view.since += dt
      /* Momentum decays over about a third of a second; the idle turn eases back in after it. */
      view.vYaw *= Math.exp(-dt / 0.32)
      const resume = reduced ? 0 : SPIN * Math.min(1, Math.max(0, (view.since - RESUME_S) / 1.2))
      view.idle = resume
      view.yaw += (view.vYaw + view.idle) * dt
      /* Tilt settles back to rest, critically damped. */
      const k = 1 - Math.exp(-dt / 0.28)
      view.el += (REST_EL - view.el) * k
      moving = Math.abs(view.vYaw) > 0.002 || view.idle > 0 || Math.abs(view.el - REST_EL) > 0.0005
    }

    /* X1 exercises its modules the way a drivebase on a bench does: steer through a slow sweep, wheels
       turning, each module on the same heading (a crab walk) and every so often turning in place. */
    if (modules.length && !reduced) {
      drive += dt
      const phase = (drive % 12) / 12
      const turning = phase > 0.62 && phase < 0.9
      for (const m of modules) {
        const crab = Math.sin(drive * 0.5) * 0.9
        const spinA = Math.atan2(-m.x, -m.z) // rolling square to the line from the centre: turning in place
        const want = turning ? spinA : crab
        let cur = m.steer.rotation.y
        let d = want - cur
        d = Math.atan2(Math.sin(d), Math.cos(d))
        if (Math.abs(d) > Math.PI / 2) d -= Math.sign(d) * Math.PI // a module never turns past 90°
        m.steer.rotation.y = cur + d * (1 - Math.exp(-dt / 0.18))
        m.wheel.rotation.z -= dt * 7
      }
      moving = true
    }

    if (ready) {
      place()
      renderer.render(scene, camera)
    }
    if (moving || !ready) still = 0
    else still += 1
    if (still < 3) raf = requestAnimationFrame(tick)
  }

  return function dispose() {
    disposed = true
    cancelAnimationFrame(raf)
    io.disconnect()
    ro.disconnect()
    canvas.removeEventListener('pointerdown', down)
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
    scene.traverse((o) => {
      if (o.isMesh) {
        o.geometry?.dispose?.()
        for (const m of [].concat(o.material)) { m?.map?.dispose?.(); m?.normalMap?.dispose?.(); m?.dispose?.() }
      }
    })
    renderer.dispose()
    renderer.forceContextLoss?.()
  }
}
