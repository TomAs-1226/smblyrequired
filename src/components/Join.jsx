import Section from './Section'
import Eyebrow from './Eyebrow'
import SplitHeading from './SplitHeading'
import StatNumeral from './StatNumeral'
import MagneticButton from './MagneticButton'
import Reveal from './Reveal'
import Icon from './Icon'
import { team, stats, mentors, contact } from '../data/team'
import { subteams, subteamsNote } from '../data/subteams'
import {
  joinFacts,
  joinEligibility,
  seasonRhythm,
  joinChannels,
  joinEmailSubject,
} from '../data/join'
import styles from './Join.module.css'

const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten']

// The two stats that matter to a parent: how many students, and who builds the
// robot. Both come from team.js — the student count already tracks the roster.
const studentStats = stats.filter(
  (s) => s.label === 'Students on the team' || s.label === 'Student-built robot'
)

// JOIN THE TEAM — for prospective students and the parents reading over their
// shoulder. Five beats: the invitation, the subteams, who runs the team, how
// the year runs, and how to reach us. All copy and numbers live in
// src/data/join.js (and the files it draws from).
export default function Join() {
  return (
    <>
      {/* ---------------------------------------------------------------------
          1 — THE INVITATION
          --------------------------------------------------------------------- */}
      <Section id="join" rule={false}>
        <div className={styles.hero}>
          <div className={styles.heroMain}>
            <SplitHeading as="h1" className={styles.heroHeading}>
              Come build with us.
            </SplitHeading>
            <Reveal className={styles.heroBody} y={24} stagger={0.08}>
              <p className="lead">{subteamsNote}</p>
              <div className={styles.heroActions}>
                <MagneticButton
                  as="a"
                  href={`mailto:${contact.generalEmail}?subject=${encodeURIComponent(
                    joinEmailSubject
                  )}`}
                  className="btn btn--gold"
                >
                  Email the team
                  <Icon name="arrowRight" size={18} className="arrow" />
                </MagneticButton>
                {/* Hash routing: a #fragment link would navigate, not scroll. */}
                <a href="#/robots" className="btn btn--ghost">
                  See what we build
                </a>
              </div>
              {joinEligibility && <p className={styles.heroNote}>{joinEligibility}</p>}
            </Reveal>
          </div>

          <Reveal className={styles.facts} y={28}>
            <p className={`data-tag ${styles.factsTag}`}>
              FRC {team.number} // {team.name}
            </p>
            <dl className={styles.factList}>
              {joinFacts.map((f) => (
                <div className={styles.fact} key={f.label}>
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
          </Reveal>
        </div>
      </Section>

      {/* ---------------------------------------------------------------------
          2 — THE SUBTEAMS
          --------------------------------------------------------------------- */}
      <Section id="join-lanes">
        <div className={styles.sectionHead}>
          <div className={styles.sectionLede}>
            <Eyebrow>The subteams</Eyebrow>
            <SplitHeading as="h2" className={styles.heading}>
              Find your lane.
            </SplitHeading>
          </div>
          <Reveal className={styles.sectionNote} y={24}>
            <p className="lead">
              {NUMBER_WORDS[subteams.length] || subteams.length} subteams, and most students cross between them. You do not need to
              know which one is yours before you arrive.
            </p>
          </Reveal>
        </div>

        <Reveal as="ul" className={styles.lanes} stagger={0.07} y={28}>
          {subteams.map((s, i) => (
            <li className={styles.lane} key={s.name}>
              <span className={styles.laneIndex} aria-hidden="true">
                {i + 1}
              </span>
              <span className={styles.laneIcon}>
                <Icon name={s.icon} size={26} />
              </span>
              <h3 className={styles.laneName}>{s.name}</h3>
              <p className={styles.laneBody}>{s.body}</p>
            </li>
          ))}
        </Reveal>
      </Section>

      {/* ---------------------------------------------------------------------
          3 — STUDENT-RUN
          --------------------------------------------------------------------- */}
      <Section id="join-student-run">
        <div className={styles.run}>
          <div className={styles.runMain}>
            <Eyebrow>Student-run</Eyebrow>
            <SplitHeading as="h2" className={styles.heading}>
              Students lead. Mentors guide.
            </SplitHeading>
            <Reveal className={styles.runBody} y={24} stagger={0.08}>
              <p className="lead">{team.mission}</p>
              <div className={styles.runStats}>
                {studentStats.map((s) => (
                  <div className={styles.runStat} key={s.label}>
                    <StatNumeral to={s.to} suffix={s.suffix || ''} label={s.label} />
                  </div>
                ))}
              </div>
            </Reveal>
          </div>

          <Reveal className={styles.mentors} y={28}>
            <p className={styles.mentorsLabel}>
              <Icon name="compass" size={16} />
              Coached &amp; mentored by
            </p>
            <ul className={styles.mentorList}>
              {mentors.map((m) => (
                <li className={styles.mentor} key={m.name}>
                  <span className={styles.mentorName}>{m.name}</span>
                  <span className={styles.mentorRole}>{m.role}</span>
                </li>
              ))}
            </ul>
            <p className={styles.mentorsNote}>
              Industry and parent mentors guide students toward college and STEM careers.
            </p>
          </Reveal>
        </div>
      </Section>

      {/* ---------------------------------------------------------------------
          4 — THE SEASON RHYTHM
          --------------------------------------------------------------------- */}
      <Section id="join-season">
        <div className={styles.sectionHead}>
          <div className={styles.sectionLede}>
            <Eyebrow>The year</Eyebrow>
            <SplitHeading as="h2" className={styles.heading}>
              How the season runs.
            </SplitHeading>
          </div>
          <Reveal className={styles.sectionNote} y={24}>
            <p className="lead">
              A hard sprint, a competition calendar, and a lighter stretch in between. Meeting days
              and times are not posted on this site &mdash; ask us and we will tell you.
            </p>
          </Reveal>
        </div>

        <Reveal as="ol" className={styles.phases} stagger={0.1} y={30}>
          {seasonRhythm.map((p, i) => (
            <li className={styles.phase} key={p.key}>
              <div className={styles.phaseTop}>
                <span className={styles.phaseIcon}>
                  <Icon name={p.icon} size={22} />
                </span>
                <span className={styles.phaseStep} aria-hidden="true">
                  {i + 1}
                </span>
              </div>
              <h3 className={styles.phaseName}>{p.label}</h3>
              <p className={`data-tag ${styles.phaseTag}`}>{p.tag}</p>
              <p className={styles.phaseBody}>{p.body}</p>

              {p.events && (
                <ul className={styles.rail}>
                  {p.events.map((e) => (
                    <li className={styles.railRow} key={e.name}>
                      <span className={styles.railMonth}>{e.month}</span>
                      <span className={styles.railMain}>
                        <span className={styles.railName}>{e.name}</span>
                        <span className={styles.railDates}>{e.dates}</span>
                      </span>
                      {e.result && <span className={styles.railResult}>{e.result}</span>}
                    </li>
                  ))}
                </ul>
              )}

              {p.robots && p.robots.length > 0 && (
                <ul className={styles.rail}>
                  {p.robots.map((r) => (
                    <li className={styles.railRow} key={r.name}>
                      <span className={styles.railMonth}>
                        <Icon name="cog" size={16} />
                      </span>
                      <span className={styles.railMain}>
                        <span className={styles.railName}>{r.name}</span>
                        <span className={styles.railDates}>
                          {r.season} &middot; {r.subtitle}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </Reveal>
      </Section>

      {/* ---------------------------------------------------------------------
          5 — GET IN TOUCH
          --------------------------------------------------------------------- */}
      <Section id="join-contact" rule={false} tight>
        <div className={`blueprint ${styles.cta}`}>
          <span className={styles.ctaField} aria-hidden="true" />
          <div className={styles.ctaMain}>
            <p className={styles.ctaKicker}>
              <span className="data-tag data-tag--gold">GET IN TOUCH</span>
            </p>
            <SplitHeading as="h2" className={styles.ctaHeading}>
              Say hello.
            </SplitHeading>
            <p className={styles.ctaLede}>
              Students and parents are both welcome to write. We do not publish an application
              form, a deadline, or a fee on this site, so the quickest way to find out how joining
              works is to ask {contact.overseer}, our {contact.overseerRole.toLowerCase()}, or
              anyone on the team.
            </p>
            <div className={styles.ctaActions}>
              <MagneticButton
                as="a"
                href={joinChannels[0].href}
                className="btn btn--gold"
              >
                Email the team
                <Icon name="arrowRight" size={18} className="arrow" />
              </MagneticButton>
              <a href="#/contact" className="btn btn--ghost">
                More ways to reach us
              </a>
            </div>
          </div>

          <ul className={styles.channels}>
            {joinChannels.map((c) => (
              <li className={styles.channel} key={c.key}>
                <span className={styles.channelIcon} aria-hidden="true">
                  <Icon name={c.icon} size={18} />
                </span>
                <span className={styles.channelBody}>
                  <span className={styles.channelLabel}>{c.label}</span>
                  {c.href ? (
                    <a className={styles.channelLink} href={c.href}>
                      {c.text}
                    </a>
                  ) : (
                    <span className={styles.channelText}>{c.text}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </Section>
    </>
  )
}
