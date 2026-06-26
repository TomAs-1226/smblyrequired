import { useRef } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import { prefersReducedMotion } from '../lib/prefersReducedMotion'

/**
 * Infinite horizontal ticker driven by gsap.ticker (zero scroll cost).
 * Pauses on hover; static under reduced motion. Decorative (aria-hidden).
 */
export default function Marquee({ items = [], speed = 0.6, separator = '✦', className = '' }) {
  const track = useRef(null)

  useGSAP(
    () => {
      if (prefersReducedMotion()) return
      const el = track.current
      const half = el.scrollWidth / 2
      if (!half) return
      let x = 0
      let paused = false
      const tick = (time, delta) => {
        if (paused) return
        x -= speed * (delta / 16.67)
        if (-x >= half) x += half
        el.style.transform = `translate3d(${x}px,0,0)`
      }
      gsap.ticker.add(tick)
      const enter = () => (paused = true)
      const leave = () => (paused = false)
      el.addEventListener('mouseenter', enter)
      el.addEventListener('mouseleave', leave)
      return () => {
        gsap.ticker.remove(tick)
        el.removeEventListener('mouseenter', enter)
        el.removeEventListener('mouseleave', leave)
      }
    },
    { scope: track }
  )

  const loop = [...items, ...items]
  return (
    <div className={`marquee ${className}`} aria-hidden="true">
      <div className="marquee__track" ref={track}>
        {loop.map((it, i) => (
          <span className="marquee__item" key={i}>
            <span>{it}</span>
            <span className="marquee__sep">{separator}</span>
          </span>
        ))}
      </div>
    </div>
  )
}
