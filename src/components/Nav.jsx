import { useEffect, useRef, useState } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import Icon from './Icon'
import MagneticButton from './MagneticButton'
import { team } from '../data/team'
import { scrollTo } from '../lib/smoothScroll'
import { prefersReducedMotion } from '../lib/prefersReducedMotion'
import styles from './Nav.module.css'

const LINKS = [
  { href: '#robots', label: 'Robots' },
  { href: '#sponsor', label: 'Sponsor' },
  { href: '#impact', label: 'Impact' },
  { href: '#team', label: 'Team' },
]

// Fixed top bar. Slides down on mount, gains a "scrolled" surface past 80px,
// and on mobile swaps the link row for a full-screen overlay menu.
export default function Nav() {
  const headerRef = useRef(null)
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)

  // Slide-down entrance.
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

  // Raise surface after 80px of scroll.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 80)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // Lock body scroll while the overlay is open.
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  // Close the overlay on Escape.
  useEffect(() => {
    if (!open) return
    const onKey = (e) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const go = (href) => (e) => {
    e.preventDefault()
    setOpen(false)
    scrollTo(href)
  }

  const goTop = (e) => {
    e.preventDefault()
    setOpen(false)
    scrollTo(0)
  }

  return (
    <header
      ref={headerRef}
      className={`${styles.nav} ${scrolled ? styles.scrolled : ''}`}
    >
      <div className={`container ${styles.bar}`}>
        {/* Brand lockup — interlocked SM crest + typographic wordmark */}
        <a href="#top" className={styles.brand} onClick={goTop} aria-label={`${team.name} — home`}>
          <img
            src="photos/logo-crest.png"
            alt=""
            className={styles.crest}
            width="34"
            height="34"
          />
          <span className={styles.wordmark}>
            <span className={styles.brandKicker}>FRC {team.number}</span>
            <span className={styles.brandName}>{team.name}</span>
          </span>
        </a>

        {/* Desktop links + CTA */}
        <nav className={styles.desktop} aria-label="Primary">
          <ul className={styles.links}>
            {LINKS.map((l) => (
              <li key={l.href}>
                <a href={l.href} className={styles.link} onClick={go(l.href)}>
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
          <MagneticButton
            as="a"
            href="#sponsor"
            onClick={go('#sponsor')}
            className={`btn btn--gold ${styles.cta}`}
          >
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
      <div
        id="nav-overlay"
        className={`${styles.overlay} ${open ? styles.overlayOpen : ''}`}
        hidden={!open}
      >
        <nav className={styles.overlayInner} aria-label="Mobile">
          <span className={styles.overlayEyebrow}>FRC {team.number} · {team.shortName}</span>
          <ul className={styles.overlayLinks}>
            {LINKS.map((l, i) => (
              <li key={l.href} style={{ '--i': i }}>
                <a href={l.href} className={styles.overlayLink} onClick={go(l.href)}>
                  <span className={styles.overlayNum}>0{i + 1}</span>
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
          <a
            href="#sponsor"
            className={`btn btn--gold ${styles.overlayCta}`}
            onClick={go('#sponsor')}
          >
            Sponsor Us
            <Icon name="arrowRight" size={18} className="arrow" />
          </a>
        </nav>
      </div>
    </header>
  )
}
