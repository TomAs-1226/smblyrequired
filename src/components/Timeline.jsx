import Section from './Section'
import Eyebrow from './Eyebrow'
import SplitHeading from './SplitHeading'
import Reveal from './Reveal'
import Icon from './Icon'
import { team } from '../data/team'
import { history, historyNote } from '../data/history'
import styles from './Timeline.module.css'

// kind -> marker icon. Names must exist in Icon.jsx.
const KIND_ICON = {
  origin: 'building',
  founded: 'flag',
  robot: 'cog',
  winner: 'trophy',
  rookie: 'star',
  finalist: 'medal',
  award: 'medal',
}

// kind -> short telemetry label. Robots and origin read from their own tag.
const KIND_LABEL = {
  winner: 'WIN',
  rookie: 'ROOKIE',
  finalist: 'FINALIST',
  award: 'AWARD',
}

// Earned hardware is gold (scarce); everything else is cyan or neutral.
const GOLD = new Set(['winner', 'rookie'])
const MUTED = new Set(['origin', 'founded'])

const markerClass = (kind) =>
  GOLD.has(kind) ? styles.markerGold : MUTED.has(kind) ? styles.markerMuted : styles.markerCyan

// TEAM HISTORY — a story, oldest first. Every entry is built in
// src/data/history.js from team.js, achievements.js and robots.js; this
// component only renders what that file hands it.
export default function Timeline() {
  return (
    <Section id="history">
      <div className={styles.head}>
        <div className={styles.headLede}>
          <Eyebrow>Team history</Eyebrow>
          <SplitHeading as="h2" className={styles.heading}>
            Where {team.shortName} came from.
          </SplitHeading>
        </div>
        <Reveal className={styles.headNote} y={24}>
          <p className="lead">{team.origin}</p>
          <p className={styles.note}>{historyNote}</p>
        </Reveal>
      </div>

      <ol className={styles.track}>
        {history.map((group) => (
          <Reveal as="li" className={styles.year} y={26} key={group.year}>
            <div className={styles.yearCol}>
              <span className={styles.yearNum}>{group.year}</span>
            </div>

            <ul className={styles.entries}>
              {group.items.map((it, i) => {
                const Tag = it.href ? 'a' : 'div'
                const linkProps = it.href
                  ? {
                      href: it.href,
                      'aria-label': `${it.title} — ${it.detail}. See the robot.`,
                    }
                  : {}
                return (
                  <li className={styles.entry} key={`${group.year}-${it.kind}-${it.title}-${i}`}>
                    <span
                      className={`${styles.marker} ${markerClass(it.kind)}`}
                      aria-hidden="true"
                    >
                      <Icon name={KIND_ICON[it.kind] || 'star'} size={16} />
                    </span>

                    <Tag
                      className={[
                        styles.body,
                        it.href && styles.bodyLink,
                        it.flagship && styles.bodyFlagship,
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      {...linkProps}
                    >
                      <span className={styles.main}>
                        <span className={styles.title}>{it.title}</span>
                        <span
                          className={`${styles.detail} ${
                            GOLD.has(it.kind) ? styles.detailGold : ''
                          }`}
                        >
                          {it.detail}
                        </span>
                        {(KIND_LABEL[it.kind] || it.tag || it.robot || it.person || it.building) && (
                          <span className={styles.meta}>
                            {KIND_LABEL[it.kind] && (
                              <span
                                className={`data-tag ${GOLD.has(it.kind) ? 'data-tag--gold' : ''}`}
                              >
                                {KIND_LABEL[it.kind]}
                              </span>
                            )}
                            {it.tag && <span className="tag">{it.tag}</span>}
                            {it.robot && <span className="tag">{it.robot}</span>}
                            {it.person && <span className="tag">Awarded to {it.person}</span>}
                            {it.building && <span className="tag">In build</span>}
                          </span>
                        )}
                      </span>
                      {it.href && (
                        <span className={styles.go} aria-hidden="true">
                          <Icon name="arrowRight" size={16} />
                        </span>
                      )}
                    </Tag>
                  </li>
                )
              })}
            </ul>
          </Reveal>
        ))}
      </ol>
    </Section>
  )
}
