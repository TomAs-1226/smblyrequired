import { useRef } from 'react'
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

// THE SEASON — editorial photo grid. Dense auto-flow masonry that honors
// per-item 'wide'/'tall' spans, navy scrim + hover-reveal caption with a mono
// data-tag, and dashed HUD placeholder slots the team can fill later.
export default function Gallery() {
  const root = useRef(null)

  useGSAP(
    () => {
      const tiles = gsap.utils.toArray(`.${styles.tile}`)
      if (!tiles.length) return

      if (prefersReducedMotion()) {
        gsap.set(tiles, { autoAlpha: 1, y: 0 })
        return
      }

      gsap.set(tiles, { autoAlpha: 0, y: 44 })
      ScrollTrigger.batch(tiles, {
        start: 'top 90%',
        once: true,
        onEnter: (batch) =>
          gsap.to(batch, {
            autoAlpha: 1,
            y: 0,
            duration: 0.85,
            ease: 'expo.out',
            stagger: 0.08,
          }),
      })
    },
    { scope: root }
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

        <div className={styles.grid}>
          {gallery.map((item) => (
            <figure
              key={item.src}
              className={`${styles.tile} ${sizeClass(item.size)}`}
              tabIndex={0}
            >
              <img
                className={styles.img}
                src={item.src}
                alt={item.caption}
                loading="lazy"
                decoding="async"
              />
              <span className={styles.scrim} aria-hidden="true" />
              <figcaption className={styles.cap}>
                <span className={`data-tag ${styles.capTag}`}>{item.tag}</span>
                <span className={styles.capText}>{item.caption}</span>
              </figcaption>
            </figure>
          ))}

          {Array.from({ length: galleryPlaceholders }).map((_, i) => (
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
    </div>
  )
}
