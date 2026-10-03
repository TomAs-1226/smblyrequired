import { useEffect, useState } from 'react'
import Icon from './Icon'
import { useRoute } from '../hooks/useRoute'
import styles from './MobileStickyCTA.module.css'

// Bottom-docked primary action on mobile (hidden on desktop via CSS). Persists
// across pages, except on the Sponsor/Contact pages where it'd be redundant.
//
// It also stands down while the page's own primary CTA is on screen. Without
// that, the top of the home page showed "Sponsor the team" in the hero and
// "Become a sponsor" docked over it — the same action, twice, eight hundred
// pixels apart, which reads as a page nagging rather than offering. The dock
// exists for the rest of the scroll, once that button is gone.
export default function MobileStickyCTA() {
  const raw = useRoute()
  const path = raw !== '/' ? raw.replace(/\/+$/, '') : '/'
  const onOwnPage = path === '/sponsor' || path === '/contact'
  const [coveredBy, setCoveredBy] = useState(0)

  useEffect(() => {
    setCoveredBy(0)
    // Two things stand the dock down: the page's own primary CTA, and the home
    // page's 3D story ([data-spine]). The story's copy runs to the bottom of a
    // phone screen and its last panel carries its own "Sponsor us" button, so
    // the dock would sit on top of the words and repeat the action. It comes
    // back once the story has scrolled away.
    const targets = [...document.querySelectorAll('[data-primary-cta], [data-spine]')]
    if (!targets.length) return
    const visible = new Set()
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target)
          else visible.delete(e.target)
        }
        setCoveredBy(visible.size)
      },
      // A sliver counts: the dock should be gone before the two overlap, not
      // at the moment they do.
      { threshold: 0 }
    )
    targets.forEach((t) => io.observe(t))
    return () => io.disconnect()
  }, [path])

  const hide = onOwnPage || coveredBy > 0

  return (
    <div
      className={`${styles.dock} ${hide ? '' : styles.show}`}
      aria-hidden={hide}
      // Spread, never inert={false}: React 18 renders that as inert="false",
      // and any value at all makes the subtree inert.
      {...(hide ? { inert: '' } : {})}
    >
      <a href="#/sponsor" className="btn btn--gold" tabIndex={hide ? -1 : 0}>
        Become a sponsor
        <Icon name="arrowRight" className="arrow" size={18} />
      </a>
    </div>
  )
}
