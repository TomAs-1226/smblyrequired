import { useRef } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { prefersReducedMotion } from '../lib/prefersReducedMotion'
import { springEase, SPRINGS } from '../lib/springEase'

gsap.registerPlugin(ScrollTrigger, useGSAP)

/**
 * Scroll-reveal wrapper. Fades + lifts the element (or its direct children
 * when `stagger` is set) into view once, when it enters the viewport.
 *
 * Driven by a real spring (`SPRINGS.reveal` — SwiftUI .smooth, no overshoot),
 * so it matches the `--spring-reveal` CSS token rather than merely resembling
 * it. `spring` picks a named curve; `duration` overrides the spring's own
 * settling time only if a caller explicitly passes one.
 */
export default function Reveal({
  children,
  as: Tag = 'div',
  y = 40,
  delay = 0,
  duration,
  spring = 'reveal',
  stagger = 0,
  start = 'top 92%',
  className = '',
  ...rest
}) {
  const ref = useRef(null)

  useGSAP(
    () => {
      const el = ref.current
      const targets = stagger > 0 ? Array.from(el.children) : el

      if (prefersReducedMotion()) {
        gsap.set(targets, { autoAlpha: 1, clearProps: 'transform' })
        return
      }

      const curve = springEase(SPRINGS[spring] ?? SPRINGS.reveal)

      gsap.fromTo(
        targets,
        { autoAlpha: 0, y },
        {
          autoAlpha: 1,
          y: 0,
          ...curve,
          // An explicit `duration` still wins, but it rescales the spring
          // rather than replacing it: the ease reads progress as a fraction of
          // the tween, so the shape survives a different length.
          ...(duration ? { duration } : null),
          delay,
          stagger,
          // Without this, GSAP leaves `transform: translate(0px, 0px)` inline
          // once the tween lands — and an inline style outranks every selector.
          // That silently killed the CSS :hover lift and :active press on every
          // revealed card, since both are transforms. The tween ends at y:0, so
          // dropping the property is visually identical and hands control back
          // to the stylesheet.
          clearProps: 'transform',
          scrollTrigger: { trigger: el, start, once: true },
        }
      )
    },
    { scope: ref }
  )

  return (
    <Tag ref={ref} className={className} {...rest}>
      {children}
    </Tag>
  )
}
