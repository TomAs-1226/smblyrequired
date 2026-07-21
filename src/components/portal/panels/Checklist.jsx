import { useCallback, useEffect, useMemo, useState } from 'react'
import Icon from '../../Icon'
import { eventCoverage, listEvents, teamChecklist } from '../../../lib/scoutingApi'
import { ErrorState, Loading, Empty } from '../ui'
import styles from '../Portal.module.css'
import c from '../forms/Checklist.module.css'

// -----------------------------------------------------------------------------
// "Who have we scouted?" — the team_scout_checklist view (migration 0007) as a
// screen, plus event_scout_coverage (0006) as the one-line answer at the top.
//
// This is read walking around a venue on a phone, usually by someone deciding
// where to send the next free scout. So the screen is built around finding the
// GAPS, not around browsing the list: the default order puts the least-scouted
// teams first, and the filters are counts of what is still missing rather than
// categories to explore. Anything that makes a gap take two taps to find is a
// bug in this screen's whole reason to exist.
// -----------------------------------------------------------------------------

const SEASON = new Date().getFullYear()

// Shared with the Scout panel on purpose: someone who picked their event there
// should not have to pick it again here, and vice versa.
const EVENT_KEY = 'frc5805.event'

const FILTERS = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'todo', label: 'Not scouted', test: (r) => !r.match_done && !r.pit_done },
  { id: 'nopit', label: 'No pit', test: (r) => !r.pit_done },
  { id: 'nomatch', label: 'No match', test: (r) => !r.match_done },
  { id: 'nophoto', label: 'No photos', test: (r) => !r.has_photos },
]

const SORTS = [
  { id: 'gaps', label: 'Least scouted first' },
  { id: 'team', label: 'Team number' },
  { id: 'recent', label: 'Most recent first' },
  { id: 'stale', label: 'Longest since scouted' },
]

/** How complete a team is, 0–2. The sort key that puts gaps at the top. */
function done(r) {
  return (r.match_done ? 1 : 0) + (r.pit_done ? 1 : 0)
}

function ago(iso) {
  if (!iso) return null
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

export default function Checklist() {
  const [eventKey, setEventKey] = useState(() => localStorage.getItem(EVENT_KEY) ?? '')
  const [events, setEvents] = useState([])
  const [rows, setRows] = useState([])
  const [coverage, setCoverage] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('all')
  const [sort, setSort] = useState('gaps')

  // The event list only populates the picker — `load` below owns the loading and
  // error state for the checklist itself, so this deliberately does not touch
  // either. Two effects both writing `loading` race on first paint whenever an
  // event is already remembered.
  useEffect(() => {
    let alive = true
    ;(async () => {
      const { data } = await listEvents(SEASON)
      if (alive) setEvents(data)
    })()
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (eventKey) localStorage.setItem(EVENT_KEY, eventKey)
  }, [eventKey])

  const load = useCallback(async () => {
    if (!eventKey) {
      setRows([])
      setCoverage(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    // Both reads at once: they are independent, and the coverage strip arriving
    // a beat after the list it summarises reads as the page still loading.
    const [list, cov] = await Promise.all([teamChecklist(eventKey), eventCoverage(eventKey)])
    setRows(list.data)
    setCoverage(cov.data)
    setError(list.error ?? cov.error)
    setLoading(false)
  }, [eventKey])

  useEffect(() => {
    load()
  }, [load])

  const counts = useMemo(() => {
    const out = {}
    for (const f of FILTERS) out[f.id] = rows.filter(f.test).length
    return out
  }, [rows])

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const test = FILTERS.find((f) => f.id === filter)?.test ?? (() => true)

    const out = rows.filter((r) => {
      if (!test(r)) return false
      if (!needle) return true
      return (
        String(r.team_number).includes(needle) || (r.nickname ?? '').toLowerCase().includes(needle)
      )
    })

    out.sort((a, z) => {
      if (sort === 'team') return a.team_number - z.team_number
      if (sort === 'recent') {
        const at = a.last_scouted ? new Date(a.last_scouted).getTime() : -Infinity
        const zt = z.last_scouted ? new Date(z.last_scouted).getTime() : -Infinity
        return zt - at
      }
      if (sort === 'stale') {
        // Never scouted sorts first, not last: a team with no timestamp at all
        // is the most overdue thing on the list, not the least.
        const at = a.last_scouted ? new Date(a.last_scouted).getTime() : -Infinity
        const zt = z.last_scouted ? new Date(z.last_scouted).getTime() : -Infinity
        return at - zt
      }
      // gaps: least complete first, then fewest match passes, then team number
      // so the order is stable rather than shuffling between refreshes.
      return done(a) - done(z) || a.match_passes - z.match_passes || a.team_number - z.team_number
    })

    return out
  }, [rows, q, filter, sort])

  return (
    <div className={styles.stack}>
      <section>
        <h2 className={styles.sectionTitle}>Event</h2>
        <div className={styles.toolbar}>
          <select
            className={c.select}
            value={eventKey}
            onChange={(e) => setEventKey(e.target.value)}
            aria-label="Event"
          >
            <option value="">Select an event…</option>
            {events.map((e) => (
              <option key={e.key} value={e.key}>
                {e.short_name || e.name} — {e.start_date}
              </option>
            ))}
          </select>
          <button type="button" className={c.refresh} onClick={load} disabled={!eventKey || loading}>
            {loading ? (
              <span className={styles.spinnerSm} aria-hidden="true" />
            ) : (
              <Icon name="download" size={15} />
            )}
            Refresh
          </button>
        </div>
      </section>

      {!eventKey ? (
        <Empty icon="calendar" title="Pick an event">
          The checklist is per-event — it reads the team list cached for that competition.
        </Empty>
      ) : loading ? (
        <Loading rows={6} label="Loading the checklist" />
      ) : error ? (
        <ErrorState error={error} onRetry={load} />
      ) : rows.length === 0 ? (
        <Empty icon="users" title="No teams cached for this event">
          Pull the team list from The Blue Alliance on the Scout tab first — ideally before you lose
          signal at the venue.
        </Empty>
      ) : (
        <>
          {coverage && <Coverage coverage={coverage} />}

          <section>
            <h2 className={styles.sectionTitle}>
              Teams
              <span className={styles.countBadge}>{visible.length}</span>
            </h2>

            <div className={c.controls}>
              <div className={c.search}>
                <Icon name="search" size={16} className={c.searchIcon} />
                <input
                  type="search"
                  className={c.searchInput}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Team number or name"
                  aria-label="Filter teams"
                />
              </div>
              <select
                className={c.select}
                value={sort}
                onChange={(e) => setSort(e.target.value)}
                aria-label="Sort order"
              >
                {SORTS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Counts live on the chips themselves. "No pit — 14" answers the
                question without anyone having to tap it first. */}
            <div className={c.filters}>
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={filter === f.id}
                  className={`${c.filter} ${filter === f.id ? c.filterOn : ''} ${
                    f.id !== 'all' && counts[f.id] === 0 ? c.filterClear : ''
                  }`}
                  onClick={() => setFilter(f.id)}
                >
                  {f.label}
                  <span className={c.filterCount}>{counts[f.id]}</span>
                </button>
              ))}
            </div>

            {visible.length === 0 ? (
              <p className={c.none}>
                <Icon name="check" size={16} />
                {filter === 'all'
                  ? 'No team matches that search.'
                  : 'Nothing left in that gap — every team here is covered.'}
              </p>
            ) : (
              <ul className={c.list}>
                {visible.map((r, i) => (
                  <TeamRow key={r.team_number} row={r} index={i} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  )
}

function Coverage({ coverage }) {
  const left = coverage.teams_unscouted ?? 0
  return (
    <section>
      <h2 className={styles.sectionTitle}>Coverage</h2>
      <div className={styles.statGrid}>
        <div className={styles.stat}>
          <span className={styles.statLabel}>Teams at event</span>
          <span className={styles.statValue}>{coverage.teams_at_event ?? 0}</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>Scouted</span>
          <span className={styles.statValue}>{coverage.teams_scouted ?? 0}</span>
        </div>
        {/* The only number anyone is actually looking for. It gets the colour. */}
        <div className={`${styles.stat} ${left > 0 ? c.statGap : c.statDone}`}>
          <span className={styles.statLabel}>Still untouched</span>
          <span className={styles.statValue}>{left}</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>Matches per team</span>
          <span className={styles.statValue}>
            {coverage.avg_matches ?? 0}
            <span className={styles.statUnit}>avg</span>
          </span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>Thinnest team</span>
          <span className={styles.statValue}>
            {coverage.min_matches ?? 0}
            <span className={styles.statUnit}>matches</span>
          </span>
        </div>
      </div>
    </section>
  )
}

function TeamRow({ row, index }) {
  const when = ago(row.last_scouted)

  return (
    <li className={c.row} style={{ '--i': Math.min(index, 8) }}>
      <div className={c.rowHead}>
        <span className={c.team}>{row.team_number}</span>
        <span className={c.nick}>{row.nickname || 'Unnamed team'}</span>
      </div>

      <div className={c.flags}>
        <Flag on={row.pit_done} label="Pit" />
        <Flag on={row.match_done} label="Match" />
      </div>

      <div className={c.meta}>
        <span className={row.match_passes ? '' : c.zero}>{row.match_passes} match</span>
        <span className={row.pit_passes ? '' : c.zero}>{row.pit_passes} pit</span>
        <span className={row.note_passes ? '' : c.zero}>{row.note_passes} notes</span>
        <span className={row.scouts ? '' : c.zero}>
          {row.scouts} {row.scouts === 1 ? 'scout' : 'scouts'}
        </span>
        <span className={row.photos ? '' : c.zero}>{row.photos} photos</span>
        <span className={when ? c.when : c.never}>{when ?? 'never scouted'}</span>
      </div>
    </li>
  )
}

/**
 * Done / not done. A filled check and a hollow ring, not colour alone — this is
 * read in daylight, on a phone, at an angle, by people who may not distinguish
 * the green from the red.
 */
function Flag({ on, label }) {
  return (
    <span className={`${c.flag} ${on ? c.flagOn : c.flagOff}`}>
      {on ? <Icon name="check" size={13} /> : <span className={c.ring} aria-hidden="true" />}
      {label}
      <span className="sr-only">{on ? ' done' : ' not done'}</span>
    </span>
  )
}
