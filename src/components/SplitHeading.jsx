import { useRef } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import SplitType from 'split-type'
import { prefersReducedMotion } from '../lib/prefersReducedMotion'

gsap.registerPlugin(ScrollTrigger, useGSAP)

/**
 * Masked, line-by-line headline reveal. Text is real in the DOM (SEO + no-JS
 * safe); the mask animation layers on only when motion is allowed.
 *
 * Robustness: the split runs one rAF after web fonts load (so line breaks are
 * measured against the final layout), and re-splits on width changes — the
 * common SplitType failure mode is measuring before the container has its
 * final width, which stacks every word onto its own line.
 */
export default function SplitHeading({
  as: Tag = 'h2',
  children,
  className = '',
  start = 'top 88%',
  stagger = 0.1,
  duration = 0.9,
  ...rest
}) {
  const ref = useRef(null)

  useGSAP(
    () => {
      const el = ref.current
      if (prefersReducedMotion()) return

      let split = null
      let tween = null
      let ro = null
      let lastW = 0

      const clear = () => {
        if (tween) {
          if (tween.scrollTrigger) tween.scrollTrigger.kill()
          tween.kill()
          tween = null
        }
        if (split) {
          split.revert()
          split = null
        }
      }

      const build = (animate) => {
        clear()
        split = new SplitType(el, { types: 'lines', lineClass: 'sh-line' })
        el.querySelectorAll('.sh-line').forEach((line) => {
          const mask = document.createElement('span')
          mask.className = 'sh-mask'
          line.parentNode.insertBefore(mask, line)
          mask.appendChild(line)
        })
        const lines = el.querySelectorAll('.sh-line')
        if (animate) {
          tween = gsap.from(lines, {
            yPercent: 118,
            duration,
            ease: 'power4.out',
            stagger,
            scrollTrigger: { trigger: el, start, once: true },
          })
        } else {
          gsap.set(lines, { yPercent: 0 })
        }
      }

      const init = () => {
        lastW = el.offsetWidth
        build(true)
        ro = new ResizeObserver(() => {
          const w = el.offsetWidth
          if (Math.abs(w - lastW) > 2) {
            lastW = w
            build(false) // re-measure lines at the new width, no re-animation
          }
        })
        ro.observe(el)
      }

      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => requestAnimationFrame(init))
      } else {
        init()
      }

      return () => {
        if (ro) ro.disconnect()
        clear()
      }
    },
    { scope: ref }
  )

  return (
    <Tag ref={ref} className={className} {...rest}>
      {children}
    </Tag>
  )
}
