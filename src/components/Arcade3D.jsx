import { useCallback, useEffect, useRef, useState } from 'react'
import { ARCHETYPES, ARCHETYPE_IDS, HUB, MATCH } from '../lib/arcade3d/config'
import { hubActive, untilHubChange, periodLabel } from '../lib/arcade3d/rules'
import {
  leaderboardEnabled, localBest, saveLocalBest, fetchTop, startRun, submitScore,
} from '../lib/arcade/leaderboard'
import { arcade } from '../data/arcade'
import { getLenis } from '../lib/smoothScroll'
import styles from './Arcade3D.module.css'

const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'KeyJ', 'ShiftLeft', 'ShiftRight', 'KeyC', 'KeyV',
])
const CAMERAS = ['driver', 'chase', 'overhead']
const CAMERA_LABEL = { driver: 'Driver station', chase: 'Chase', overhead: 'Overhead' }
const NAME_KEY = 'frc5805.arcade.name'
const MAX_STEPS_PER_FRAME = 4

const fmtClock = (t) => {
  const left = Math.max(0, Math.ceil(MATCH.total - Math.max(0, t)))
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
}
const readStored = (k, d) => {
  try { return localStorage.getItem(k) || d } catch { return d }
}
const store = (k, v) => {
  try { localStorage.setItem(k, v) } catch { /* not remembered */ }
}

/** Bars for the archetype cards: 0..1 against the strongest archetype. */
function statBars(a) {
  const max = (f) => Math.max(...ARCHETYPE_IDS.map((id) => f(ARCHETYPES[id])))
  return [
    ['Speed', a.speed / max((x) => x.speed)],
    ['Hopper', a.capacity / max((x) => x.capacity)],
    ['Range', a.exit / max((x) => x.exit)],
    ['Climb', a.climb / 3],
  ]
}

export default function Arcade3D() {
  const frameRef = useRef(null)
  const canvasRef = useRef(null)
  const mods = useRef(null) // { R, sim, scene module }
  const viewRef = useRef(null) // the three.js scene
  const simRef = useRef(null)
  const screenRef = useRef('loading')
  const camRef = useRef(readStored('frc5805.arcade.camera', 'driver'))
  const keys = useRef(new Set())
  const mouse = useRef({ active: false, x: 0, y: 0, down: false })
  const touches = useRef(new Map())
  const runRef = useRef(null)

  const [screen, setScreenState] = useState('loading')
  const [loadError, setLoadError] = useState('')
  const [arch, setArch] = useState(() => (ARCHETYPES[readStored('frc5805.arcade.arch', '')] ? readStored('frc5805.arcade.arch', '') : 'turret'))
  const [difficulty, setDifficulty] = useState('regional')
  const [camera, setCameraState] = useState(camRef.current)
  const [hud, setHud] = useState(null)
  const [final, setFinal] = useState(null)
  const [best, setBest] = useState(() => localBest('regional'))
  const [board, setBoard] = useState({ loading: false, rows: [], error: '' })
  const [name, setName] = useState(() => readStored(NAME_KEY, ''))
  const [post, setPost] = useState({ state: 'idle', msg: '' })

  const setScreen = useCallback((s) => {
    screenRef.current = s
    setScreenState(s)
  }, [])

  // ---- load three.js + Rapier only when the page is opened
  useEffect(() => {
    let cancelled = false
    let raf = 0
    let ro = null
    ;(async () => {
      try {
        const [rapierMod, simMod, sceneMod, rig] = await Promise.all([
          import('@dimforge/rapier3d-compat'),
          import('../lib/arcade3d/sim'),
          import('../lib/arcade3d/scene'),
          import('./robot/robotRig'),
        ])
        const R = rapierMod.init ? rapierMod : rapierMod.default
        await R.init()
        if (cancelled) return
        mods.current = { R, ...simMod }
        const cs = getComputedStyle(frameRef.current)
        const tok = (n, d) => cs.getPropertyValue(n).trim() || d
        const view = sceneMod.createScene(canvasRef.current, {
          void: tok('--bg-void', '#050505'),
          blue: tok('--brand-blue-lift', '#2f74c8'),
          red: tok('--danger', '#f06363'),
          gold: tok('--accent-gold', '#d9c68a'),
          muted: tok('--text-muted', '#8d8f96'),
          fuel: tok('--arcade-fuel', '#f0c43c'),
        }, {
          // the hub cut from FIRST's field model, shared with the robot page
          loadHub: () => rig.loadHub(`${import.meta.env.BASE_URL}models/`),
        })
        viewRef.current = view
        ro = new ResizeObserver(([entry]) => {
          const { width, height } = entry.contentRect
          view.resize(width, height, Math.min(window.devicePixelRatio || 1, 2))
        })
        ro.observe(canvasRef.current)
        newDemo()
        setScreen('menu')
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

  function newDemo() {
    const m = mods.current
    if (simRef.current) m.destroySim(simRef.current)
    const sim = m.createSim(m.R, { difficulty: 'regional', demo: true })
    sim.clock = 0
    simRef.current = sim
    viewRef.current.attach(sim)
    viewRef.current.setCamera('broadcast')
  }

  function snapshot(sim) {
    const me = sim.robots[0]
    const t = sim.clock
    const hubs = {}
    for (const team of ['blue', 'red']) {
      const on = t >= 0 && hubActive(t, team, sim.autoWinner)
      // Until auto is decided nobody knows which hub goes dark first, so no countdown.
      const change = t >= 0 && sim.autoWinner ? untilHubChange(t, team, sim.autoWinner) : Infinity
      hubs[team] = { on, change: Number.isFinite(change) ? Math.ceil(change) : null }
    }
    const climbable =
      sim.period === 'endgame' && me.a.climb > 0 && me.climb.state === 'none' && mods.current.inClimbZone(me)
    return {
      clock: t,
      period: sim.period,
      label: periodLabel(t),
      blue: sim.score.blue.total,
      red: sim.score.red.total,
      hubs,
      carry: me.carry,
      capacity: me.a.capacity,
      climb: me.climb.state,
      climbLevel: me.climb.level,
      climbable,
      auto: sim.period === 'auto',
    }
  }

  // ---- input
  function readInput() {
    const sim = simRef.current
    const view = viewRef.current
    const me = sim.robots[0]
    const k = keys.current
    const b = view.basis()
    let fwd = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0)
    let strafe = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0)
    let aim = null
    let turn = (k.has('ArrowRight') ? 1 : 0) - (k.has('ArrowLeft') ? 1 : 0)
    let fire = k.has('Space') || k.has('KeyJ') || mouse.current.down
    if (mouse.current.active && !turn) {
      const p = view.pick(mouse.current.x, mouse.current.y)
      if (p && Math.hypot(p.x - me.x, p.z - me.z) > 0.4) aim = Math.atan2(p.z - me.z, p.x - me.x)
    }
    for (const tch of touches.current.values()) {
      if (tch.side === 'left') {
        strafe = tch.dx
        fwd = -tch.dy
      } else if (Math.hypot(tch.dx, tch.dy) > 0.25) {
        const ax = b.fx * -tch.dy + b.rx * tch.dx
        const az = b.fz * -tch.dy + b.rz * tch.dx
        aim = Math.atan2(az, ax)
        if (Math.hypot(tch.dx, tch.dy) > 0.85) fire = true
      }
    }
    if (k.has('ShiftLeft') || k.has('ShiftRight')) aim = Math.atan2(HUB.blue.z - me.z, HUB.blue.x - me.x)
    if (k.has('ArrowUp')) aim = Math.atan2(HUB.blue.z - me.z, HUB.blue.x - me.x)
    return {
      vx: b.fx * fwd + b.rx * strafe,
      vz: b.fz * fwd + b.rz * strafe,
      aim,
      turn: aim == null ? turn : 0,
      fire,
      climb: k.has('KeyC') || climbTap.current,
    }
  }
  const climbTap = useRef(false)

  // ---- leaderboard
  const loadBoard = useCallback((d) => {
    if (!leaderboardEnabled) return
    setBoard((b) => ({ ...b, loading: true, error: '' }))
    fetchTop(d)
      .then((rows) => setBoard({ loading: false, rows, error: '' }))
      .catch(() => setBoard({ loading: false, rows: [], error: 'The leaderboard is offline right now.' }))
  }, [])
  useEffect(() => {
    setBest(localBest(difficulty))
    loadBoard(difficulty)
  }, [difficulty, loadBoard])

  // ---- match lifecycle
  const start = useCallback(async () => {
    const m = mods.current
    if (!m) return
    keys.current.clear()
    touches.current.clear()
    mouse.current.down = false
    climbTap.current = false
    store('frc5805.arcade.arch', arch)
    if (simRef.current) m.destroySim(simRef.current)
    const sim = m.createSim(m.R, { difficulty, arch })
    simRef.current = sim
    viewRef.current.attach(sim)
    viewRef.current.setCamera(camRef.current)
    setFinal(null)
    setHud(snapshot(sim))
    setScreen('playing')
    frameRef.current?.focus({ preventScroll: true })
    // Bring the whole field into view, below the floating nav, so the HUD is not under it.
    const frame = frameRef.current
    if (frame) {
      const nav = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--nav-h')) || 72
      const top = frame.getBoundingClientRect().top + window.scrollY - nav - 12
      const lenis = getLenis()
      if (lenis) lenis.scrollTo(top, { duration: 0.6 })
      else window.scrollTo({ top, behavior: 'smooth' })
    }
    runRef.current = null
    runRef.current = await startRun(difficulty)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arch, difficulty, setScreen])

  function endMatch(sim) {
    const r = mods.current.result(sim)
    saveLocalBest(sim.difficulty, r.blue.total)
    setBest(localBest(sim.difficulty))
    setHud(snapshot(sim))
    setFinal({ ...r, difficulty: sim.difficulty, arch: sim.robots[0].arch })
    setPost({ state: 'idle', msg: '' })
    setScreen('over')
  }

  const togglePause = useCallback(() => {
    if (screenRef.current === 'playing') setScreen('paused')
    else if (screenRef.current === 'paused') setScreen('playing')
    keys.current.clear()
    mouse.current.down = false
  }, [setScreen])

  const toMenu = useCallback(() => {
    newDemo()
    setHud(null)
    setScreen('menu')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setScreen])

  const cycleCamera = useCallback(() => {
    const next = CAMERAS[(CAMERAS.indexOf(camRef.current) + 1) % CAMERAS.length]
    camRef.current = next
    setCameraState(next)
    store('frc5805.arcade.camera', next)
    if (simRef.current && !simRef.current.demo) viewRef.current?.setCamera(next)
  }, [])

  // ---- keyboard, only while a match is up
  useEffect(() => {
    if (screen !== 'playing' && screen !== 'paused') return
    const down = (e) => {
      if (e.target instanceof HTMLInputElement) return
      if (e.code === 'Escape' || e.code === 'KeyP') { e.preventDefault(); togglePause(); return }
      if (e.code === 'KeyV' && !e.repeat) { e.preventDefault(); cycleCamera(); return }
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
  }, [screen, togglePause, cycleCamera])

  // ---- pointer
  const ndc = (e) => {
    const rect = canvasRef.current.getBoundingClientRect()
    return {
      cx: e.clientX - rect.left,
      cy: e.clientY - rect.top,
      w: rect.width,
      x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
      y: -(((e.clientY - rect.top) / rect.height) * 2 - 1),
    }
  }
  const onPointerDown = (e) => {
    if (screenRef.current !== 'playing') return
    const p = ndc(e)
    if (e.pointerType === 'mouse') {
      mouse.current = { active: true, x: p.x, y: p.y, down: e.button === 0 }
      return
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    touches.current.set(e.pointerId, { side: p.cx < p.w / 2 ? 'left' : 'right', ox: p.cx, oy: p.cy, dx: 0, dy: 0 })
  }
  const onPointerMove = (e) => {
    const p = ndc(e)
    if (e.pointerType === 'mouse') {
      mouse.current.active = true
      mouse.current.x = p.x
      mouse.current.y = p.y
      return
    }
    const t = touches.current.get(e.pointerId)
    if (!t) return
    let dx = (p.cx - t.ox) / 50
    let dy = (p.cy - t.oy) / 50
    const m = Math.hypot(dx, dy)
    if (m > 1) { dx /= m; dy /= m }
    t.dx = dx
    t.dy = dy
  }
  const onPointerUp = (e) => {
    if (e.pointerType === 'mouse') mouse.current.down = false
    touches.current.delete(e.pointerId)
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
  const outcomeText = final && { win: 'Blue wins', loss: 'Red wins', tie: 'Tie match' }[final.outcome]
  const archInfo = ARCHETYPES[arch]

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
          onPointerLeave={(e) => { if (e.pointerType === 'mouse') { mouse.current.down = false; mouse.current.active = false } }}
          onContextMenu={(e) => e.preventDefault()}
        />

        {playing && hud && (
          <>
            <div className={styles.hud}>
              <div className={styles.side}>
                <span className={`${styles.score} ${styles.blue}`}>{hud.blue}</span>
                <span className={`${styles.hub} ${hud.hubs.blue.on ? styles.hubOn : ''}`}>
                  {hud.hubs.blue.on ? 'Hub live' : 'Hub dark'}
                  {hud.hubs.blue.change != null && hud.period !== 'countdown' ? ` · ${hud.hubs.blue.change}s` : ''}
                </span>
              </div>
              <div className={styles.clock}>
                <span className={styles.clockNum}>{hud.period === 'countdown' ? Math.ceil(-hud.clock) : fmtClock(hud.clock)}</span>
                <span className={styles.period}>{hud.label}</span>
              </div>
              <div className={`${styles.side} ${styles.sideRed}`}>
                <span className={`${styles.score} ${styles.red}`}>{hud.red}</span>
                <span className={`${styles.hub} ${hud.hubs.red.on ? styles.hubOnRed : ''}`}>
                  {hud.hubs.red.on ? 'Hub live' : 'Hub dark'}
                  {hud.hubs.red.change != null && hud.period !== 'countdown' ? ` · ${hud.hubs.red.change}s` : ''}
                </span>
              </div>
            </div>

            <div className={styles.robot}>
              <span className={styles.robotName}>5805 · {ARCHETYPES[simRef.current?.robots[0].arch]?.label}</span>
              <span className={styles.meter} aria-label={`Carrying ${hud.carry} of ${hud.capacity}`}>
                <span className={styles.meterFill} style={{ transform: `scaleX(${hud.carry / hud.capacity})` }} />
              </span>
              <span className={styles.carry}>{hud.carry} / {hud.capacity} fuel</span>
              {hud.auto && <span className={styles.tip}>Auto: your robot is running its own routine</span>}
              {hud.climbable && (
                <button type="button" className={styles.climb} onClick={() => { climbTap.current = true }}>
                  Climb (C)
                </button>
              )}
              {hud.climb !== 'none' && (
                <span className={styles.tip}>{hud.climb === 'done' ? `Hanging on L${hud.climbLevel}` : `Climbing to L${hud.climbLevel}…`}</span>
              )}
            </div>

            <div className={styles.toolbar}>
              <button type="button" className={styles.tool} onClick={cycleCamera} title="Camera (V)">
                {CAMERA_LABEL[camera]}
              </button>
              <button type="button" className={styles.tool} onClick={togglePause}>
                {screen === 'paused' ? 'Resume' : 'Pause'}
              </button>
              <button type="button" className={styles.tool} onClick={fullscreen}>Full screen</button>
            </div>
          </>
        )}

        {screen === 'loading' && (
          <div className={styles.overlay}>
            <p className={styles.loading}>Loading the field and the physics engine…</p>
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

        {screen === 'menu' && (
          <div className={styles.overlay}>
            <div className={`${styles.panel} ${styles.menu}`}>
              <h2 className={styles.panelTitle}>Pick your robot</h2>
              <div className={styles.archs} role="radiogroup" aria-label="Robot">
                {ARCHETYPE_IDS.map((id) => {
                  const a = ARCHETYPES[id]
                  return (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={arch === id}
                      className={`${styles.arch} ${arch === id ? styles.archOn : ''}`}
                      onClick={() => setArch(id)}
                    >
                      <span className={styles.archLabel}>{a.label}</span>
                      <span className={styles.archBlurb}>{a.blurb}</span>
                      <span className={styles.stats}>
                        {statBars(a).map(([k, v]) => (
                          <span key={k} className={styles.stat}>
                            <span className={styles.statName}>{k}</span>
                            <span className={styles.statBar}>
                              <span className={styles.statFill} style={{ transform: `scaleX(${v})` }} />
                            </span>
                          </span>
                        ))}
                      </span>
                    </button>
                  )
                })}
              </div>
              <div className={styles.diffs} role="radiogroup" aria-label="Difficulty">
                {arcade.difficulties.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    role="radio"
                    aria-checked={difficulty === d.id}
                    title={d.blurb}
                    className={`${styles.diff} ${difficulty === d.id ? styles.diffOn : ''}`}
                    onClick={() => setDifficulty(d.id)}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
              <button type="button" className="btn btn--gold" onClick={start}>
                Start match as the {archInfo.label.toLowerCase()}
              </button>
              {best > 0 && <p className={styles.muted}>Your best on {difficulty}: {best}</p>}
            </div>
          </div>
        )}

        {screen === 'paused' && (
          <div className={styles.overlay}>
            <div className={styles.panel}>
              <h2 className={styles.panelTitle}>Paused</h2>
              <div className={styles.row}>
                <button type="button" className="btn btn--gold" onClick={togglePause}>Resume</button>
                <button type="button" className="btn btn--ghost" onClick={toMenu}>Quit</button>
              </div>
            </div>
          </div>
        )}

        {screen === 'over' && final && (
          <div className={styles.overlay}>
            <div className={styles.panel} aria-live="polite">
              <h2 className={`${styles.panelTitle} ${styles[final.outcome]}`}>{outcomeText}</h2>
              <p className={styles.final}>
                <span className={styles.blue}>{final.blue.total}</span>
                <span className={styles.dash}>–</span>
                <span className={styles.red}>{final.red.total}</span>
              </p>
              <dl className={styles.breakdown}>
                <div><dt>Fuel</dt><dd>{final.blue.fuel}</dd></div>
                <div><dt>In auto</dt><dd>{final.blue.auto}</dd></div>
                <div><dt>Climb</dt><dd>{final.blue.climb}</dd></div>
                <div><dt>Into a dark hub</dt><dd>{final.blue.wasted}</dd></div>
                <div><dt>Your shots</dt><dd>{final.made}/{final.fired}</dd></div>
                <div><dt>Your climb</dt><dd>{final.climb ? `L${final.climb}` : '—'}</dd></div>
              </dl>
              {leaderboardEnabled && post.state !== 'done' && (
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
                <button type="button" className="btn btn--ghost" onClick={toMenu}>Change robot</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {leaderboardEnabled && (
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
