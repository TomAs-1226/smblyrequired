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
import { team, stats, pillars, mentors, firstFacts } from '../data/team'
import { rosterCount } from '../data/roster'
import { prefersReducedMotion } from '../lib/prefersReducedMotion'
import styles from './About.module.css'

gsap.registerPlugin(ScrollTrigger, useGSAP)

// Pull the student-count stat from `stats` but show the live roster count so the
// number can never drift from the actual roster.
const kpis = stats.map((s) =>
  s.label === 'Students on the team' ? { ...s, to: rosterCount } : s
)

export default function About() {
  const root = useRef(null)
  const photo = useRef(null)

  useGSAP(
    () => {
      if (prefersReducedMotion()) return
      const img = photo.current
      if (!img) return
      // Subtle parallax + scale settle on the full-bleed team band.
      gsap.fromTo(
        img,
        { scale: 1.18, yPercent: -6 },
        {
          scale: 1.04,
          yPercent: 6,
          ease: 'none',
          scrollTrigger: {
            trigger: img.parentElement,
            start: 'top bottom',
            end: 'bottom top',
            scrub: true,
          },
        }
      )
    },
    { scope: root }
  )

  return (
    <div ref={root}>
      <Section id="team">
        <Eyebrow num="01">The team</Eyebrow>

        {/* Top: asymmetric 7 / 5 split — mission narrative left, KPI rail right */}
        <div className={styles.top}>
          <div className={styles.lede}>
            <SplitHeading as="h2" className={styles.heading}>
              A student-run engineering team.
            </SplitHeading>

            <Reveal className={styles.ledeBody} stagger={0.1} y={28}>
              <p className="lead">{team.mission}</p>
              <p className={styles.missionTag}>
                <Icon name="spark" size={18} className={styles.missionTagIcon} />
                {team.missionTag}
              </p>
              <p className={styles.origin}>{team.origin}</p>
            </Reveal>
          </div>

          <Reveal className={styles.kpis} stagger={0.09} y={24}>
            <p className={styles.kpiCaption}>By the numbers</p>
            {kpis.map((s, i) => (
              <div className={styles.kpi} key={s.label}>
                <StatNumeral
                  to={s.to}
                  suffix={s.suffix || ''}
                  label={s.label}
                  gold={i === 0}
                />
              </div>
            ))}
          </Reveal>
        </div>

        {/* Display pull-quote: the motto */}
        <Reveal className={styles.mottoWrap} y={32}>
          <p className={styles.motto}>
            {team.motto.split('.').filter(Boolean).map((part, i, arr) => (
              <span className={styles.mottoLine} key={i}>
                {part.trim()}
                <span className={styles.mottoDot}>.</span>
                {i < arr.length - 1 ? ' ' : ''}
              </span>
            ))}
          </p>
        </Reveal>

        {/* Pillars: non-uniform staggered 2x2 with offset column */}
        <div className={styles.pillars}>
          <p className={styles.pillarsLabel}>
            <span className={styles.pillarsRule} aria-hidden="true" />
            <span>What we do</span>
          </p>
          <Reveal className={styles.pillarGrid} stagger={0.1} y={36}>
            {pillars.map((p) => (
              <article className={styles.pillar} key={p.title}>
                <span className={styles.pillarIcon}>
                  <Icon name={p.icon} size={24} />
                </span>
                <h3 className={styles.pillarTitle}>{p.title}</h3>
                <p className={styles.pillarBody}>{p.body}</p>
              </article>
            ))}
          </Reveal>
        </div>
      </Section>

      {/* Full-bleed team photo band with navy scrim + caption */}
      <div className={styles.band}>
        <div className={styles.bandImgWrap}>
          <img
            ref={photo}
            className={styles.bandImg}
            src="photos/team-pit.jpg"
            alt={`${team.shortName} — ${rosterCount} students in front of ${team.school}`}
            loading="lazy"
            decoding="async"
          />
          <div className={styles.bandScrim} aria-hidden="true" />
        </div>
        <div className={styles.bandCaptionWrap}>
          <div className="container">
            <p className={styles.bandCaption}>
              <span className={styles.bandTick} aria-hidden="true" />
              Team {team.number} — {team.school}
            </p>
          </div>
        </div>
      </div>

      {/* What is FIRST? aside + mentor credits */}
      <Section id="team-first" rule={false} tight>
        <div className={styles.firstRow}>
          <aside className={styles.firstCard} aria-labelledby="first-aside-title">
            <p className={styles.firstKicker}>
              <Icon name="flag" size={16} />
              {team.program}
            </p>
            <h3 className={styles.firstTitle} id="first-aside-title">
              What is FIRST?
            </h3>
            <Reveal className={styles.firstList} stagger={0.08} y={18} as="ul">
              {firstFacts.map((f, i) => (
                <li className={styles.firstItem} key={i}>
                  <Icon name="check" size={18} className={styles.firstCheck} />
                  <span>
                    <strong>{f.strong}</strong> {f.rest}
                  </span>
                </li>
              ))}
            </Reveal>
          </aside>

          <div className={styles.mentorCol}>
            <p className={styles.mentorLabel}>Guided by</p>
            <Reveal className={styles.mentorList} stagger={0.08} y={16}>
              {mentors.map((m) => (
                <div className={styles.mentor} key={m.name}>
                  <span className={styles.mentorIcon}>
                    <Icon name="user" size={18} />
                  </span>
                  <span className={styles.mentorText}>
                    <span className={styles.mentorName}>{m.name}</span>
                    <span className={styles.mentorRole}>{m.role}</span>
                  </span>
                </div>
              ))}
            </Reveal>
            <p className={styles.sibling}>
              Sister program to{' '}
              <strong>
                FIRST Team {team.siblingTeam.number} ({team.siblingTeam.name})
              </strong>
              , competing out of {team.school} since {team.siblingTeam.since}.
            </p>
          </div>
        </div>
      </Section>
    </div>
  )
}
