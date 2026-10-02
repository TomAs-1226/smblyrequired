import { useEffect, useRef, useState } from 'react'
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
  const [primaryOnScreen, setPrimaryOnScreen] = useState(false)
  const dockRef = useRef(null)

  useEffect(() => {
    setPrimaryOnScreen(false)
    const target = document.querySelector('[data-primary-cta]')
    if (!target) return
    const io = new IntersectionObserver(
      ([entry]) => setPrimaryOnScreen(entry.isIntersecting),
      // A sliver counts: the dock should be gone before the two overlap, not
      // at the moment they do.
      { threshold: 0 }
    )
    io.observe(target)
    return () => io.disconnect()
  }, [path])

  const hide = onOwnPage || primaryOnScreen

  return (
    <div className={`${styles.dock} ${hide ? '' : styles.show}`} aria-hidden={hide}>
      <a href="#/sponsor" className="btn btn--gold" tabIndex={hide ? -1 : 0}>
        Become a sponsor
        <Icon name="arrowRight" className="arrow" size={18} />
      </a>
    </div>
  )
}
