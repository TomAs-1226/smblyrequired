import { useRef } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import Section from './Section'
import Eyebrow from './Eyebrow'
import SplitHeading from './SplitHeading'
import Reveal from './Reveal'
import Icon from './Icon'
import { robots } from '../data/robots'
import { prefersReducedMotion } from '../lib/prefersReducedMotion'
import styles from './RobotDetail.module.css'

gsap.registerPlugin(ScrollTrigger, useGSAP)

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI']
const slugOf = (name) => name.toLowerCase()

// Per-robot detail page. Resolved from the URL slug against name.toLowerCase().
export default function RobotDetail({ slug }) {
  const index = robots.findIndex((r) => slugOf(r.name) === slug)
  const robot = index === -1 ? null : robots[index]

  if (!robot) return <NotFound slug={slug} />

  const { name, book, season, year, game, status, result, blurb, image, current } = robot
  const champion = status === 'champion'
  const build = status === 'build'
  const prev = index > 0 ? robots[index - 1] : null
  const next = index < robots.length - 1 ? robots[index + 1] : null

  const specs = [
    { label: 'Season', value: season },
    { label: 'Game', value: game },
    { label: 'Year', value: String(year) },
    { label: 'Result', value: result },
  ]

  return (
    <Section id="robot">
      <a className={styles.back} href="#/robots">
        <span aria-hidden="true">&larr;</span> All robots
      </a>

      <div className={styles.layout}>
        {/* --- Media: real photo (never cropped) or typographic plate --- */}
        <div className={styles.mediaCol}>
          {image ? (
            <figure className={`hud-frame ${styles.frame}`}>
              <div className={styles.frameInner}>
                <img
                  className={styles.photo}
                  src={image}
                  alt={`${name} — Team 5805's ${year} ${game} robot`}
                  decoding="async"
                />
              </div>
              <figcaption className={styles.frameCap}>
                <span className={styles.frameTick} aria-hidden="true" />
                {name} · {game} · {year}
              </figcaption>
            </figure>
          ) : (
            <figure className={`hud-frame ${styles.frame} ${styles.plateFrame}`}>
              <div className={`${styles.frameInner} ${styles.plate}`} aria-hidden="true">
                <span className={`num-ghost ${styles.plateGhost}`}>
                  {ROMAN[index] || index + 1}
                </span>
                <span className={styles.plateYear}>{year}</span>
                <span className={styles.plateBook}>{book}</span>
              </div>
            </figure>
          )}
        </div>

        {/* --- Identity + narrative + spec --- */}
        <div className={styles.textCol}>
          <Eyebrow className={styles.eyebrow}>
            {book} · {season}
          </Eyebrow>

          <SplitHeading as="h1" className={styles.name}>
            {name}
          </SplitHeading>

          <span className={`data-tag ${styles.game}`}>{game}</span>

          <Reveal className={styles.statusRow} stagger={0.08} y={18}>
            <p
              className={[styles.result, champion && styles.resultGold, build && styles.resultBuild]
                .filter(Boolean)
                .join(' ')}
            >
              {champion && <Icon name="trophy" size={20} className={styles.resultIcon} />}
              {build && <Icon name="wrench" size={18} className={styles.resultIcon} />}
              <span>{result}</span>
            </p>
            {current && (
              <span className={styles.current}>
                <span className={styles.currentDot} aria-hidden="true" />
                Current robot
              </span>
            )}
          </Reveal>

          <Reveal y={24}>
            <p className={`lead ${styles.blurb}`}>{blurb}</p>
          </Reveal>

          <Reveal className={styles.spec} stagger={0.07} y={16} as="dl">
            {specs.map((s) => (
              <div className={styles.specRow} key={s.label}>
                <dt className={styles.specKey}>{s.label}</dt>
                <dd className={styles.specVal}>{s.value}</dd>
              </div>
            ))}
          </Reveal>
        </div>
      </div>

      {/* --- Prev / next through the lineage --- */}
      {(prev || next) && (
        <nav className={styles.pager} aria-label="Robot lineage">
          {prev ? (
            <a className={`${styles.pagerLink} ${styles.pagerPrev}`} href={'#/robots/' + slugOf(prev.name)}>
              <span className={styles.pagerDir}>
                <Icon name="arrowRight" size={16} className={styles.pagerArrowBack} />
                Previous
              </span>
              <span className={styles.pagerName}>{prev.name}</span>
              <span className={styles.pagerMeta}>{prev.book} · {prev.year}</span>
            </a>
          ) : (
            <span className={styles.pagerSpacer} aria-hidden="true" />
          )}

          {next ? (
            <a className={`${styles.pagerLink} ${styles.pagerNext}`} href={'#/robots/' + slugOf(next.name)}>
              <span className={styles.pagerDir}>
                Next
                <Icon name="arrowRight" size={16} className={styles.pagerArrow} />
              </span>
              <span className={styles.pagerName}>{next.name}</span>
              <span className={styles.pagerMeta}>{next.book} · {next.year}</span>
            </a>
          ) : (
            <span className={styles.pagerSpacer} aria-hidden="true" />
          )}
        </nav>
      )}
    </Section>
  )
}

function NotFound({ slug }) {
  const root = useRef(null)
  useGSAP(
    () => {
      if (prefersReducedMotion()) return
      gsap.from(root.current.children, {
        autoAlpha: 0,
        y: 24,
        duration: 0.7,
        ease: 'expo.out',
        stagger: 0.1,
      })
    },
    { scope: root }
  )

  return (
    <Section id="robot-404">
      <div className={styles.missing} ref={root}>
        <span className={`num-ghost ${styles.missingGhost}`} aria-hidden="true">
          404
        </span>
        <Eyebrow className={styles.missingEyebrow}>Off the field</Eyebrow>
        <h1 className={styles.missingTitle}>Robot not found</h1>
        <p className={`lead ${styles.missingBody}`}>
          {slug ? (
            <>
              We don&rsquo;t have a robot named <span className={styles.missingSlug}>{slug}</span> in
              the lineage. It may have been renamed, or the link is off.
            </>
          ) : (
            <>That robot isn&rsquo;t in the lineage.</>
          )}
        </p>
        <a className="btn btn--cyan" href="#/robots">
          <span aria-hidden="true">&larr;</span> Back to all robots
        </a>
      </div>
    </Section>
  )
}
