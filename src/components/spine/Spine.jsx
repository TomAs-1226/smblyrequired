import { useEffect, useRef } from 'react'
import { spinePanels, spineTitle } from '../../data/spine'
import styles from './Spine.module.css'

// The landing page's opening: the season's robot on a sticky stage, choreographed by the panels that
// scroll past it. React renders the words; engine.js reads them from the DOM (data-shot, data-box,
// data-anchor) and runs the stage. See shots.js for what each shot does.

/* "*word*" → the gold accent, "\n" → a line break. */
function Rich({ text }) {
  return text.split('\n').map((line, i) => (
    <span key={i} className={styles.line}>
      {line.split(/(\*[^*]+\*)/).map((part, j) =>
        part.startsWith('*') ? <em key={j}>{part.slice(1, -1)}</em> : part,
      )}
    </span>
  ))
}

function Panel({ p }) {
  if (!p.kicker) return <section className={`${styles.panel} ${styles.lead}`} data-shot={p.shot} aria-hidden="true" />
  const cls = [styles.panel, p.right && styles.right, p.caption && styles.caption, p.tight && styles.tight].filter(Boolean).join(' ')
  return (
    <section className={cls} data-shot={p.shot}>
      <div className={styles.box} data-box>
        <p className={styles.kicker}>
          {p.index && <b>{p.index}</b>}
          {p.kicker}
        </p>
        <h2 className={styles.h2}><Rich text={p.title} /></h2>
        {p.body && <p className={styles.body}>{p.body}</p>}
        {p.facts && (
          <dl className={styles.facts}>
            {p.facts.map((f) => (
              <div key={f.label} className={styles.fact}>
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {p.specs && (
          <ul className={styles.specs}>
            {p.specs.map((s) => (
              <li key={s.anchor} className={styles.spec} data-anchor={s.anchor}>
                <b>{s.name}</b>
                <span>{s.value}</span>
              </li>
            ))}
          </ul>
        )}
        {p.links && (
          <div className={styles.row}>
            {p.links.map((l) => (
              <a key={l.href} href={l.href} className={l.primary ? styles.btn : `${styles.btn} ${styles.quiet}`}>
                {l.label}
                {l.primary && <i aria-hidden="true">↗</i>}
              </a>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

export default function Spine() {
  const root = useRef(null)
  const canvas = useRef(null)
  const overlay = useRef(null)
  const hair = useRef(null)
  const title = useRef(null)
  const cue = useRef(null)

  useEffect(() => {
    // three.js and the engine load on demand, in their own chunk: every other page — and the
    // first paint of this one, which is the title card — should not wait for a 3D library.
    let dispose = null
    let cancelled = false
    const noStage = (e) => {
      // No WebGL (or the chunk failed): the words and the spec lists still carry the page.
      console.warn('spine: no 3D stage', e)
      root.current?.setAttribute('data-no-stage', '')
    }
    import('./engine')
      .then(({ createSpine }) => {
        if (cancelled) return
        try {
          dispose = createSpine({
            root: root.current,
            canvas: canvas.current,
            overlay: overlay.current,
            hair: hair.current,
            title: title.current,
            cue: cue.current,
            classes: { callout: styles.callout },
            models: `${import.meta.env.BASE_URL}models/`,
          })
        } catch (e) {
          noStage(e)
        }
      })
      .catch(noStage)
    return () => {
      cancelled = true
      dispose?.()
    }
  }, [])

  return (
    <div className={styles.spine} ref={root} data-spine>
      <div className={styles.stage}>
        <div className={styles.col}>
          <canvas
            ref={canvas}
            className={styles.canvas}
            role="img"
            aria-label="Numbers, Team 5805's robot for this season, in 3D. It comes apart, shows its subsystems, and drives off to score as you scroll."
          />
          <div ref={overlay} className={styles.overlay} aria-hidden="true">
            <svg ref={hair} className={styles.hair} />
          </div>
        </div>
        <div ref={title} className={styles.titlecard}>
          <span className={styles.pre}>{spineTitle.pre}</span>
          <h1 className={styles.num}>
            <span className={styles.edge} aria-hidden="true">{spineTitle.number}</span>
            <span className={styles.fill}>{spineTitle.number}</span>
            <span className={styles.srOnly}> — {spineTitle.name}</span>
          </h1>
          <span className={styles.post} aria-hidden="true">{spineTitle.name}</span>
        </div>
        <span ref={cue} className={styles.cue} aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </div>
      <div className={styles.panels}>
        {spinePanels.map((p) => <Panel key={p.shot} p={p} />)}
      </div>
    </div>
  )
}
