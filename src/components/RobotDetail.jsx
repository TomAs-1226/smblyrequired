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
  const mediaRef = useRef(null)

  // Staged-photo reveal + gentle scrub parallax for the hero shot. Hooks must
  // run unconditionally; the body is a no-op when there's no photo/motion.
  useGSAP(
    () => {
      if (prefersReducedMotion() || !mediaRef.current) return
      const stage = mediaRef.current.querySelector(`.${styles.stage}`)
      const photo = mediaRef.current.querySelector(`.${styles.photo}`)
      if (photo) {
        gsap.from(photo, {
          scale: 1.05,
          autoAlpha: 0,
          duration: 1.15,
          ease: 'expo.out',
          // See Reveal.jsx — the leftover inline transform would kill
          // `.frame:hover .photo`'s zoom.
          clearProps: 'transform',
        })
      }
      if (stage) {
        gsap.fromTo(
          stage,
          { y: 22 },
          {
            y: -22,
            ease: 'none',
            scrollTrigger: {
              trigger: mediaRef.current,
              start: 'top bottom',
              end: 'bottom top',
              scrub: 0.6,
            },
          }
        )
      }
    },
    { scope: mediaRef, dependencies: [slug] }
  )

  if (!robot) return <NotFound slug={slug} />

  const { name, book, season, year, game, status, result, blurb, image, current, subtitle } = robot
  const champion = status === 'champion'
  const build = status === 'build'
  const prev = index > 0 ? robots[index - 1] : null
  const next = index < robots.length - 1 ? robots[index + 1] : null

  // Lead with the real mechanism specs from the data, then round out the grid
  // with the season/result context. Keeps the page driven by what's on the bot.
  const specs = [
    ...(robot.specs || []),
    { label: 'Season', value: season },
    { label: 'Result', value: result },
  ]

  return (
    <Section id="robot">
      <a className={styles.back} href="#/robots">
        <span aria-hidden="true">&larr;</span> All robots
      </a>

      <div className={styles.layout}>
        {/* --- Media: real photo (never cropped) or typographic plate --- */}
        <div className={styles.mediaCol} ref={mediaRef}>
          {image ? (
            <figure className={`hud-frame ${styles.frame} ${champion ? styles.isChampion : ''}`}>
              {/* Staged well: spotlight + blueprint backdrop, subject grounded
                  with a soft reflection so it reads as a staged shot. */}
              <div className={styles.stage}>
                <span className={styles.spot} aria-hidden="true" />
                <span className={styles.grid} aria-hidden="true" />
                <div className={styles.subject}>
                  <img
                    className={styles.photo}
                    src={image}
                    alt={`${name} — Team 5805's ${year} ${game} robot`}
                    decoding="async"
                  />
                  <span className={styles.shadow} aria-hidden="true" />
                </div>
              </div>
              <figcaption className={styles.frameCap}>
                <span className={styles.frameTick} aria-hidden="true" />
                {name} · {game} · {year}
              </figcaption>
            </figure>
          ) : (
            <figure className={`hud-frame ${styles.frame} ${styles.plateFrame}`}>
              <div className={`${styles.stage} ${styles.plate}`} aria-hidden="true">
                <span className={styles.spot} />
                <span className={styles.grid} />
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

          {subtitle && (
            <Reveal y={16}>
              <p className={styles.subtitle}>{subtitle}</p>
            </Reveal>
          )}

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
        // See Reveal.jsx — these children include the "back home" .btn, whose
        // `:active` press is a transform the leftover inline style would kill.
        clearProps: 'transform',
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
