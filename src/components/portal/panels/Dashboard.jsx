import { useCallback, useEffect, useState } from 'react'
import Icon from '../../Icon'
import { useAuth } from '../../../lib/auth'
import { supabase } from '../../../lib/supabase'
import { backupHealth, listFiles, formatBytes } from '../../../lib/portalApi'
import { listEntries, teamStats, listVisionSessions } from '../../../lib/scoutingApi'
import { navigate } from '../../../lib/router'
import { Loading, ErrorState, StatTile, Empty } from '../ui'
import BackupLeg from '../BackupLeg'
import ExportButton from '../ExportButton'
import styles from '../Portal.module.css'
import d from './Dashboard.module.css'

// The overview answers "what is the state of things?" in one screen. Every item
// on it is either a number somebody acts on, or a link to where they act.

// Bucket recent entries into one count per day for the last `days` days, oldest
// first, with empty days included so the line has a real baseline instead of
// skipping the gaps. Done in the browser over ~500 recent rows, which keeps the
// query a single `select recorded_at`.
function bucketByDay(rows, days = 14) {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (days - 1))
  const buckets = Array.from({ length: days }, (_, i) => {
    const date = new Date(start)
    date.setDate(start.getDate() + i)
    return { date, count: 0 }
  })
  const DAY_MS = 86400000
  for (const r of rows) {
    if (!r?.recorded_at) continue
    const t = new Date(r.recorded_at)
    if (Number.isNaN(t.getTime())) continue
    t.setHours(0, 0, 0, 0)
    const idx = Math.round((t.getTime() - start.getTime()) / DAY_MS)
    if (idx >= 0 && idx < days) buckets[idx].count += 1
  }
  return buckets
}

// A 14-day pulse of scouting activity, drawn as an inline SVG — no charting
// library, just a path. Purely presentational and deliberately static: this
// screen is read constantly, so nothing on it animates.
function Sparkline({ buckets }) {
  const total = buckets.reduce((sum, b) => sum + b.count, 0)
  const peak = Math.max(0, ...buckets.map((b) => b.count))

  // No activity is a real answer, not a broken chart. Say so plainly rather than
  // draw a flat line pretending there is a shape.
  if (total === 0) {
    return <div className={d.sparkEmpty}>No scouting recorded in the last 14 days.</div>
  }

  // Fixed coordinate space, stretched to fill the card; the stroke is drawn
  // non-scaling so it stays crisp however wide the card gets.
  const W = 100
  const H = 32
  const pad = 3
  const n = buckets.length
  const max = Math.max(1, peak)
  const px = (i) => (n <= 1 ? W / 2 : (i / (n - 1)) * W)
  const py = (v) => H - pad - (v / max) * (H - pad * 2)
  const pts = buckets.map((b, i) => `${px(i).toFixed(2)},${py(b.count).toFixed(2)}`)
  const line = `M ${pts.join(' L ')}`
  const area = `M ${px(0).toFixed(2)},${H} L ${pts.join(' L ')} L ${px(n - 1).toFixed(2)},${H} Z`
  const label = `Scouting activity over the last 14 days: ${total} ${
    total === 1 ? 'entry' : 'entries'
  }, busiest day ${peak}.`

  return (
    <svg
      className={d.spark}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <path className={d.sparkArea} d={area} />
      <path className={d.sparkLine} d={line} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

// Fixed columns first, then one column per dynamic `data` key — the union across
// the fetched rows, so a field only some entries carry still earns a column.
// scout_entries.data is keyed by the active form's field keys; `scout` is the
// recording member's id (scout_id).
const SCOUT_BASE_COLUMNS = [
  { key: 'team_number', header: 'team_number' },
  { key: 'kind', header: 'kind' },
  { key: 'match_number', header: 'match_number' },
  { key: 'alliance', header: 'alliance' },
  // The scout's name, from the profile join listEntries now flattens onto the
  // row. Falls back to the id if the profile is gone, so the column is never
  // silently blank.
  { header: 'scout', value: (row) => row?.scout_name ?? row?.scout_id ?? '' },
  { key: 'recorded_at', header: 'recorded_at' },
]
const SCOUT_BASE_HEADERS = new Set(SCOUT_BASE_COLUMNS.map((col) => col.header))

function scoutColumns(rows) {
  const keys = []
  const seen = new Set()
  for (const row of rows) {
    for (const key of Object.keys(row?.data ?? {})) {
      // Once each, first-seen order (stable columns), and never a data key that
      // would collide with a fixed column's header.
      if (seen.has(key) || SCOUT_BASE_HEADERS.has(key)) continue
      seen.add(key)
      keys.push(key)
    }
  }
  return [
    ...SCOUT_BASE_COLUMNS,
    ...keys.map((key) => ({ header: key, value: (row) => row?.data?.[key] })),
  ]
}

export default function Dashboard() {
  const { atLeast, profile, role } = useAuth()
  // backup_runs is member+ in RLS, so a viewer legitimately reads zero rows.
  // Without this gate an empty result would render as "No backup has ever run",
  // which is alarming, wrong, and unactionable for the person seeing it. Not
  // being allowed to see something is not the same as it not existing.
  const canSeeBackups = atLeast('member')
  const [s, setS] = useState({ loading: true, error: null })

  const load = useCallback(async () => {
    setS((p) => ({ ...p, loading: true, error: null }))
    const eventKey = localStorage.getItem('frc5805.event') || null
    // The signed-in scout's own id, for the personal contribution count below.
    // Null before the profile resolves; the query is skipped until then, and load
    // re-runs once it arrives (profile?.id is in the dependency array).
    const scoutId = profile?.id ?? null

    const [health, recent, counts, coverage, activity, spark, leaders, vision, mine] =
      await Promise.all([
        canSeeBackups ? backupHealth() : Promise.resolve({ data: [], error: null }),
        listFiles({ limit: 5 }),
        // head:true returns the count without transferring the rows. This runs on
        // every portal visit; there is no reason to pull a thousand entries down
        // in order to display the number 1000.
        Promise.all([
          supabase.from('scout_entries').select('id', { count: 'exact', head: true }),
          supabase.from('graphs').select('id', { count: 'exact', head: true }),
          supabase.from('code_archives').select('id', { count: 'exact', head: true }),
          supabase.from('knowledge_docs').select('id', { count: 'exact', head: true }),
          supabase.from('profiles').select('id', { count: 'exact', head: true }),
          supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'pending'),
        ]),
        eventKey
          ? supabase.from('event_scout_coverage').select('*').eq('event_key', eventKey).maybeSingle()
          : Promise.resolve({ data: null }),
        supabase
          .from('scout_entries')
          .select('team_number, kind, recorded_at')
          .order('recorded_at', { ascending: false })
          .limit(6),
        // Added for the 14-day activity sparkline: only recorded_at crosses the
        // wire, capped at 500 rows and bucketed by day in the browser. Separate
        // from the counts/coverage/activity reads above — those are unchanged.
        supabase
          .from('scout_entries')
          .select('recorded_at')
          .order('recorded_at', { ascending: false })
          .limit(500),
        // Top-team leaderboard for the active event. team_event_stats is member+
        // in RLS, so a viewer — or an event with no match rows yet — legitimately
        // reads nothing, which renders an empty state rather than a crash. Guarded
        // like coverage; .catch keeps a failure here from blanking the overview.
        eventKey ? teamStats(eventKey).catch(() => ({ data: [] })) : Promise.resolve({ data: [] }),
        // Vision capture sessions — the active event's, or the most recent across
        // every event when none is selected. Only the count is surfaced.
        listVisionSessions(eventKey || null, 100).catch(() => ({ data: [] })),
        // This scout's own lifetime entry count — a small, motivating figure.
        // head-only, and only asked once we know who they are.
        scoutId
          ? Promise.resolve(
              supabase
                .from('scout_entries')
                .select('id', { count: 'exact', head: true })
                .eq('scout_id', scoutId)
            ).catch(() => ({ count: 0 }))
          : Promise.resolve({ count: 0 }),
      ])

    const [entries, graphs, archives, docs, members, pending] = counts
    setS({
      loading: false,
      error: health.error ?? recent.error ?? null,
      health: health.data ?? [],
      recent: recent.data ?? [],
      eventKey,
      counts: {
        entries: entries.count ?? 0,
        graphs: graphs.count ?? 0,
        archives: archives.count ?? 0,
        docs: docs.count ?? 0,
        members: members.count ?? 0,
        pending: pending.count ?? 0,
      },
      coverage: coverage?.data ?? null,
      activity: activity.data ?? [],
      spark: spark.data ?? [],
      // New overview reads. Each tolerates its own failure by degrading to empty,
      // matching the per-read null-tolerance the rest of this loader already has.
      leaders: leaders?.data ?? [],
      visionCount: (vision?.data ?? []).length,
      myEntries: mine?.count ?? 0,
    })
  }, [canSeeBackups, profile?.id])

  useEffect(() => {
    load()
  }, [load])

  if (s.loading) return <Loading rows={6} label="Loading overview" />
  if (s.error) return <ErrorState error={s.error} onRetry={load} />

  const c = s.counts
  const bytes = Math.max(0, ...s.health.map((r) => r.byte_total ?? 0))
  const objects = Math.max(0, ...s.health.map((r) => r.object_count ?? 0))
  const first = profile?.full_name?.split(' ')[0]
  const today = new Date()
  const buckets = bucketByDay(s.spark ?? [])
  const sparkTotal = buckets.reduce((sum, b) => sum + b.count, 0)
  const sparkPeak = Math.max(0, ...buckets.map((b) => b.count))
  const myEntries = s.myEntries ?? 0
  const visionCount = s.visionCount ?? 0

  // Coverage as a bar: teams_scouted / teams_at_event. Guarded against a missing
  // row (no event_teams yet) and a zero denominator so the width is always sane.
  const cov = s.coverage
  const covPct =
    cov && cov.teams_at_event > 0
      ? Math.round((cov.teams_scouted / cov.teams_at_event) * 100)
      : 0

  // Top five by observed match score. team_event_stats already orders this, but a
  // null avg_score (a team seen only in the pit so far) is not a leaderboard row,
  // so drop those before taking the head — and sort defensively in case the
  // fallback path handed back an unordered list.
  const leaders = (s.leaders ?? [])
    .filter((t) => t.avg_score != null && !Number.isNaN(Number(t.avg_score)))
    .sort((a, b) => Number(b.avg_score) - Number(a.avg_score))
    .slice(0, 5)

  // All entries for the selected event; with none selected, the most recent
  // across every event so the button still does something useful. Both are
  // capped — a single event is a few thousand rows at most, and this is a manual
  // export, not a background sync.
  const loadScoutRows = async () => {
    const { data, error } = await listEntries(
      s.eventKey ? { eventKey: s.eventKey, limit: 5000 } : { limit: 2000 }
    )
    if (error) throw new Error(error)
    return data
  }
  const exportName = `scout-entries-${s.eventKey || 'recent'}-${today
    .toISOString()
    .slice(0, 10)}.csv`

  return (
    <div className={styles.stack}>
      {/* Header band: who you are and what day it is, framed off from the
          numbers so they have a context to sit in. Static — read every visit. */}
      <header className={d.hero}>
        <div className={d.heroText}>
          <span className={d.heroEyebrow}>Overview</span>
          <p className={d.heroGreeting}>{first ? `Hello, ${first}.` : 'Welcome back.'}</p>
          <p className={d.heroSub}>Here's where things stand.</p>
          {profile?.id && (
            <p className={d.heroContrib}>
              You've recorded <strong>{myEntries.toLocaleString()}</strong>{' '}
              {myEntries === 1 ? 'entry' : 'entries'}.
            </p>
          )}
        </div>
        <div className={d.heroMeta}>
          {role && (
            <span className={d.identChip}>
              <span className={d.identLabel}>Signed in as</span>
              <span className={`${styles.roleTag} ${styles[`role_${role}`] ?? ''}`}>{role}</span>
            </span>
          )}
          <span className="data-tag">
            <time dateTime={today.toISOString().slice(0, 10)}>
              {today.toLocaleDateString(undefined, {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
              })}
            </time>
          </span>
        </div>
      </header>

      {/* Pending approvals lead, because this is the only item here that blocks
          another person from working — and it is invisible unless someone looks. */}
      {atLeast('admin') && c.pending > 0 && (
        <button type="button" className={styles.alertRow} onClick={() => navigate('/portal/admin')}>
          <Icon name="users" size={17} />
          <span>
            <strong>{c.pending}</strong> {c.pending === 1 ? 'person is' : 'people are'} waiting for
            approval — they can see nothing until promoted.
          </span>
          <Icon name="arrowRight" size={15} />
        </button>
      )}

      {/* Headline: the scouting numbers people open this for, a 14-day pulse of
          activity, and the data export. The one raised, primary block here. */}
      <section className={d.headline}>
        <div className={d.headlineTop}>
          <h2 className={d.headTitle}>
            <Icon name="flag" size={15} />
            Scouting
          </h2>
          {atLeast('member') && (
            <ExportButton load={loadScoutRows} columns={scoutColumns} filename={exportName}>
              Export scouting data
            </ExportButton>
          )}
        </div>

        {/* Active event + coverage. The event key frames every number in this
            block; with none selected, a calm prompt to pick one rather than a
            row of dashes that reads as broken. */}
        {s.eventKey ? (
          <div className={d.coverage}>
            <div className={d.coverageHead}>
              <span className={d.coverageLabel}>Active event</span>
              <span className={d.coverageEvent}>{s.eventKey}</span>
            </div>
            {cov ? (
              <>
                <div
                  className={d.progress}
                  role="progressbar"
                  aria-valuenow={covPct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${cov.teams_scouted} of ${cov.teams_at_event} teams scouted`}
                >
                  <div className={d.progressFill} style={{ width: `${covPct}%` }} />
                </div>
                <div className={d.coverageMeta}>
                  <span>
                    <strong>{cov.teams_scouted}</strong> of {cov.teams_at_event} teams scouted
                  </span>
                  <span className={d.coveragePct}>{covPct}%</span>
                </div>
              </>
            ) : (
              <p className={d.coverageHint}>
                No teams loaded for {s.eventKey} yet — sync the roster in Scout.
              </p>
            )}
          </div>
        ) : (
          <button type="button" className={d.noEvent} onClick={() => navigate('/portal/scout')}>
            <Icon name="compass" size={16} />
            <span>No active event — pick one in Scout.</span>
            <Icon name="arrowRight" size={15} />
          </button>
        )}

        <div className={d.figures}>
          <div className={d.figure}>
            <span className={d.figureLabel}>Entries recorded</span>
            <span className={d.figureValue}>{c.entries.toLocaleString()}</span>
          </div>
          <div className={d.figure}>
            <span className={d.figureLabel}>Team members</span>
            <span className={d.figureValue}>{c.members}</span>
          </div>
        </div>

        {/* Top-teams leaderboard — the single most-requested overview view. Only
            with an event active; empty until a match actually carries a score. */}
        {s.eventKey && (
          <div className={d.board}>
            <div className={d.boardHead}>
              <span className={d.boardTitle}>
                <Icon name="trophy" size={14} />
                Top teams
              </span>
              {leaders.length > 0 && <span className={d.boardBy}>by avg score</span>}
            </div>
            {leaders.length === 0 ? (
              <p className={d.boardEmpty}>No match data yet for {s.eventKey}.</p>
            ) : (
              <ol className={d.boardList}>
                {leaders.map((t, i) => {
                  const matches = t.matches_scouted ?? 0
                  return (
                    <li key={t.team_number} className={d.boardRow}>
                      <span className={d.boardRank}>{i + 1}</span>
                      <span className={d.boardTeam}>
                        <span className={d.boardNum}>{t.team_number}</span>
                        {matches > 0 && (
                          <span className={d.boardMatches}>
                            {matches.toLocaleString()} {matches === 1 ? 'match' : 'matches'}
                          </span>
                        )}
                      </span>
                      <span className={d.boardScore}>{Number(t.avg_score).toFixed(1)}</span>
                    </li>
                  )
                })}
              </ol>
            )}
          </div>
        )}

        <div className={d.sparkWrap}>
          <div className={d.sparkHead}>
            <span className={d.sparkTitle}>Activity · last 14 days</span>
            {sparkTotal > 0 && (
              <span className={d.sparkStat}>
                <strong>{sparkTotal.toLocaleString()}</strong> {sparkTotal === 1 ? 'entry' : 'entries'} ·
                peak <strong>{sparkPeak}</strong>/day
              </span>
            )}
          </div>
          <Sparkline buckets={buckets} />
        </div>

        {s.coverage && !s.coverage.fully_covered && (
          <button
            type="button"
            className={styles.alertRow}
            onClick={() => navigate('/portal/checklist')}
          >
            <Icon name="alert" size={16} />
            <span>
              <strong>{s.coverage.teams_unscouted}</strong> teams at {s.eventKey} still have no
              match data.
            </span>
            <Icon name="arrowRight" size={15} />
          </button>
        )}
      </section>

      {/* Secondary detail: plain sections, so the headline card above reads as
          the primary one by contrast. */}
      <section>
        <h2 className={styles.sectionTitle}>
          <Icon name="folder" size={15} />
          Archive
        </h2>
        <div className={styles.statGrid}>
          <StatTile label="Knowledge docs" value={c.docs} />
          <StatTile label="Code archives" value={c.archives} />
          <StatTile label="Graphs" value={c.graphs} />
          <StatTile label="Vision sessions" value={visionCount} />
        </div>
      </section>

      {canSeeBackups && (
        <section>
          <h2 className={styles.sectionTitle}>
            <Icon name="check" size={15} />
            Backup — as of last run
          </h2>
          <div className={styles.statGrid}>
            <StatTile label="Objects stored" value={objects.toLocaleString()} />
            <StatTile label="Total size" value={formatBytes(bytes)} />
            <StatTile label="Buckets" value="5" />
          </div>
          {s.health.length === 0 ? (
            <Empty icon="alert" title="No backup has ever run">
              Everything here exists in exactly one place until the nightly mirror reports in.
            </Empty>
          ) : (
            <ul className={styles.legList}>
              {s.health.map((leg) => (
                <BackupLeg key={leg.leg} leg={leg} />
              ))}
            </ul>
          )}
        </section>
      )}

      <div className={styles.twoCol}>
        <section>
          <h2 className={styles.sectionTitle}>
            <Icon name="flag" size={15} />
            Latest scouting
          </h2>
          {s.activity.length === 0 ? (
            <Empty title="Nothing scouted yet">Entries appear as soon as a phone syncs.</Empty>
          ) : (
            <ul className={styles.miniList}>
              {s.activity.map((a, i) => (
                <li key={i} className={styles.miniRow} style={{ '--i': Math.min(i, 8) }}>
                  <span className={styles.miniTitle}>Team {a.team_number}</span>
                  <span className={styles.miniMeta}>
                    <code className={styles.bucketTag}>{a.kind}</code>
                    {new Date(a.recorded_at).toLocaleDateString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2 className={styles.sectionTitle}>
            <Icon name="folder" size={15} />
            Recently added
          </h2>
          {s.recent.length === 0 ? (
            <Empty title="Nothing uploaded yet">Files added anywhere show up here.</Empty>
          ) : (
            <ul className={styles.miniList}>
              {s.recent.map((f, i) => (
                <li key={f.id} className={styles.miniRow} style={{ '--i': Math.min(i, 8) }}>
                  <span className={styles.miniTitle}>{f.title}</span>
                  <span className={styles.miniMeta}>
                    <code className={styles.bucketTag}>{f.bucket}</code>
                    {formatBytes(f.byte_size)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section>
        <h2 className={styles.sectionTitle}>
          <Icon name="spark" size={15} />
          Jump to
        </h2>
        <div className={styles.quickGrid}>
          {[
            { to: '/portal/scout', icon: 'flag', label: 'Scout a match' },
            { to: '/portal/checklist', icon: 'check', label: 'Coverage' },
            { to: '/portal/compare', icon: 'bars', label: 'Compare teams' },
            { to: '/portal/picks', icon: 'trophy', label: 'Pick list' },
            { to: '/portal/vision', icon: 'cpu', label: 'Vision capture' },
            { to: '/portal/graphs', icon: 'share', label: 'Graphs' },
            { to: '/portal/kb', icon: 'book', label: 'Knowledge' },
          ].map((q) => (
            <a key={q.to} href={`#${q.to}`} className={styles.quickCard}>
              <Icon name={q.icon} size={18} />
              {q.label}
            </a>
          ))}
        </div>
      </section>
    </div>
  )
}
