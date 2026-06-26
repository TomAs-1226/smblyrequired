import { useEffect, useRef, useState } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import Icon from './Icon'
import MagneticButton from './MagneticButton'
import { team } from '../data/team'
import { navLinks } from '../data/navigation'
import { useRoute } from '../hooks/useRoute'
import { prefersReducedMotion } from '../lib/prefersReducedMotion'
import styles from './Nav.module.css'

// Fixed top bar. Slides down on mount, raises a surface past 80px (or always on
// subpages), and on mobile swaps the link row for a full-screen overlay menu.
// Multi-page: links are hash routes (#/team …); active state tracks the route.
export default function Nav() {
  const headerRef = useRef(null)
  const raw = useRoute()
  const path = raw !== '/' ? raw.replace(/\/+$/, '') : '/'
  const isHome = path === '/'
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)

  useGSAP(
    () => {
      if (prefersReducedMotion()) return
      gsap.from(headerRef.current, {
        yPercent: -100,
        duration: 0.9,
        delay: 0.15,
        ease: 'power4.out',
      })
    },
    { scope: headerRef }
  )

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 80)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // Close the overlay whenever the route changes.
  useEffect(() => {
    setOpen(false)
  }, [path])

  // Surface shows once scrolled, or always on subpages (no hero behind).
  const showSurface = scrolled || !isHome
  const close = () => setOpen(false)

  return (
    <header
      ref={headerRef}
      className={`${styles.nav} ${showSurface ? styles.scrolled : ''}`}
    >
      <div className={`container ${styles.bar}`}>
        {/* Brand lockup — interlocked SM crest + typographic wordmark */}
        <a href="#/" className={styles.brand} onClick={close} aria-label={`${team.name} — home`}>
          <img src="photos/logo-crest.png" alt="" className={styles.crest} width="34" height="34" />
          <span className={styles.wordmark}>
            <span className={styles.brandKicker}>FRC {team.number}</span>
            <span className={styles.brandName}>{team.name}</span>
          </span>
        </a>

        {/* Desktop links + CTA */}
        <nav className={styles.desktop} aria-label="Primary">
          <ul className={styles.links}>
            {navLinks.map((l) => {
              const active = path === l.path
              return (
                <li key={l.path}>
                  <a
                    href={`#${l.path}`}
                    className={`${styles.link} ${active ? styles.linkActive : ''}`}
                    aria-current={active ? 'page' : undefined}
                  >
                    {l.label}
                  </a>
                </li>
              )
            })}
          </ul>
          <MagneticButton as="a" href="#/sponsor" className={`btn btn--gold ${styles.cta}`}>
            Sponsor Us
            <Icon name="arrowRight" size={18} className="arrow" />
          </MagneticButton>
        </nav>

        {/* Mobile toggle */}
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={open}
          aria-controls="nav-overlay"
          onClick={() => setOpen((v) => !v)}
        >
          <span className="sr-only">{open ? 'Close menu' : 'Open menu'}</span>
          <Icon name={open ? 'close' : 'menu'} size={26} />
        </button>
      </div>

      {/* Mobile full-screen overlay */}
      <div id="nav-overlay" className={`${styles.overlay} ${open ? styles.overlayOpen : ''}`} hidden={!open}>
        <nav className={styles.overlayInner} aria-label="Mobile">
          <span className={styles.overlayEyebrow}>
            FRC {team.number} · {team.shortName}
          </span>
          <ul className={styles.overlayLinks}>
            {navLinks.map((l, i) => (
              <li key={l.path} style={{ '--i': i }}>
                <a href={`#${l.path}`} className={styles.overlayLink} onClick={close}>
                  <span className={styles.overlayNum}>{String(i + 1).padStart(2, '0')}</span>
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
          <a href="#/sponsor" className={`btn btn--gold ${styles.overlayCta}`} onClick={close}>
            Sponsor Us
            <Icon name="arrowRight" size={18} className="arrow" />
          </a>
        </nav>
      </div>
    </header>
  )
}
