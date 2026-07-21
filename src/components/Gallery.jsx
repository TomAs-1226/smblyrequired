import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import Section from './Section'
import Eyebrow from './Eyebrow'
import SplitHeading from './SplitHeading'
import Icon from './Icon'
import { gallery, galleryNote, galleryPlaceholders } from '../data/gallery'
import { prefersReducedMotion } from '../lib/prefersReducedMotion'
import styles from './Gallery.module.css'

gsap.registerPlugin(ScrollTrigger, useGSAP)

const ALL = 'All'

// THE SEASON — editorial photo grid. Photos are composed onto a cohesive navy
// STAGE (radial spotlight + blueprint that fades at center, grounding shadow,
// cool color grade, edge-blending scrim) so snapshots read as staged product
// shots, not pasted rectangles. Tag chips filter the grid; a tile opens a
// full-screen lightbox with prev/next + keyboard/backdrop/Escape close.
export default function Gallery() {
  const root = useRef(null)

  // --- Tag filter ---------------------------------------------------------
  const tags = useMemo(() => {
    const set = []
    gallery.forEach((g) => {
      if (g.tag && !set.includes(g.tag)) set.push(g.tag)
    })
    return [ALL, ...set]
  }, [])
  const [active, setActive] = useState(ALL)

  const visible = useMemo(
    () => (active === ALL ? gallery : gallery.filter((g) => g.tag === active)),
    [active]
  )
  const showPlaceholders = active === ALL

  // --- Lightbox -----------------------------------------------------------
  // index into the *visible* list, or null when closed
  const [boxIndex, setBoxIndex] = useState(null)
  const isOpen = boxIndex !== null
  const overlayRef = useRef(null)
  const closeBtnRef = useRef(null)
  const lastFocused = useRef(null)

  const openBox = useCallback((i) => {
    lastFocused.current = document.activeElement
    setBoxIndex(i)
  }, [])
  const closeBox = useCallback(() => setBoxIndex(null), [])

  const step = useCallback(
    (dir) => {
      setBoxIndex((i) => {
        if (i === null || !visible.length) return i
        return (i + dir + visible.length) % visible.length
      })
    },
    [visible.length]
  )

  const current = isOpen ? visible[boxIndex] : null

  // Lock body scroll + restore focus + key handlers while open
  useEffect(() => {
    if (!isOpen) return

    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeBox()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        step(1)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        step(-1)
      } else if (e.key === 'Tab') {
        // simple focus trap within the overlay
        const node = overlayRef.current
        if (!node) return
        const focusables = Array.from(
          node.querySelectorAll('button, [href], [tabindex]:not([tabindex="-1"])')
        ).filter((el) => !el.disabled && el.offsetParent !== null)
        if (!focusables.length) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)

    // move focus into the dialog
    const id = requestAnimationFrame(() => closeBtnRef.current?.focus())

    return () => {
      document.removeEventListener('keydown', onKey)
      cancelAnimationFrame(id)
      document.body.style.overflow = prevOverflow
      // restore focus to the tile that opened it
      if (lastFocused.current && lastFocused.current.focus) {
        lastFocused.current.focus()
      }
    }
  }, [isOpen, closeBox, step])

  // Animate the overlay in once on open (reduced-motion: instant)
  useGSAP(
    () => {
      if (!isOpen) return
      if (prefersReducedMotion()) return
      const backdrop = overlayRef.current?.querySelector(`.${styles.lbBackdrop}`)
      const dialog = overlayRef.current?.querySelector(`.${styles.lbDialog}`)
      const tl = gsap.timeline()
      if (backdrop) tl.fromTo(backdrop, { opacity: 0 }, { opacity: 1, duration: 0.32, ease: 'power2.out' }, 0)
      if (dialog)
        tl.fromTo(
          dialog,
          { opacity: 0, scale: 0.94, y: 18 },
          { opacity: 1, scale: 1, y: 0, duration: 0.5, ease: 'power3.out' },
          0.04
        )
    },
    { scope: overlayRef, dependencies: [isOpen] }
  )

  // Cross-fade the image on prev/next without replaying the whole dialog
  useGSAP(
    () => {
      if (!isOpen) return
      if (prefersReducedMotion()) return
      const img = overlayRef.current?.querySelector(`.${styles.lbImg}`)
      if (img) gsap.fromTo(img, { opacity: 0.2 }, { opacity: 1, duration: 0.4, ease: 'power2.out' })
    },
    { scope: overlayRef, dependencies: [boxIndex] }
  )

  // --- Grid reveal (scroll-batched) — re-runs when the filter changes -----
  useGSAP(
    () => {
      const tiles = gsap.utils.toArray(`.${styles.tile}`)
      if (!tiles.length) return

      if (prefersReducedMotion()) {
        gsap.set(tiles, { autoAlpha: 1, clearProps: 'transform' })
        return
      }

      gsap.set(tiles, { autoAlpha: 0, y: 44 })
      ScrollTrigger.batch(tiles, {
        start: 'top 92%',
        once: true,
        onEnter: (batch) =>
          gsap.to(batch, {
            autoAlpha: 1,
            y: 0,
            duration: 0.8,
            ease: 'power4.out',
            stagger: 0.07,
            // See Reveal.jsx — the leftover inline transform outranks the
            // stylesheet and would kill the tile's hover lift and press state.
            clearProps: 'transform',
          }),
      })
      ScrollTrigger.refresh()
    },
    { scope: root, dependencies: [active] }
  )

  // size: 'wide' (2 cols) | 'tall' (2 rows) | undefined (1x1)
  const sizeClass = (size) =>
    size === 'wide' ? styles.wide : size === 'tall' ? styles.tall : ''

  return (
    <div ref={root}>
      <Section id="gallery" className={styles.root}>
        <header className={styles.head}>
          <Eyebrow>The season</Eyebrow>
          <SplitHeading as="h2" className={styles.heading}>
            In the pit and on the field.
          </SplitHeading>
          <p className={`lead ${styles.note}`}>{galleryNote}</p>
        </header>

        {/* --- Tag filter chips --- */}
        <div className={styles.filters} role="group" aria-label="Filter photos by tag">
          {tags.map((t) => {
            const isActive = active === t
            return (
              <button
                key={t}
                type="button"
                className={`${styles.chip} ${isActive ? styles.chipActive : ''}`}
                aria-pressed={isActive}
                onClick={() => setActive(t)}
              >
                <span className={styles.chipDot} aria-hidden="true" />
                {t}
              </button>
            )
          })}
        </div>

        <div className={styles.grid}>
          {visible.map((item, i) => {
            return (
              <figure
                key={item.src}
                className={`${styles.tile} ${sizeClass(item.size)}`}
              >
                <button
                  type="button"
                  className={styles.tileBtn}
                  onClick={() => openBox(i)}
                  aria-label={`View photo: ${item.caption}`}
                >
                  <span className={styles.stage} aria-hidden="true" />
                  <img
                    className={styles.img}
                    src={item.src}
                    alt={item.caption}
                    loading="lazy"
                    decoding="async"
                  />
                  <span className={styles.scrim} aria-hidden="true" />
                  <span className={styles.zoomCue} aria-hidden="true">
                    <Icon name="external" size={16} />
                  </span>
                  <figcaption className={styles.cap}>
                    <span className={`data-tag ${styles.capTag}`}>{item.tag}</span>
                    <span className={styles.capText}>{item.caption}</span>
                  </figcaption>
                </button>
              </figure>
            )
          })}

          {showPlaceholders &&
            Array.from({ length: galleryPlaceholders }).map((_, i) => (
              <div
                key={`ph-${i}`}
                className={`hud-frame ${styles.tile} ${styles.placeholder}`}
                aria-hidden="true"
              >
                <span className={styles.placeholderMark}>
                  <Icon name="spark" size={26} />
                </span>
                <span className={styles.placeholderText}>More coming soon</span>
                <span className={styles.placeholderTag}>ADD A PHOTO</span>
              </div>
            ))}
        </div>
      </Section>

      {/* --- LIGHTBOX --- */}
      {isOpen && current && (
        <div
          ref={overlayRef}
          className={styles.lightbox}
          role="dialog"
          aria-modal="true"
          aria-label={current.caption}
        >
          <div className={styles.lbBackdrop} onClick={closeBox} aria-hidden="true" />

          <button
            ref={closeBtnRef}
            type="button"
            className={styles.lbClose}
            onClick={closeBox}
            aria-label="Close"
          >
            <Icon name="close" size={22} />
          </button>

          <button
            type="button"
            className={`${styles.lbNav} ${styles.lbPrev}`}
            onClick={() => step(-1)}
            aria-label="Previous photo"
            disabled={visible.length < 2}
          >
            <Icon name="arrowRight" size={26} />
          </button>

          <figure className={styles.lbDialog} onClick={(e) => e.stopPropagation()}>
            <div className={styles.lbStage}>
              <img
                key={current.src}
                className={styles.lbImg}
                src={current.src}
                alt={current.caption}
                decoding="async"
              />
            </div>
            <figcaption className={styles.lbCap}>
              <span className={`data-tag ${styles.lbTag}`}>{current.tag}</span>
              <span className={styles.lbText}>{current.caption}</span>
              <span className={styles.lbCount}>
                {String(boxIndex + 1).padStart(2, '0')} / {String(visible.length).padStart(2, '0')}
              </span>
            </figcaption>
          </figure>

          <button
            type="button"
            className={`${styles.lbNav} ${styles.lbNext}`}
            onClick={() => step(1)}
            aria-label="Next photo"
            disabled={visible.length < 2}
          >
            <Icon name="arrowRight" size={26} />
          </button>
        </div>
      )}
    </div>
  )
}
