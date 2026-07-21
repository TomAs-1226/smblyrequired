import { useCallback, useEffect, useRef, useState } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import Icon from './Icon'
import MagneticButton from './MagneticButton'
import { team } from '../data/team'
import { navLinks } from '../data/navigation'
import { useRoute } from '../hooks/useRoute'
import { prefersReducedMotion } from '../lib/prefersReducedMotion'
import { getLenis } from '../lib/smoothScroll'
import styles from './Nav.module.css'

// Fixed top bar. Slides down on mount, raises a surface past 80px (or always on
// subpages), and on mobile swaps the link row for a full-screen overlay menu.
// Multi-page: links are hash routes (#/team …); active state tracks the route.
export default function Nav() {
  const headerRef = useRef(null)
  const overlayRef = useRef(null)
  const toggleRef = useRef(null)
  // Set only when a close should hand focus back to the burger (Escape, or the
  // toggle itself). Following a link is a navigation, not a dismissal — pulling
  // focus back to the nav there would fight the new page.
  const restoreFocus = useRef(false)
  const wasOpen = useRef(false)
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
        // A leftover inline transform would make the <header> a containing
        // block for `position: fixed` descendants. Verified at runtime that
        // this does clear (computed transform is `none` once the tween ends).
        // The overlay no longer lives inside the header either — see below —
        // but this stays, because a stuck transform would still park the bar
        // off-screen and kill the CSS press states. See Reveal.jsx.
        clearProps: 'transform',
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

  // Scroll lock while the overlay is up.
  useEffect(() => {
    if (!open) return

    // `document.body.style.overflow = 'hidden'` alone does NOT hold this page.
    // Lenis drives scrolling programmatically, and `overflow: hidden` only
    // blocks *user* scrolling — the element stays a scroll container and
    // scrollTop can still be written. So a wheel/touch gesture over the open
    // menu still advanced Lenis's virtual target and it wrote the result
    // straight back: measured 400px -> 1000px with the menu open. Lenis has to
    // be stopped explicitly.
    const lenis = getLenis()
    lenis?.stop()

    // Still lock the body: Lenis is never constructed on the reduced-motion
    // path, and this is also what holds native touch scrolling.
    const prevOverflow = document.body.style.overflow
    const prevPadding = document.body.style.paddingRight
    // Losing the scrollbar reflows the page; hold its width so nothing shifts
    // sideways underneath the overlay. Zero on mobile/overlay scrollbars.
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth
    document.body.style.overflow = 'hidden'
    if (scrollbarWidth > 0) document.body.style.paddingRight = `${scrollbarWidth}px`

    return () => {
      // Neither lock moves the scroll position, so it is preserved on close.
      lenis?.start()
      document.body.style.overflow = prevOverflow
      document.body.style.paddingRight = prevPadding
    }
  }, [open])

  // Escape to dismiss, and a focus trap so Tab cannot walk out of the overlay
  // into the 37-odd tabbable elements still sitting behind it.
  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') {
        restoreFocus.current = true
        setOpen(false)
        return
      }
      if (e.key !== 'Tab') return
      const overlay = overlayRef.current
      if (!overlay) return
      // The toggle doubles as the close button and sits outside the overlay,
      // so it belongs in the cycle.
      const nodes = [
        toggleRef.current,
        ...overlay.querySelectorAll('a[href], button:not([disabled])'),
      ].filter(Boolean)
      if (!nodes.length) return
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      const active = document.activeElement
      if (!nodes.includes(active)) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
      } else if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // Hand focus back to the burger on dismissal. Marking the overlay `inert`
  // drops focus to <body>, so without this a keyboard user closing the menu
  // lands at the top of the document with no position.
  useEffect(() => {
    if (wasOpen.current && !open && restoreFocus.current) {
      const active = document.activeElement
      if (!active || active === document.body || overlayRef.current?.contains(active)) {
        toggleRef.current?.focus()
      }
    }
    restoreFocus.current = false
    wasOpen.current = open
  }, [open])

  // Close the overlay whenever the route changes.
  useEffect(() => {
    setOpen(false)
  }, [path])

  // Surface shows once scrolled, or always on subpages (no hero behind).
  const showSurface = scrolled || !isHome
  const close = useCallback(() => setOpen(false), [])
  const toggle = useCallback(() => {
    setOpen((v) => {
      if (v) restoreFocus.current = true
      return !v
    })
  }, [])

  return (
    <>
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
            {/* Staff door. Deliberately quiet — the nav's audience is sponsors
                and prospective students, and the gold CTA is the one thing on
                this bar that should read as an invitation. A plain anchor, not
                a router import: the portal is lazy-loaded so the public bundle
                never pays for the Supabase client, and touching auth from here
                would drag it back into index-*.js. */}
            <a href="#/portal" className={styles.signIn}>
              <Icon name="user" size={15} className={styles.signInIcon} />
              <span className={styles.signInLabel}>Sign in</span>
            </a>
            <MagneticButton as="a" href="#/sponsor" className={`btn btn--gold ${styles.cta}`}>
              Sponsor Us
              <Icon name="arrowRight" size={18} className="arrow" />
            </MagneticButton>
          </nav>

          {/* Mobile toggle */}
          <button
            type="button"
            ref={toggleRef}
            className={styles.toggle}
            aria-expanded={open}
            aria-controls="nav-overlay"
            onClick={toggle}
          >
            <span className="sr-only">{open ? 'Close menu' : 'Open menu'}</span>
            <Icon name={open ? 'close' : 'menu'} size={26} />
          </button>
        </div>
      </header>

      {/* Mobile full-screen overlay — a SIBLING of <header>, not a child.
          This is load-bearing. `backdrop-filter` on the scrolled bar makes the
          <header> a containing block for `position: fixed` descendants, exactly
          the way `transform` does, so `inset: 0` resolved against the 72px bar
          and the menu opened as a 71px strip. That fired on every subpage
          (which is always `.scrolled`) and on home past 80px. Rendering it
          outside the header means no ancestor can capture it again.

          Deliberately NOT `hidden` — that applies display:none, which kills the
          fade in both directions (the element is gone before it can animate out,
          and has no start state on the way in). CSS drives visibility instead so
          the transition runs; `inert` keeps the closed menu out of the tab order
          and the a11y tree. It is spread conditionally because React 18 would
          render inert="false" — and per spec any value, including "false",
          makes the subtree inert. */}
      <div
        id="nav-overlay"
        ref={overlayRef}
        className={`${styles.overlay} ${open ? styles.overlayOpen : ''}`}
        style={{ '--link-count': navLinks.length }}
        {...(!open && { inert: '' })}
      >
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
          <a href="#/portal" className={styles.overlaySignIn} onClick={close}>
            <Icon name="user" size={16} className={styles.signInIcon} />
            Team sign in
          </a>
        </nav>
      </div>
    </>
  )
}
