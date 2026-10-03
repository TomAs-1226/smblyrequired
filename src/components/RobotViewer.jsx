import { useEffect, useRef, useState } from 'react'
import { prefersReducedMotion } from '../lib/prefersReducedMotion'
import styles from './RobotViewer.module.css'

// A robot on a turntable (src/components/robot/viewer.js). three.js and the model load only when the
// stage comes within a screen of the viewport, so a page of four robots costs nothing until you scroll
// to them. Fills its parent; the parent decides the shape.

const MODELS = `${import.meta.env.BASE_URL}models/`

export default function RobotViewer({ model, label, az, onFail }) {
  const canvas = useRef(null)
  const [progress, setProgress] = useState(0)
  const [state, setState] = useState('idle') // idle → loading → ready | failed

  useEffect(() => {
    let dispose = null
    let cancelled = false
    const el = canvas.current
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return
      io.disconnect()
      setState('loading')
      import('./robot/viewer')
        .then((m) => {
          if (cancelled) return
          try {
            dispose = m.createViewer({
              canvas: el,
              models: MODELS,
              model,
              az,
              reduced: prefersReducedMotion(),
              /* The transmission pass draws the scene twice; phones get the cheaper polycarbonate. */
              glassy: !window.matchMedia('(max-width: 760px)').matches,
              onProgress: setProgress,
              onReady: () => setState('ready'),
              onError: () => { setState('failed'); onFail?.() },
            })
          } catch (err) {
            console.warn('robot viewer: no 3D stage', err)
            setState('failed')
            onFail?.()
          }
        })
        .catch(() => { setState('failed'); onFail?.() })
    }, { rootMargin: '100% 0px' })
    io.observe(el)
    return () => {
      cancelled = true
      io.disconnect()
      dispose?.()
    }
  }, [model, az])

  return (
    <div className={styles.viewer} data-state={state}>
      <canvas ref={canvas} className={styles.canvas} role="img" aria-label={label} />
      <span className={styles.load} aria-hidden="true">
        <span style={{ transform: `scaleX(${state === 'ready' ? 1 : Math.max(0.04, progress)})` }} />
      </span>
      {state === 'failed' && <p className={styles.fallback}>The 3D model didn’t load.</p>}
    </div>
  )
}
