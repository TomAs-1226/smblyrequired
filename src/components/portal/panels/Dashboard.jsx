import { useCallback, useEffect, useRef, useState } from 'react'
import Icon from '../../Icon'
import { useAuth } from '../../../lib/auth'
import { supabase } from '../../../lib/supabase'
import { backupHealth, listFiles, formatBytes } from '../../../lib/portalApi'
import { listEntries, teamStats, listVisionSessions } from '../../../lib/scoutingApi'
import { useOfflineQueue } from '../../../hooks/useOfflineQueue'
import { navigate } from '../../../lib/router'
import { Loading, ErrorState, StatTile, Empty } from '../ui'
import BackupLeg from '../BackupLeg'
import ExportButton from '../ExportButton'
import SyncBadge from '../SyncBadge'
import styles from '../Portal.module.css'
import d from './Dashboard.module.css'

// The overview answers "what is the state of things?" in one screen. Every item
// on it is either a number somebody acts on, or a link to where they act.
//
// It is also the screen this app is judged by, so it is built to never blank and
// never lie: each widget loads independently (one failed read empties only its
// own card), a refetch keeps the last-good data on screen instead of flashing a
// skeleton, and a first-load blip self-heals with a short retry ladder before it
// is ever allowed to show an error. See load() for the mechanics.

// How often the overview refreshes itself while the tab is being looked at, and
// the backoff ladder a *first* load walks before it admits defeat. A venue
// network drops packets for a few seconds at a time; retrying twice turns that
// into a hiccup nobody sees rather than an error screen.
const POLL_MS = 45_000
const RETRY_BACKOFFS_MS = [800, 2_000]
const FIRST_LOAD_ERROR =
  'The overview could not load. Check your connection and try again.'

function errText(e) {
  if (!e) return null
  return typeof e === 'string' ? e : e.message || null
}

// Run one read to a { ok, value } record. Supabase resolves a network or policy
// failure as { error } rather than throwing, and RLS row-filtering hands back
// empty data with NO error — so a viewer's legitimately-empty read still counts
// as ok, and only a real failure (a thrown error, or an `error` field) flips ok
// to false. `value` is preserved on failure so the caller can read its message.
async function settle(promise, fallback) {
  try {
    const value = await promise
    if (value && value.error) return { ok: false, value, error: errText(value.error) }
    return { ok: true, value: value ?? fallback }
  } catch (e) {
    return { ok: false, value: fallback, error: errText(e) || 'Request failed' }
  }
}

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

// A circular-arrow glyph for the manual refresh control. Inline rather than in
// the shared Icon set because it is the only place the overview needs it, and it
// matches Icon's stroke vocabulary (currentColor, round joins) so it reads as
// part of the same family.
function RefreshGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 11.5A8 8 0 1 0 18.3 16.9" />
      <path d="M20 4.5V11h-6.5" />
    </svg>
  )
}

// "updated Ns ago", ticking once a second off a local clock. Isolated into its
// own component so only this label re-renders every second — the numbers, board
// and sparkline around it stay still, which is the whole point of the screen.
function LiveAgo({ since, stale, online }) {
  const [, force] = useState(0)
  useEffect(() => {
    const id = setInterval(() => force((n) => (n + 1) % 60), 1000)
    return () => clearInterval(id)
  }, [])
  if (!since) return null
  const secs = Math.max(0, Math.round((Date.now() - since) / 1000))
  const ago =
    secs < 60
      ? `${secs}s`
      : secs < 3600
        ? `${Math.floor(secs / 60)}m`
        : `${Math.floor(secs / 3600)}h`
  // Stale = the most recent refetch could not complete, so the data on screen is
  // the last good copy. Say why, calmly — offline is a normal state, not a fault.
  const note = stale ? (online ? ' · reconnecting…' : ' · offline') : ''
  return (
    <span className={d.updated} title="Time since the overview last refreshed">
      <span
        className={`${d.updatedDot} ${stale ? d.updatedDotStale : ''}`}
        aria-hidden="true"
      />
      updated {ago} ago{note}
    </span>
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

const INITIAL = {
  loading: true, // very first load only — a refetch never returns here
  loaded: false, // has the overview ever populated? gates keep-last-good
  error: null, // only ever set on a first load that fully failed the retry ladder
  stale: false, // last refetch could not complete; data on screen is last-good
  lastUpdated: null,
  eventKey: null,
  health: [],
  recent: [],
  counts: { entries: 0, graphs: 0, archives: 0, docs: 0, members: 0, pending: 0 },
  coverage: null,
  activity: [],
  spark: [],
  leaders: [],
  visionCount: 0,
  myEntries: 0,
}

export default function Dashboard() {
  const { atLeast, profile, role } = useAuth()
  // backup_runs is member+ in RLS, so a viewer legitimately reads zero rows.
  // Without this gate an empty result would render as "No backup has ever run",
  // which is alarming, wrong, and unactionable for the person seeing it. Not
  // being allowed to see something is not the same as it not existing.
  const canSeeBackups = atLeast('member')
  const [s, setS] = useState(INITIAL)
  const [manualBusy, setManualBusy] = useState(false)

  // The offline write queue's live view: how many scouting entries are saved on
  // this device but not yet on the server. Read through the shared hook, which
  // subscribes to offlineQueue's change events and seeds from getState(); the
  // count that matters is `pending`. Surfaced below as "nothing is lost".
  const queue = useOfflineQueue()

  // Guards a setState after unmount, and lets any in-flight fetch notice the
  // component is gone and bail before touching state.
  const aliveRef = useRef(true)
  // Have we ever populated? A ref (not just state) so the async loader can read
  // it synchronously, before its setS, to decide between "first-load failure"
  // (retry) and "refetch failure" (keep last-good).
  const loadedRef = useRef(false)
  // The message a fully-failed first load should show, captured from the reads.
  const firstErrorRef = useRef(null)
  // The currently-running first-load retry ladder, so a new one (or unmount) can
  // cancel it and its pending timers.
  const retryRef = useRef({ cancelled: false, timers: [] })

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // One fetch pass. Never throws, never rejects: every read is settled so a
  // single failure can only empty its own widget (first load) or be papered over
  // by the last-good value (refetch). Returns whether the overview is populated,
  // which the retry ladder uses to decide whether to try again.
  const load = useCallback(async () => {
    const eventKey = localStorage.getItem('frc5805.event') || null
    // The signed-in scout's own id, for the personal contribution count. Null
    // before the profile resolves; the query is skipped until then, and load
    // re-runs once it arrives (profile?.id is in the dependency array).
    const scoutId = profile?.id ?? null

    // The six headline/archive counts. head:true returns the count without the
    // rows. Each is caught to null independently, so one failing count degrades
    // only its own tile instead of taking the other five down with it.
    const countReads = [
      supabase.from('scout_entries').select('id', { count: 'exact', head: true }),
      supabase.from('graphs').select('id', { count: 'exact', head: true }),
      supabase.from('code_archives').select('id', { count: 'exact', head: true }),
      supabase.from('knowledge_docs').select('id', { count: 'exact', head: true }),
      supabase.from('profiles').select('id', { count: 'exact', head: true }),
      supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'pending'),
    ].map((q) =>
      Promise.resolve(q)
        .then((r) => (r?.error ? null : (r?.count ?? 0)))
        .catch(() => null)
    )

    // Every read fires concurrently and is settled independently — the old
    // single Promise.all rejected the whole screen if any one read threw.
    const [health, recent, coverage, activity, spark, leaders, vision, mine, counts] =
      await Promise.all([
        settle(canSeeBackups ? backupHealth() : Promise.resolve({ data: [], error: null }), { data: [] }),
        settle(listFiles({ limit: 5 }), { data: [] }),
        settle(
          eventKey
            ? supabase.from('event_scout_coverage').select('*').eq('event_key', eventKey).maybeSingle()
            : Promise.resolve({ data: null }),
          { data: null }
        ),
        settle(
          supabase
            .from('scout_entries')
            .select('team_number, kind, recorded_at')
            .order('recorded_at', { ascending: false })
            .limit(6),
          { data: [] }
        ),
        // Only recorded_at crosses the wire for the 14-day sparkline, capped at
        // 500 rows and bucketed by day in the browser.
        settle(
          supabase
            .from('scout_entries')
            .select('recorded_at')
            .order('recorded_at', { ascending: false })
            .limit(500),
          { data: [] }
        ),
        // Top-team leaderboard for the active event. team_event_stats is member+
        // in RLS, so a viewer — or an event with no match rows yet — legitimately
        // reads nothing, which renders an empty state rather than a crash.
        settle(eventKey ? teamStats(eventKey) : Promise.resolve({ data: [] }), { data: [] }),
        // Vision capture sessions — the active event's, or the most recent across
        // every event when none is selected. Only the count is surfaced.
        settle(listVisionSessions(eventKey || null, 100), { data: [] }),
        // This scout's own lifetime entry count — a small, motivating figure.
        // head-only, and only asked once we know who they are.
        settle(
          scoutId
            ? supabase.from('scout_entries').select('id', { count: 'exact', head: true }).eq('scout_id', scoutId)
            : Promise.resolve({ count: 0 }),
          { count: 0 }
        ),
        Promise.all(countReads),
      ])

    // Unmounted while the requests were in flight — drop the result on the floor
    // rather than setting state on a component that is gone.
    if (!aliveRef.current) return true

    const countsOk = counts.some((v) => v !== null)
    // "Core" = the reads the overview is fundamentally about. leaders/vision/mine
    // are best-effort extras that degrade to empty and never drive staleness or
    // the retry decision, matching the loader's existing hierarchy. coreOk is
    // true if ANY core read landed, so !coreOk means the whole refetch came back
    // empty-handed — the honest "we are not current" (offline / reconnecting)
    // state, as opposed to one secondary widget quietly missing a single beat.
    const coreOk =
      health.ok || recent.ok || coverage.ok || activity.ok || spark.ok || countsOk

    const everLoaded = loadedRef.current
    if (!everLoaded && !coreOk) {
      // Total failure on the very first load. Leave the skeleton up and let the
      // retry ladder try again; only once it is exhausted does an error show.
      firstErrorRef.current =
        health.error ||
        recent.error ||
        coverage.error ||
        activity.error ||
        spark.error ||
        FIRST_LOAD_ERROR
      return false
    }

    loadedRef.current = true
    const stamp = coreOk ? Date.now() : null
    setS((prev) => ({
      loading: false,
      loaded: true,
      error: null,
      // Stale only means something once there is prior data to be stale against;
      // on the first populate it is always false. !coreOk = the refetch refreshed
      // nothing, i.e. the data on screen is now a frozen last-good copy.
      stale: prev.loaded ? !coreOk : false,
      // Only advance the clock when we actually got fresh core data. A refetch
      // that fully failed keeps the old stamp, so "updated Nm ago" keeps honestly
      // counting up instead of resetting to "0s".
      lastUpdated: coreOk ? stamp : prev.lastUpdated,
      eventKey,
      // Each widget takes its fresh value when its read succeeded, otherwise the
      // last-good value (or the initial empty on a first load). This is what
      // keeps a failed read from ever blanking a widget that had data.
      health: health.ok ? (health.value.data ?? []) : prev.health,
      recent: recent.ok ? (recent.value.data ?? []) : prev.recent,
      counts: {
        entries: counts[0] ?? prev.counts.entries,
        graphs: counts[1] ?? prev.counts.graphs,
        archives: counts[2] ?? prev.counts.archives,
        docs: counts[3] ?? prev.counts.docs,
        members: counts[4] ?? prev.counts.members,
        pending: counts[5] ?? prev.counts.pending,
      },
      coverage: coverage.ok ? (coverage.value?.data ?? null) : prev.coverage,
      activity: activity.ok ? (activity.value.data ?? []) : prev.activity,
      spark: spark.ok ? (spark.value.data ?? []) : prev.spark,
      leaders: leaders.ok ? (leaders.value?.data ?? []) : prev.leaders,
      visionCount: vision.ok ? (vision.value?.data ?? []).length : prev.visionCount,
      myEntries: mine.ok ? (mine.value?.count ?? 0) : prev.myEntries,
    }))
    return true
  }, [canSeeBackups, profile?.id])

  // First load, with a short retry ladder. Only a load that has never succeeded
  // walks the ladder; a venue blip on cold start self-heals instead of showing
  // an error. Also serves the ErrorState's "Try again", so a manual retry gets
  // the same resilience the automatic one does.
  const startFirstLoad = useCallback(() => {
    // Cancel any ladder already in flight and adopt a fresh cancellation token.
    retryRef.current.cancelled = true
    retryRef.current.timers.forEach(clearTimeout)
    const token = { cancelled: false, timers: [] }
    retryRef.current = token

    // Show the skeleton only if we have never had data; a re-entry after we are
    // loaded (e.g. profile resolving) must not flash it away.
    setS((prev) => (prev.loaded ? prev : { ...prev, loading: true, error: null }))

    const attempt = async (i) => {
      if (token.cancelled || !aliveRef.current) return
      const ok = await load()
      if (token.cancelled || !aliveRef.current || ok) return
      if (i < RETRY_BACKOFFS_MS.length) {
        token.timers.push(setTimeout(() => attempt(i + 1), RETRY_BACKOFFS_MS[i]))
      } else if (!loadedRef.current) {
        // Ladder exhausted and still nothing — now, and only now, an error.
        setS((prev) =>
          prev.loaded
            ? prev
            : { ...prev, loading: false, error: firstErrorRef.current || FIRST_LOAD_ERROR }
        )
      }
    }
    attempt(0)
  }, [load])

  useEffect(() => {
    startFirstLoad()
    return () => {
      retryRef.current.cancelled = true
      retryRef.current.timers.forEach(clearTimeout)
    }
  }, [startFirstLoad])

  // Auto-refresh — "never drops a beat". Poll while the tab is visible, pause
  // entirely while it is hidden, and refetch the instant it becomes visible or
  // the window regains focus, so returning to the tab is always current. Every
  // timer and listener is torn down on unmount. Keyed on `load` (stable across
  // renders — its deps are primitives), so the interval never re-arms itself on
  // an ordinary render.
  useEffect(() => {
    let interval = null
    const tick = () => {
      if (document.visibilityState === 'visible' && aliveRef.current) load()
    }
    const startPolling = () => {
      if (interval == null) interval = setInterval(tick, POLL_MS)
    }
    const stopPolling = () => {
      if (interval != null) {
        clearInterval(interval)
        interval = null
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (aliveRef.current) load()
        startPolling()
      } else {
        stopPolling()
      }
    }
    const onFocus = () => {
      if (aliveRef.current) load()
    }

    if (document.visibilityState === 'visible') startPolling()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)
    return () => {
      stopPolling()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
    }
  }, [load])

  // Manual refresh. Forces a fetch and spins only its own control — auto-polls
  // stay invisible — while keeping the current data on screen throughout.
  const onRefresh = useCallback(async () => {
    setManualBusy(true)
    try {
      await load()
    } finally {
      if (aliveRef.current) setManualBusy(false)
    }
  }, [load])

  // Skeleton on the very first load only. Once anything has ever loaded, a
  // refetch keeps the screen up (handled in load), so we never return here again.
  if (s.loading) return <Loading rows={6} label="Loading overview" />
  // The full-panel error is reserved for a first load that exhausted its retries.
  // After data has ever loaded, a failure is absorbed as stale, never thrown here.
  if (!s.loaded && s.error) return <ErrorState error={s.error} onRetry={startFirstLoad} />

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
  const queued = queue.pending ?? 0

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
          {/* Live status cluster: when the numbers last refreshed, a manual
              refresh, and the offline-queue trust chip — the screen's proof it
              is current and that nothing has been lost. */}
          <div className={d.liveBar}>
            <LiveAgo since={s.lastUpdated} stale={s.stale} online={queue.online} />
            <button
              type="button"
              className={d.refreshBtn}
              onClick={onRefresh}
              disabled={manualBusy}
              aria-label="Refresh overview"
              title="Refresh now"
            >
              {manualBusy ? (
                <span className={styles.spinnerSm} aria-hidden="true" />
              ) : (
                <RefreshGlyph />
              )}
            </button>
            <SyncBadge />
          </div>
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

      {/* Never losing data: any scouting saved on this device but not yet synced
          is called out plainly and reassuringly. Amber when waiting to sync,
          muted when offline — offline is a safe, normal state, never an error. */}
      {queued > 0 && (
        <div
          className={`${d.saveState} ${queue.online ? d.saveStatePending : d.saveStateOffline}`}
          role="status"
          aria-live="polite"
        >
          <span className={d.saveStateDot} aria-hidden="true" />
          <span className={d.saveStateText}>
            <strong>{queued.toLocaleString()}</strong> scouting{' '}
            {queued === 1 ? 'entry' : 'entries'} saved on this device
            {queue.online
              ? queue.syncing
                ? ', syncing now — nothing is lost.'
                : ', waiting to sync — nothing is lost.'
              : " — they'll sync automatically when you're back online. Nothing is lost."}
          </span>
        </div>
      )}

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
