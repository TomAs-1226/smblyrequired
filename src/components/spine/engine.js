// The landing page's 3D spine: one robot on a sticky stage, choreographed by the panels scrolling past.
//
// Framework-free on purpose. Spine.jsx renders the markup — panels carrying `data-shot`, specs
// carrying `data-anchor` — and hands the DOM to createSpine(), which reads it, drives the canvas and
// the callouts every frame, and returns dispose(). Nothing here re-renders through React; a scroll
// frame touching component state would re-render the page sixty times a second.
//
// The choreography is data (shots.js); the copy is data (src/data/spine.js).

import * as THREE from 'three'
import { createStudio, blob, loadRobot, loadHub, rigRobot, profiled, lag } from '../robot/robotRig'
import {
  SHOTS, GROUPS, groupOfNode, LAYERS, REMOVE_W, REMOVE_ORDER, ANCHORS,
  ROUTINE, ROUTINE_LOOP, HEADING, HUB_AT, FUEL_START, FUEL_ROWS, SHOT_SPOTS,
} from './shots'
import { createAutonomy } from './autonomy'

const SVG = 'http://www.w3.org/2000/svg'
const FOV = 30
const TAN = Math.tan((FOV * Math.PI) / 360)
/* 40 gap + the widest label (~210) + 24 margin, with room to spare. */
const LABEL_COL = 280

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const smooth = (t) => t * t * (3 - 2 * t)
const lerp = (a, b, t) => a + (b - a) * t

/**
 * Start the spine.
 *
 * root     the scrolling section; its `[data-shot]` panels name shots, their `.box` is the copy, and
 *          their `[data-anchor]` specs become callouts (`b` the name, `span` the value)
 * canvas   the stage canvas
 * overlay  the element callouts are placed in; `hair` the SVG their hairlines are drawn in
 * title    the title card, faded and lifted as the first shot hands over
 * classes  CSS class names for the generated callouts: { callout }
 * models   where robot.glb, robot.json and hub.glb are served from
 */
export function createSpine({ root, canvas, overlay, hair, title, classes, models }) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const narrowMQ = matchMedia('(max-width: 1024px)')
  let disposed = false
  const cleanups = []
  const listen = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts)
    cleanups.push(() => target.removeEventListener(type, fn, opts))
  }

  /* ── renderer, studio, rig ─────────────────────────────────────────── */
  const { renderer, scene, camera } = createStudio(canvas, { fov: FOV })
  const rig = new THREE.Group()
  scene.add(rig)

  /* ── panels and callouts, from the markup ──────────────────────────── */
  const panels = [...root.querySelectorAll('[data-shot]')].map((el) => ({
    el,
    box: el.querySelector('[data-box]'),
    shot: SHOTS[el.dataset.shot],
    name: el.dataset.shot,
    specs: [...el.querySelectorAll('[data-anchor]')].map((s) => ({
      anchor: s.dataset.anchor, name: s.querySelector('b').textContent, value: s.querySelector('span').textContent,
    })),
  }))
  const callouts = []
  panels.forEach((p, pi) => p.specs.forEach((s) => {
    const el = document.createElement('div')
    el.className = classes.callout
    el.setAttribute('aria-hidden', 'true') // the same words are in the panel's own list
    el.innerHTML = '<small></small><b></b>'
    el.firstChild.textContent = s.name
    el.lastChild.textContent = s.value
    overlay.appendChild(el)
    const line = document.createElementNS(SVG, 'line')
    const dot = document.createElementNS(SVG, 'circle')
    dot.setAttribute('r', '2.5')
    line.style.opacity = dot.style.opacity = 0
    hair.append(line, dot)
    callouts.push({ pi, anchor: s.anchor, el, line, dot, w: 0, h: 0, side: null, x: 0, y: 0, live: false })
  }))
  cleanups.push(() => callouts.forEach((c) => { c.el.remove(); c.line.remove(); c.dot.remove() }))
  /* A label's side is chosen from its width, so a re-measure (the web font arriving, a resize) lets
     every label choose again. */
  const measureCallouts = () => { for (const c of callouts) { c.w = c.el.offsetWidth; c.h = c.el.offsetHeight; c.side = null } }

  /* ── sizing ────────────────────────────────────────────────────────── */
  let W = 1
  let H = 1
  let copyEdges = [] // per panel: the copy box's left/right in canvas px
  const measureCopy = () => {
    const col = canvas.getBoundingClientRect()
    copyEdges = panels.map((p) => {
      if (!p.box) return null
      const r = p.box.getBoundingClientRect()
      return { left: r.left - col.left, right: r.right - col.left }
    })
  }
  const resize = () => {
    const r = canvas.getBoundingClientRect()
    if (!r.width) return
    W = r.width
    H = r.height
    renderer.setPixelRatio(Math.min(devicePixelRatio, narrowMQ.matches ? 1.5 : 2))
    renderer.setSize(W, H, false)
    camera.aspect = W / H
    camera.updateProjectionMatrix()
    measureCallouts()
    measureCopy()
  }
  listen(window, 'resize', resize)
  resize()
  document.fonts?.ready.then(() => { if (!disposed) { measureCallouts(); measureCopy() } })

  /* Drag to turn — it is an object, not a video. It eases home when let go, so a composed shot is
     never left wherever a drag happened to stop. */
  let spinUser = 0
  let spinVel = 0
  let dragging = false
  let lastX = 0
  listen(canvas, 'pointerdown', (e) => {
    dragging = true
    lastX = e.clientX
    canvas.dataset.dragging = 'true'
    try { canvas.setPointerCapture(e.pointerId) } catch { /* not capturable; drag still works */ }
  })
  listen(canvas, 'pointermove', (e) => {
    if (!dragging) return
    const dx = e.clientX - lastX
    lastX = e.clientX
    spinUser += dx * 0.006
    spinVel = dx * 0.006
  })
  const endDrag = () => { dragging = false; delete canvas.dataset.dragging }
  listen(canvas, 'pointerup', endDrag)
  listen(canvas, 'pointercancel', endDrag)

  /* ── the model ─────────────────────────────────────────────────────── */
  let robot = null // the shared rig (robotRig.js), once loaded
  let top = null
  let ready = false
  let manifest = null
  const moving = []
  const anchors = {}
  let groupMats = {}
  let groupNodes = {}
  let hoodNode = null
  let intakeNode = null
  let intakeAxis = null
  let ending = null
  /* Phones get the cheaper polycarbonate: the transmission pass draws the opaque scene a second time. */
  const glassy = !narrowMQ.matches

  function adopt(root, man) {
    manifest = man
    rig.add(root)
    robot = rigRobot(root, man, { glassy, groupOf: groupOfNode })
    ;({ top, hoodNode, intakeNode, intakeAxis } = robot)
    groupMats = Object.fromEntries(GROUPS.map((g) => [g, robot.groupMats[g] ?? []]))
    groupNodes = Object.fromEntries(GROUPS.map((g) => [g, robot.groupNodes[g] ?? []]))

    root.updateMatrixWorld(true)
    for (const [name, L] of Object.entries(LAYERS)) {
      const n = root.getObjectByName(name)
      if (n) moving.push({ n, home: n.position.clone(), dir: new THREE.Vector3(...L.dir), d: L.d, at: L.at, off: new THREE.Vector3() })
    }
    /* Each anchor is two points. `live` rides on its node, so the hairline ends on the part wherever
       it moves. `rest` is the same point with only the teardown applied — no hood swing, no deploy,
       no steering — and the labels are laid out from that, so the words hold still while the
       mechanism moves under them. */
    for (const [k, [node, p]] of Object.entries(ANCHORS)) {
      const n = root.getObjectByName(node)
      if (!n) continue
      const live = new THREE.Object3D()
      live.position.copy(n.worldToLocal(new THREE.Vector3(...p)))
      n.add(live)
      anchors[k] = { live, mover: moving.find((q) => q.n === n), home: n.position.clone(), local: new THREE.Vector3(...p).sub(n.position) }
    }
    ending = createAutonomy({ scene, manifest, hubAt: HUB_AT, spots: FUEL_START, rows: FUEL_ROWS, shots: SHOT_SPOTS })
    /* Compile every shader now, not on the first frame that needs it. */
    renderer.compile(scene, camera)
    ready = true
  }

  loadRobot(models)
    .then(({ root, manifest: man }) => { if (!disposed) adopt(root, man) })
    .catch((e) => console.error('spine: the robot did not load', e))

  /* ── the HUB, contact shadows and FUEL ─────────────────────────────── */
  let hub = null
  loadHub(models).then((h) => {
    if (disposed) return
    hub = h
    hub.visible = false
    scene.add(hub)
  }).catch((e) => console.warn('spine: no HUB, so the ending shoots at nothing', e))
  const shadow = blob(scene, 1.35, 0.75)
  const hubShadow = blob(scene, 2.1, 0.6)
  hubShadow.visible = false

  /* The shot solver, said out loud: one live callout while the robot aims and fires. */
  const solverEl = document.createElement('div')
  solverEl.className = classes.callout
  solverEl.setAttribute('aria-hidden', 'true')
  solverEl.innerHTML = '<small>Shot solver</small><b></b>'
  overlay.appendChild(solverEl)
  const solverLine = document.createElementNS(SVG, 'line')
  const solverDot = document.createElementNS(SVG, 'circle')
  solverDot.setAttribute('r', '2.5')
  solverLine.style.opacity = solverDot.style.opacity = 0
  hair.append(solverLine, solverDot)
  cleanups.push(() => { solverEl.remove(); solverLine.remove(); solverDot.remove() })
  const hoodTip = new THREE.Vector3()

  /* ── scroll → shot ─────────────────────────────────────────────────── */
  /* The reading line: mid-screen on desktop, just under the robot band on a phone. A panel's shot is
     fully in place when the panel's key point is on that line — its middle on desktop, its top on a
     phone so the heading is the first thing read under the robot. Between two, the move holds for the
     first and last fifth so the copy is read against a still robot. */
  const readingLine = () => (narrowMQ.matches ? canvas.getBoundingClientRect().height + 12 : innerHeight / 2)
  const panelKey = (r) => (narrowMQ.matches ? r.top : r.top + r.height / 2)
  function scrollShot() {
    const line = readingLine()
    const keys = panels.map((p) => panelKey(p.el.getBoundingClientRect()))
    if (line <= keys[0]) return 0
    for (let i = 0; i < keys.length - 1; i++) if (line < keys[i + 1]) return i + (line - keys[i]) / (keys[i + 1] - keys[i])
    return keys.length - 1
  }

  /* What a shot means on this screen: where the subject's centre goes and how far the camera must be
     for it to fill its share of the free region. The region is what is left after the copy box
     (measured, not assumed) and, in a shot with callouts, a label column each side of the robot.
     Under 1200 px only the far column is kept. */
  function frameShot(s, pi) {
    if (narrowMQ.matches) {
      const D = Math.min(0.84 * W, 0.7 * H)
      return { cx: W / 2, d: (H * s.R) / (D * TAN) }
    }
    const labelled = panels[pi].specs.length > 0
    const far = labelled ? LABEL_COL : 0
    const near = labelled && s.labelSide !== 'far' && W >= 1200 ? LABEL_COL : 0
    const c = copyEdges[pi]
    let lo = 0
    let hi = W
    if (s.side > 0) { lo = (c ? c.right + 28 : 0) + near; hi = W - far }
    else if (s.side < 0) { lo = far; hi = (c ? c.left - 28 : W) - near }
    else if (labelled) { lo = far; hi = W - far }
    const D = Math.min(s.fill * (hi - lo), s.fillH * H)
    return { cx: (lo + hi) / 2, d: (H * s.R) / (D * TAN) }
  }
  /* Each shot's look point in world terms (a robot-frame point turned by that shot's yaw), so a robot
     shot can hand over to a world shot. */
  const worldLook = (sh) => (sh.worldLook ? sh.look : new THREE.Vector3(...sh.look).applyAxisAngle(THREE.Object3D.DEFAULT_UP, sh.yaw).toArray())
  function blend(i, t) {
    const a = panels[i].shot
    const b = panels[i + 1].shot
    const fa = frameShot(a, i)
    const fb = frameShot(b, i + 1)
    const o = { dim: {}, show: {} }
    for (const k of ['yaw', 'el', 'R']) o[k] = lerp(a[k], b[k], t)
    for (const k of ['explode', 'prog', 'drive']) o[k] = lerp(a[k] ?? 0, b[k] ?? 0, t)
    const la = worldLook(a)
    const lb = worldLook(b)
    o.lookW = la.map((v, k) => lerp(v, lb[k], t))
    o.cx = lerp(fa.cx, fb.cx, t)
    o.d = lerp(fa.d, fb.d, t)
    for (const g of GROUPS) {
      o.dim[g] = lerp(a.dim?.[g] ?? 1, b.dim?.[g] ?? 1, t)
      o.show[g] = lerp(a.show?.[g] ?? 1, b.show?.[g] ?? 1, t)
    }
    return o
  }
  function applyLook(dim, show) {
    for (const g of GROUPS) {
      for (const n of groupNodes[g]) n.visible = show[g] > 0.001 // only once it has left the frame
      for (const m of groupMats[g]) {
        const b = m.userData.base
        m.color.copy(b.color).multiplyScalar(dim[g])
        m.envMapIntensity = b.env * dim[g]
      }
    }
  }

  /* ── the mechanisms ────────────────────────────────────────────────── */
  const hoodP = profiled(40, 0.45)
  const deployP = profiled(0.42, 0.55)
  let progT = 0
  let mechT = 0
  let endLive = false // the ending has started since the reader last left it
  let wheelV = 0
  let endCmd = null // the ending's pose and commands, from last frame's update
  const hubAt = new THREE.Vector3(...HUB_AT)
  const routineAt = (t) => { const o = {}; for (const k of ROUTINE) { if (k.t > t) break; Object.assign(o, k) } return o }
  function runMechanisms(w, dw, dt, yaw, baseYaw) {
    if (reduced) { w = 0; dw = 0 }
    mechT += dt
    if (w > 0.001) progT += dt
    /* Leaving the last shot puts the field back, so it starts from the top next time. */
    if (dw > 0.001) endLive = true
    else if (endLive) { endLive = false; ending?.reset(baseYaw); endCmd = null }
    const inEnding = dw > 0.5 && endCmd
    const mw = inEnding ? dw : w
    const r = inEnding
      ? { intake: endCmd.intake, hood: endCmd.hood, fly: endCmd.fly, feed: endCmd.feed, rollers: endCmd.rollers }
      : routineAt(progT % ROUTINE_LOOP)

    /* What the drive asks of each module: in the ending, the robot's own velocity and turn rate
       (swerve kinematics, v + ω × r); otherwise the routine. */
    let drive = null
    let pose = null
    if (dw > 0.01 && endCmd) {
      pose = endCmd.pose
      const vx = endCmd.vel.vx * dw
      const vz = endCmd.vel.vz * dw
      const om = endCmd.vel.w * dw
      const c = Math.cos(yaw)
      const sn = Math.sin(yaw)
      drive = { vx: vx * c - vz * sn, vz: vx * sn + vz * c, om } // world → robot frame
    }
    robot.steer(drive, dt, {
      weight: Math.max(w, dw),
      rawFor: (m) => (r.drive === 'spin' ? 0 : r.drive === 'x' ? Math.PI / 2 : HEADING[r.drive] - m.cad),
      speed: wheelV * 0.9,
    })
    wheelV = lag(wheelV, (r.wheel ?? 0) * w, 0.25, dt)

    /* Rollers spin up and coast down per channel; ratios from the manifest. */
    /* In the ending the intake rollers run only while collecting; in the routine, whenever it is out. */
    const intakeRun = r.rollers ?? r.intake ?? 0
    robot.rollers({ fly: (r.fly ?? 0) * mw, feed: (r.feed ?? 0) * mw, intake: intakeRun * mw, conveyor: Math.max(r.feed ?? 0, intakeRun * 0.6) * mw }, dt)

    const cad = manifest?.hood?.cadAngle ?? 11
    let hoodDeg = cad
    hoodDeg += mw * (hoodP.at(r.hood ?? 15, mechT) - cad) // Hood.java's range is 13–45°
    robot.setHood(hoodDeg)
    const deploy = deployP.at((r.intake ?? 0) * (manifest?.intake?.travel ?? 0.3), mechT) * mw
    return { deploy, hoodDeg, pose }
  }

  /* ── callouts: Catalyst Console's layoutCallouts, ported ───────────── */
  /* Labels go out past the robot's edge on the side their part is on, level with it; one side keeps
     its order and is pushed apart so labels never overlap. A label picks its side once, when it
     appears — re-deciding every frame made labels flick across as the robot swayed. */
  function layoutCallouts(items, box, area) {
    const gap = 40
    const spacing = 14
    const margin = 24
    const sides = { left: [], right: [] }
    const middle = (box.left + box.right) / 2
    for (const it of items) {
      const room = { left: box.left - gap - it.w - margin, right: area.w - margin - (box.right + gap + it.w) }
      let side = it.c.side || it.force
      if (!side) {
        side = it.p.x < middle ? 'left' : 'right'
        const other = side === 'left' ? 'right' : 'left'
        if (room[side] < 0 && room[other] > room[side]) side = other
      }
      it.c.side = side
      sides[side].push({ ...it, y: it.p.y - it.h / 2 })
    }
    const out = []
    for (const side of ['left', 'right']) {
      const list = sides[side].sort((a, b) => a.y - b.y)
      const band = area[side] ?? [0, area.h]
      let floor = band[0]
      for (const it of list) { it.y = Math.max(it.y, floor); floor = it.y + it.h + spacing }
      let ceiling = band[1]
      for (let i = list.length - 1; i >= 0; i--) {
        const it = list[i]
        it.y = Math.max(band[0], Math.min(it.y, ceiling - it.h))
        ceiling = it.y - spacing
      }
      for (const it of list) out.push({ ...it, side, x: side === 'left' ? Math.max(margin, box.left - gap - it.w) : Math.min(area.w - margin - it.w, box.right + gap) })
    }
    return out
  }
  /* The band a column may use: the full height under the nav, unless the copy box sits in that
     column — then whichever part above or below it is taller. */
  function bandFor(x0, x1, copy) {
    const t = 96
    const b = H - 28
    if (!copy || x1 < copy.left - 16 || x0 > copy.right + 16) return [t, b]
    const above = [t, copy.top - 20]
    const below = [copy.bottom + 20, b]
    return above[1] - above[0] >= below[1] - below[0] ? above : below
  }
  const v = new THREE.Vector3()
  const bb = new THREE.Box3()
  const tmp = new THREE.Box3()
  const corner = new THREE.Vector3()
  let sbox = null // the subject's screen box, smoothed
  /* Only the assemblies in focus, so a shot that dims the rest labels the shooter, not the machine. */
  function subjectBox(look) {
    bb.makeEmpty()
    for (const g of GROUPS) if (look.show[g] > 0.5 && look.dim[g] > 0.5) for (const n of groupNodes[g]) { tmp.setFromObject(n); bb.union(tmp) }
    if (bb.isEmpty()) return null
    let l = 1e9
    let r = -1e9
    let t = 1e9
    let b = -1e9
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z).project(camera)
      const x = ((corner.x + 1) / 2) * W
      const y = ((1 - corner.y) / 2) * H
      l = Math.min(l, x); r = Math.max(r, x); t = Math.min(t, y); b = Math.max(b, y)
    }
    return { left: l, right: r, top: t, bottom: b }
  }
  function placeCallouts(beat, look, dt) {
    const k = 1 - Math.exp(-dt * 12)
    let laid = []
    if (!narrowMQ.matches && beat >= 0) {
      const raw = subjectBox(look)
      if (raw) {
        /* Smoothed so the column holds still while the robot sways or is dragged. */
        if (!sbox) sbox = { ...raw }
        else for (const q of ['left', 'right', 'top', 'bottom']) sbox[q] += (raw[q] - sbox[q]) * (1 - Math.exp(-dt * 5))
        const box = { ...sbox, w: sbox.right - sbox.left }
        const cr = panels[beat].box?.getBoundingClientRect()
        const col = canvas.getBoundingClientRect()
        const copy = cr ? { left: cr.left - col.left, right: cr.right - col.left, top: cr.top - col.top, bottom: cr.bottom - col.top } : null
        const shot = panels[beat].shot
        const force = shot.labelSide === 'far' ? (shot.side > 0 ? 'right' : 'left') : null
        const items = []
        for (const c of callouts) {
          if (c.pi !== beat) continue
          const a = anchors[c.anchor]
          if (!a) continue
          v.copy(a.home)
          if (a.mover) v.add(a.mover.off)
          v.add(a.local)
          top.localToWorld(v).project(camera)
          const p = { x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * H }
          if (v.z > 1 || p.x < 0 || p.x > W || p.y < 0 || p.y > H) continue
          a.live.getWorldPosition(v).project(camera)
          items.push({ c, p, live: { x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * H }, w: c.w, h: c.h, force })
        }
        const maxW = Math.max(0, ...items.map((i) => i.w))
        laid = layoutCallouts(items, box, {
          w: W, h: H,
          left: bandFor(box.left - 40 - maxW, box.left - 40, copy),
          right: bandFor(box.right + 40, box.right + 40 + maxW, copy),
        })
      }
    } else sbox = null
    const shown = new Set(laid.map((l) => l.c))
    for (const l of laid) {
      const c = l.c
      if (!c.live) { c.x = l.x; c.y = l.y; c.live = true }
      else { c.x += (l.x - c.x) * k; c.y += (l.y - c.y) * k }
      c.el.dataset.side = l.side
      c.el.dataset.on = 'true'
      c.el.style.transform = `translate(${c.x.toFixed(1)}px,${c.y.toFixed(1)}px)`
      c.line.setAttribute('x1', l.side === 'left' ? c.x + c.w + 10 : c.x - 10)
      c.line.setAttribute('y1', c.y + c.h / 2)
      c.line.setAttribute('x2', l.live.x)
      c.line.setAttribute('y2', l.live.y)
      c.dot.setAttribute('cx', l.live.x)
      c.dot.setAttribute('cy', l.live.y)
      c.line.style.opacity = c.dot.style.opacity = 1
    }
    for (const c of callouts) if (!shown.has(c)) {
      c.el.dataset.on = 'false'
      c.line.style.opacity = c.dot.style.opacity = 0
      c.live = false
      c.side = null
    }
  }

  /* The solver's callout: beside the shooter while the robot aims and fires, on desktop only. */
  function placeSolver(cmd, drive) {
    const on = !narrowMQ.matches && drive > 0.95 && cmd.shot && cmd.fly
    solverEl.dataset.on = on ? 'true' : 'false'
    solverLine.style.opacity = solverDot.style.opacity = on ? 1 : 0
    if (!on || !hoodNode) return
    solverEl.lastChild.textContent = `${cmd.shot.range.toFixed(1)} m → hood ${cmd.shot.hood.toFixed(1)}°`
    hoodNode.getWorldPosition(hoodTip).project(camera)
    const px = ((hoodTip.x + 1) / 2) * W
    const py = ((1 - hoodTip.y) / 2) * H
    const w = solverEl.offsetWidth || 160
    const x = Math.min(W - w - 24, px + 70)
    const y = Math.max(96, py - 70)
    solverEl.dataset.side = 'right'
    solverEl.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`
    solverLine.setAttribute('x1', x - 10)
    solverLine.setAttribute('y1', y + 18)
    solverLine.setAttribute('x2', px)
    solverLine.setAttribute('y2', py)
    solverDot.setAttribute('cx', px)
    solverDot.setAttribute('cy', py)
  }

  /* ── the frame ─────────────────────────────────────────────────────── */
  let s = 0
  let swayAmp = 1
  let visible = true
  const rmv = new THREE.Vector3()
  const removeW = new THREE.Vector3(...REMOVE_W)
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting })
  io.observe(root)
  cleanups.push(() => io.disconnect())

  function frame(dt, draw = true) {
    if (!ready) return
    const target = scrollShot()
    s = reduced ? target : s + (target - s) * (1 - Math.exp(-dt * 7))
    const i = Math.min(panels.length - 2, Math.floor(s))
    const look = blend(i, smooth(clamp01((s - i - 0.2) / 0.6)))

    /* Focus pull: the title is sharp over a soft robot, then hands over. */
    const tOut = clamp01(s / 0.55)
    if (title) {
      title.style.opacity = String(1 - tOut)
      title.style.transform = `translateY(${-tOut * 70}px) scale(${1 + tOut * 0.05})`
    }
    canvas.style.setProperty('--dof', `${((1 - tOut) * 14).toFixed(2)}px`)

    /* Copy fades with distance from the reading line. */
    const line = readingLine()
    for (const p of panels) {
      if (!p.box) continue
      const dist = Math.abs(panelKey(p.el.getBoundingClientRect()) - line) / innerHeight
      p.box.style.opacity = String(narrowMQ.matches ? 1 : 1 - smooth(clamp01((dist - 0.22) / 0.3)))
    }

    applyLook(look.dim, look.show)
    const mech = runMechanisms(look.prog, look.drive, dt, rig.rotation.y, look.yaw)
    /* Removal direction, world → robot frame: "up and away from the camera" whatever the turn. */
    rmv.copy(removeW).applyAxisAngle(THREE.Object3D.DEFAULT_UP, -rig.rotation.y)
    for (const q of moving) {
      q.off.copy(q.dir).multiplyScalar(smooth(clamp01((look.explode - q.at) / (1 - q.at))) * q.d)
      q.n.position.copy(q.home).add(q.off)
      const g = groupOfNode(q.n.name)
      const o = REMOVE_ORDER[g] ?? 0
      const gone = clamp01((1 - look.show[g] - o) / (1 - o))
      q.n.position.addScaledVector(rmv, gone * gone) // eases in: lifts off, then accelerates away
      if (q.n === intakeNode) q.n.position.addScaledVector(intakeAxis, mech.deploy)
    }
    rig.position.set(mech.pose ? mech.pose.x * look.drive : 0, 0, mech.pose ? mech.pose.z * look.drive : 0)
    /* The HUB and the FUEL on the carpet slide in from the right as the last shot frames them — the
       field coming into view — rather than appearing. */
    const fieldShift = 5 * (1 - smooth(look.drive))
    if (hub) {
      hub.visible = look.drive > 0.002
      hub.position.set(hubAt.x + fieldShift, 0, hubAt.z)
      hubShadow.position.copy(hub.position).setY(0.001)
      hubShadow.visible = hub.visible
    }
    shadow.position.set(rig.position.x, 0.001, rig.position.z)

    /* Turn: the shot's yaw, a slow sway that stops (smoothly) while labels are up, and whatever the
       reader dragged, easing back. */
    const beat = Math.round(s)
    const settled = Math.abs(s - beat) < 0.18 && panels[beat].specs.length > 0
    if (!dragging) { spinUser += spinVel; spinVel *= 0.9; spinUser *= Math.exp(-dt * 0.6) }
    swayAmp += ((settled ? 0 : 1) - swayAmp) * (1 - Math.exp(-dt * 1.5))
    const sway = reduced ? 0 : Math.sin(performance.now() / 5200) * 0.07 * swayAmp
    rig.rotation.y = look.yaw + sway + spinUser + (mech.pose ? (mech.pose.yaw - look.yaw) * look.drive : 0)

    /* Camera on a sphere round the look point, with the principal point moved so the subject lands at
       cx: shifting the view rather than the robot keeps perspective square. On a phone the nav pill
       covers the top of the band, so the subject sits a little below its middle. */
    const lk = v.set(...look.lookW)
    camera.position.set(lk.x, lk.y + Math.sin(look.el) * look.d, lk.z + Math.cos(look.el) * look.d)
    camera.lookAt(lk)
    camera.setViewOffset(W, H, W / 2 - look.cx, narrowMQ.matches ? -26 : 0, W, H)
    camera.updateMatrixWorld()
    /* Measure against this frame's pose; rendering would only refresh world matrices afterwards. */
    scene.updateMatrixWorld()

    placeCallouts(settled ? beat : -1, look, dt)
    if (ending) {
      endCmd = ending.update(dt, {
        top, deploy: mech.deploy, baseYaw: look.yaw, shift: fieldShift,
        active: look.drive > 0.98 && !reduced, visible: look.drive > 0.002,
      })
      placeSolver(endCmd, look.drive)
    }
    if (draw) renderer.render(scene, camera)
  }
  const clock = new THREE.Clock()
  renderer.setAnimationLoop(() => {
    const dt = Math.min(0.05, clock.getDelta())
    if (visible) frame(dt)
  })

  /* Verification hook, development only. Automated review browsers throttle requestAnimationFrame
     below 1 fps, so eased values cannot be observed; settle() scrolls a panel onto the reading line
     and drives the same frame function until it rests. "3.5" is halfway between the fourth and fifth
     shots, "lineage:500" settles for 500 frames, "end@5.4" is the ending 5.4 s after it starts. */
  if (import.meta.env.DEV) {
    window.__spine = {
      get ready() { return ready },
      settle(name, steps = 200) {
        if (String(name).startsWith('end@')) {
          const t = Number(String(name).slice(4))
          this.settle('lineage', 120)
          /* Play the ending from its start, so collecting and shooting happen in order. */
          ending?.reset(SHOTS.lineage.yaw)
          const steps = Math.round(t * 60)
          for (let k = 0; k < steps; k++) frame(1 / 60, k === steps - 1)
          return { s: +s.toFixed(3), mode: endCmd?.mode, reason: endCmd?.reason, held: endCmd?.held }
        }
        if (String(name).includes(':')) { const [nm, k] = String(name).split(':'); name = nm; steps = Number(k) || steps }
        const n = Number(name)
        const keys = panels.map((x) => scrollY + panelKey(x.el.getBoundingClientRect()))
        let y
        if (Number.isFinite(n)) { const i = Math.min(keys.length - 2, Math.floor(n)); y = keys[i] + (n - i) * (keys[i + 1] - keys[i]) }
        else y = keys[Math.max(0, panels.findIndex((x) => x.name === name))]
        window.scrollTo(0, y - readingLine())
        for (let k = 0; k < steps; k++) frame(1 / 60, k === steps - 1)
        return { s: +s.toFixed(3), shown: callouts.filter((c) => c.el.dataset.on === 'true').length }
      },
      /* The ending as numbers: every quarter second for `sec` seconds, what the robot is doing. */
      trace(sec = 30) {
        this.settle('lineage', 120)
        ending?.reset(SHOTS.lineage.yaw)
        const out = []
        for (let k = 0; k < sec * 60; k++) {
          frame(1 / 60, false)
          if (k % 15 === 0 && endCmd) {
            const p = endCmd.pose
            out.push(`${(k / 60).toFixed(2)} ${endCmd.mode.padEnd(8)} x${p.x.toFixed(2)} z${p.z.toFixed(2)} yaw${p.yaw.toFixed(2)} v${Math.hypot(endCmd.vel.vx, endCmd.vel.vz).toFixed(2)} w${endCmd.vel.w.toFixed(2)} held${endCmd.held}`)
          }
        }
        return out.join('\n')
      },
      /* Where a world point lands on the stage, in canvas px — for placing things in frame. */
      project(x, y, z) {
        const q = new THREE.Vector3(x, y, z).project(camera)
        return { x: Math.round(((q.x + 1) / 2) * W), y: Math.round(((1 - q.y) / 2) * H), W, H }
      },
      callouts() {
        return callouts.filter((c) => c.el.dataset.on === 'true').map((c) => ({ a: c.anchor, side: c.side, x: Math.round(c.x), y: Math.round(c.y), w: c.w, h: c.h }))
      },
    }
  }

  return function dispose() {
    disposed = true
    renderer.setAnimationLoop(null)
    cleanups.forEach((f) => f())
    scene.traverse((o) => {
      o.geometry?.dispose?.()
      const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : []
      ms.forEach((m) => { m.map?.dispose?.(); m.dispose?.() })
    })
    scene.environment?.dispose?.()
    renderer.dispose()
    if (import.meta.env.DEV) delete window.__spine
  }
}
