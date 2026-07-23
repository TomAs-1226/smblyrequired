import Section from './Section'
import Eyebrow from './Eyebrow'
import SplitHeading from './SplitHeading'
import StatNumeral from './StatNumeral'
import Reveal from './Reveal'
import Icon from './Icon'
import { roster, rosterCount } from '../data/roster'
import { mentors } from '../data/team'
import styles from './MeetTheTeam.module.css'

// Display order for grade groups (most senior first).
const GRADE_ORDER = ['Senior', 'Junior', 'Sophomore', 'Freshman']

// Avatar initials. The public roster is first-names-only, so a lone name gives
// its first two letters ("Ian" -> "IA", "Cyra" -> "CY"); a two-word name (a
// mentor) still gives first+last initials. Never reveals a student's last name.
function initialsOf(name) {
  const words = name
    .replace(/\([^)]*\)/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) return '58'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[words.length - 1][0]).toUpperCase()
}

const captain = roster.find((p) => p.captain)
const crew = roster.filter((p) => !p.captain)

// Count per grade across the *full* roster (captain included) for the stat tags.
const gradeCounts = roster.reduce((acc, p) => {
  acc[p.grade] = (acc[p.grade] || 0) + 1
  return acc
}, {})

// Group the non-captain crew by grade, in seniority order.
const groups = GRADE_ORDER.map((grade) => ({
  grade,
  people: crew.filter((p) => p.grade === grade),
})).filter((g) => g.people.length > 0)

function Person({ name, grade, dim = false }) {
  return (
    <div className={`${styles.person}${dim ? ` ${styles.personDim}` : ''}`}>
      <span className={styles.avatar} aria-hidden="true">
        {initialsOf(name)}
      </span>
      <span className={styles.personText}>
        <span className={styles.personName}>{name}</span>
        {grade && <span className={styles.personGrade}>{grade}</span>}
      </span>
    </div>
  )
}

export default function MeetTheTeam() {
  return (
    <Section id="team-roster">
      <Eyebrow>The crew</Eyebrow>

      {/* Header: asymmetric narrative left + roster manifest stat rail right */}
      <div className={styles.head}>
        <div className={styles.headLede}>
          <SplitHeading as="h2" className={styles.heading}>
            The students behind 5805.
          </SplitHeading>
          <Reveal className={styles.headBody} stagger={0.1} y={24}>
            <p className="lead">
              <strong>{rosterCount} students</strong> across every grade — designers,
              machinists, programmers, and the business crew who keep the season running.
              Student-led, mentor-guided, every season from scratch.
            </p>
            <p className={styles.manifest}>
              <span className={styles.manifestTick} aria-hidden="true" />
              {`Roster 5805 // ${rosterCount} active`}
            </p>
          </Reveal>
        </div>

        <Reveal className={styles.statRail} y={28}>
          <p className={styles.statCaption}>Roster manifest</p>
          <div className={styles.statBig}>
            <StatNumeral to={rosterCount} label="Students on the team" />
          </div>
          <ul className={styles.breakdown}>
            {GRADE_ORDER.filter((g) => gradeCounts[g]).map((g) => (
              <li className={styles.breakdownItem} key={g}>
                <span className={styles.breakdownN}>
                  {String(gradeCounts[g]).padStart(2, '0')}
                </span>
                <span className={styles.breakdownL}>{g}s</span>
              </li>
            ))}
          </ul>
        </Reveal>
      </div>

      {/* Featured captain */}
      {captain && (
        <Reveal className={styles.captainWrap} y={32}>
          <article className={`${styles.captainCard} hud-frame`}>
            <span className={styles.captainAvatar} aria-hidden="true">
              {initialsOf(captain.name)}
            </span>
            <div className={styles.captainText}>
              <span className={styles.captainLabel}>
                <Icon name="medal" size={15} className={styles.captainLabelIcon} />
                Team Captain
              </span>
              <h3 className={styles.captainName}>{captain.name}</h3>
              <span className="data-tag data-tag--gold">{captain.grade} // Lead</span>
            </div>
            <p className={styles.captainNote}>
              Sets the build schedule, runs the shop, and drives the team through every
              competition weekend.
            </p>
          </article>
        </Reveal>
      )}

      {/* Full roster, grouped by grade — dense, multi-column, editorial */}
      <div className={styles.roster}>
        {groups.map((group) => (
          <section className={styles.group} key={group.grade} aria-label={`${group.grade}s`}>
            <header className={styles.groupHead}>
              <span className={styles.groupName}>{group.grade}s</span>
              <span className={styles.groupRule} aria-hidden="true" />
              <span className={styles.groupCount}>
                {String(group.people.length).padStart(2, '0')}
              </span>
            </header>
            <Reveal className={styles.groupGrid} stagger={0.05} y={18}>
              {group.people.map((p) => (
                <Person key={p.id} name={p.name} grade="" />
              ))}
            </Reveal>
          </section>
        ))}
      </div>

      {/* Compact mentors strip */}
      <div className={styles.mentors}>
        <p className={styles.mentorsLabel}>
          <span className={styles.mentorsRule} aria-hidden="true" />
          Guided by
        </p>
        <Reveal className={styles.mentorsList} stagger={0.08} y={14}>
          {mentors.map((m) => (
            <div className={styles.mentor} key={m.name}>
              <span className={styles.mentorIcon} aria-hidden="true">
                <Icon name="user" size={16} />
              </span>
              <span className={styles.mentorText}>
                <span className={styles.mentorName}>{m.name}</span>
                <span className={styles.mentorRole}>{m.role}</span>
              </span>
            </div>
          ))}
        </Reveal>
      </div>
    </Section>
  )
}
