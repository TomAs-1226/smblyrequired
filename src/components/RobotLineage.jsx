import { useRef } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import Section from './Section'
import Eyebrow from './Eyebrow'
import SplitHeading from './SplitHeading'
import Icon from './Icon'
import { robots, lineageNote } from '../data/robots'
import { prefersReducedMotion } from '../lib/prefersReducedMotion'
import styles from './RobotLineage.module.css'

gsap.registerPlugin(ScrollTrigger, useGSAP)

// Clean, READABLE vertical lineage. Four robots as large editorial rows that
// alternate sides (image left / text right, then mirrored). No pin, no scrub —
// every row is real text in the DOM (SEO + no-JS safe) and just gently reveals
// on scroll. The pinned horizontal version was too tall and unreadable.
export default function RobotLineage() {
  const root = useRef(null)

  useGSAP(
    () => {
      if (prefersReducedMotion()) return
      const rows = gsap.utils.toArray(`.${styles.row}`)
      rows.forEach((row) => {
        const media = row.querySelector(`.${styles.mediaCol}`)
        const text = row.querySelector(`.${styles.textCol}`)
        const parts = [media, text].filter(Boolean)

        // Columns lift + fade in, gently staggered.
        gsap.from(parts, {
          autoAlpha: 0,
          y: 44,
          duration: 0.9,
          ease: 'power4.out',
          stagger: 0.12,
          scrollTrigger: { trigger: row, start: 'top 82%', once: true },
        })

        // The staged photo settles in: a subtle scale-in (1.045 → 1) on the
        // image inside its lit well, so it reads as composed, not pasted.
        const photo = row.querySelector(`.${styles.photo}`)
        if (photo) {
          gsap.from(photo, {
            scale: 1.045,
            autoAlpha: 0,
            duration: 1.1,
            ease: 'expo.out',
            scrollTrigger: { trigger: row, start: 'top 82%', once: true },
          })
        }

        // Tasteful scrub parallax: the well drifts a hair as the row passes,
        // giving the staged subject real depth against the blueprint.
        const well = row.querySelector(`.${styles.stage}`)
        if (well) {
          gsap.fromTo(
            well,
            { y: 26 },
            {
              y: -26,
              ease: 'none',
              scrollTrigger: {
                trigger: row,
                start: 'top bottom',
                end: 'bottom top',
                scrub: 0.6,
              },
            }
          )
        }
      })
    },
    { scope: root }
  )

  return (
    <Section id="robots" className={styles.section}>
      <div className={styles.intro}>
        <Eyebrow>The robots</Eyebrow>
        <SplitHeading as="h2" className={styles.heading}>
          Named for the Books.
        </SplitHeading>
        <p className={`lead ${styles.note}`}>{lineageNote}</p>
      </div>

      <div className={styles.lineage} ref={root}>
        {robots.map((r, i) => (
          <Row key={r.name} robot={r} index={i} total={robots.length} />
        ))}
      </div>
    </Section>
  )
}

function Row({ robot, index, total }) {
  const { name, book, season, year, game, status, result, blurb, image, current, subtitle, specs } =
    robot
  const champion = status === 'champion'
  const build = status === 'build'
  // Even rows: image left / text right. Odd rows: text left / image right.
  const mirrored = index % 2 === 1
  // Lead with the real mechanism specs — top 2–3 as compact mono chips.
  const topSpecs = (specs || []).slice(0, 3)

  return (
    <article
      className={[
        styles.row,
        mirrored && styles.rowMirror,
        champion && styles.isChampion,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className={styles.mediaCol}>
        {image ? (
          <figure className={`hud-frame ${styles.frame}`}>
            {/* Staged well: spotlight + blueprint backdrop, subject grounded
                with a soft reflection so it sits in space, never pasted. */}
            <div className={styles.stage}>
              <span className={styles.spot} aria-hidden="true" />
              <span className={styles.grid} aria-hidden="true" />
              <div className={styles.subject}>
                <img
                  className={styles.photo}
                  src={image}
                  alt={`${name} — Team 5805's ${year} ${game} robot`}
                  loading="lazy"
                  decoding="async"
                />
                <span className={styles.shadow} aria-hidden="true" />
              </div>
            </div>
          </figure>
        ) : (
          <figure className={`hud-frame ${styles.frame} ${styles.plateFrame}`}>
            <div className={`${styles.stage} ${styles.plate}`} aria-hidden="true">
              <span className={styles.spot} />
              <span className={styles.grid} />
              <span className={`num-ghost ${styles.plateGhost}`}>{romanFor(index)}</span>
              <span className={styles.plateYear}>{year}</span>
              <span className={styles.plateBook}>{book}</span>
            </div>
          </figure>
        )}
      </div>

      <div className={styles.textCol}>
        <p className={styles.bookLine}>
          <span className={styles.bookName}>{book}</span>
          <span className={styles.bookDot} aria-hidden="true">
            ·
          </span>
          <span>{season}</span>
        </p>

        <div className={styles.nameRow}>
          <h3 className={styles.name}>
            <a className={styles.nameLink} href={`#/robots/${name.toLowerCase()}`}>
              {name}
            </a>
          </h3>
          {current && (
            <span className={styles.current}>
              <span className={styles.currentDot} aria-hidden="true" />
              Current robot
            </span>
          )}
        </div>

        {subtitle && <p className={styles.subtitle}>{subtitle}</p>}

        <span className={`data-tag ${styles.game}`}>{game}</span>

        {topSpecs.length > 0 && (
          <dl className={styles.specChips}>
            {topSpecs.map((s) => (
              <div className={styles.specChip} key={s.label}>
                <dt className={styles.specChipKey}>{s.label}</dt>
                <dd className={styles.specChipVal}>{s.value}</dd>
              </div>
            ))}
          </dl>
        )}

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
          {build && <Icon name="wrench" size={18} className={styles.resultIcon} />}
          <span>{result}</span>
        </p>

        <p className={styles.blurb}>{blurb}</p>

        <a className={styles.detailLink} href={`#/robots/${name.toLowerCase()}`}>
          Full details
          <Icon name="arrowRight" size={18} className="arrow" />
        </a>

        <span className={styles.index} aria-hidden="true">
          {String(index + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}
        </span>
      </div>
    </article>
  )
}

function romanFor(i) {
  return ['I', 'II', 'III', 'IV', 'V', 'VI'][i] || String(i + 1)
}
