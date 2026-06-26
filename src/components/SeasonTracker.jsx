import Section from './Section'
import Eyebrow from './Eyebrow'
import SplitHeading from './SplitHeading'
import Reveal from './Reveal'
import Icon from './Icon'
import live from '../data/live.json'
import styles from './SeasonTracker.module.css'

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

// 'YYYY-MM-DD' -> 'Mar 6, 2026' (graceful passthrough if the shape is off).
function formatEventDate(date) {
  const parts = String(date || '').split('-')
  if (parts.length !== 3) return String(date || '—')
  const [year, month, day] = parts
  const m = MONTHS[Number(month) - 1]
  if (!m) return String(date)
  return `${m} ${Number(day)}, ${year}`
}

// Parse the build-time ISO stamp into a readable, deterministic UTC date so the
// "UPDATED" tag never drifts with the reader's locale.
function formatUpdated(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const m = MONTHS[d.getUTCMonth()]
  return `${m} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
}

// A finals/championship finish earns the gold treatment.
const GOLD_RESULT = /finalist|winner|champion/i

export default function SeasonTracker() {
  const { events = [], recentMatches = [], updated, source, season } = live
  const hasEvents = events.length > 0

  return (
    <Section id="season-tracker" className={styles.section}>
      <div className={`${styles.field} blueprint`} aria-hidden="true" />

      <Eyebrow>Live from the field</Eyebrow>

      <div className={styles.head}>
        <SplitHeading as="h2" className={styles.heading}>
          {`The ${season || ''} season, by the numbers.`.trim()}
        </SplitHeading>

        <div className={styles.headMeta}>
          <span className={`data-tag ${styles.updated}`}>
            Updated {formatUpdated(updated)}
          </span>
          {source && (
            <a
              className={styles.sourceLink}
              href={source}
              target="_blank"
              rel="noopener noreferrer"
            >
              via The Blue Alliance
              <Icon name="external" size={14} className={styles.sourceIcon} />
            </a>
          )}
        </div>
      </div>

      {!hasEvents ? (
        <div className={`${styles.empty} hud-frame`}>
          <span className={styles.emptyTick} aria-hidden="true" />
          <p className={styles.emptyText}>
            Season data updates at build time — check back during competition.
          </p>
        </div>
      ) : (
        <>
          {/* --- Events: editorial telemetry ledger --- */}
          <div className={styles.events}>
            <div className={styles.eventsHeadRow} aria-hidden="true">
              <span>Event</span>
              <span>Rank</span>
              <span>Record</span>
            </div>

            <Reveal className={styles.eventsList} stagger={0.09} y={22} as="ol">
              {events.map((ev) => {
                const gold = ev.result && GOLD_RESULT.test(ev.result)
                return (
                  <li className={styles.event} key={ev.key}>
                    <div className={styles.eventMain}>
                      <span className={styles.eventNode} aria-hidden="true" />
                      <div className={styles.eventText}>
                        <h3 className={styles.eventName}>{ev.name}</h3>
                        <time
                          className={`data-tag ${styles.eventDate}`}
                          dateTime={ev.dates}
                        >
                          {formatEventDate(ev.dates)}
                        </time>
                      </div>
                    </div>

                    <div className={styles.eventStats}>
                      <span className={styles.rankPill}>
                        <span className={styles.rankHash}>#</span>
                        {ev.rank}
                        <span className={styles.rankSep}>/</span>
                        <span className={styles.rankTotal}>{ev.total}</span>
                      </span>
                      {ev.record && (
                        <span className={`data-tag data-tag--gold ${styles.record}`}>
                          {ev.record}
                        </span>
                      )}
                    </div>

                    {ev.result && (
                      <p
                        className={`${styles.result} ${gold ? styles.resultGold : ''}`}
                      >
                        {gold && (
                          <Icon
                            name="trophy"
                            size={15}
                            className={styles.resultIcon}
                          />
                        )}
                        {ev.result}
                      </p>
                    )}
                  </li>
                )
              })}
            </Reveal>
          </div>

          {/* --- Recent matches: compact result strip --- */}
          {recentMatches.length > 0 && (
            <div className={styles.matches}>
              <p className={styles.matchesLabel}>
                <span className={styles.matchesRule} aria-hidden="true" />
                <span>Recent matches</span>
                <span className={styles.matchesMeta}>Last {recentMatches.length}</span>
              </p>

              <Reveal className={styles.matchStrip} stagger={0.05} y={16}>
                {recentMatches.map((m, i) => {
                  const oc = m.outcome
                  const tone =
                    oc === 'W'
                      ? styles.isWin
                      : oc === 'T'
                      ? styles.isTie
                      : styles.isLoss
                  return (
                    <span
                      className={`${styles.match} ${tone}`}
                      key={`${m.label}-${i}`}
                    >
                      <span className={styles.matchLabel}>{m.label}</span>
                      <span className={styles.matchScore}>
                        <span className={styles.matchUs}>{m.usScore}</span>
                        <span className={styles.matchDash}>–</span>
                        <span className={styles.matchThem}>{m.themScore}</span>
                      </span>
                      <span className={styles.matchMark} aria-hidden="true">
                        {oc}
                      </span>
                      <span className="sr-only">
                        {oc === 'W' ? 'Win' : oc === 'T' ? 'Tie' : 'Loss'}
                      </span>
                    </span>
                  )
                })}
              </Reveal>
            </div>
          )}
        </>
      )}
    </Section>
  )
}
