import { useRef } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import Section from './Section'
import Eyebrow from './Eyebrow'
import SplitHeading from './SplitHeading'
import StatNumeral from './StatNumeral'
import Reveal from './Reveal'
import Icon from './Icon'
import { achievements, recordStats, recordNote } from '../data/achievements'
import { schedule, season, livestreamUrl } from '../data/schedule'
import { team } from '../data/team'
import { rosterCount } from '../data/roster'
import { prefersReducedMotion } from '../lib/prefersReducedMotion'
import styles from './Impact.module.css'

gsap.registerPlugin(ScrollTrigger, useGSAP)

// kind => accent. winner & rookie are EARNED hardware => gold (scarce, prestige).
// finalist & award => cyan (live/data voice).
const GOLD_KINDS = new Set(['winner', 'rookie'])
const isGold = (kind) => GOLD_KINDS.has(kind)

// Short telemetry label shown beside each award.
const KIND_TAG = {
  winner: 'WIN',
  rookie: 'ROOKIE',
  finalist: 'FINALIST',
  award: 'AWARD',
}

// Group achievements by year, DESC, preserving in-file order within a year.
function groupByYear(list) {
  const order = []
  const map = new Map()
  for (const a of list) {
    if (!map.has(a.year)) {
      map.set(a.year, [])
      order.push(a.year)
    }
    map.get(a.year).push(a)
  }
  return order
    .sort((x, y) => y - x)
    .map((year) => ({ year, rows: map.get(year) }))
}

const honors = groupByYear(achievements)

// TRACK RECORD — "05". Editorial honors timeline (kind-colored ticks; gold for
// wins only), a full-bleed real-win proof band, a 2026 season telemetry rail,
// and a judge-facing program-impact narrative built only from real facts.
export default function Impact() {
  const root = useRef(null)
  const proof = useRef(null)

  useGSAP(
    () => {
      if (prefersReducedMotion()) return
      const scope = root.current

      // 1) Full-bleed proof band — cinematic parallax + scale settle.
      const img = proof.current
      if (img) {
        gsap.fromTo(
          img,
          { scale: 1.2, yPercent: -8 },
          {
            scale: 1.05,
            yPercent: 8,
            ease: 'none',
            scrollTrigger: {
              trigger: img.parentElement,
              start: 'top bottom',
              end: 'bottom top',
              scrub: true,
            },
          }
        )
      }

      // 2) Timeline spine — grow the vertical hairline as the list scrolls.
      const spine = scope.querySelector(`.${styles.spineFill}`)
      const track = scope.querySelector(`.${styles.timeline}`)
      if (spine && track) {
        gsap.fromTo(
          spine,
          { scaleY: 0 },
          {
            scaleY: 1,
            ease: 'none',
            scrollTrigger: {
              trigger: track,
              start: 'top 78%',
              end: 'bottom 72%',
              scrub: true,
            },
          }
        )
      }

      // 3) Kind-colored ticks pop in on their row, one at a time.
      scope.querySelectorAll(`.${styles.tick}`).forEach((tick) => {
        gsap.fromTo(
          tick,
          { scale: 0, opacity: 0 },
          {
            scale: 1,
            opacity: 1,
            duration: 0.5,
            ease: 'back.out(2)',
            scrollTrigger: { trigger: tick, start: 'top 90%', once: true },
          }
        )
      })
    },
    { scope: root }
  )

  return (
    <div ref={root}>
      <Section id="impact">
        {/* ---- Header: eyebrow + dramatic heading + record note ---- */}
        <div className={styles.head}>
          <div className={styles.headLede}>
            <Eyebrow num="05">Track record</Eyebrow>
            <SplitHeading as="h2" className={styles.heading}>
              Winning since rookie year.
            </SplitHeading>
          </div>
          <Reveal className={styles.headNote} y={24}>
            <p className="lead">{recordNote}</p>
          </Reveal>
        </div>

        {/* ---- Record stats rail (one gold max) + source credibility ---- */}
        <div className={styles.statsBlock}>
          <Reveal className={styles.statsRow} stagger={0.1} y={28}>
            {recordStats.map((s, i) => (
              <div className={styles.stat} key={s.label}>
                <StatNumeral to={s.to} suffix={s.suffix || ''} label={s.label} gold={i === 1} />
              </div>
            ))}
          </Reveal>
          <p className={`data-tag ${styles.source}`}>Source: The Blue Alliance</p>
        </div>
      </Section>

      {/* ---- The Honors: editorial timeline grouped by year DESC ---- */}
      <Section id="impact-honors" rule={false} tight>
        <p className={styles.honorsLabel}>
          <span className={styles.honorsRule} aria-hidden="true" />
          <span>The honors</span>
        </p>

        <div className={styles.timeline}>
          {/* vertical spine that grows on scroll */}
          <span className={styles.spine} aria-hidden="true">
            <span className={styles.spineFill} />
          </span>

          {honors.map((group) => (
            <div className={styles.yearGroup} key={group.year}>
              <div className={styles.yearCol}>
                <span className={styles.yearNum}>{group.year}</span>
                <span className={styles.yearTag}>Season</span>
              </div>

              <div className={styles.rows}>
                {group.rows.map((a, i) => {
                  const gold = isGold(a.kind)
                  return (
                    <Reveal
                      className={[
                        styles.row,
                        a.flagship && styles.rowFlagship,
                        a.flagship && 'hud-frame',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      y={26}
                      key={`${a.year}-${a.event}-${i}`}
                    >
                      <span
                        className={`${styles.tick} ${gold ? styles.tickGold : styles.tickCyan}`}
                        aria-hidden="true"
                      />
                      <div className={styles.rowMain}>
                        <p className={styles.rowEvent}>
                          {a.event}
                          {a.flagship && (
                            <span className={styles.flagMark} aria-hidden="true">
                              <Icon name="star" size={14} />
                            </span>
                          )}
                        </p>
                        <p
                          className={`${styles.rowAward} ${
                            gold ? styles.awardGold : styles.awardCyan
                          }`}
                        >
                          {a.award}
                        </p>
                      </div>

                      <div className={styles.rowMeta}>
                        <span
                          className={`data-tag ${gold ? 'data-tag--gold' : ''} ${styles.kindTag}`}
                        >
                          {KIND_TAG[a.kind] || a.kind}
                        </span>
                        {a.person ? (
                          <span className={`tag ${styles.personTag}`}>
                            <Icon name="user" size={13} className={styles.personIcon} />
                            <span className={styles.personLabel}>Awarded to</span>
                            {a.person}
                          </span>
                        ) : (
                          a.robot && <span className={`tag ${styles.robotTag}`}>{a.robot}</span>
                        )}
                      </div>
                    </Reveal>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* ---- Full-bleed proof band: the real 2025 Ventura win ---- */}
      <div className={`${styles.proof} hud-frame`}>
        <div className={styles.proofImgWrap}>
          <img
            ref={proof}
            className={styles.proofImg}
            src="photos/ventura-2025.jpg"
            alt={`${team.shortName} at the 2025 Ventura County Regional with winner banners on the floor`}
            loading="lazy"
            decoding="async"
          />
          <div className={styles.proofScrim} aria-hidden="true" />
        </div>
        <div className={styles.proofCaptionWrap}>
          <div className="container">
            <p className={styles.proofKicker}>
              <Icon name="trophy" size={18} className={styles.proofTrophy} />
              Regional Winners
            </p>
            <p className={styles.proofTitle}>2025 Ventura County Regional — Winners</p>
            <p className={`data-tag data-tag--gold ${styles.proofTag}`}>
              REEFSCAPE // VENTURA // 2025
            </p>
          </div>
        </div>
      </div>

      {/* ---- 2026 season telemetry rail + program-impact narrative ---- */}
      <Section id="impact-season" rule={false}>
        <div className={styles.seasonGrid}>
          <div className={styles.seasonCol}>
            <div className={styles.seasonHead}>
              <p className={styles.honorsLabel}>
                <span className={styles.honorsRule} aria-hidden="true" />
                <span>2026 season</span>
              </p>
              <p className={`data-tag ${styles.seasonTag}`}>SEASON {season}</p>
            </div>

            <Reveal className={styles.rail} stagger={0.09} y={22}>
              {schedule.map((s) => (
                <div className={styles.railRow} key={s.event}>
                  <span className={styles.railMonth}>{s.month}</span>
                  <div className={styles.railMain}>
                    <p className={styles.railEvent}>{s.event}</p>
                    <p className={styles.railDates}>{s.dates}</p>
                  </div>
                  <span
                    className={`${styles.railResult} ${
                      s.result ? styles.railResultLive : styles.railResultPending
                    }`}
                  >
                    {s.result || 'Upcoming'}
                  </span>
                </div>
              ))}
            </Reveal>

            <a
              className={styles.watch}
              href={livestreamUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              <span className={styles.watchPulse} aria-hidden="true" />
              Watch live
              <Icon name="external" size={16} className={styles.watchIcon} />
            </a>
          </div>

          {/* program-impact narrative — honest, judge-facing */}
          <aside className={styles.impactCol} aria-labelledby="impact-narrative-title">
            <p className={styles.impactKicker}>
              <Icon name="flag" size={16} />
              Why it matters
            </p>
            <h3 className={styles.impactTitle} id="impact-narrative-title">
              Sustained success. Building leaders.
            </h3>
            <Reveal className={styles.impactBody} stagger={0.1} y={18}>
              <p className={styles.impactPara}>
                Santa Margarita Catholic High School fields <strong>two FIRST teams</strong> — FRC{' '}
                <strong>5805</strong> competing since <strong>2016</strong>, alongside sister team{' '}
                <strong>3020</strong> running since <strong>2009</strong>. Over a decade of
                continuous robotics under one roof.
              </p>
              <p className={styles.impactPara}>
                This year <strong>{rosterCount} students</strong> lead the program end to end —
                engineering the robot, running the budget and sponsorships, and driving STEM
                outreach. The record on this page is the byproduct of students who learn to lead,
                adapt, and win.
              </p>
            </Reveal>
            <p className={styles.impactProof}>
              <span className={styles.impactProofTick} aria-hidden="true" />
              Rookie All-Star 2016 &middot; OC Regional Champions 2018 &middot; Ventura Champions
              2025
            </p>
          </aside>
        </div>
      </Section>
    </div>
  )
}
