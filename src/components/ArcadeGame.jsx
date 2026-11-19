import { useCallback, useEffect, useRef, useState } from 'react'
import { createGame, step, result, player, FIELD, HUBS, MATCH } from '../lib/arcade/engine'
import { drawGame, readPalette } from '../lib/arcade/draw'
import {
  leaderboardEnabled, localBest, saveLocalBest, fetchTop, startRun, submitScore,
} from '../lib/arcade/leaderboard'
import { arcade } from '../data/arcade'
import styles from './ArcadeGame.module.css'

const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'KeyJ', 'ShiftLeft', 'ShiftRight',
])
const NAME_KEY = 'frc5805.arcade.name'

const fmtClock = (clock) => {
  const left = Math.max(0, Math.ceil(MATCH.total - Math.max(0, clock)))
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
}
const PHASE_LABEL = { countdown: 'Ready', auto: 'Auto', teleop: 'Teleop', endgame: 'Endgame', over: 'Final' }

function readName() {
  try { return localStorage.getItem(NAME_KEY) || '' } catch { return '' }
}

export default function ArcadeGame() {
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const gameRef = useRef(null)
  const sizeRef = useRef({ cssW: 800, dpr: 1 })
  const palRef = useRef(null)
  const keys = useRef(new Set())
  const mouse = useRef({ active: false, x: 0, y: 0, down: false })
  const touches = useRef(new Map()) // pointerId → { side, ox, oy, dx, dy }
  const runRef = useRef(null)

  const [screen, setScreen] = useState('menu') // menu | playing | paused | over
  const [difficulty, setDifficulty] = useState('regional')
  const [hud, setHud] = useState(null)
  const [final, setFinal] = useState(null)
  const [best, setBest] = useState(() => localBest('regional'))
  const [board, setBoard] = useState({ loading: false, rows: [], error: '' })
  const [name, setName] = useState(readName)
  const [post, setPost] = useState({ state: 'idle', msg: '' }) // idle | sending | done | error

  // ---- sizing: the canvas is always 2:1 and as wide as its frame
  useEffect(() => {
    const canvas = canvasRef.current
    palRef.current = readPalette(wrapRef.current)
    // Observe the canvas, not the frame: CSS decides its size (full width, or
    // fit-to-screen in full screen), and the backing store follows.
    const ro = new ResizeObserver(([entry]) => {
      const cssW = entry.contentRect.width
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(cssW * dpr)
      canvas.height = Math.round((cssW / 2) * dpr)
      sizeRef.current = { cssW, dpr }
      draw()
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [])

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

  // ---- input → the player's command for this frame
  const readInput = useCallback(() => {
    const k = keys.current
    const s = gameRef.current
    const p = player(s)
    let mx = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0)
    let my = (k.has('KeyS') ? 1 : 0) - (k.has('KeyW') ? 1 : 0)
    let fire = k.has('Space') || k.has('KeyJ') || mouse.current.down
    let aim = null
    const ax = (k.has('ArrowRight') ? 1 : 0) - (k.has('ArrowLeft') ? 1 : 0)
    const ay = (k.has('ArrowDown') ? 1 : 0) - (k.has('ArrowUp') ? 1 : 0)
    if (ax || ay) aim = Math.atan2(ay, ax)
    else if (mouse.current.active) aim = Math.atan2(mouse.current.y - p.y, mouse.current.x - p.x)
    for (const t of touches.current.values()) {
      if (t.side === 'left') { mx = t.dx; my = t.dy }
      else if (Math.hypot(t.dx, t.dy) > 0.25) {
        aim = Math.atan2(t.dy, t.dx)
        if (Math.hypot(t.dx, t.dy) > 0.8) fire = true
      }
    }
    if (k.has('ShiftLeft') || k.has('ShiftRight')) aim = Math.atan2(HUBS.blue.y - p.y, HUBS.blue.x - p.x)
    return { mx, my, aim, fire }
  }, [])

  // ---- the loop. Runs a demo match behind the menu, the real one when playing.
  useEffect(() => {
    if (screen === 'menu' && (!gameRef.current || !gameRef.current.demo)) {
      gameRef.current = createGame({ difficulty: 'regional', demo: true })
    }
    if (screen === 'paused' || screen === 'over') {
      draw()
      return
    }
    let raf = 0
    let last = performance.now()
    let lastHud = 0
    const frame = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const s = gameRef.current
      if (s.demo) {
        step(s, dt)
        if (s.phase === 'over') gameRef.current = createGame({ difficulty: 'regional', demo: true })
      } else {
        step(s, dt, readInput())
        if (now - lastHud > 100) {
          lastHud = now
          setHud({ clock: s.clock, phase: s.phase, blue: s.score.blue.total, red: s.score.red.total, carry: player(s).carry })
        }
        if (s.phase === 'over') {
          draw()
          endMatch(s)
          return
        }
      }
      draw()
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen])

  function draw() {
    const canvas = canvasRef.current
    const s = gameRef.current
    if (!canvas || !s || !palRef.current) return
    const { cssW, dpr } = sizeRef.current
    const sticks = [...touches.current.values()].map((t) => ({ x: t.ox, y: t.oy, dx: t.dx, dy: t.dy }))
    drawGame(canvas.getContext('2d'), s, { cssW, dpr, pal: palRef.current, aim: !s.demo, sticks })
  }

  function endMatch(s) {
    const r = result(s)
    saveLocalBest(s.difficulty, r.blue.total)
    setBest(localBest(s.difficulty))
    setHud({ clock: s.clock, phase: 'over', blue: r.blue.total, red: r.red.total, carry: 0 })
    setFinal(r)
    setPost({ state: 'idle', msg: '' })
    setScreen('over')
  }

  const start = useCallback(async (d) => {
    keys.current.clear()
    touches.current.clear()
    mouse.current.down = false
    gameRef.current = createGame({ difficulty: d })
    setFinal(null)
    setHud({ clock: -MATCH.countdown, phase: 'countdown', blue: 0, red: 0, carry: 1 })
    setScreen('playing')
    wrapRef.current?.focus({ preventScroll: true })
    runRef.current = null
    runRef.current = await startRun(d)
  }, [])

  const togglePause = useCallback(() => {
    setScreen((sc) => (sc === 'playing' ? 'paused' : sc === 'paused' ? 'playing' : sc))
    keys.current.clear()
  }, [])

  // ---- keyboard: only while a match is on screen, so the page scrolls normally otherwise
  useEffect(() => {
    if (screen !== 'playing' && screen !== 'paused') return
    const down = (e) => {
      if (e.target instanceof HTMLInputElement) return
      if (e.code === 'Escape' || e.code === 'KeyP') { e.preventDefault(); togglePause(); return }
      if (GAME_KEYS.has(e.code)) { e.preventDefault(); keys.current.add(e.code) }
    }
    const up = (e) => keys.current.delete(e.code)
    const blur = () => { if (screen === 'playing') togglePause() }
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
  }, [screen, togglePause])

  // ---- pointer: mouse aims and fires; touch is two virtual sticks
  const toField = (e) => {
    const rect = canvasRef.current.getBoundingClientRect()
    return {
      cx: e.clientX - rect.left,
      cy: e.clientY - rect.top,
      x: ((e.clientX - rect.left) / rect.width) * FIELD.w,
      y: ((e.clientY - rect.top) / rect.height) * FIELD.h,
      w: rect.width,
    }
  }
  const onPointerDown = (e) => {
    if (screen !== 'playing') return
    const f = toField(e)
    if (e.pointerType === 'mouse') {
      mouse.current = { active: true, x: f.x, y: f.y, down: e.button === 0 }
      return
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    touches.current.set(e.pointerId, { side: f.cx < f.w / 2 ? 'left' : 'right', ox: f.cx, oy: f.cy, dx: 0, dy: 0 })
  }
  const onPointerMove = (e) => {
    const f = toField(e)
    if (e.pointerType === 'mouse') {
      mouse.current.active = true
      mouse.current.x = f.x
      mouse.current.y = f.y
      return
    }
    const t = touches.current.get(e.pointerId)
    if (!t) return
    let dx = (f.cx - t.ox) / 44
    let dy = (f.cy - t.oy) / 44
    const m = Math.hypot(dx, dy)
    if (m > 1) { dx /= m; dy /= m }
    t.dx = dx
    t.dy = dy
  }
  const onPointerUp = (e) => {
    if (e.pointerType === 'mouse') mouse.current.down = false
    touches.current.delete(e.pointerId)
  }

  // ---- posting a score
  const onSubmit = async (e) => {
    e.preventDefault()
    const clean = name.trim().slice(0, 16)
    if (!clean || !final) return
    try { localStorage.setItem(NAME_KEY, clean) } catch { /* not remembered */ }
    setPost({ state: 'sending', msg: '' })
    try {
      const res = await submitScore({
        run: runRef.current,
        name: clean,
        difficulty: gameRef.current.difficulty,
        blue: final.blue.total,
        red: final.red.total,
        made: final.shotsMade,
        fired: final.shotsFired,
      })
      setPost({ state: 'done', msg: res.rank ? `Posted — #${res.rank} on ${gameRef.current.difficulty}.` : 'Posted.' })
      loadBoard(gameRef.current.difficulty)
    } catch (err) {
      setPost({ state: 'error', msg: err.message || 'Could not post that score.' })
    }
  }

  const fullscreen = () => {
    const el = wrapRef.current
    if (document.fullscreenElement) document.exitFullscreen?.()
    else el.requestFullscreen?.().catch(() => {})
  }

  const outcomeText = final && { win: 'Blue wins', loss: 'Red wins', tie: 'Tie match' }[final.outcome]
  const playing = screen === 'playing' || screen === 'paused'

  return (
    <div className={styles.game}>
      <div className={styles.hud} aria-hidden={!playing}>
        <div className={`${styles.score} ${styles.blue}`}>
          <span className={styles.scoreLabel}>Blue</span>
          <span className={styles.scoreNum}>{hud?.blue ?? 0}</span>
        </div>
        <div className={styles.clock}>
          <span className={styles.clockNum}>{hud ? fmtClock(hud.clock) : '2:00'}</span>
          <span className={styles.phase}>{hud ? PHASE_LABEL[hud.phase] : 'Cycle Rush'}</span>
        </div>
        <div className={`${styles.score} ${styles.red}`}>
          <span className={styles.scoreLabel}>Red</span>
          <span className={styles.scoreNum}>{hud?.red ?? 0}</span>
        </div>
      </div>

      <div
        ref={wrapRef}
        className={styles.frame}
        tabIndex={-1}
      >
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          role="img"
          aria-label="Cycle Rush playing field"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={(e) => { if (e.pointerType === 'mouse') mouse.current.down = false }}
          onContextMenu={(e) => e.preventDefault()}
        />

        {playing && (
          <div className={styles.toolbar}>
            <button type="button" className={styles.tool} onClick={togglePause}>
              {screen === 'paused' ? 'Resume' : 'Pause'}
            </button>
            <button type="button" className={styles.tool} onClick={fullscreen}>Full screen</button>
          </div>
        )}

        {screen === 'menu' && (
          <div className={styles.overlay}>
            <div className={styles.panel}>
              <h2 className={styles.panelTitle}>{arcade.title}</h2>
              <p className={styles.panelText}>Pick a difficulty to start a match.</p>
              <div className={styles.diffs} role="radiogroup" aria-label="Difficulty">
                {arcade.difficulties.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    role="radio"
                    aria-checked={difficulty === d.id}
                    className={`${styles.diff} ${difficulty === d.id ? styles.diffOn : ''}`}
                    onClick={() => setDifficulty(d.id)}
                  >
                    <span className={styles.diffLabel}>{d.label}</span>
                    <span className={styles.diffBlurb}>{d.blurb}</span>
                  </button>
                ))}
              </div>
              <button type="button" className="btn btn--gold" onClick={() => start(difficulty)}>
                Start match
              </button>
              {best > 0 && <p className={styles.best}>Your best on {difficulty}: {best}</p>}
            </div>
          </div>
        )}

        {screen === 'paused' && (
          <div className={styles.overlay}>
            <div className={styles.panel}>
              <h2 className={styles.panelTitle}>Paused</h2>
              <div className={styles.row}>
                <button type="button" className="btn btn--gold" onClick={togglePause}>Resume</button>
                <button type="button" className="btn btn--ghost" onClick={() => setScreen('menu')}>Quit</button>
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
                <div><dt>Auto</dt><dd>{final.blue.auto}</dd></div>
                <div><dt>Cells</dt><dd>{final.blue.cells}</dd></div>
                <div><dt>Dock</dt><dd>{final.blue.dock}</dd></div>
                <div><dt>Your shots</dt><dd>{final.shotsMade}/{final.shotsFired}</dd></div>
              </dl>
              {leaderboardEnabled && post.state !== 'done' && (
                <form className={styles.post} onSubmit={onSubmit}>
                  <label className={styles.postLabel} htmlFor="arcade-name">Name for the leaderboard</label>
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
                <button type="button" className="btn btn--gold" onClick={() => start(gameRef.current.difficulty)}>
                  Play again
                </button>
                <button type="button" className="btn btn--ghost" onClick={() => setScreen('menu')}>Menu</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {playing && hud && (
        <p className={styles.carry}>Carrying {hud.carry} of 5 · Best on {gameRef.current?.difficulty}: {best}</p>
      )}

      {leaderboardEnabled && (
        <section className={styles.board} aria-labelledby="arcade-board">
          <h3 id="arcade-board" className={styles.boardTitle}>
            Leaderboard · {arcade.difficulties.find((d) => d.id === difficulty)?.label}
          </h3>
          {board.error && <p className={styles.err}>{board.error}</p>}
          {!board.error && !board.loading && board.rows.length === 0 && (
            <p className={styles.muted}>No scores yet. Be first.</p>
          )}
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
