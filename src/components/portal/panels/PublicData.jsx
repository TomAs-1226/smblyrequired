import { useCallback, useEffect, useMemo, useState } from 'react'
import { navigate } from '../../../lib/router'
import { listEvents, teamStats } from '../../../lib/scoutingApi'
import { forgetPublicEvent, publicEventData } from '../../../lib/publicData'
import { ErrorState, Loading, Empty } from '../ui'
import { rememberDetailTeam } from './TeamDetail'
import styles from '../Portal.module.css'
import p from './PublicData.module.css'

// -----------------------------------------------------------------------------
// Field data — every team at the event, from the public record, beside what we
// scouted ourselves.
//
// We will not have a scout on every robot. Statbotics (EPA, split into auto,
// teleop and endgame) and The Blue Alliance (OPR) cover all of them, so this is
// where a team we never watched still has a number. Two things keep it honest:
// every column says which source it is from, and a team's own scouting sits in
// the same row, so the two can be read against each other rather than averaged
// into one figure nobody can check.
// -----------------------------------------------------------------------------

const SEASON = new Date().getFullYear()
// Shared with Scout and Coverage: pick the event once.
const EVENT_KEY = 'frc5805.event'

const SORTS = [
  { id: 'epa', label: 'EPA', get: (r) => r.epa?.total, desc: true },
  { id: 'opr', label: 'OPR', get: (r) => r.opr, desc: true },
  { id: 'rank', label: 'Rank', get: (r) => r.record?.rank, desc: false },
  { id: 'ours', label: 'Our average', get: (r) => r.ours?.avg_score, desc: true },
  { id: 'team', label: 'Team number', get: (r) => r.team_number, desc: false },
]

const FILTERS = [
  { id: 'all', label: 'All teams', test: () => true },
  { id: 'unscouted', label: 'Not scouted by us', test: (r) => !(r.ours?.matches_scouted > 0) },
  { id: 'scouted', label: 'Scouted by us', test: (r) => r.ours?.matches_scouted > 0 },
]

const fmt = (v, places = 1) => (v == null ? '—' : Number(v).toFixed(places))

function ago(iso) {
  if (!iso) return null
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs} h ago`
  return `${Math.round(hrs / 24)} d ago`
}

export default function PublicData() {
  const [eventKey, setEventKey] = useState(() => localStorage.getItem(EVENT_KEY) ?? '')
  const [events, setEvents] = useState([])
  const [state, setState] = useState({ loading: false, error: null, data: null, ours: new Map() })
  const [q, setQ] = useState('')
  const [sort, setSort] = useState('epa')
  const [filter, setFilter] = useState('all')
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      const { data } = await listEvents(SEASON)
      if (alive) setEvents(data ?? [])
    })()
    return () => {
      alive = false
    }
  }, [])

  const load = useCallback(async (force = false) => {
    if (!eventKey) return
    if (force) forgetPublicEvent(eventKey)
    force ? setRefreshing(true) : setState((s) => ({ ...s, loading: true, error: null }))
    // Our own statistics are optional here: the public table stands without them.
    const [pub, ours] = await Promise.all([publicEventData(eventKey, { force }), teamStats(eventKey)])
    setRefreshing(false)
    setState({
      loading: false,
      error: pub.error,
      data: pub.data,
      ours: new Map((ours.data ?? []).map((t) => [t.team_number, t])),
    })
  }, [eventKey])

  useEffect(() => {
    load(false)
  }, [load])

  const rows = useMemo(() => {
    const by = SORTS.find((s) => s.id === sort) ?? SORTS[0]
    const keep = FILTERS.find((f) => f.id === filter) ?? FILTERS[0]
    const term = q.trim().toLowerCase()
    return (state.data?.teams ?? [])
      .map((t) => ({ ...t, ours: state.ours.get(t.team_number) ?? null }))
      .filter(keep.test)
      .filter((r) => !term || String(r.team_number).includes(term) || (r.name ?? '').toLowerCase().includes(term))
      .sort((a, b) => {
        const x = by.get(a)
        const y = by.get(b)
        // A team with no value for the sorted column always goes last.
        if (x == null && y == null) return a.team_number - b.team_number
        if (x == null) return 1
        if (y == null) return -1
        return by.desc ? y - x : x - y
      })
  }, [state, sort, filter, q])

  const counts = useMemo(() => {
    const all = (state.data?.teams ?? []).map((t) => ({ ...t, ours: state.ours.get(t.team_number) ?? null }))
    return Object.fromEntries(FILTERS.map((f) => [f.id, all.filter(f.test).length]))
  }, [state])

  function pickEvent(key) {
    setEventKey(key)
    if (key) localStorage.setItem(EVENT_KEY, key)
  }

  function openTeam(team) {
    rememberDetailTeam(eventKey, team)
    navigate('/portal/team')
  }

  const src = state.data?.sources
  return (
    <div className={styles.stack}>
      <div className={p.controls}>
        <label className={p.field}>
          <span className={p.fieldLabel}>Event</span>
          <select className={styles.input} value={eventKey} onChange={(e) => pickEvent(e.target.value)}>
            <option value="">Select an event…</option>
            {events.map((e) => (
              <option key={e.key} value={e.key}>
                {e.short_name || e.name} — {e.start_date}
              </option>
            ))}
            {eventKey && !events.some((e) => e.key === eventKey) && <option value={eventKey}>{eventKey}</option>}
          </select>
        </label>
        <button type="button" className={`btn btn--ghost ${p.refresh}`} onClick={() => load(true)} disabled={!eventKey || refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {!eventKey ? (
        <Empty icon="compass" title="Pick an event">
          Every team there appears with its public numbers, whether or not we scouted it.
        </Empty>
      ) : state.loading ? (
        <Loading rows={8} label="Loading public data" />
      ) : state.error && !state.data ? (
        <ErrorState error={state.error} onRetry={() => load(false)} />
      ) : !state.data?.teams?.length ? (
        <Empty icon="compass" title="Nothing published for this event yet">
          Statbotics lists a team once the event’s team list is posted. Check back closer to the event.
        </Empty>
      ) : (
        <>
          <p className={p.source}>
            <strong>{state.data.teams.length} teams.</strong>{' '}
            EPA from Statbotics{state.data.synced_at ? `, updated ${ago(state.data.synced_at)}` : ''}
            {state.data.stale ? ' — Statbotics is not answering, so this is the last copy we saved' : ''}.{' '}
            {src?.tba?.ok ? 'OPR from The Blue Alliance.' : 'No OPR: The Blue Alliance has not published it for this event, or its key is not set.'}{' '}
            These are estimates from match scores. They cannot see a robot that broke, played defence or was carried — scout
            the teams that matter.
          </p>

          <div className={p.toolbar}>
            <input
              type="search"
              className={`${styles.input} ${p.search}`}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Team number or name"
              aria-label="Find a team"
            />
            <label className={p.sort}>
              <span className={p.fieldLabel}>Sort by</span>
              <select className={styles.input} value={sort} onChange={(e) => setSort(e.target.value)}>
                {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </label>
          </div>
          <div className={p.filters} role="group" aria-label="Which teams">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={p.filter}
                aria-pressed={filter === f.id}
                onClick={() => setFilter(f.id)}
              >
                {f.label} <span>{counts[f.id]}</span>
              </button>
            ))}
          </div>

          <div className={p.tableWrap}>
            <table className={p.table}>
              <thead>
                <tr>
                  <th scope="col" className={p.team}>Team</th>
                  <th scope="col" title="Expected points added, from Statbotics">EPA</th>
                  <th scope="col">Auto</th>
                  <th scope="col">Teleop</th>
                  <th scope="col">End</th>
                  <th scope="col" title="Offensive power rating, from The Blue Alliance">OPR</th>
                  <th scope="col">Rank</th>
                  <th scope="col">Record</th>
                  <th scope="col" className={p.ours} title="Average points in the matches we scouted">Our avg</th>
                  <th scope="col" className={p.ours}>Scouted</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const n = r.ours?.matches_scouted ?? 0
                  return (
                    <tr key={r.team_number}>
                      <th scope="row" className={p.team}>
                        <button type="button" className={p.teamBtn} onClick={() => openTeam(r.team_number)}>
                          <b>{r.team_number}</b>
                          <span>{r.name ?? ''}</span>
                        </button>
                      </th>
                      <td className={p.strong}>{fmt(r.epa?.total)}</td>
                      <td>{fmt(r.epa?.auto)}</td>
                      <td>{fmt(r.epa?.teleop)}</td>
                      <td>{fmt(r.epa?.endgame)}</td>
                      <td>{fmt(r.opr)}</td>
                      <td>{r.record?.rank ?? '—'}</td>
                      <td>{r.record?.played ? `${r.record.wins}–${r.record.losses}${r.record.ties ? `–${r.record.ties}` : ''}` : '—'}</td>
                      <td className={p.ours}>{n ? fmt(r.ours?.avg_score) : '—'}</td>
                      <td className={p.ours}>{n ? `${n} match${n === 1 ? '' : 'es'}` : <span className={p.none}>not scouted</span>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {!rows.length && <p className={p.noMatch}>No team matches that.</p>}
        </>
      )}
    </div>
  )
}
