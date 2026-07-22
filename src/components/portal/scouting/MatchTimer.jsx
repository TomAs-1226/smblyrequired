import { useEffect, useRef, useState } from 'react'
import Icon from '../../Icon'
import styles from './Scouting.module.css'

// -----------------------------------------------------------------------------
// Match timer — REBUILT (2026) phase clock for a scout on the stands.
//
// A scout watching one robot loses track of where the match is: was that a
// teleop cycle or the tail of auto? did endgame start? The timer answers that
// at a glance and, more usefully, calls the phase BOUNDARIES so the scout can
// look up at the right moments without watching a clock.
//
// Phases from the 2026 game manual:
//   Auto     0:00 – 0:20   (20s)
//   Teleop   0:20 – 2:40   (2:20)
//   Endgame  last 0:30 of teleop  → flagged, not a separate clock
//
// Everything is derived from a single start timestamp compared against
// performance.now(), NOT from decrementing a counter every tick. A setInterval
// that subtracts 1 each second drifts — background-tab throttling alone loses
// seconds — and a scout's timer that says 1:30 when the field says 1:15 is worse
// than no timer. The interval here only triggers re-renders; the truth is always
// elapsed = now - start.
// -----------------------------------------------------------------------------

const AUTO_END = 20
const TELEOP_END = 20 + 140 // 2:40
const ENDGAME_START = TELEOP_END - 30 // last 30s
const MATCH_END = TELEOP_END

const PHASES = [
  { key: 'pre', label: 'Ready', from: -Infinity, to: 0 },
  { key: 'auto', label: 'Autonomous', from: 0, to: AUTO_END },
  { key: 'teleop', label: 'Teleop', from: AUTO_END, to: ENDGAME_START },
  { key: 'endgame', label: 'Endgame', from: ENDGAME_START, to: MATCH_END },
  { key: 'done', label: 'Match over', from: MATCH_END, to: Infinity },
]

function phaseAt(t) {
  return PHASES.find((p) => t >= p.from && t < p.to) ?? PHASES[PHASES.length - 1]
}

function fmt(sec) {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export default function MatchTimer() {
  const [startedAt, setStartedAt] = useState(null)
  const [elapsed, setElapsed] = useState(0)
  const raf = useRef(0)
  const lastPhase = useRef('pre')

  // Drive updates off rAF while running; stop entirely when idle or finished so
  // the timer costs nothing when it is not counting.
  useEffect(() => {
    if (startedAt == null) return
    let alive = true
    const tick = () => {
      if (!alive) return
      const t = (performance.now() - startedAt) / 1000
      setElapsed(t)

      // Haptic pulse on each phase boundary — the scout is watching the field,
      // not the phone, and the buzz is the actual signal that a phase changed.
      const p = phaseAt(t).key
      if (p !== lastPhase.current) {
        lastPhase.current = p
        if (navigator.vibrate) {
          navigator.vibrate(p === 'endgame' ? [40, 30, 40] : 25)
        }
      }
      if (t >= MATCH_END + 1) return // let it rest one second past the end, then stop
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => {
      alive = false
      cancelAnimationFrame(raf.current)
    }
  }, [startedAt])

  const running = startedAt != null && elapsed < MATCH_END
  const phase = startedAt == null ? PHASES[0] : phaseAt(elapsed)

  const start = () => {
    lastPhase.current = 'pre'
    setElapsed(0)
    setStartedAt(performance.now())
    if (navigator.vibrate) navigator.vibrate(15)
  }
  const reset = () => {
    cancelAnimationFrame(raf.current)
    setStartedAt(null)
    setElapsed(0)
    lastPhase.current = 'pre'
  }

  // Countdown WITHIN the current phase is what a scout actually wants — "11s of
  // auto left", not "elapsed 9s". Endgame counts down to the buzzer.
  const remainingInMatch = Math.max(0, MATCH_END - elapsed)

  return (
    <div className={`${styles.timer} ${styles[`timer_${phase.key}`]}`}>
      <div className={styles.timerMain}>
        <span className={styles.timerPhase}>{phase.label}</span>
        <span className={styles.timerClock} aria-live="off">
          {startedAt == null ? '2:40' : fmt(remainingInMatch)}
        </span>
        {phase.key === 'endgame' && <span className={styles.timerFlag}>Endgame — climbing</span>}
      </div>

      {/* Phase track: a thin bar showing where in the match we are, with the
          auto/teleop/endgame splits marked. Composited (scaleX), not width. */}
      <div className={styles.timerTrack} aria-hidden="true">
        <span
          className={styles.timerFill}
          style={{ transform: `scaleX(${Math.min(1, elapsed / MATCH_END)})` }}
        />
        <span className={styles.timerTick} style={{ left: `${(AUTO_END / MATCH_END) * 100}%` }} />
        <span
          className={styles.timerTick}
          style={{ left: `${(ENDGAME_START / MATCH_END) * 100}%` }}
        />
      </div>

      <div className={styles.timerBtns}>
        {startedAt == null ? (
          <button type="button" className={styles.timerStart} onClick={start}>
            <Icon name="flag" size={18} />
            Start match
          </button>
        ) : (
          <>
            <button type="button" className={styles.timerReset} onClick={reset}>
              {running ? 'Reset' : 'Clear'}
            </button>
            {running && (
              <span className={styles.timerElapsed}>{fmt(elapsed)} in</span>
            )}
          </>
        )}
      </div>
    </div>
  )
}
