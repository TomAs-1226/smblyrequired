import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../../Icon'
import {
  activeForm,
  askAi,
  listEntries,
  listEvents,
  listEventTeams,
  teamChecklist,
  teamStats,
} from '../../../lib/scoutingApi'
import { Loading, Empty, ErrorState } from '../ui'
import styles from '../Portal.module.css'
import css from './Compare.module.css'
import { MIN_N, THIN_N, buildRows, deriveColumn, judgeOverall } from './stats'

// -----------------------------------------------------------------------------
// Side-by-side team comparison.
//
// One row per metric, one column per team, up to five. The product pattern is
// Apple's spec-comparison page; the content is scouting data, which is a very
// different kind of number — a MacBook's RAM is 16 GB, full stop, and a robot's
// average is 41.2 give or take twelve depending on which four matches somebody
// happened to be standing at the right end of the field for.
//
// So the whole panel is built around one distinction that the Apple pattern
// does not need and this one cannot survive without: the difference between the
// team that is AHEAD and the team that is BETTER. Ahead is arithmetic. Better
// is a claim, and this panel makes it far less often than the table has rows.
// The maths for that lives in stats.js; everything here is presentation, with
// one job — never let a number look more certain than it is.
//
// Nothing here writes. It is a reading surface over `team_event_stats`,
// `team_scout_checklist` and `scout_entries`, all through scoutingApi.js.
// -----------------------------------------------------------------------------

const MAX_TEAMS = 5

export default function Compare() {
  const [events, setEvents] = useState([])
  const [eventKey, setEventKey] = useState(() => localStorage.getItem('frc5805.event') ?? '')
  const [boot, setBoot] = useState({ loading: true, error: null })

  const [roster, setRoster] = useState([])
  const [stats, setStats] = useState([])
  const [checklist, setChecklist] = useState([])
  const [form, setForm] = useState(null)
  const [loadingEvent, setLoadingEvent] = useState(false)
  const [eventError, setEventError] = useState(null)

  const [selected, setSelected] = useState([])
  const [entries, setEntries] = useState(() => new Map())
  const [pending, setPending] = useState(() => new Set())
  const fetched = useRef(new Set())

  const [query, setQuery] = useState('')
  const [flipped, setFlipped] = useState(() => new Set())
  const [ai, setAi] = useState({ running: false, results: null })

  // --- loading --------------------------------------------------------------

  const loadEvents = useCallback(async () => {
    setBoot({ loading: true, error: null })
    // The season an event belongs to comes off its key, not off the wall clock —
    // see loadEvent below. The current year is only what gets listed first.
    const { data, error } = await listEvents(new Date().getFullYear())
    setEvents(data)
    setBoot({ loading: false, error: data.length ? null : error })
  }, [])

  useEffect(() => {
    loadEvents()
  }, [loadEvents])

  const loadEvent = useCallback(async (key) => {
    if (!key) return
    setLoadingEvent(true)
    setEventError(null)
    const year = Number(key.slice(0, 4)) || new Date().getFullYear()
    const [t, s, c, f] = await Promise.all([
      listEventTeams(key),
      teamStats(key),
      teamChecklist(key),
      // Field labels and types for the dynamic rows. The match form is the one
      // that matters here: pit answers are recorded once and do not average.
      activeForm(year, 'match'),
    ])
    setRoster(t.data)
    setStats(s.data)
    setChecklist(c.data)
    setForm(f.data)
    setEventError(t.error ?? s.error ?? c.error ?? null)
    setLoadingEvent(false)
  }, [])

  useEffect(() => {
    if (!eventKey) return
    localStorage.setItem('frc5805.event', eventKey)
    fetched.current = new Set()
    setEntries(new Map())
    setAi({ running: false, results: null })
    // Selection is remembered per event. Walking back to this tab between
    // matches and finding your five teams still there is most of the value.
    try {
      const saved = JSON.parse(localStorage.getItem(`frc5805.compare.${eventKey}`) ?? '[]')
      setSelected(Array.isArray(saved) ? saved.slice(0, MAX_TEAMS).map(Number) : [])
    } catch {
      setSelected([])
    }
    loadEvent(eventKey)
  }, [eventKey, loadEvent])

  useEffect(() => {
    if (!eventKey) return
    localStorage.setItem(`frc5805.compare.${eventKey}`, JSON.stringify(selected))
  }, [eventKey, selected])

  // Entries are what make the dynamic rows possible and what give the score
  // rows their true n. Fetched once per team and kept — a column that has been
  // loaded stays loaded while you swap the others around it.
  useEffect(() => {
    if (!eventKey) return
    const missing = selected.filter((t) => !fetched.current.has(t))
    if (!missing.length) return
    let alive = true
    for (const team of missing) fetched.current.add(team)
    setPending((p) => new Set([...p, ...missing]))
    ;(async () => {
      await Promise.all(
        missing.map(async (team) => {
          // Every kind, not just 'match'. The score aggregate in the view spans
          // whatever entries carry a total_score, and counting a different set
          // here is how the sample size on screen stops matching the average
          // printed above it.
          const { data } = await listEntries({ eventKey, teamNumber: team, limit: 300 })
          if (!alive) return
          setEntries((m) => new Map(m).set(team, data))
          setPending((p) => {
            const next = new Set(p)
            next.delete(team)
            return next
          })
        })
      )
    })()
    return () => {
      alive = false
    }
  }, [eventKey, selected])

  // --- derived --------------------------------------------------------------

  const rosterBy = useMemo(() => new Map(roster.map((r) => [r.team_number, r])), [roster])
  const statsBy = useMemo(() => new Map(stats.map((r) => [r.team_number, r])), [stats])
  const checkBy = useMemo(() => new Map(checklist.map((r) => [r.team_number, r])), [checklist])

  const fieldMeta = useMemo(() => {
    const m = new Map()
    for (const f of form?.fields ?? []) {
      if (f?.key) m.set(f.key, f)
    }
    return m
  }, [form])

  const columns = useMemo(
    () =>
      selected.map((team) =>
        deriveColumn({
          team,
          roster: rosterBy.get(team),
          stats: statsBy.get(team),
          check: checkBy.get(team),
          entries: entries.get(team),
          loaded: entries.has(team),
        })
      ),
    [selected, rosterBy, statsBy, checkBy, entries]
  )

  const rows = useMemo(
    () => buildRows(columns, fieldMeta, flipped),
    [columns, fieldMeta, flipped]
  )

  const overall = useMemo(
    () => judgeOverall(rows, new Map(columns.map((c) => [c.team, c.matches]))),
    [rows, columns]
  )

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q
      ? roster.filter(
          (t) =>
            String(t.team_number).startsWith(q) ||
            (t.nickname ?? '').toLowerCase().includes(q)
        )
      : roster
    return list.slice(0, 60)
  }, [roster, query])

  // --- actions --------------------------------------------------------------

  const toggle = (team) =>
    setSelected((s) =>
      s.includes(team) ? s.filter((x) => x !== team) : s.length >= MAX_TEAMS ? s : [...s, team]
    )

  const flip = (id) =>
    setFlipped((f) => {
      const next = new Set(f)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  /**
   * The written comparison, one call per column.
   *
   * `scouting_summary` takes ONE team (read supabase/functions/ai/index.ts) —
   * there is no compare task, so this fans out and stacks the answers rather
   * than inventing a combined prompt the function does not implement.
   *
   * Every answer is rendered VERBATIM. The function's prompt is built around
   * forcing the model to lead with its sample size, and summarising it here
   * would delete the part that was hardest to get and matters most.
   */
  const runAi = useCallback(async () => {
    if (!eventKey || !selected.length) return
    setAi({ running: true, results: null })
    const out = await Promise.all(
      selected.map(async (team) => {
        const res = await askAi('scouting_summary', { eventKey, teamNumber: team })
        // Two envelopes. The edge function's ok() wraps its payload as
        // { data, error }, and askAi() returns invoke()'s parsed body without
        // unwrapping it — so the summary sits at res.data.data. syncFromTba()
        // in the same module does the `data?.data ?? data` dance for exactly
        // this reason; askAi() does not, so it is done here.
        const payload = res.data?.data ?? res.data
        return { team, error: res.error, payload: payload ?? null }
      })
    )
    setAi({ running: false, results: out })
  }, [eventKey, selected])

  // --- render ---------------------------------------------------------------

  if (boot.loading) return <Loading rows={3} label="Loading events" />
  if (boot.error && !events.length) return <ErrorState error={boot.error} onRetry={loadEvents} />

  return (
    <div className={styles.stack}>
      <section>
        <h2 className={styles.sectionTitle}>Event</h2>
        <div className={styles.toolbar}>
          <select
            className={css.select}
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
        </div>
      </section>

      {!events.length ? (
        <Empty icon="calendar" title="No events cached for this season">
          Nothing to compare against until someone pulls the schedule from The Blue Alliance — a
          lead can do that from the Scout tab.
        </Empty>
      ) : !eventKey ? (
        <Empty icon="flag" title="Pick an event first">
          Comparison is always within one event. A team's average at a week-1 regional and their
          average at champs are different robots with the same number on them.
        </Empty>
      ) : loadingEvent ? (
        <Loading rows={5} label="Loading teams and stats" />
      ) : eventError && !roster.length ? (
        <ErrorState error={eventError} onRetry={() => loadEvent(eventKey)} />
      ) : (
        <>
          <Picker
            results={results}
            query={query}
            onQuery={setQuery}
            selected={selected}
            statsBy={statsBy}
            onToggle={toggle}
          />

          {columns.length < 2 ? (
            <Empty icon="grid" title="Add at least two teams">
              Search above by number or name. Up to {MAX_TEAMS} columns — beyond that nobody reads
              the table, they just look at the widest bar.
            </Empty>
          ) : (
            <>
              <Verdict overall={overall} columns={columns} />
              <Table
                columns={columns}
                rows={rows}
                pending={pending}
                onRemove={toggle}
                onFlip={flip}
              />
              <AiNarrative
                ai={ai}
                columns={columns}
                onRun={runAi}
                disabled={!selected.length}
              />
            </>
          )}
        </>
      )}
    </div>
  )
}

// =============================================================================
// Pieces
// =============================================================================

function Picker({ results, query, onQuery, selected, statsBy, onToggle }) {
  const full = selected.length >= MAX_TEAMS
  return (
    <section>
      <h2 className={styles.sectionTitle}>
        Teams
        <span className={styles.countBadge}>
          {selected.length}/{MAX_TEAMS}
        </span>
      </h2>

      <div className={css.pickerBar}>
        <div className={css.search}>
          <Icon name="search" size={16} className={css.searchIcon} />
          <input
            type="search"
            className={css.searchInput}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Team number or name…"
            aria-label="Search teams by number or name"
          />
        </div>
      </div>

      {full && (
        <p className={css.note}>
          Five columns is the limit. Remove one to add another.
        </p>
      )}

      <ul className={css.pickList}>
        {results.map((t) => {
          const on = selected.includes(t.team_number)
          const s = statsBy.get(t.team_number)
          const n = Number(s?.matches_scouted ?? 0) || 0
          return (
            <li key={t.team_number}>
              <button
                type="button"
                className={`${css.pickBtn} ${on ? css.pickOn : ''}`}
                aria-pressed={on}
                disabled={!on && full}
                onClick={() => onToggle(t.team_number)}
              >
                <span className={css.pickNum}>{t.team_number}</span>
                <span className={css.pickName}>{t.nickname ?? '—'}</span>
                {/* Sample size is visible before you even add the column, so a
                    two-match team is never picked up believing otherwise. */}
                <span className={`${css.pickN} ${n < THIN_N ? css.pickNThin : ''}`}>
                  {n === 0 ? 'no data' : `${n}m`}
                </span>
                <Icon name={on ? 'check' : 'plus'} size={15} className={css.pickIcon} />
              </button>
            </li>
          )
        })}
        {!results.length && <li className={css.note}>No team matches “{query}”.</li>}
      </ul>
    </section>
  )
}

function Verdict({ overall, columns }) {
  const flagged = columns.filter((c) => c.unreliable)
  const tone =
    overall.verdict === 'winner'
      ? css.verdictWin
      : overall.verdict === 'provisional'
        ? css.verdictWarn
        : css.verdictNeutral

  const heading =
    overall.verdict === 'winner'
      ? `${overall.winner} comes out ahead`
      : overall.verdict === 'provisional'
        ? `${overall.winner} leads — provisionally`
        : overall.verdict === 'insufficient'
          ? 'Nothing to compare yet'
          : 'Too close to call'

  return (
    <section className={`${css.verdict} ${tone}`} aria-live="polite">
      <div className={css.verdictHead}>
        <Icon
          name={overall.verdict === 'winner' ? 'trophy' : overall.verdict === 'provisional' ? 'alert' : 'bars'}
          size={20}
        />
        <h2 className={css.verdictTitle}>{heading}</h2>
      </div>
      <p className={css.verdictReason}>{overall.reason}</p>

      {overall.tally.length > 0 && (
        <ul className={css.tally}>
          {overall.tally.map((t) => (
            <li key={t.team} className={css.tallyItem}>
              <span className={css.tallyTeam}>{t.team}</span>
              <span className={css.tallyCount}>
                {t.count} {t.count === 1 ? 'category' : 'categories'}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* Surfaced beside the verdict rather than folded into it as a hidden
          weight. A team can win the tally and still be the wrong pick, and the
          reader is the one who should be making that trade knowingly. */}
      {flagged.length > 0 && (
        <p className={css.verdictFlag}>
          <Icon name="alert" size={14} />
          {flagged
            .map(
              (c) =>
                `${c.team}: ${[
                  c.breakdowns ? `${c.breakdowns} breakdown${c.breakdowns === 1 ? '' : 's'}` : null,
                  c.noShows ? `${c.noShows} no-show${c.noShows === 1 ? '' : 's'}` : null,
                ]
                  .filter(Boolean)
                  .join(', ')}`
            )
            .join(' · ')}
          . Reliability outranks average score in a pick, whatever the tally says.
        </p>
      )}
    </section>
  )
}

function Table({ columns, rows, pending, onRemove, onFlip }) {
  const groups = []
  for (const r of rows) {
    if (!groups.length || groups.at(-1).name !== r.group) groups.push({ name: r.group, rows: [] })
    groups.at(-1).rows.push(r)
  }

  return (
    <section>
      <p className={css.swipeHint} aria-hidden="true">
        <Icon name="arrowRight" size={13} />
        Swipe the table to reach the other columns
      </p>

      <div className={css.scroller} tabIndex={0} role="region" aria-label="Team comparison table">
        <table className={css.table}>
          <caption className="sr-only">
            Metrics down the side, teams across the top. Rows the data separates are marked with a
            winner; rows it does not are marked too close to call.
          </caption>
          <thead>
            <tr>
              <th scope="col" className={`${css.cell} ${css.corner}`}>
                Metric
              </th>
              {columns.map((c) => (
                <ColumnHead key={c.team} col={c} loading={pending.has(c.team)} onRemove={onRemove} />
              ))}
            </tr>
          </thead>

          {groups.map((g) => (
            <tbody key={g.name}>
              <tr className={css.groupRow}>
                <th scope="colgroup" colSpan={columns.length + 1} className={css.groupHead}>
                  <span className={css.groupInner}>
                    {g.name}
                    {g.name === 'Coverage' && (
                      <span className={css.groupNote}>
                        how much we have looked — not how good they are, and never scored
                      </span>
                    )}
                  </span>
                </th>
              </tr>
              {g.rows.map((r) => (
                <MetricRow key={r.id} row={r} columns={columns} onFlip={onFlip} />
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </section>
  )
}

function ColumnHead({ col, loading, onRemove }) {
  const tone = col.empty || col.thin ? css.headThin : col.light ? css.headLight : ''
  return (
    <th scope="col" className={`${css.cell} ${css.colHead} ${tone}`}>
      <span className={css.colNum}>{col.team}</span>
      <span className={css.colName}>{col.nickname ?? '—'}</span>

      {/* The single most important thing in this header. A column built on two
          matches must not look as authoritative as one built on fifteen, so the
          count is large, always present, and colour-coded rather than tucked
          into the coverage rows forty pixels further down. */}
      <span
        className={`${css.colN} ${col.empty || col.thin ? css.colNThin : col.light ? css.colNLight : ''}`}
      >
        {loading ? (
          <span className={styles.spinnerSm} aria-hidden="true" />
        ) : (
          <>
            <strong>{col.matches}</strong> {col.matches === 1 ? 'match' : 'matches'}
          </>
        )}
      </span>

      {col.loaded && col.scoredN !== col.matches && (
        <span className={css.colWarn} title="Matches scouted vs matches with a score recorded">
          {col.scoredN} scored
        </span>
      )}
      {col.empty && <span className={css.colWarn}>never scouted</span>}
      {col.unreliable && (
        <span className={css.colFlag}>
          <Icon name="alert" size={12} />
          {col.breakdowns ? `${col.breakdowns} broke` : ''}
          {col.breakdowns && col.noShows ? ' · ' : ''}
          {col.noShows ? `${col.noShows} no-show` : ''}
        </span>
      )}

      <button
        type="button"
        className={css.remove}
        onClick={() => onRemove(col.team)}
        title={`Remove team ${col.team}`}
      >
        <Icon name="close" size={14} />
        <span className="sr-only">Remove team {col.team}</span>
      </button>
    </th>
  )
}

function MetricRow({ row, columns, onFlip }) {
  const { judgment: j, spec } = row
  const max = j.range.max ?? 0

  return (
    <tr className={css.row}>
      <th scope="row" className={`${css.cell} ${css.rowHead}`}>
        <span className={css.rowLabel}>{row.label}</span>
        {row.sub && <span className={css.rowSub}>{row.sub}</span>}

        <span className={css.rowMeta}>
          {spec.scored && (
            <span className={css.dir} title={`${spec.direction === 'higher' ? 'Higher' : 'Lower'} is better`}>
              {spec.direction === 'higher' ? '↑' : '↓'} better
            </span>
          )}
          {row.assumed && (
            <button
              type="button"
              className={css.flip}
              onClick={() => onFlip(row.id)}
              title={
                `Assumed from the field name: ${spec.direction} is better. The form schema ` +
                `records a field's type but never which way round it goes — tap to flip it.`
              }
            >
              <span aria-hidden="true">⇅</span>
              assumed
              <span className="sr-only">
                — direction guessed from the field name. Activate to flip which direction counts
                as better for {row.label}.
              </span>
            </button>
          )}
          {row.orphan && (
            <span className={css.orphan} title="Recorded against a form that is no longer active">
              old form
            </span>
          )}
        </span>

        <Chip row={row} />
        {row.help && <span className={css.rowHelp}>{row.help}</span>}
        {row.caveat && <span className={css.rowCaveat}>{row.caveat}</span>}
        {row.contextNote && <span className={css.rowCaveat}>{row.contextNote}</span>}
      </th>

      {columns.map((col) => {
        const cell = row.cells.find((c) => c.team === col.team) ?? { team: col.team, value: null }
        const value = cell.value ?? null
        const won = j.winner === col.team
        const ahead = j.winner == null && j.leader === col.team
        const frac = value != null && max > 0 ? Math.max(0, Math.min(1, value / max)) : 0
        const detail = row.detail ? row.detail(cell) : null
        // A key nobody filled in on every pass has its own sample size, smaller
        // than the column's. Shown when they disagree, because a mean of two is
        // not the same claim as a mean of twelve even inside one column.
        const partial = cell.n != null && cell.n > 0 && cell.n < col.matches && !row.noBar

        return (
          <td
            key={col.team}
            className={`${css.cell} ${css.value} ${won ? css.won : ''} ${
              col.thin || col.empty ? css.thin : ''
            }`}
          >
            <span className={css.valueRow}>
              <span className={css.valueNum}>{value == null ? '—' : row.format(value)}</span>
              {won && (
                <span className={css.crown} title="Clear winner in this category">
                  <Icon name="check" size={13} />
                  <span className="sr-only">winner, {row.label}</span>
                </span>
              )}
              {ahead && (
                <span className={css.aheadTag} title="Ahead on the raw number, but not by enough to call">
                  ahead
                </span>
              )}
            </span>

            {detail && <span className={css.valueDetail}>{detail}</span>}
            {partial && <span className={css.valueDetail}>n={cell.n}</span>}

            {/* Bar length is always magnitude, never rank — inverting it on
                "lower is better" rows would make the picture disagree with the
                number printed above it. Colour carries the judgement instead. */}
            {value != null && !row.noBar && (
              <span className={css.bar} aria-hidden="true">
                <span className={css.barFill} style={{ '--v': frac }} />
              </span>
            )}
          </td>
        )
      })}
    </tr>
  )
}

/**
 * The one-line honest answer for a row.
 *
 * Both numbers are quoted in the row's own units. A gap printed as "0.2" under
 * a column of cells reading "20%" looks like a third, unrelated measurement,
 * and the whole point of this chip is that the reader can check the call.
 */
function Chip({ row }) {
  const j = row.judgment
  const q = (v) => (row.spec.kind === 'rate' ? `${Math.round(v * 100)}%` : v.toFixed(1))

  if (j.verdict === 'decisive') {
    return (
      <span className={`${css.chip} ${css.chipWin}`}>
        gap {q(j.gap)} vs ±{q(j.uncertainty)} noise
      </span>
    )
  }
  if (j.verdict === 'close') {
    return (
      <span className={`${css.chip} ${css.chipClose}`}>
        too close to call
        {j.uncertainty != null && (
          <span className={css.chipWhy}>
            gap {q(j.gap)}, noise ±{q(j.uncertainty)}
          </span>
        )}
      </span>
    )
  }
  if (j.verdict === 'thin') {
    return (
      <span className={`${css.chip} ${css.chipThin}`}>
        not enough matches
        <span className={css.chipWhy}>under {MIN_N} on {j.thinTeams.join(', ')}</span>
      </span>
    )
  }
  if (j.verdict === 'tie') return <span className={`${css.chip} ${css.chipClose}`}>tied</span>
  // 'context' and 'none' get nothing. The Coverage group already carries a
  // heading that says it is never scored, and stamping seven identical "context
  // only" chips down the page would train the eye to skip chips entirely —
  // including the "too close to call" one, which is the whole point.
  return null
}

function AiNarrative({ ai, columns, onRun, disabled }) {
  const nameOf = (team) => columns.find((c) => c.team === team)?.nickname ?? ''
  // A summary is a snapshot of the columns that were on screen when it was
  // asked for. Drop a team's card the moment its column goes, rather than
  // leaving prose about a robot that is no longer part of the comparison.
  const shown = ai.results?.filter((r) => columns.some((c) => c.team === r.team)) ?? []

  return (
    <section className={css.aiBlock}>
      <h2 className={styles.sectionTitle}>Written summary</h2>

      <div className={css.aiBar}>
        <button
          type="button"
          className={`btn btn--cyan ${css.aiBtn}`}
          onClick={onRun}
          disabled={disabled || ai.running}
        >
          {ai.running ? (
            <span className={styles.spinnerSm} aria-hidden="true" />
          ) : (
            <Icon name="spark" size={16} />
          )}
          {ai.running ? 'Asking…' : 'Write it up'}
        </button>
        <span className={css.note}>
          Optional. Everything above is complete without it.
        </span>
      </div>

      {shown.map((r) => (
        <article key={r.team} className={css.aiCard}>
          <header className={css.aiHead}>
            <span className={css.aiTeam}>{r.team}</span>
            <span className={css.aiName}>{nameOf(r.team)}</span>
            {r.payload?.matches_scouted != null && (
              <span className={css.aiN}>{r.payload.matches_scouted} matches</span>
            )}
          </header>

          {r.error || !r.payload?.summary ? (
            // Not an error state. The numbers above are the feature; this is a
            // convenience on top of them, and a missing OpenAI key must read as
            // "one optional extra is off" rather than "the panel is broken".
            //
            // The message is deliberately vague about WHY, because it has to
            // be: supabase-js turns any non-2xx from an edge function into a
            // generic "non-2xx status code", so the function's own clear
            // "OPENAI_API_KEY is not configured on the server." never reaches
            // the browser. Whatever did arrive is shown underneath rather than
            // dressed up as a diagnosis.
            <p className={css.aiOff}>
              <Icon name="alert" size={14} />
              AI summary unavailable for this team.
              {r.error && <span className={css.aiWhy}>{String(r.error)}</span>}
            </p>
          ) : (
            <>
              {/* Verbatim. The prompt in supabase/functions/ai/index.ts is built
                  around making the model state its sample size and refuse to
                  extrapolate; re-phrasing it here would throw that away. */}
              <p className={css.aiText}>{r.payload.summary}</p>
              <p className={css.aiFoot}>
                {r.payload.model
                  ? `${r.payload.model} · generated, not verified — check it against the table.`
                  : 'No model was called: there was no data to summarise.'}
              </p>
            </>
          )}
        </article>
      ))}
    </section>
  )
}
