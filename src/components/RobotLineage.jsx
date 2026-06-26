import { useRef } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import Section from './Section'
import Eyebrow from './Eyebrow'
import SplitHeading from './SplitHeading'
import Icon from './Icon'
import { robots, lineageNote } from '../data/robots'
import styles from './RobotLineage.module.css'

gsap.registerPlugin(ScrollTrigger, useGSAP)

// THE signature pinned moment: on desktop the four robot panels are pinned and
// horizontally scrubbed; on mobile / reduced-motion they fall back to a plain
// vertical card stack. Real text lives in the DOM either way (SEO + no-JS safe).
export default function RobotLineage() {
  const pinWrap = useRef(null)
  const track = useRef(null)

  useGSAP(
    () => {
      const wrap = pinWrap.current
      const inner = track.current
      if (!wrap || !inner) return

      const mm = gsap.matchMedia()

      // Desktop, motion OK: pin + horizontal scrub of the track.
      mm.add('(min-width: 768px) and (prefers-reduced-motion: no-preference)', () => {
        const panels = inner.children.length
        const distance = () => inner.scrollWidth - window.innerWidth

        const tween = gsap.to(inner, {
          x: () => -distance(),
          ease: 'none',
          scrollTrigger: {
            trigger: wrap,
            start: 'top top',
            end: () => '+=' + distance(),
            pin: true,
            anticipatePin: 1,
            scrub: 1,
            invalidateOnRefresh: true,
            snap: panels > 1 ? { snapTo: 1 / (panels - 1), duration: 0.35, ease: 'power1.inOut' } : false,
          },
        })

        return () => tween.kill()
      })

      // Mobile / reduced-motion: stagger the stacked cards in on scroll.
      // (Each panel as a card — the desktop pin branch above owns its motion,
      //  so this branch only stacks + lifts.) Reduced-motion lands on final state.
      mm.add('(max-width: 767px) and (prefers-reduced-motion: no-preference)', () => {
        const panels = gsap.utils.toArray(inner.children)
        const anims = panels.map((p) =>
          gsap.from(p, {
            autoAlpha: 0,
            y: 48,
            duration: 0.8,
            ease: 'expo.out',
            scrollTrigger: { trigger: p, start: 'top 88%', once: true },
          })
        )
        return () => anims.forEach((a) => a.kill())
      })

      return () => mm.revert()
    },
    { scope: pinWrap }
  )

  return (
    <Section id="robots" bleed className={styles.section}>
      <div className={`container ${styles.intro}`}>
        <Eyebrow num="02">The robots</Eyebrow>
        <div className={styles.introGrid}>
          <SplitHeading as="h2" className={styles.heading}>
            Named for the Books.
          </SplitHeading>
          <p className={`lead ${styles.note}`}>{lineageNote}</p>
        </div>
      </div>

      {/* DESKTOP: pinned horizontal track. MOBILE/reduced: vertical stack
          (CSS turns the track into a column; the pin matchMedia simply never
          fires below 768px or when motion is reduced). */}
      <div ref={pinWrap} className={styles.pinWrap}>
        <div ref={track} className={styles.track}>
          {robots.map((r, i) => (
            <Panel key={r.name} robot={r} index={i} total={robots.length} />
          ))}
        </div>
      </div>
    </Section>
  )
}

function Panel({ robot, index, total }) {
  const { name, book, season, year, status, result, blurb, image, current } = robot
  const champion = status === 'champion'
  const build = status === 'build'

  // Each panel is a real <article> with an <h3> nameplate — visible in the DOM
  // with no JS. Desktop motion is the pin scrub; mobile motion is the stagger in
  // the parent's matchMedia. The outer div only carries slide/stack layout.
  return (
    <div className={styles.panelOuter}>
    <article
      className={[
        styles.panel,
        champion && styles.isChampion,
        build && styles.isBuild,
        image && styles.hasImage,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {image ? (
        <div className={styles.media} aria-hidden="true">
          <img src={image} alt="" loading="lazy" />
          <span className={styles.mediaScrim} />
        </div>
      ) : (
        <div className={styles.glyph} aria-hidden="true">
          <span className={styles.glyphYear}>{year}</span>
          <span className={styles.glyphNum}>{romanFor(index)}</span>
        </div>
      )}

      <div className={styles.body}>
        <div className={styles.plateRow}>
          <span className={styles.bookLabel}>
            {book}
            <span className={styles.bookDot} aria-hidden="true">
              ·
            </span>
            {season}
          </span>
          {current && (
            <span className={styles.current}>
              <span className={styles.currentDot} aria-hidden="true" />
              Current robot
            </span>
          )}
        </div>

        <h3 className={styles.name}>{name}</h3>

        <p
          className={[
            styles.result,
            champion && styles.resultGold,
            build && styles.resultBuild,
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {champion && <Icon name="trophy" size={20} className={styles.resultIcon} />}
          {build && <Icon name="wrench" size={20} className={styles.resultIcon} />}
          <span>{result}</span>
        </p>

        <p className={styles.blurb}>{blurb}</p>

        <span className={styles.index} aria-hidden="true">
          {String(index + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}
        </span>
      </div>
    </article>
    </div>
  )
}

function romanFor(i) {
  return ['I', 'II', 'III', 'IV', 'V', 'VI'][i] || String(i + 1)
}
