import Section from './Section'
import Eyebrow from './Eyebrow'
import SplitHeading from './SplitHeading'
import Reveal from './Reveal'
import MagneticButton from './MagneticButton'
import Icon from './Icon'
import { mentors } from '../data/team'
import styles from './Mentors.module.css'

// Role-generic one-liners: what the ROLE does on any FRC team. Deliberately NOT
// invented personal history — these describe the job, keyed by the role string in
// data/team.js, with a sensible default for anything new. Mentors are adults, so
// full names are fine here (unlike the student roster, which is first-names-only).
const ROLE_BLURB = {
  'Head Coach & Program Manager':
    'Runs the program end to end — safety, logistics, travel, and the through-line that keeps a student-led team pointed the same direction all season long.',
  'Lead Mentor':
    'Steers the build without taking the wrench: design reviews, the hard engineering calls, and the judgment that only comes from having shipped a robot before.',
  Mentor:
    'In the shop alongside students — teaching a tool, unblocking a subsystem, and asking the one question that makes the design better.',
}
const DEFAULT_BLURB =
  'Guides students through the season, sharing the experience that turns a good idea into a robot that survives a match.'

function initials(name) {
  const w = name.trim().split(/\s+/).filter(Boolean)
  return ((w[0]?.[0] ?? '') + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase() || '58'
}

export default function Mentors() {
  const [lead, ...rest] = mentors // the head coach is featured first

  return (
    <Section id="mentors">
      <Eyebrow>Guided by</Eyebrow>

      <div className={styles.head}>
        <SplitHeading as="h2" className={styles.heading}>
          Student-led. Mentor-guided.
        </SplitHeading>
        <Reveal className={styles.lede} y={24}>
          <p className="lead">
            The students design, machine, wire, and drive the robot — every season, from scratch.
            Our mentors don't do it for them. They teach the tools, ask the sharper question, and
            lend the experience that turns a good idea into a robot that survives a match.
          </p>
        </Reveal>
      </div>

      {lead && (
        <Reveal className={styles.featuredWrap} y={30}>
          <article className={`${styles.featured} hud-frame`}>
            <span className={styles.featuredAvatar} aria-hidden="true">
              {initials(lead.name)}
            </span>
            <div className={styles.featuredText}>
              <span className={styles.featuredLabel}>
                <Icon name="compass" size={15} className={styles.featuredLabelIcon} />
                Head Coach
              </span>
              <h3 className={styles.featuredName}>{lead.name}</h3>
              <span className="data-tag data-tag--gold">{lead.role}</span>
              <p className={styles.featuredBlurb}>{ROLE_BLURB[lead.role] ?? DEFAULT_BLURB}</p>
            </div>
          </article>
        </Reveal>
      )}

      {rest.length > 0 && (
        <Reveal className={styles.grid} stagger={0.08} y={24}>
          {rest.map((m) => (
            <article className={styles.card} key={m.name}>
              <span className={styles.avatar} aria-hidden="true">
                {initials(m.name)}
              </span>
              <h3 className={styles.name}>{m.name}</h3>
              <span className={styles.role}>{m.role}</span>
              <p className={styles.blurb}>{ROLE_BLURB[m.role] ?? DEFAULT_BLURB}</p>
            </article>
          ))}
        </Reveal>
      )}

      <Reveal className={styles.ctaWrap} y={20}>
        <div className={`${styles.cta} hud-frame`}>
          <div className={styles.ctaText}>
            <h3 className={styles.ctaTitle}>Mentor with us</h3>
            <p className={styles.ctaBody}>
              Engineers, machinists, programmers, business pros — a few hours a week in build season
              can change a student's trajectory. Hands-on mentorship is one of the most valuable
              things you can give the team.
            </p>
          </div>
          <MagneticButton as="a" href="#/contact" className={`btn btn--cyan ${styles.ctaBtn}`}>
            Get in touch <Icon name="arrowRight" className="arrow" />
          </MagneticButton>
        </div>
      </Reveal>
    </Section>
  )
}
