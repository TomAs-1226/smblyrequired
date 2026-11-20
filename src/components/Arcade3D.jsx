import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MODES } from '../lib/arcade3d/config'
import { untilHubChange, periodLabel } from '../lib/arcade3d/rules'
import {
  leaderboardEnabled, localBest, saveLocalBest, fetchTop, startRun, submitScore,
} from '../lib/arcade/leaderboard'
import { REALISM } from '../lib/arcade3d/faults'
import { arcade } from '../data/arcade'
import { getLenis } from '../lib/smoothScroll'
import styles from './Arcade3D.module.css'

const RobotPreview = lazy(() => import('./RobotPreview'))

// If the preview's WebGL fails, say so in its place; the rest of the page carries on.
class PreviewBoundary extends Component {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(err) { console.warn('[arcade] robot preview', err) }
  render() {
    return this.state.failed ? <span className={styles.previewNote}>The 3D preview is not available here.</span> : this.props.children
  }
}

// Drive W A S D · turn Q E or ← → · shoot Space · intake Shift · special X
const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'ShiftLeft', 'ShiftRight', 'KeyX',
])
const CAMERAS = ['follow', 'chase', 'top', 'station']
const CAMERA_LABEL = { follow: 'Follow', chase: 'Chase', top: 'Overhead', station: 'Driver station' }
const AIM_LABEL = {
  hub: { ready: 'Locked: firing', aiming: 'Lining up', near: 'Too close to the hub', far: 'Too far from the hub', fast: 'Too fast to shoot straight' },
  pass: { ready: 'Passing', aiming: 'Lining up the pass', near: 'Too close to pass', far: 'Too far to pass', home: 'Already in your zone' },
}
// A shot lined up while going faster than the shooter can allow for will trail: say so.
const aimState = (aim) => (aim.kind === 'hub' && aim.fast && (aim.state === 'ready' || aim.state === 'aiming') ? 'fast' : aim.state)
const NAME_KEY = 'frc5805.arcade.name'
const MAX_STEPS_PER_FRAME = 4

const fmtClock = (left) => {
  const s = Math.max(0, Math.ceil(left))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const readStored = (k, d) => {
  try { return localStorage.getItem(k) || d } catch { return d }
}
const store = (k, v) => {
  try { localStorage.setItem(k, v) } catch { /* not remembered */ }
}
const bestKey = (mode, difficulty, key) => (mode === 'match' ? difficulty : `${mode}.${key}`)
// A team colour dark enough to vanish on the panel falls back to the body text colour.
const readable = (hex) => {
  const n = parseInt((hex || '').replace('#', ''), 16)
  if (Number.isNaN(n)) return undefined
  const lum = (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255
  return lum < 0.32 ? undefined : hex
}

export default function Arcade3D() {
  const frameRef = useRef(null)
  const canvasRef = useRef(null)
  const mods = useRef(null) // { R, sim module, assets, field }
  const viewRef = useRef(null)
  const simRef = useRef(null)
  const screenRef = useRef('loading')
  const camRef = useRef(CAMERAS.includes(readStored('frc5805.arcade.camera', '')) ? readStored('frc5805.arcade.camera', '') : 'follow')
  const keys = useRef(new Set())
  const touches = useRef(new Map()) // the two thumbs on a touch screen
  const pads = useRef({ fire: false, intake: false, special: false }) // its three buttons
  const runRef = useRef(null)

  const [screen, setScreenState] = useState('loading')
  const [loadError, setLoadError] = useState('')
  const [specs, setSpecs] = useState([])
  const [robotKey, setRobotKey] = useState(() => readStored('frc5805.arcade.robot', '5805-numbers'))
  const [mode, setMode] = useState(() => (MODES[readStored('frc5805.arcade.mode', 'match')] ? readStored('frc5805.arcade.mode', 'match') : 'match'))
  const [difficulty, setDifficulty] = useState('regional')
  const [filter, setFilter] = useState('all')
  const [camera, setCameraState] = useState(camRef.current)
  const [hud, setHud] = useState(null)
  const [final, setFinal] = useState(null)
  const [board, setBoard] = useState({ loading: false, rows: [], error: '' })
  const [name, setName] = useState(() => readStored(NAME_KEY, ''))
  const [post, setPost] = useState({ state: 'idle', msg: '' })
  const [realism, setRealism] = useState(() => (REALISM[readStored('frc5805.arcade.realism', 'off')] ? readStored('frc5805.arcade.realism', 'off') : 'off'))
  const [query, setQuery] = useState('')
  const [pal, setPal] = useState(null)
  const [intakeLatch, setIntakeLatch] = useState(false) // the touch Intake button is a switch

  const setScreen = useCallback((s) => {
    screenRef.current = s
    setScreenState(s)
  }, [])

  const spec = useMemo(() => specs.find((s) => s.key === robotKey) || specs[0] || null, [specs, robotKey])
  const best = spec ? localBest(bestKey(mode, difficulty, spec.key)) : 0
  const tilesRef = useRef(null)

  // Keep the chosen robot's tile in view. Scroll the strip itself, never the page.
  useEffect(() => {
    const list = tilesRef.current
    const tile = list?.querySelector(`[data-key="${CSS.escape(robotKey)}"]`)
    if (!list || !tile) return
    const left = tile.offsetLeft - (list.clientWidth - tile.offsetWidth) / 2
    list.scrollTo({ left: Math.max(0, left), behavior: 'smooth' })
  }, [robotKey, screen, specs.length])

  // ---- load three.js, Rapier and the imported assets only when the page is opened
  useEffect(() => {
    let cancelled = false
    let raf = 0
    let ro = null
    ;(async () => {
      try {
        const [rapierMod, simMod, sceneMod, assetsMod] = await Promise.all([
          import('@dimforge/rapier3d-compat'),
          import('../lib/arcade3d/sim'),
          import('../lib/arcade3d/scene'),
          import('../lib/arcade3d/assets'),
        ])
        const R = rapierMod.init ? rapierMod : rapierMod.default
        const assets = assetsMod.createAssets(import.meta.env.BASE_URL)
        const [, rosterData] = await Promise.all([R.init(), assets.roster()])
        if (cancelled) return
        mods.current = { R, ...simMod, assets, field: rosterData.field }
        setSpecs(rosterData.specs)
        const cs = getComputedStyle(frameRef.current)
        const tok = (n, d) => cs.getPropertyValue(n).trim() || d
        const palette = {
          void: tok('--bg-void', '#050505'),
          blue: tok('--brand-blue-lift', '#2f74c8'),
          red: tok('--danger', '#f06363'),
          gold: tok('--accent-gold', '#d9c68a'),
          muted: tok('--text-muted', '#8d8f96'),
          fuel: tok('--arcade-fuel', '#f0c43c'),
        }
        setPal(palette)
        const view = sceneMod.createScene(canvasRef.current, palette, assets)
        viewRef.current = view
        ro = new ResizeObserver(([entry]) => {
          const { width, height } = entry.contentRect
          view.resize(width, height, Math.min(window.devicePixelRatio || 1, 2))
        })
        ro.observe(canvasRef.current)
        newDemo(rosterData.specs)
        setScreen('menu')
        // Development only: lets a test drive read the live sim and the scene's load state.
        if (import.meta.env.DEV) window.__arcade = { sim: () => simRef.current, scene: view, keys: keys.current }
        raf = requestAnimationFrame(loop)
      } catch (err) {
        console.error(err)
        if (!cancelled) {
          setLoadError(err?.message || String(err))
          setScreen('error')
        }
      }
    })()

    let last = performance.now()
    let acc = 0
    let lastHud = 0
    function loop(now) {
      raf = requestAnimationFrame(loop)
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const sim = simRef.current
      const view = viewRef.current
      const m = mods.current
      if (!sim || !view || !m) return
      const sc = screenRef.current
      const running = sc === 'playing' || sc === 'menu'
      if (running) {
        acc += dt
        let n = 0
        const input = sc === 'playing' ? readInput() : undefined
        while (acc >= m.DT && n < MAX_STEPS_PER_FRAME) {
          m.step(sim, input)
          acc -= m.DT
          n++
        }
        if (n === MAX_STEPS_PER_FRAME) acc = 0 // fell behind: drop time rather than spiral
      } else {
        acc = 0
      }
      const focus = sim.demo ? null : sim.robots[0]
      view.render(sim, dt, { focus })

      if (sc === 'menu' && sim.over) newDemo()
      if (sc === 'playing') {
        if (now - lastHud > 100) {
          lastHud = now
          setHud(snapshot(sim))
        }
        if (sim.over) endMatch(sim)
      }
    }

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      ro?.disconnect()
      if (simRef.current && mods.current) mods.current.destroySim(simRef.current)
      simRef.current = null
      viewRef.current?.dispose()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const randomLineup = (all, first, n = 6) => {
    const pool = all.filter((s) => s !== first).sort(() => Math.random() - 0.5)
    const blue = [first || pool.shift(), pool.shift(), pool.shift()]
    return { blue, red: pool.slice(0, n - 3) }
  }

  function newDemo(all = mods.current?.specsCache) {
    const m = mods.current
    if (!m) return
    if (all) m.specsCache = all
    const list = m.specsCache || []
    if (!list.length) return
    if (simRef.current) m.destroySim(simRef.current)
    const sim = m.createSim(m.R, { field: m.field, lineup: randomLineup(list, null), mode: 'match', difficulty: 'regional', demo: true })
    sim.clock = 0
    simRef.current = sim
    viewRef.current.attach(sim)
    viewRef.current.setCamera('broadcast')
  }

  function snapshot(sim) {
    const me = sim.robots[0]
    const m = mods.current
    const t = sim.clock
    const hubs = {}
    for (const team of ['blue', 'red']) {
      const on = m.hubLive(sim, team)
      // Until auto is decided nobody knows which hub goes dark first, so no countdown.
      const change = sim.rules.shifts && t >= 0 && sim.autoWinner ? untilHubChange(t, team, sim.autoWinner) : Infinity
      hubs[team] = { on, change: Number.isFinite(change) ? Math.ceil(change) : null }
    }
    const total = sim.rules.total
    return {
      clock: t,
      left: total == null ? null : total - Math.max(0, t),
      period: sim.period,
      label: sim.rules.shifts ? periodLabel(t) : { countdown: 'Ready', teleop: sim.rules.label, endgame: 'Endgame', practice: 'Practice', over: 'Final' }[sim.period],
      blue: sim.score.blue.total,
      red: sim.score.red.total,
      opponents: sim.rules.redRobots > 0,
      shifts: sim.rules.shifts,
      hubs,
      carry: me.carry,
      capacity: me.a.capacity,
      intake: me.intakeOn,
      aim: me.aim ? AIM_LABEL[me.aim.kind]?.[aimState(me.aim)] || null : null,
      aimState: me.aim ? aimState(me.aim) : null,
      climb: me.climb.state,
      climbLevel: me.climb.level,
      // What X does right now: climb when the robot can, otherwise pass.
      special: m.canClimbNow(sim, me) ? `Climb to L${me.a.climb}` : 'Pass',
      climbable: m.canClimbNow(sim, me),
      made: sim.stats.made,
      fired: sim.stats.fired,
      health: me.health.on
        ? {
            volts: me.health.volts,
            soc: me.health.soc,
            brownout: me.health.brownout > 0,
            broken: me.health.intakeBroken,
            jam: me.health.jam > 0,
            comms: me.health.comms > 0,
            hot: me.health.hot,
          }
        : null,
      // What has gone wrong around the field in the last few seconds.
      feed: sim.faultLog.filter((f) => t - f.at < 5).slice(-3).reverse(),
    }
  }

  // ---- input: keys, or two thumbs and three buttons on a touch screen
  function readInput() {
    const k = keys.current
    const b = viewRef.current.basis()
    let fwd = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0)
    let strafe = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0)
    let turn = (k.has('ArrowRight') || k.has('KeyE') ? 1 : 0) - (k.has('ArrowLeft') || k.has('KeyQ') ? 1 : 0)
    for (const tch of touches.current.values()) {
      if (tch.side === 'left') {
        strafe = tch.dx
        fwd = -tch.dy
      } else if (Math.abs(tch.dx) > 0.15) {
        turn = tch.dx
      }
    }
    const pad = pads.current
    return {
      vx: b.fx * fwd + b.rx * strafe,
      vz: b.fz * fwd + b.rz * strafe,
      turn,
      fire: k.has('Space') || pad.fire,
      intake: k.has('ShiftLeft') || k.has('ShiftRight') || pad.intake,
      special: k.has('KeyX') || pad.special,
    }
  }

  // ---- leaderboard (matches only: the server ranks by difficulty)
  const loadBoard = useCallback((d) => {
    if (!leaderboardEnabled) return
    setBoard((b) => ({ ...b, loading: true, error: '' }))
    fetchTop(d)
      .then((rows) => setBoard({ loading: false, rows, error: '' }))
      .catch(() => setBoard({ loading: false, rows: [], error: 'The leaderboard is offline right now.' }))
  }, [])
  useEffect(() => { loadBoard(difficulty) }, [difficulty, loadBoard])

  // ---- match lifecycle
  const start = useCallback(async () => {
    const m = mods.current
    if (!m || !spec) return
    keys.current.clear()
    touches.current.clear()
    pads.current = { fire: false, intake: false, special: false }
    setIntakeLatch(false)
    store('frc5805.arcade.robot', spec.key)
    store('frc5805.arcade.mode', mode)
    store('frc5805.arcade.realism', realism)
    if (simRef.current) m.destroySim(simRef.current)
    const lineup = randomLineup(specs, spec)
    const sim = m.createSim(m.R, { field: m.field, lineup, difficulty, mode, realism })
    simRef.current = sim
    viewRef.current.attach(sim)
    viewRef.current.setCamera(camRef.current)
    setFinal(null)
    setHud(snapshot(sim))
    setScreen('playing')
    frameRef.current?.focus({ preventScroll: true })
    // The game is the top of the page: bring it fully into view.
    const lenis = getLenis()
    if (lenis) lenis.scrollTo(0, { immediate: true })
    else window.scrollTo(0, 0)
    runRef.current = null
    if (mode === 'match') runRef.current = await startRun(difficulty)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, specs, mode, difficulty, realism, setScreen])

  function endMatch(sim) {
    const r = mods.current.result(sim)
    const me = sim.robots[0]
    const k = bestKey(sim.mode, sim.difficulty, me.a.key)
    saveLocalBest(k, r.blue.total)
    setHud(snapshot(sim))
    setFinal({ ...r, difficulty: sim.difficulty, robot: me.a, best: localBest(k) })
    setPost({ state: 'idle', msg: '' })
    setScreen('over')
  }

  const togglePause = useCallback(() => {
    if (screenRef.current === 'playing') setScreen('paused')
    else if (screenRef.current === 'paused') setScreen('playing')
    keys.current.clear()
    pads.current.fire = false
    pads.current.special = false
  }, [setScreen])

  const toMenu = useCallback(() => {
    newDemo()
    setHud(null)
    setScreen('menu')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setScreen])

  const endPractice = useCallback(() => {
    const sim = simRef.current
    if (sim && mods.current) mods.current.endNow(sim)
    if (screenRef.current === 'paused') setScreen('playing')
  }, [setScreen])

  const resetRobot = useCallback(() => {
    const sim = simRef.current
    if (!sim || sim.mode !== 'practice') return
    const me = sim.robots[0]
    me.body.setTranslation({ x: 3, y: 0.02, z: 2.35 }, true)
    me.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true)
    me.body.setLinvel({ x: 0, y: 0, z: 0 }, true)
    me.carry = 8
  }, [])

  const cycleCamera = useCallback(() => {
    const next = CAMERAS[(CAMERAS.indexOf(camRef.current) + 1) % CAMERAS.length]
    camRef.current = next
    setCameraState(next)
    store('frc5805.arcade.camera', next)
    if (simRef.current && !simRef.current.demo) viewRef.current?.setCamera(next)
  }, [])

  // ---- no page scrolling under a match (Lenis scrolls programmatically, so stop it too)
  useEffect(() => {
    if (screen !== 'playing' && screen !== 'paused') return
    const html = document.documentElement
    const before = html.style.overflow
    html.style.overflow = 'hidden'
    getLenis()?.stop()
    return () => {
      html.style.overflow = before
      getLenis()?.start()
    }
  }, [screen])

  // ---- keyboard, only while a match is up
  useEffect(() => {
    if (screen !== 'playing' && screen !== 'paused') return
    const down = (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      if (e.code === 'Escape' || e.code === 'KeyP') { e.preventDefault(); togglePause(); return }
      if (e.code === 'KeyV' && !e.repeat) { e.preventDefault(); cycleCamera(); return }
      if (e.code === 'KeyR' && !e.repeat) { e.preventDefault(); resetRobot(); return }
      if (GAME_KEYS.has(e.code)) { e.preventDefault(); keys.current.add(e.code) }
    }
    const up = (e) => keys.current.delete(e.code)
    const blur = () => { if (screenRef.current === 'playing') togglePause() }
    const vis = () => { if (document.hidden) blur() }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    document.addEventListener('visibilitychange', vis)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      document.removeEventListener('visibilitychange', vis)
    }
  }, [screen, togglePause, cycleCamera, resetRobot])

  // ---- touch: a thumb on each half of the field. Left drives, right turns.
  // The mouse does nothing on the field: nothing follows the cursor.
  const onPointerDown = (e) => {
    if (screenRef.current !== 'playing' || e.pointerType === 'mouse') return
    const rect = canvasRef.current.getBoundingClientRect()
    const cx = e.clientX - rect.left
    e.currentTarget.setPointerCapture(e.pointerId)
    touches.current.set(e.pointerId, { side: cx < rect.width / 2 ? 'left' : 'right', ox: cx, oy: e.clientY - rect.top, dx: 0, dy: 0 })
  }
  const onPointerMove = (e) => {
    const t = touches.current.get(e.pointerId)
    if (!t) return
    const rect = canvasRef.current.getBoundingClientRect()
    let dx = (e.clientX - rect.left - t.ox) / 50
    let dy = (e.clientY - rect.top - t.oy) / 50
    const m = Math.hypot(dx, dy)
    if (m > 1) { dx /= m; dy /= m }
    t.dx = dx
    t.dy = dy
  }
  const onPointerUp = (e) => {
    touches.current.delete(e.pointerId)
  }
  // The on-screen buttons: Shoot and Special are held, Intake is a switch.
  const hold = (name) => ({
    onPointerDown: (e) => { e.preventDefault(); pads.current[name] = true },
    onPointerUp: () => { pads.current[name] = false },
    onPointerCancel: () => { pads.current[name] = false },
    onPointerLeave: () => { pads.current[name] = false },
  })
  const toggleIntakePad = () => {
    pads.current.intake = !pads.current.intake
    setIntakeLatch(pads.current.intake)
  }

  // ---- posting
  const onSubmit = async (e) => {
    e.preventDefault()
    const clean = name.trim().slice(0, 16)
    if (!clean || !final) return
    store(NAME_KEY, clean)
    setPost({ state: 'sending', msg: '' })
    try {
      const res = await submitScore({
        run: runRef.current,
        name: clean,
        difficulty: final.difficulty,
        blue: final.blue.total,
        red: final.red.total,
        made: final.made,
        fired: final.fired,
      })
      setPost({ state: 'done', msg: res.rank ? `Posted: #${res.rank} on ${final.difficulty}.` : 'Posted.' })
      loadBoard(final.difficulty)
    } catch (err) {
      setPost({ state: 'error', msg: err.message || 'Could not post that score.' })
    }
  }

  const fullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.()
    else frameRef.current?.requestFullscreen?.().catch(() => {})
  }

  const playing = screen === 'playing' || screen === 'paused'
  const outcomeText = final && { win: 'Blue wins', loss: 'Red wins', tie: 'Tie match', solo: `${final.blue.total} points` }[final.outcome]
  const q = query.trim().toLowerCase()
  const shown = specs.filter((s) =>
    (filter === 'all' ? true : filter === 'turret' ? s.turret : filter === 'climb' ? s.climb > 0 : filter === 'trench' ? s.trench : true) &&
    (!q || `${s.label} ${s.robot} ${s.team}`.toLowerCase().includes(q)))
  // The arrows beside the robot step through whatever the strip is showing.
  const stepRobot = (dir) => {
    const list = shown.length ? shown : specs
    const i = list.findIndex((s) => s.key === spec?.key)
    const next = list[(i + dir + list.length) % list.length]
    if (next) setRobotKey(next.key)
  }
  const maxOf = (f) => Math.max(...specs.map(f), 1)
  // [label, 0..1 against the strongest robot, value, unit]
  const statRows = spec
    ? [
        ['Top speed', spec.speed / maxOf((s) => s.speed), spec.speed.toFixed(1), 'm/s'],
        ['Hopper', spec.capacity / maxOf((s) => s.capacity), String(spec.capacity), 'fuel'],
        ['Fire rate', spec.fireRate / maxOf((s) => s.fireRate), String(Math.round(spec.fireRate)), 'per s'],
        ['Range', spec.shot.maxRange / maxOf((s) => s.shot.maxRange), `${spec.shot.minRange.toFixed(1)}–${spec.shot.maxRange.toFixed(1)}`, 'm'],
        ['Shoots moving', spec.shot.moveSpeed / maxOf((s) => s.shot.moveSpeed), `up to ${spec.shot.moveSpeed.toFixed(1)}`, 'm/s'],
      ]
    : []
  const lanes = spec ? spec.shot.exits.length : 1
  const traits = spec
    ? [
        spec.turret
          ? (lanes > 1 ? 'Twin turrets' : 'Turret')
          : lanes > 1 ? `Wide shooter, ${lanes} abreast` : 'Fixed shooter',
        spec.trench ? 'fits under the trench' : 'too tall for the trench',
        spec.special === 'climb' ? `X climbs to L${spec.climb}` : 'X passes fuel home',
      ].filter(Boolean)
    : []

  return (
    <div className={styles.game}>
      <div ref={frameRef} className={styles.frame} tabIndex={-1}>
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          role="img"
          aria-label="Cycle Rush 3D playing field"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onContextMenu={(e) => e.preventDefault()}
        />

        {playing && hud && (
          <>
            <div className={styles.hud}>
              <div className={styles.side}>
                <span className={`${styles.score} ${styles.blue}`}>{hud.blue}</span>
                <span className={`${styles.hub} ${hud.hubs.blue.on ? styles.hubOn : ''}`}>
                  {hud.hubs.blue.on ? 'Hub live' : 'Hub dark'}
                  {hud.hubs.blue.change != null ? ` · ${hud.hubs.blue.change}s` : ''}
                </span>
              </div>
              <div className={styles.clock}>
                <span className={styles.clockNum}>
                  {hud.period === 'countdown' ? Math.ceil(-hud.clock) : hud.left == null ? fmtClock(hud.clock) : fmtClock(hud.left)}
                </span>
                <span className={styles.period}>{hud.label}</span>
              </div>
              {hud.opponents ? (
                <div className={`${styles.side} ${styles.sideRed}`}>
                  <span className={`${styles.score} ${styles.red}`}>{hud.red}</span>
                  <span className={`${styles.hub} ${hud.hubs.red.on ? styles.hubOnRed : ''}`}>
                    {hud.hubs.red.on ? 'Hub live' : 'Hub dark'}
                    {hud.hubs.red.change != null ? ` · ${hud.hubs.red.change}s` : ''}
                  </span>
                </div>
              ) : (
                <div className={`${styles.side} ${styles.sideRed}`}>
                  <span className={styles.score}>{hud.made}/{hud.fired}</span>
                  <span className={styles.hub}>Shots made</span>
                </div>
              )}
            </div>

            <div className={styles.robot}>
              <span className={styles.robotName}>{spec?.label} · {spec?.robot}</span>
              <span className={styles.meter} aria-label={`Carrying ${hud.carry} of ${hud.capacity}`}>
                <span className={styles.meterFill} style={{ transform: `scaleX(${hud.carry / hud.capacity})` }} />
              </span>
              <span className={styles.carry}>
                {hud.carry} / {hud.capacity} fuel{hud.health?.broken ? ' · intake broken' : hud.intake ? ' · intaking' : ''}
              </span>
              {hud.aim && <span className={styles.aim} data-state={hud.aimState}>{hud.aim}</span>}
              {hud.health && (
                <span className={styles.battery} data-level={hud.health.volts < 7.5 ? 'low' : hud.health.volts < 10 ? 'mid' : 'ok'}>
                  <span className={styles.volts}>{hud.health.volts.toFixed(1)} V</span>
                  <span className={styles.batteryBar}><span className={styles.batteryFill} style={{ transform: `scaleX(${hud.health.soc})` }} /></span>
                </span>
              )}
              {hud.health && (hud.health.brownout || hud.health.broken || hud.health.jam || hud.health.comms || hud.health.hot) && (
                <span className={styles.alerts}>
                  {hud.health.brownout && <span className={`${styles.alert} ${styles.alertBad}`}>Brownout</span>}
                  {hud.health.comms && <span className={`${styles.alert} ${styles.alertBad}`}>No radio</span>}
                  {hud.health.broken && <span className={`${styles.alert} ${styles.alertBad}`}>Intake broken</span>}
                  {hud.health.jam && <span className={styles.alert}>Shooter jammed</span>}
                  {hud.health.hot && <span className={styles.alert}>Motors hot</span>}
                </span>
              )}
              {hud.climbable && <span className={styles.tip}>In the climb box: hold X to climb</span>}
              {/* What the three action keys do right now. */}
              <ul className={styles.keys} aria-label="Controls">
                <li><kbd>Space</kbd>Shoot</li>
                <li><kbd>Shift</kbd>Intake</li>
                <li><kbd>X</kbd>{hud.special}</li>
              </ul>
              {hud.climb !== 'none' && (
                <span className={styles.tip}>{hud.climb === 'done' ? `Hanging on L${hud.climbLevel}` : `Climbing to L${hud.climbLevel}…`}</span>
              )}
            </div>

            {hud.feed.length > 0 && (
              <ul className={styles.feed} aria-live="polite">
                {hud.feed.map((f) => (
                  <li key={`${f.id}-${f.at}`} className={`${styles.feedItem} ${f.player ? styles.feedMine : ''}`}>
                    <span className={f.team === 'blue' ? styles.blue : styles.red}>{f.player ? 'You' : f.label}</span> {f.text}
                  </li>
                ))}
              </ul>
            )}

            {/* The same three, as buttons, where there is no keyboard. */}
            <div className={styles.pads}>
              <button type="button" className={`${styles.pad} ${intakeLatch ? styles.padOn : ''}`} aria-pressed={intakeLatch} onClick={toggleIntakePad}>Intake</button>
              <button type="button" className={styles.pad} {...hold('special')}>{hud.special}</button>
              <button type="button" className={`${styles.pad} ${styles.padMain}`} {...hold('fire')}>Shoot</button>
            </div>

            <div className={styles.toolbar}>
              <button type="button" className={styles.tool} onClick={cycleCamera} title="Camera (V)">
                {CAMERA_LABEL[camera]}
              </button>
              {mode === 'practice' && (
                <button type="button" className={styles.tool} onClick={endPractice}>End session</button>
              )}
              <button type="button" className={styles.tool} onClick={togglePause}>
                {screen === 'paused' ? 'Resume' : 'Pause'}
              </button>
              <button type="button" className={styles.tool} onClick={fullscreen}>Full screen</button>
            </div>
          </>
        )}

        {screen === 'loading' && (
          <div className={`${styles.overlay} ${styles.loadingWrap}`}>
            <div className={styles.loadingCard}>
              <span className={styles.brandEyebrow}>FRC 5805 Arcade</span>
              <span className={styles.brandTitle}>Cycle Rush</span>
              <span className={styles.loadingBar} aria-hidden="true"><span /></span>
              <p className={styles.loading}>Loading the field, 22 robots and the physics engine…</p>
            </div>
          </div>
        )}

        {screen === 'error' && (
          <div className={styles.overlay}>
            <div className={styles.panel}>
              <h2 className={styles.panelTitle}>This browser can’t run the game</h2>
              <p className={styles.panelText}>It needs WebGL and WebAssembly. Try an up-to-date Chrome, Edge, Firefox or Safari.</p>
              {loadError && <p className={styles.muted}>{loadError}</p>}
            </div>
          </div>
        )}

        {screen === 'menu' && spec && (
          <div className={styles.picker}>
            <header className={styles.pickTop}>
              <div className={styles.brand}>
                <span className={styles.brandEyebrow}>FRC 5805 Arcade</span>
                <span className={styles.brandTitle}>Cycle Rush</span>
              </div>
              <div className={styles.modeBox}>
                <div className={styles.tabs} role="radiogroup" aria-label="Mode">
                  {Object.entries(MODES).map(([id, m]) => (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={mode === id}
                      className={`${styles.tab} ${mode === id ? styles.tabOn : ''}`}
                      onClick={() => setMode(id)}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
                <p className={styles.tabNote}>{arcade.modes[mode]}</p>
              </div>
            </header>

            <section className={styles.pickInfo} aria-live="polite">
              {spec.source === 'numbers' && <span className={styles.home}>Our robot</span>}
              <p className={styles.pickTeam}>{spec.team}</p>
              <p className={styles.pickNum} style={{ '--team': readable(spec.colors?.primary) || 'var(--accent-data)' }}>{spec.label}</p>
              <h2 className={styles.pickName}>{spec.robot}</h2>
              <p className={styles.traits}>{traits.join('  ·  ')}</p>
              <dl className={styles.specs}>
                {statRows.map(([k, v, value, unit]) => (
                  <div key={k} className={styles.spec}>
                    <dt className={styles.specLabel}>{k}</dt>
                    <dd className={styles.specValue}>{value}<span className={styles.specUnit}>{unit}</span></dd>
                    <dd className={styles.specBar} aria-hidden="true">
                      <span className={styles.specFill} style={{ transform: `scaleX(${Math.max(0.03, Math.min(1, v))})` }} />
                    </dd>
                  </div>
                ))}
              </dl>
            </section>

            <div className={styles.pickStage}>
              {mods.current && pal && (
                <PreviewBoundary>
                  <Suspense fallback={<span className={styles.previewNote}>Loading the preview…</span>}>
                    <RobotPreview assets={mods.current.assets} spec={spec} pal={pal} />
                  </Suspense>
                </PreviewBoundary>
              )}
              <button type="button" className={`${styles.cycle} ${styles.cyclePrev}`} onClick={() => stepRobot(-1)} aria-label="Previous robot">‹</button>
              <button type="button" className={`${styles.cycle} ${styles.cycleNext}`} onClick={() => stepRobot(1)} aria-label="Next robot">›</button>
            </div>

            <section className={styles.pickSide} aria-label="Match options">
              {mode === 'match' && (
                <div className={styles.option}>
                  <span className={styles.optionLabel}>Opponents</span>
                  <div className={styles.seg} role="radiogroup" aria-label="Difficulty">
                    {arcade.difficulties.map((d) => (
                      <button key={d.id} type="button" role="radio" aria-checked={difficulty === d.id} title={d.blurb}
                        className={`${styles.segBtn} ${difficulty === d.id ? styles.segOn : ''}`} onClick={() => setDifficulty(d.id)}>
                        {d.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className={styles.option}>
                <span className={styles.optionLabel}>Realism</span>
                <div className={styles.seg} role="radiogroup" aria-label="Realism">
                  {Object.entries(REALISM).map(([id, r]) => (
                    <button key={id} type="button" role="radio" aria-checked={realism === id}
                      className={`${styles.segBtn} ${realism === id ? styles.segOn : ''}`} onClick={() => setRealism(id)}>
                      {r.label}
                    </button>
                  ))}
                </div>
                <p className={styles.optionNote}>{REALISM[realism].blurb}</p>
              </div>
              <button type="button" className={`btn btn--gold ${styles.startBtn}`} onClick={start}>
                Start {MODES[mode].label.toLowerCase()}
              </button>
              <p className={styles.hint}>{best > 0 ? `Your best with ${spec.label} here: ${best} · ` : ''}Esc pauses</p>
            </section>

            <nav className={styles.strip} aria-label="Robots">
              <div className={styles.stripTools}>
                <input
                  type="search"
                  className={styles.search}
                  placeholder="Search"
                  aria-label="Search robots by number, name or team"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <div className={styles.filters} role="radiogroup" aria-label="Show">
                  {[['all', 'All'], ['turret', 'Turret'], ['climb', 'Climbs'], ['trench', 'Trench']].map(([id, label]) => (
                    <button key={id} type="button" role="radio" aria-checked={filter === id}
                      className={`${styles.chip} ${filter === id ? styles.chipOn : ''}`} onClick={() => setFilter(id)}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <ul ref={tilesRef} className={styles.tiles} role="radiogroup" aria-label="Robot">
                {shown.map((s) => (
                  <li key={s.key}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={spec.key === s.key}
                      data-key={s.key}
                      className={`${styles.tile} ${spec.key === s.key ? styles.tileOn : ''}`}
                      style={{ '--team': readable(s.colors?.primary) || 'var(--text-muted)' }}
                      onClick={() => setRobotKey(s.key)}
                    >
                      <span className={styles.tileNum}>{s.label}</span>
                      <span className={styles.tileName}>{s.robot}</span>
                      {s.source === 'numbers' && <span className={styles.tileHome} aria-label="Our robot">★</span>}
                    </button>
                  </li>
                ))}
                {shown.length === 0 && <li className={styles.empty}>No robot matches.</li>}
              </ul>
            </nav>
          </div>
        )}

        {screen === 'paused' && (
          <div className={`${styles.overlay} ${styles.pauseWrap}`}>
            <div className={`${styles.panel} ${styles.pause}`} role="dialog" aria-modal="true" aria-labelledby="arcade-paused">
              <p className={styles.pauseEyebrow}>{spec?.label} · {spec?.robot} · {MODES[mode].label}</p>
              <h2 id="arcade-paused" className={styles.panelTitle}>Paused</h2>
              <div className={styles.pauseMenu}>
                <button type="button" className={`btn btn--gold ${styles.pauseBtn}`} onClick={togglePause} autoFocus>Resume</button>
                <button type="button" className={`btn btn--ghost ${styles.pauseBtn}`} onClick={start}>Restart</button>
                {mode === 'practice' && (
                  <button type="button" className={`btn btn--ghost ${styles.pauseBtn}`} onClick={endPractice}>End session</button>
                )}
                <button type="button" className={`btn btn--ghost ${styles.pauseBtn}`} onClick={cycleCamera}>Camera: {CAMERA_LABEL[camera]}</button>
                <button type="button" className={`btn btn--ghost ${styles.pauseBtn}`} onClick={toMenu}>Quit to setup</button>
              </div>
              <dl className={styles.pauseKeys}>
                {arcade.controls.keyboard.slice(0, 8).map(([k, v]) => (
                  <div key={k}><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>
                ))}
              </dl>
              <p className={styles.muted}>Esc to resume</p>
            </div>
          </div>
        )}

        {screen === 'over' && final && (
          <div className={styles.overlay}>
            <div className={styles.panel} aria-live="polite">
              <h2 className={`${styles.panelTitle} ${styles[final.outcome] || ''}`}>{outcomeText}</h2>
              {final.outcome !== 'solo' && (
                <p className={styles.final}>
                  <span className={styles.blue}>{final.blue.total}</span>
                  <span className={styles.dash}>–</span>
                  <span className={styles.red}>{final.red.total}</span>
                </p>
              )}
              <dl className={styles.breakdown}>
                <div><dt>Fuel</dt><dd>{final.blue.fuel}</dd></div>
                {final.mode !== 'skills' && final.mode !== 'practice' && <div><dt>In auto</dt><dd>{final.blue.auto}</dd></div>}
                <div><dt>Climb</dt><dd>{final.blue.climb}</dd></div>
                {final.blue.wasted > 0 && <div><dt>Into a dark hub</dt><dd>{final.blue.wasted}</dd></div>}
                <div><dt>Your shots</dt><dd>{final.made}/{final.fired}</dd></div>
                <div><dt>Picked up</dt><dd>{final.intaken}</dd></div>
                <div><dt>Driven</dt><dd>{Math.round(final.distance)} m</dd></div>
                <div><dt>Top speed</dt><dd>{final.topSpeed.toFixed(1)} m/s</dd></div>
                <div><dt>Your climb</dt><dd>{final.climb ? `L${final.climb}` : '—'}</dd></div>
                {final.health && <div><dt>Brownouts</dt><dd>{final.health.brownouts}</dd></div>}
                {final.health && <div><dt>Lowest voltage</dt><dd>{final.health.minVolts.toFixed(1)} V</dd></div>}
                {final.health?.intakeBroken && <div><dt>Intake</dt><dd>Broke</dd></div>}
              </dl>
              {final.best > 0 && <p className={styles.muted}>Best with {final.robot.label} here: {final.best}</p>}
              {leaderboardEnabled && final.mode === 'match' && post.state !== 'done' && (
                <form className={styles.post} onSubmit={onSubmit}>
                  <label className={styles.muted} htmlFor="arcade-name">Name for the leaderboard</label>
                  <div className={styles.row}>
                    <input
                      id="arcade-name"
                      className={styles.input}
                      value={name}
                      maxLength={16}
                      autoComplete="nickname"
                      onChange={(e) => setName(e.target.value)}
                      placeholder="First name or initials"
                    />
                    <button type="submit" className="btn btn--cyan" disabled={post.state === 'sending' || !name.trim()}>
                      {post.state === 'sending' ? 'Posting…' : 'Post score'}
                    </button>
                  </div>
                </form>
              )}
              {post.msg && <p className={post.state === 'error' ? styles.err : styles.ok}>{post.msg}</p>}
              <div className={styles.row}>
                <button type="button" className="btn btn--gold" onClick={start}>Play again</button>
                <button type="button" className="btn btn--ghost" onClick={toMenu}>Change robot or mode</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {leaderboardEnabled && mode === 'match' && (
        <section className={styles.board} aria-labelledby="arcade-board">
          <h3 id="arcade-board" className={styles.boardTitle}>
            Leaderboard · {arcade.difficulties.find((d) => d.id === difficulty)?.label}
          </h3>
          {board.error && <p className={styles.err}>{board.error}</p>}
          {!board.error && !board.loading && board.rows.length === 0 && <p className={styles.muted}>No scores yet. Be first.</p>}
          {board.rows.length > 0 && (
            <ol className={styles.rows}>
              {board.rows.map((r, i) => (
                <li key={`${r.name}-${i}`} className={styles.rowItem}>
                  <span className={styles.rank}>{i + 1}</span>
                  <span className={styles.rowName}>{r.name}</span>
                  <span className={styles.rowScore}>{r.blue}–{r.red}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </div>
  )
}

