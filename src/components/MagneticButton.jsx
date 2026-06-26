import { useRef } from 'react'
import { gsap } from 'gsap'
import { prefersReducedMotion } from '../lib/prefersReducedMotion'

/**
 * Pointer-gated magnetic button/link. Only engages with a fine pointer and when
 * motion is allowed — touch users get a plain button.
 */
export default function MagneticButton({ as: Tag = 'a', strength = 0.4, className = '', children, ...rest }) {
  const ref = useRef(null)
  const fine = () => typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches

  const onMove = (e) => {
    if (prefersReducedMotion() || !fine()) return
    const el = ref.current
    const r = el.getBoundingClientRect()
    const x = (e.clientX - (r.left + r.width / 2)) * strength
    const y = (e.clientY - (r.top + r.height / 2)) * strength
    gsap.to(el, { x, y, duration: 0.4, ease: 'power3.out' })
  }
  const onLeave = () => {
    if (!ref.current) return
    gsap.to(ref.current, { x: 0, y: 0, duration: 0.5, ease: 'power3.out' })
  }

  return (
    <Tag ref={ref} className={className} onMouseMove={onMove} onMouseLeave={onLeave} {...rest}>
      {children}
    </Tag>
  )
}
