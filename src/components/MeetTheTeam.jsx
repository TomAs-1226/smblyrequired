import Section from './Section'
import SplitHeading from './SplitHeading'
import StatNumeral from './StatNumeral'
import Reveal from './Reveal'
import Icon from './Icon'
import { roster, rosterCount } from '../data/roster'
import { subteams } from '../data/subteams'
import { mentors } from '../data/team'
import styles from './MeetTheTeam.module.css'

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

// The roster carries no grades (see src/data/roster.js for why), so the list is
// flat. `captain` is still honoured if a student is ever flagged as one — the
// featured card below re-appears the moment that field comes back.
const captain = roster.find((p) => p.captain)
const crew = roster.filter((p) => !p.captain)

// Stat rail facts. These replace the old per-grade breakdown and are derived,
// not hand-maintained, so they cannot drift from the data.
const facts = [
  { n: rosterCount, label: 'Students' },
  { n: subteams.length, label: 'Subteams' },
  { n: mentors.length, label: 'Mentors' },
]

function Person({ name }) {
  return (
    <div className={styles.person}>
      <span className={styles.avatar} aria-hidden="true">
        {initialsOf(name)}
      </span>
      <span className={styles.personText}>
        <span className={styles.personName}>{name}</span>
      </span>
    </div>
  )
}

export default function MeetTheTeam() {
  return (
    <Section id="team-roster">

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
          </Reveal>
        </div>

        <Reveal className={styles.statRail} y={28}>
          <p className={styles.statCaption}>Roster manifest</p>
          <div className={styles.statBig}>
            <StatNumeral to={rosterCount} label="Students on the team" />
          </div>
          <ul className={styles.breakdown}>
            {facts.map((f) => (
              <li className={styles.breakdownItem} key={f.label}>
                <span className={styles.breakdownN}>{f.n}</span>
                <span className={styles.breakdownL}>{f.label}</span>
              </li>
            ))}
          </ul>
        </Reveal>
      </div>

      {/* Featured captain — renders only when a student carries `captain: true` */}
      {captain && (
        <Reveal className={styles.captainWrap} y={32}>
          <article className={styles.captainCard}>
            <span className={styles.captainAvatar} aria-hidden="true">
              {initialsOf(captain.name)}
            </span>
            <div className={styles.captainText}>
              <span className={styles.captainLabel}>
                <Icon name="medal" size={15} className={styles.captainLabelIcon} />
                Team Captain
              </span>
              <h3 className={styles.captainName}>{captain.name}</h3>
              <span className="data-tag data-tag--gold">Lead</span>
            </div>
            <p className={styles.captainNote}>
              Sets the build schedule, runs the shop, and drives the team through every
              competition weekend.
            </p>
          </article>
        </Reveal>
      )}

      {/* Full roster — one flat, dense, multi-column grid */}
      <div className={styles.roster}>
        <section className={styles.group} aria-label="Student roster">
          <header className={styles.groupHead}>
            <span className={styles.groupName}>Students</span>
            <span className={styles.groupRule} aria-hidden="true" />
            <span className={styles.groupCount}>{crew.length}</span>
          </header>
          <Reveal className={styles.groupGrid} stagger={0.04} y={18}>
            {crew.map((p) => (
              <Person key={p.id} name={p.name} />
            ))}
          </Reveal>
        </section>
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
