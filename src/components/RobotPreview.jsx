import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import styles from './Arcade3D.module.css'

const CAPTURE = 'Simulator capture - freeplay controls'
const clipLabel = (name) =>
  name === CAPTURE ? 'Recorded run' : name.replace(/^Joint demo - /, '').replace(/_/g, ' ')

/** A soft pool of light for the robot to stand in. */
function floorTexture(color) {
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const g = c.getContext('2d')
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128)
  grad.addColorStop(0, 'rgba(255,255,255,0.18)')
  grad.addColorStop(0.55, `${color}33`)
  grad.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 256, 256)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

/**
 * The chosen robot, turning: its recorded run or any joint demo the export
 * carries. Numbers has no clips, so it shows its live mechanisms instead.
 *
 * One renderer for the life of the picker; only the model changes. A new WebGL
 * context per robot would run into the browser's limit after a few quick picks.
 */
export default function RobotPreview({ assets, spec, team = 'blue', pal }) {
  const hostRef = useRef(null)
  const ctl = useRef({ paused: false })
  const specRef = useRef(spec)
  const [clips, setClips] = useState([])
  const [clip, setClip] = useState(CAPTURE)
  const [playing, setPlaying] = useState(true)
  const [state, setState] = useState('loading')
  specRef.current = spec

  // ---- the stage: renderer, lights, floor, camera, loop
  useEffect(() => {
    // A canvas of its own each time: a canvas whose context was released cannot
    // be given to a new renderer (it would get the lost context back).
    const canvas = document.createElement('canvas')
    canvas.className = styles.previewCanvas
    canvas.setAttribute('aria-hidden', 'true')
    hostRef.current.appendChild(canvas)
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.1
    const scene = new THREE.Scene()
    // Metal is what it reflects: without this the aluminium on a robot is near black.
    try {
      scene.environment = assets.environment(renderer)
      scene.environmentIntensity = 0.75
    } catch { /* plain lights only */ }
    const accent = team === 'red' ? pal?.red || '#f06363' : pal?.blue || '#2f74c8'
    scene.add(new THREE.HemisphereLight(0xe6eeff, 0x15171b, 1.6))
    const key = new THREE.DirectionalLight(0xffffff, 2.6)
    key.position.set(2.5, 4, 3)
    scene.add(key)
    const rim = new THREE.DirectionalLight(new THREE.Color(accent), 2.2)
    rim.position.set(-3, 1.8, -2.5)
    scene.add(rim)
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(2.6, 2.6),
      new THREE.MeshBasicMaterial({ map: floorTexture(accent), transparent: true, depthWrite: false }),
    )
    floor.rotation.x = -Math.PI / 2
    floor.position.y = 0.002
    scene.add(floor)
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.98, 1, 128),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(accent), transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
    )
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.004
    scene.add(ring)
    const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 40)
    const turn = new THREE.Group()
    scene.add(turn)
    Object.assign(ctl.current, { turn, team, accent })

    const resize = () => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (!w || !h) return
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    let raf = 0
    let last = performance.now()
    let angle = 0.7
    const loop = (now) => {
      raf = requestAnimationFrame(loop)
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const c = ctl.current
      const s = specRef.current
      if (!c.paused) angle += dt * 0.28
      turn.rotation.y = angle
      if (c.mixer && !c.paused) c.mixer.update(dt)
      if (c.model && c.pin) {
        // The recorded run drives the robot around the field; keep it on the spot.
        const top = c.model.children[0]
        if (top) { top.position.x = 0; top.position.z = 0 }
      }
      if (c.numbers && !c.paused) {
        c.numbers.t += dt
        const t = c.numbers.t
        const u = (Math.sin(t * 0.8) + 1) / 2
        c.numbers.rig.update({
          psi: 0, vx: Math.cos(t) * 1.5, vz: Math.sin(t * 0.7) * 1.2, om: Math.sin(t * 0.5),
          carry: 10, firing: u > 0.7 ? 1 : 0, intakeOut: u, team, x: 1.6 - 3 * u, z: 4.03, a: s,
        }, dt)
      }
      // Frame the robot: big, whole, from a little above, whatever the stage's shape.
      const size = Math.max(s.len, s.wid) * 1.25
      const half = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
      const fill = 0.66
      const dist = (size / (2 * half * fill)) * Math.max(1, 1 / camera.aspect)
      const el = 0.36
      camera.position.set(Math.cos(0.65) * dist * Math.cos(el), s.height * 0.45 + dist * Math.sin(el), Math.sin(0.65) * dist * Math.cos(el))
      camera.lookAt(0, s.height * 0.42, 0)
      renderer.render(scene, camera)
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      ctl.current.mixer?.stopAllAction()
      scene.traverse((o) => {
        o.geometry?.dispose?.()
        o.material?.map?.dispose?.()
      })
      scene.environment?.dispose?.()
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
      ctl.current = { paused: false }
    }
  }, [assets, team, pal])

  // ---- the robot: swap the model when the pick changes
  useEffect(() => {
    let stale = false
    setState('loading')
    setClips([])
    const c = ctl.current
    assets.robot(spec)
      .then(({ root, clips: list, rig }) => {
        if (stale || !c.turn) return
        if (c.model) c.turn.remove(c.model)
        c.mixer?.stopAllAction()
        c.model = root
        c.mixer = null
        c.numbers = null
        c.turn.add(root)
        // Bumpers in the alliance colour, as on the field.
        root.traverse((o) => {
          if ((o.userData?.name ?? o.name) !== 'bumpers:cloth') return
          o.traverse((m) => {
            if (!m.isMesh) return
            m.material = m.material.clone()
            m.material.color.set(spec.cloth?.[c.team] || c.accent)
          })
        })
        if (spec.source === 'numbers') c.numbers = { rig, t: 0 }
        if (list?.length) {
          c.mixer = new THREE.AnimationMixer(root)
          c.clips = list
          setClips(list.map((x) => x.name))
        } else {
          c.clips = []
        }
        setClip(CAPTURE)
        setState('ready')
      })
      .catch(() => { if (!stale) setState('error') })
    return () => { stale = true }
  }, [assets, spec])

  // ---- play the chosen clip (the recorded run unless another is picked)
  useEffect(() => {
    const { mixer, clips: list } = ctl.current
    if (!mixer || !list?.length) return
    mixer.stopAllAction()
    const c = list.find((x) => x.name === clip) || list[0]
    ctl.current.pin = c.name === CAPTURE
    mixer.clipAction(c).reset().setLoop(THREE.LoopRepeat, Infinity).play()
  }, [clip, clips])

  useEffect(() => {
    ctl.current.paused = !playing
  }, [playing])

  return (
    <div className={styles.preview}>
      <div ref={hostRef} className={styles.previewHost} role="img" aria-label={`${spec.robot}, turning`} />
      {state === 'loading' && <span className={styles.previewNote}>Loading {spec.robot}…</span>}
      {state === 'error' && <span className={styles.previewNote}>Could not load this robot’s model.</span>}
      <div className={styles.previewControls}>
        {clips.length > 0 && (
          <select className={styles.select} value={clip} onChange={(e) => setClip(e.target.value)} aria-label="Animation">
            {clips.map((c) => <option key={c} value={c}>{clipLabel(c)}</option>)}
          </select>
        )}
        <button type="button" className={styles.previewBtn} onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'Pause the preview' : 'Play the preview'}>
          {playing ? 'Pause' : 'Play'}
        </button>
      </div>
    </div>
  )
}
