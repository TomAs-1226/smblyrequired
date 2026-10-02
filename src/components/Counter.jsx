import { useRef } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { prefersReducedMotion } from '../lib/prefersReducedMotion'

gsap.registerPlugin(ScrollTrigger)

/**
 * Counts up from 0 to `to` when scrolled into view (once). `prefix`/`suffix`
 * frame the number; non-numeric values (e.g. "2016") render as-is.
 *
 * The true value is the resting state, never merely the end of an animation.
 * React renders it, `onComplete` restates it, the cleanup restores it, and a
 * hidden tab skips the count entirely. That matters because the failure mode
 * is not a missing flourish — it is the page calmly stating "0% student-built
 * robot" and "0+ seasons competing", which is worse than no animation at all.
 * A count-up is decoration; the number is a fact, and the fact has to survive
 * the decoration not running.
 */
export default function Counter({ to, prefix = '', suffix = '', duration = 1.8 }) {
  const ref = useRef(null)

  useGSAP(
    () => {
      const el = ref.current
      const final = `${prefix}${to}${suffix}`
      const numeric = typeof to === 'number'

      if (prefersReducedMotion() || !numeric) {
        el.textContent = final
        return
      }

      const obj = { v: 0 }
      gsap.to(obj, {
        v: to,
        duration,
        ease: 'power2.out',
        onUpdate: () => {
          el.textContent = `${prefix}${Math.round(obj.v)}${suffix}`
        },
        // Rounding during the tween can land a frame short (99 for 100). State
        // the real number once at the end rather than trusting the last frame.
        onComplete: () => {
          el.textContent = final
        },
        scrollTrigger: {
          trigger: el,
          start: 'top 92%',
          once: true,
          // A count-up in a tab nobody is looking at buys nothing, and a tween
          // whose frames are throttled writes 0 and then waits — which is how
          // the stat band ends up reading 0+ and 0%.
          //
          // Use `self.animation` rather than closing over the tween: this can
          // fire synchronously from inside the gsap.to() call above, while a
          // surrounding `const` is still in its temporal dead zone.
          onEnter: (self) => {
            if (document.visibilityState !== 'visible') {
              self.animation?.progress(1)
            }
          },
        },
      })

      // Unmounting mid-count (a route change) must not leave the last rounded
      // frame on screen as if it were the number.
      return () => {
        el.textContent = final
      }
    },
    { scope: ref }
  )

  return (
    <span ref={ref}>
      {prefix}
      {to}
      {suffix}
    </span>
  )
}
