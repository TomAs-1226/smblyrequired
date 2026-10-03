import { useEffect, useRef, useState } from 'react'
import { catalystDemos } from '../data/catalyst'
import styles from './CatalystDemos.module.css'

// The Catalyst page's live demos, run on the season's robot (src/components/catalyst/demos.js).
// Each stage loads three.js and the model only when it comes near the screen, so the page itself
// stays light; React renders the words and the readout, the stage reports what it is doing.

const MODELS = `${import.meta.env.BASE_URL}models/`

/* Start a demo once its canvas is within a screen of the viewport, and tear it down on unmount. */
function useDemo(create, onState) {
  const canvas = useRef(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let dispose = null
    let cancelled = false
    const el = canvas.current
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return
      io.disconnect()
      import('./catalyst/demos')
        .then((m) => {
          if (cancelled) return
          try {
            dispose = m[create]({ canvas: el, models: MODELS, onState })
          } catch (err) {
            console.warn('catalyst demo: no 3D stage', err)
            setFailed(true)
          }
        })
        .catch(() => setFailed(true))
    }, { rootMargin: '100% 0px' })
    io.observe(el)
    return () => {
      cancelled = true
      io.disconnect()
      dispose?.()
    }
  }, [create, onState])
  return { canvas, failed }
}

const MODE = {
  approach: { label: 'Line up', tone: 'line' },
  sweep: { label: 'Collect', tone: 'collect' },
  score: { label: 'Score', tone: 'score' },
}

export function AutonomyDemo() {
  const [st, setSt] = useState(null)
  const { canvas, failed } = useDemo('createAutonomyDemo', setSt)
  const copy = catalystDemos.autonomy
  const mode = MODE[st?.mode] ?? { label: '—', tone: 'line' }
  return (
    <section className={styles.demo} aria-labelledby="demo-autonomy">
      <div className={styles.head}>
        <p className={styles.kicker}>{copy.kicker}</p>
        <h2 id="demo-autonomy" className={styles.h2}>{copy.title}</h2>
        <p className={styles.lede}>{copy.body}</p>
      </div>
      <div className={styles.grid}>
        <div className={styles.device}>
          <div className={styles.deviceCore}>
            <canvas
              ref={canvas}
              className={styles.canvas}
              role="img"
              aria-label="Numbers on a REBUILT field: it collects FUEL in one pass, drives to range, and scores into the HUB while moving."
            />
            {failed && <p className={styles.fallback}>The live demo needs WebGL.</p>}
          </div>
        </div>
        <aside className={styles.panel} aria-live="polite">
          <p className={styles.label}>Decision</p>
          <p className={styles.decision} data-tone={mode.tone}>
            <i aria-hidden="true" />
            {mode.label}
          </p>
          <p className={styles.reason}>{st?.reason || 'Waking up…'}</p>
          <div className={styles.meter}>
            <div className={styles.meterHead}>
              <span>FUEL aboard</span>
              <b>{st ? `${st.held} of ${st.inPlay}` : '—'}</b>
            </div>
            <div className={styles.bar}>
              <span style={{ transform: `scaleX(${st ? st.held / st.inPlay : 0})` }} />
            </div>
          </div>
          <dl className={styles.facts}>
            <div>
              <dt>Range</dt>
              <dd>{st?.shot ? `${st.shot.range.toFixed(1)} m` : '—'}</dd>
            </div>
            <div>
              <dt>Hood</dt>
              <dd>{st?.shot ? `${st.shot.hood.toFixed(1)}°` : '—'}</dd>
            </div>
          </dl>
          <p className={styles.fine}>{copy.note}</p>
        </aside>
      </div>
    </section>
  )
}

/* The state graph, drawn: four states on a diamond, every declared transition as a hairline. */
const NODES = { STOW: [60, 110], INTAKE: [200, 34], AIM: [340, 110], SHOOT: [200, 186] }
const EDGES = [['STOW', 'INTAKE'], ['INTAKE', 'AIM'], ['STOW', 'AIM'], ['AIM', 'SHOOT'], ['SHOOT', 'STOW']]

export function StatesDemo() {
  const [st, setSt] = useState(null)
  const { canvas, failed } = useDemo('createStatesDemo', setSt)
  const copy = catalystDemos.states
  const cur = st?.target ?? 'STOW'
  return (
    <section className={styles.demo} aria-labelledby="demo-states">
      <div className={styles.head}>
        <p className={styles.kicker}>{copy.kicker}</p>
        <h2 id="demo-states" className={styles.h2}>{copy.title}</h2>
        <p className={styles.lede}>{copy.body}</p>
      </div>
      <div className={`${styles.grid} ${styles.flip}`}>
        <aside className={styles.panel} aria-live="polite">
          <p className={styles.label}>Superstructure</p>
          <svg className={styles.graph} viewBox="0 0 400 220" role="img" aria-label={`State machine, currently ${cur}${st?.arrived ? '' : ' (on its way)'}`}>
            {EDGES.map(([a, b]) => {
              const live = cur === b && !st?.arrived
              return (
                <line
                  key={a + b}
                  x1={NODES[a][0]} y1={NODES[a][1]} x2={NODES[b][0]} y2={NODES[b][1]}
                  className={live ? styles.edgeLive : styles.edge}
                />
              )
            })}
            {st?.refused && (
              <line
                x1={NODES[st.refused.from][0]} y1={NODES[st.refused.from][1]}
                x2={NODES[st.refused.to][0]} y2={NODES[st.refused.to][1]}
                className={styles.edgeRefused}
              />
            )}
            {Object.entries(NODES).map(([name, [x, y]]) => (
              <g key={name} className={styles.node} data-on={name === cur || undefined} data-arrived={(name === cur && st?.arrived) || undefined}>
                <rect x={x - 46} y={y - 17} width="92" height="34" rx="17" />
                <text x={x} y={y + 5}>{name}</text>
              </g>
            ))}
          </svg>
          {st?.refused ? (
            <p className={styles.refused}>{st.refused.reason}</p>
          ) : (
            <p className={styles.reason}>{st?.arrived ? `At ${cur}.` : `Moving to ${cur} — not there until the mechanisms say so.`}</p>
          )}
          <ol className={styles.log}>
            {(st?.log ?? []).map((l, i) => <li key={`${i}-${l}`}>{l}</li>)}
          </ol>
        </aside>
        <div className={styles.device}>
          <div className={styles.deviceCore}>
            <canvas
              ref={canvas}
              className={styles.canvas}
              role="img"
              aria-label="Numbers in close-up moving through its states: the hopper extends to intake, the hood rises and the flywheel spins up to aim, then it fires."
            />
            {failed && <p className={styles.fallback}>The live demo needs WebGL.</p>}
          </div>
        </div>
      </div>
    </section>
  )
}
