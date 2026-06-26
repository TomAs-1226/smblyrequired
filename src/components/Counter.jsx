import { useRef } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { prefersReducedMotion } from '../lib/prefersReducedMotion'

gsap.registerPlugin(ScrollTrigger)

/**
 * Counts up from 0 to `to` when scrolled into view (once). `prefix`/`suffix`
 * frame the number; non-numeric values (e.g. "2016") render as-is.
 */
export default function Counter({ to, prefix = '', suffix = '', duration = 1.8 }) {
  const ref = useRef(null)

  useGSAP(
    () => {
      const el = ref.current
      const numeric = typeof to === 'number'
      if (prefersReducedMotion() || !numeric) {
        el.textContent = `${prefix}${to}${suffix}`
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
        scrollTrigger: { trigger: el, start: 'top 92%', once: true },
      })
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
