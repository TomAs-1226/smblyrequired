import { useEffect, useRef } from 'react'
import { gsap } from 'gsap'
import { springEase, SPRINGS } from '../lib/springEase'
import { prefersReducedMotion } from '../lib/prefersReducedMotion'

// Drag gesture physics, following the Detent pipeline:
//
//   track 1:1 -> estimate velocity -> project the rest point -> choose a target
//   (velocity first, distance second) -> settle with a spring at the release
//   velocity -> rubber-band at the edges.
//
// The point of each piece:
//  * 1:1 tracking from the grab point is what makes a surface feel physical.
//    Anything else (easing the finger, scaling the delta) reads as lag.
//  * The decision is made on where the flick is HEADED, not where the finger
//    was lifted. A fast short swipe should dismiss; a slow long drag should not.
//  * Release velocity is handed to the settling spring, so the surface keeps
//    the speed the finger gave it instead of restarting from zero.
//  * An edge with nowhere to go resists instead of stopping dead.

// WWDC18 projection. r is UIScrollView's deceleration rate.
const DECELERATION = 0.998
function project(velocity, rate = DECELERATION) {
  return (velocity / 1000) * (rate / (1 - rate))
}

// Reverse-engineered from iOS. Resistance grows as you pull further past the
// limit, so the surface never quite runs out of travel.
function rubberBand(offset, dimension, constant = 0.55) {
  const sign = Math.sign(offset)
  const x = Math.abs(offset)
  return sign * (1 - 1 / ((x * constant) / dimension + 1)) * dimension
}

// Least-squares fit over the last 100ms. A two-sample difference is far too
// noisy at the end of a flick - the final pointermove is often a 1px jitter,
// which reads as "they stopped" and kills the throw.
const VELOCITY_WINDOW_MS = 100
function makeTracker() {
  const samples = []
  return {
    reset() {
      samples.length = 0
    },
    push(x, y, t) {
      samples.push({ x, y, t })
      while (samples.length && t - samples[0].t > VELOCITY_WINDOW_MS) samples.shift()
    },
    velocity() {
      if (samples.length < 2) return { x: 0, y: 0 }
      const t0 = samples[0].t
      let st = 0, stt = 0, sx = 0, sy = 0, stx = 0, sty = 0
      for (const s of samples) {
        const t = (s.t - t0) / 1000
        st += t
        stt += t * t
        sx += s.x
        sy += s.y
        stx += t * s.x
        sty += t * s.y
      }
      const n = samples.length
      const denom = n * stt - st * st
      if (Math.abs(denom) < 1e-9) return { x: 0, y: 0 }
      return { x: (n * stx - st * sx) / denom, y: (n * sty - st * sy) / denom }
    },
  }
}

// About 10pt of slop before a touch counts as a drag (WWDC18). Below this the
// gesture stays undecided, so a tap never nudges the surface.
const HYSTERESIS = 10

/**
 * Attach a drag gesture to `ref`.
 *
 * @param {object}   opts
 * @param {object}   opts.ref         Element to drag.
 * @param {boolean}  opts.enabled
 * @param {Function} opts.onDismiss   Called when a downward throw wins.
 * @param {Function} opts.onStep      Called with -1 / +1 for a horizontal throw.
 * @param {boolean}  opts.horizontal  Allow the horizontal axis at all.
 */
export function useDragGesture({ ref, enabled, onDismiss, onStep, horizontal = true }) {
  // Handlers change every render; keeping them in a ref lets the effect depend
  // only on `enabled`, so a re-render mid-drag does not tear down the listeners
  // and strand the pointer capture.
  const cb = useRef({ onDismiss, onStep, horizontal })
  cb.current = { onDismiss, onStep, horizontal }

  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return
    // Reduced motion: no drag. The surface still closes by button and Escape,
    // so nothing becomes unreachable.
    if (prefersReducedMotion()) return

    const tracker = makeTracker()
    let dragging = false
    let axis = null
    let startX = 0
    let startY = 0
    let pointerId = null

    const setXY = (x, y) => gsap.set(el, { x, y })

    const onDown = (e) => {
      if (e.button != null && e.button !== 0) return
      if (e.target.closest('button, a, [role="button"]')) return
      dragging = true
      axis = null
      startX = e.clientX
      startY = e.clientY
      pointerId = e.pointerId
      tracker.reset()
      tracker.push(e.clientX, e.clientY, e.timeStamp)
      // Kill any in-flight settle so the drag starts from what is on screen,
      // not from where the last animation was headed.
      gsap.killTweensOf(el)
      // Capture keeps the move/up stream coming even when the pointer leaves
      // the element. It throws if the id is no longer active (a pointer that
      // was already released, or a synthetic event), and an exception here
      // would abort the handler and leave `dragging` stuck true.
      try {
        el.setPointerCapture?.(e.pointerId)
      } catch {
        /* capture is an optimisation, not a requirement */
      }
    }

    const onMove = (e) => {
      if (!dragging || e.pointerId !== pointerId) return
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      tracker.push(e.clientX, e.clientY, e.timeStamp)

      if (!axis) {
        if (Math.hypot(dx, dy) < HYSTERESIS) return
        axis = Math.abs(dx) > Math.abs(dy) && cb.current.horizontal ? 'x' : 'y'
        el.style.cursor = 'grabbing'
      }

      if (axis === 'x') {
        setXY(dx, 0)
      } else {
        // Downward is the dismiss direction, so it tracks the finger exactly.
        // Upward has nowhere to go and resists instead.
        setXY(0, dy >= 0 ? dy : rubberBand(dy, el.offsetHeight || 600))
      }
    }

    const settle = () => {
      const curve = springEase(SPRINGS.drawer)
      gsap.to(el, { x: 0, y: 0, ...curve, overwrite: true })
    }

    const onUp = (e) => {
      if (!dragging || e.pointerId !== pointerId) return
      dragging = false
      el.style.cursor = ''
      try {
        el.releasePointerCapture?.(e.pointerId)
      } catch {
        /* never captured, or already released */
      }

      const dx = e.clientX - startX
      const dy = e.clientY - startY
      const v = tracker.velocity()

      if (!axis) {
        setXY(0, 0)
        return
      }

      if (axis === 'y') {
        // Where the throw is actually headed, not where the finger stopped.
        const projected = dy + project(v.y)
        const threshold = Math.min(160, (el.offsetHeight || 600) * 0.25)
        if (projected > threshold) {
          cb.current.onDismiss?.()
          return
        }
        settle()
        return
      }

      const projected = dx + project(v.x)
      const threshold = Math.min(180, (el.offsetWidth || 800) * 0.25)
      if (Math.abs(projected) > threshold) {
        // Swipe direction IS the exit direction: dragging left advances.
        cb.current.onStep?.(projected < 0 ? 1 : -1)
      }
      settle()
    }

    const onCancel = () => {
      if (!dragging) return
      dragging = false
      el.style.cursor = ''
      settle()
    }

    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onCancel)

    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onCancel)
      gsap.killTweensOf(el)
      // The tween leaves an inline transform behind; without this the dialog
      // keeps it across an open/close cycle (CLAUDE.md gotcha #1).
      gsap.set(el, { clearProps: 'transform' })
    }
  }, [ref, enabled])
}

export { project, rubberBand }
