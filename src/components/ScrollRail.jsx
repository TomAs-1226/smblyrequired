import { useEffect, useState } from 'react'
import { scrollTo } from '../lib/smoothScroll'
import styles from './ScrollRail.module.css'

// Desktop-only left progress rail. Highlights the in-view section with a gold
// tick. Uses IntersectionObserver (cheap, no scroll handler).
const SECTIONS = [
  { id: 'top', label: 'Top' },
  { id: 'team', label: 'Team' },
  { id: 'subteams', label: 'Join' },
  { id: 'robots', label: 'Robots' },
  { id: 'drive', label: 'Drive' },
  { id: 'sponsor', label: 'Sponsor' },
  { id: 'partnership', label: 'Tiers' },
  { id: 'impact', label: 'Record' },
  { id: 'catalyst', label: 'Catalyst' },
  { id: 'gallery', label: 'Gallery' },
  { id: 'contact', label: 'Contact' },
]

export default function ScrollRail() {
  const [active, setActive] = useState('top')

  useEffect(() => {
    const els = SECTIONS.map((s) => document.getElementById(s.id)).filter(Boolean)
    if (!els.length) return
    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) setActive(e.target.id)
        })
      },
      { rootMargin: '-45% 0px -45% 0px', threshold: 0 }
    )
    els.forEach((el) => obs.observe(el))
    return () => obs.disconnect()
  }, [])

  return (
    <nav className={styles.rail} aria-label="Section navigation">
      <ul>
        {SECTIONS.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              className={active === s.id ? styles.active : ''}
              onClick={() => scrollTo('#' + s.id)}
              aria-current={active === s.id ? 'true' : undefined}
            >
              <span className={styles.tick} aria-hidden="true" />
              <span className={styles.label}>{s.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}
