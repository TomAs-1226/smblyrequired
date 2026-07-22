import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../../Icon'
import {
  activeForm,
  askAi,
  listEntries,
  listEvents,
  listEventTeams,
  syncFromTba,
  teamCollaboration,
  teamPhotos,
  teamStat,
} from '../../../lib/scoutingApi'
import { signedUrl } from '../../../lib/portalApi'
import { Loading, Empty, ErrorState } from '../ui'
import styles from '../Portal.module.css'
import css from './TeamDetail.module.css'

// -----------------------------------------------------------------------------
// Team detail — everything known about ONE team at ONE event, on one screen.
//
// This is the page a strategy lead opens with a specific number in mind: "tell
// me about 4021 before we talk to them." So it is not a browsing surface, it is
// an answer. Every section is built around one discipline that the rest of the
// scouting portal shares and this screen cannot survive without — never letting
// a number look more certain than the sample behind it. A team seen twice does
// not get to look like a team seen fifteen times, the pit guess never blends
// into the match average (migration 0009 fixed exactly that), and a workability
// note nobody has corroborated is withheld rather than shown as a verdict about
// somebody else's students.
//
// Nothing here writes. It reads team_event_stats, scout_entries, robot_photos,
// team_collaboration_summary and the active forms, all through scoutingApi.js,
// and mints signed URLs for photos through portalApi.
// -----------------------------------------------------------------------------

const SEASON = new Date().getFullYear()

// Shared with Scout, Coverage and Compare on purpose: an event picked on any of
// those screens is the one that opens here, and vice versa.
const EVENT_KEY = 'frc5805.event'
// Last-viewed team is remembered PER event — walking back between matches and
// finding the same team still open is most of the value.
const teamStoreKey = (eventKey) => `frc5805.team.${eventKey}`

// Confidence tiers by match sample size. THIN is the migration-0009 / Compare
// floor of 3, below which a spread means nothing; SOLID is where a read stops
// being provisional. The whole point of the header chip is that a 2-match team
// looks visibly less authoritative than a 12-match one, so these drive both the
// wording and the styling.
const THIN_N = 3
const SOLID_N = 12

// Signed URLs are minted once per photo at load. Long enough to sit in an
// alliance-selection meeting with the tab open; short enough that a link is dead
// well before it could be pasted anywhere it should not be.
const PHOTO_TTL = 3600

// Mirrors RobotCapture's capture sequence so photos read in the order they were
// shot rather than alphabetically. An angle the constraint allows but this map
// misses still renders — it falls through to the raw id.
const ANGLE_ORDER = ['front', 'side', 'rear', 'drivetrain', 'intake', 'scoring', 'other']
const ANGLE_LABEL = {
  front: 'Front',
  side: 'Side',
  rear: 'Rear',
  drivetrain: 'Drivetrain',
  intake: 'Intake',
  scoring: 'Scoring',
  other: 'Other',
}

const COMP_LEVEL = { qm: 'Qual', ef: 'Eighth', qf: 'Quarter', sf: 'Semi', f: 'Final' }

// -----------------------------------------------------------------------------
// Deep-link helper.
//
// Portal renders panels as <Panel /> with no props, so another screen cannot
// hand this one a team directly yet. What it CAN do is seed the same localStorage
// this panel reads on mount, then navigate to #/portal/team — the panel opens on
// exactly that team. This is the small export the registration wires deep links
// through; the `teamNumber` prop below is the eventual in-process path for when
// Portal learns to pass it.
// -----------------------------------------------------------------------------
export function rememberDetailTeam(eventKey, teamNumber) {
  try {
    if (eventKey) localStorage.setItem(EVENT_KEY, eventKey)
    if (eventKey && teamNumber != null)
      localStorage.setItem(teamStoreKey(eventKey), String(teamNumber))
  } catch {
    // Private mode or storage disabled: the deep link just won't pre-seed, which
    // is a smaller failure than throwing on the way to another screen.
  }
}

// --- small pure helpers -------------------------------------------------------

// PostgREST hands `numeric` columns back as strings; coerce before any maths so
// avg + stddev never accidentally string-concatenate.
const num = (v) => (v == null || v === '' ? null : Number(v))
const int = (v) => {
  const n = num(v)
  return n == null || Number.isNaN(n) ? 0 : Math.round(n)
}
function f1(n) {
  if (n == null || Number.isNaN(n)) return '—'
  return (Math.round(n * 10) / 10).toString()
}

function prettifyKey(key) {
  return key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

// Renders a single jsonb answer as text. Returns null for "nothing worth a row"
// so blank fields do not pad every entry with empty label/value pairs.
function formatValue(v) {
  if (v == null) return null
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (Array.isArray(v)) return v.length ? v.join(', ') : null
  if (typeof v === 'object') return JSON.stringify(v)
  const s = String(v)
  return s.trim() === '' ? null : s
}

// Turns an entry's `data` into ordered label/value rows. Form order first (so it
// reads like the form the scout filled in), then any keys the active form no
// longer defines — those are flagged `orphan`, because a key with no field is
// data recorded against a form that has since changed.
function entryRows(data, fields) {
  const rows = []
  const seen = new Set()
  for (const field of fields ?? []) {
    if (!field?.key || field.type === 'heading') continue
    if (!(field.key in (data ?? {}))) continue
    const value = formatValue(data[field.key])
    seen.add(field.key)
    if (value == null) continue
    rows.push({ key: field.key, label: field.label ?? prettifyKey(field.key), value })
  }
  for (const key of Object.keys(data ?? {})) {
    if (seen.has(key)) continue
    const value = formatValue(data[key])
    if (value == null) continue
    rows.push({ key, label: prettifyKey(key), value, orphan: true })
  }
  return rows
}

function whenLabel(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function confidenceOf(n) {
  if (!n) return { tier: 'none', label: 'No match data' }
  if (n < THIN_N) return { tier: 'thin', label: 'Thin data' }
  if (n < SOLID_N) return { tier: 'building', label: 'Building' }
  return { tier: 'solid', label: 'Solid sample' }
}

// Plain-language read on spread. Sample SD is null at n<2 (correct — one match
// says nothing about consistency), and that case is reported as such rather than
// as "0 spread". Everything else is a coefficient of variation bucketed into
// words a drive coach can act on.
function consistencyLabel(avg, sd) {
  if (sd == null) return 'need 2+ scored matches to judge consistency'
  if (avg == null || avg === 0) return `±${f1(sd)} spread`
  const cv = sd / Math.abs(avg)
  if (cv < 0.15) return 'very consistent'
  if (cv < 0.3) return 'fairly consistent'
  if (cv < 0.5) return 'inconsistent'
  return 'swings widely'
}

// =============================================================================
// Component
// =============================================================================

export default function TeamDetail({ teamNumber: teamProp = null }) {
  const [events, setEvents] = useState([])
  const [booting, setBooting] = useState(true)
  const [bootError, setBootError] = useState(null)

  const [eventKey, setEventKey] = useState(() => localStorage.getItem(EVENT_KEY) ?? '')
  const [roster, setRoster] = useState([])
  const [forms, setForms] = useState({ match: [], pit: [], strategy: [] })
  const [eventLoading, setEventLoading] = useState(false)
  const [eventError, setEventError] = useState(null)

  const [query, setQuery] = useState('')
  const [team, setTeam] = useState(() => {
    if (teamProp != null) return Number(teamProp)
    const ek = localStorage.getItem(EVENT_KEY) ?? ''
    const saved = ek ? Number(localStorage.getItem(teamStoreKey(ek))) : 0
    return saved || null
  })

  const [detail, setDetail] = useState(null)
  const [teamLoading, setTeamLoading] = useState(false)
  const [teamError, setTeamError] = useState(null)
  const reqRef = useRef(0)

  const [ai, setAi] = useState({ running: false, done: false, error: null, payload: null })
  const [lightbox, setLightbox] = useState(null) // index into ordered photo list

  // --- events (the picker's top select) -------------------------------------
  const loadEvents = useCallback(async () => {
    setBooting(true)
    setBootError(null)
    const { data, error } = await listEvents(SEASON)
    setEvents(data)
    setBootError(data.length ? null : error)
    setBooting(false)
  }, [])

  useEffect(() => {
    loadEvents()
  }, [loadEvents])

  // --- event -> roster + the three active forms -----------------------------
  useEffect(() => {
    if (!eventKey) {
      setRoster([])
      return
    }
    localStorage.setItem(EVENT_KEY, eventKey)
    let alive = true
    setEventLoading(true)
    setEventError(null)
    const season = Number(eventKey.slice(0, 4)) || SEASON
    ;(async () => {
      // The forms are the key->label dictionary for the entries list; the match
      // one matters most but pit and strategy answers get labelled too.
      const [t, mf, pf, sf] = await Promise.all([
        listEventTeams(eventKey),
        activeForm(season, 'match'),
        activeForm(season, 'pit'),
        activeForm(season, 'strategy'),
      ])
      if (!alive) return
      setRoster(t.data)
      setForms({
        match: mf.data?.fields ?? [],
        pit: pf.data?.fields ?? [],
        strategy: sf.data?.fields ?? [],
      })
      setEventError(t.error)
      setEventLoading(false)
    })()
    return () => {
      alive = false
    }
  }, [eventKey])

  // Re-seat the selected team when the event (or the deep-link prop) changes.
  useEffect(() => {
    if (teamProp != null) {
      setTeam(Number(teamProp))
      return
    }
    if (!eventKey) {
      setTeam(null)
      return
    }
    const saved = Number(localStorage.getItem(teamStoreKey(eventKey)))
    setTeam(saved || null)
  }, [eventKey, teamProp])

  useEffect(() => {
    if (eventKey && team) localStorage.setItem(teamStoreKey(eventKey), String(team))
  }, [eventKey, team])

  // --- team -> the whole detail payload -------------------------------------
  const loadTeam = useCallback(async () => {
    if (!eventKey || !team) {
      setDetail(null)
      return
    }
    const req = ++reqRef.current
    setTeamLoading(true)
    setTeamError(null)
    setAi({ running: false, done: false, error: null, payload: null })
    // Close any open lightbox — its index points into the OLD team's photos.
    setLightbox(null)

    const [stat, entries, collab, photos, tba] = await Promise.all([
      teamStat(eventKey, team),
      listEntries({ eventKey, teamNumber: team, limit: 300 }),
      teamCollaboration(eventKey, team),
      teamPhotos(eventKey, team),
      // TBA's official numbers, alongside what the scouts saw. It goes through
      // the edge proxy (the TBA key is server-side), and a failure here — no
      // results yet, key unset, network — must never sink the rest of the page,
      // so it is swallowed to null rather than propagated.
      syncFromTba('team_event_detail', { eventKey, teamNumber: team }).catch(() => ({ data: null })),
    ])
    // A team switched away from mid-flight must not overwrite the new one.
    if (req !== reqRef.current) return

    // Sign each photo. A row whose object was deleted (file null) is dropped
    // rather than rendered as a broken tile.
    const withUrls = await Promise.all(
      (photos.data ?? [])
        .filter((p) => p.file?.bucket && p.file?.path)
        .map(async (p) => {
          const { data: url } = await signedUrl(p.file.bucket, p.file.path, PHOTO_TTL)
          return { ...p, url }
        })
    )
    if (req !== reqRef.current) return

    setDetail({
      stat: stat.data,
      entries: entries.data ?? [],
      collab: collab.data,
      photos: withUrls,
      tba: tba?.data ?? null,
    })
    setTeamError(stat.error ?? entries.error ?? collab.error ?? photos.error ?? null)
    setTeamLoading(false)
  }, [eventKey, team])

  useEffect(() => {
    loadTeam()
  }, [loadTeam])

  // --- derived ---------------------------------------------------------------
  const teamInfo = useMemo(
    () => roster.find((r) => r.team_number === team) ?? null,
    [roster, team]
  )

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q
      ? roster.filter(
          (t) =>
            String(t.team_number).startsWith(q) || (t.nickname ?? '').toLowerCase().includes(q)
        )
      : roster
    return list.slice(0, 60)
  }, [roster, query])

  // Photos grouped into the capture order, plus a flat ordered list so the
  // lightbox can walk prev/next through exactly what the eye sees.
  const photoGroups = useMemo(() => {
    const groups = []
    const byAngle = new Map()
    for (const p of detail?.photos ?? []) {
      const key = p.angle ?? 'other'
      if (!byAngle.has(key)) byAngle.set(key, [])
      byAngle.get(key).push(p)
    }
    const order = [...ANGLE_ORDER, ...[...byAngle.keys()].filter((k) => !ANGLE_ORDER.includes(k))]
    for (const angle of order) {
      const list = byAngle.get(angle)
      if (list?.length) groups.push({ angle, label: ANGLE_LABEL[angle] ?? prettifyKey(angle), list })
    }
    return groups
  }, [detail])

  const flatPhotos = useMemo(() => photoGroups.flatMap((g) => g.list), [photoGroups])

  const runAi = useCallback(async () => {
    if (!eventKey || !team) return
    setAi({ running: true, done: false, error: null, payload: null })
    const res = await askAi('scouting_summary', { eventKey, teamNumber: team })
    // Two envelopes: askAi returns invoke()'s parsed body without unwrapping the
    // edge function's own { data, error }, so the summary sits at res.data.data.
    const payload = res.data?.data ?? res.data
    setAi({ running: false, done: true, error: res.error ?? null, payload: payload ?? null })
  }, [eventKey, team])

  // --- render ----------------------------------------------------------------
  if (booting) return <Loading rows={3} label="Loading events" />
  if (bootError && !events.length) return <ErrorState error={bootError} onRetry={loadEvents} />

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
          Nothing to look up until someone pulls the schedule from The Blue Alliance — a lead can do
          that from the Scout tab.
        </Empty>
      ) : !eventKey ? (
        <Empty icon="flag" title="Pick an event first">
          A team's record is always within one event. Their average at a week-1 regional and at
          champs are different robots with the same number.
        </Empty>
      ) : eventLoading ? (
        <Loading rows={5} label="Loading teams" />
      ) : eventError && !roster.length ? (
        <ErrorState error={eventError} onRetry={() => setEventKey(eventKey)} />
      ) : !roster.length ? (
        <Empty icon="users" title="No teams cached for this event">
          Pull the team list from The Blue Alliance on the Scout tab first — ideally before you lose
          signal at the venue.
        </Empty>
      ) : (
        <>
          <Picker results={results} query={query} onQuery={setQuery} team={team} onPick={setTeam} />

          {!team ? (
            <Empty icon="search" title="Pick a team">
              Search by number or name above. Everything we know about them at this event lands on
              one screen.
            </Empty>
          ) : teamLoading ? (
            <Loading rows={6} label="Loading the team" />
          ) : teamError && !detail ? (
            <ErrorState error={teamError} onRetry={loadTeam} />
          ) : (
            detail && (
              <>
                <Header team={team} info={teamInfo} stat={detail.stat} />
                <Performance stat={detail.stat} />
                <OfficialNumbers tba={detail.tba} />
                <Entries entries={detail.entries} forms={forms} />
                <Photos
                  groups={photoGroups}
                  flat={flatPhotos}
                  onOpen={(i) => setLightbox(i)}
                />
                <Workability collab={detail.collab} team={team} />
                <AiNote ai={ai} onRun={runAi} />
              </>
            )
          )}
        </>
      )}

      {lightbox != null && flatPhotos[lightbox] && (
        <Lightbox
          photos={flatPhotos}
          index={lightbox}
          onIndex={setLightbox}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  )
}

// =============================================================================
// Picker
// =============================================================================

function Picker({ results, query, onQuery, team, onPick }) {
  return (
    <section>
      <h2 className={styles.sectionTitle}>Team</h2>
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

      <ul className={css.pickList}>
        {results.map((t) => {
          const on = t.team_number === team
          return (
            <li key={t.team_number}>
              <button
                type="button"
                className={`${css.pickBtn} ${on ? css.pickOn : ''}`}
                aria-pressed={on}
                onClick={() => onPick(t.team_number)}
              >
                <span className={css.pickNum}>{t.team_number}</span>
                <span className={css.pickName}>{t.nickname ?? '—'}</span>
                <Icon name={on ? 'check' : 'arrowRight'} size={15} className={css.pickIcon} />
              </button>
            </li>
          )
        })}
        {!results.length && <li className={css.note}>No team matches “{query}”.</li>}
      </ul>
    </section>
  )
}

// =============================================================================
// Header — identity + confidence
// =============================================================================

function Header({ team, info, stat }) {
  const matches = int(stat?.matches_scouted)
  const scored = int(stat?.scored_matches)
  const conf = confidenceOf(matches)
  const place = [info?.city, info?.state_prov].filter(Boolean).join(', ')

  return (
    <header className={css.head}>
      <div className={css.headMain}>
        <div className={css.identity}>
          <span className={css.teamNum}>{team}</span>
          <div className={css.identityText}>
            <h2 className={css.teamNick}>{info?.nickname || 'Unnamed team'}</h2>
            {(place || info?.rookie_year) && (
              <p className={css.teamSub}>
                {place}
                {place && info?.rookie_year ? ' · ' : ''}
                {info?.rookie_year ? `rookie ${info.rookie_year}` : ''}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className={css.headMeta}>
        <span className={`${css.conf} ${css[`conf_${conf.tier}`]}`}>
          <span className={css.confDot} aria-hidden="true" />
          {conf.label}
        </span>
        <span className={css.matchCount}>
          <strong>{matches}</strong> {matches === 1 ? 'match' : 'matches'} scouted
          {matches > 0 && scored !== matches && (
            <span className={css.matchScored}>· {scored} scored</span>
          )}
        </span>
      </div>
    </header>
  )
}

// =============================================================================
// Official numbers — The Blue Alliance, next to what the scouts saw
//
// These are the field's own record: component estimates (OPR/DPR/CCWM), the
// event ranking, the W-L record, and match outcomes. They are the counterweight
// to human scouting — where TBA and your scouts disagree is exactly the
// conversation worth having. Renders nothing at all before an event has results,
// rather than a row of dashes, because "no official data yet" is not a finding.
// =============================================================================

function OfficialNumbers({ tba }) {
  if (!tba) return null
  const hasComponents = tba.opr != null || tba.rank != null || tba.record
  const matches = tba.matches ?? []
  if (!hasComponents && matches.length === 0) return null

  return (
    <section>
      <h2 className={styles.sectionTitle}>
        Official — The Blue Alliance
        <span className={css.tbaHint}>the field's own record</span>
      </h2>

      {hasComponents && (
        <div className={styles.statGrid}>
          {tba.rank != null && (
            <div className={styles.stat}>
              <span className={styles.statLabel}>Event rank</span>
              <span className={styles.statValue}>
                #{tba.rank}
                {tba.total_ranked && <span className={styles.statUnit}>of {tba.total_ranked}</span>}
              </span>
            </div>
          )}
          {tba.record && (
            <div className={styles.stat}>
              <span className={styles.statLabel}>Record</span>
              <span className={styles.statValue}>{tba.record}</span>
            </div>
          )}
          {tba.opr != null && (
            <div className={styles.stat}>
              <span className={styles.statLabel}>OPR</span>
              <span className={styles.statValue}>{tba.opr.toFixed(1)}</span>
            </div>
          )}
          {tba.dpr != null && (
            <div className={styles.stat}>
              <span className={styles.statLabel}>DPR</span>
              <span className={styles.statValue}>{tba.dpr.toFixed(1)}</span>
            </div>
          )}
          {tba.ccwm != null && (
            <div className={styles.stat}>
              <span className={styles.statLabel}>CCWM</span>
              <span className={styles.statValue}>{tba.ccwm.toFixed(1)}</span>
            </div>
          )}
        </div>
      )}

      {/* OPR is a least-squares ESTIMATE of contribution, not a measurement —
          labelled so nobody reads it as ground truth next to scouted numbers. */}
      {tba.opr != null && (
        <p className={css.tbaNote}>
          OPR/DPR/CCWM are alliance-wide statistical estimates, not per-robot measurements — use
          them to sanity-check scouting, not replace it.
        </p>
      )}

      {matches.length > 0 && (
        <ul className={css.tbaMatches}>
          {matches.map((m) => (
            <li key={m.key} className={css.tbaMatch}>
              <span className={css.tbaMatchLabel}>{m.label}</span>
              <span className={`${css.tbaAlliance} ${css[`tbaAlliance_${m.alliance}`] ?? ''}`}>
                {m.alliance}
              </span>
              <span className={css.tbaScore}>
                {m.us_score != null ? `${m.us_score}–${m.them_score}` : 'TBD'}
              </span>
              {m.outcome && (
                <span className={`${css.tbaOutcome} ${css[`tbaOutcome_${m.outcome}`] ?? ''}`}>
                  {m.outcome}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// =============================================================================
// Performance — match play only, pit estimate kept firmly apart
// =============================================================================

function Performance({ stat }) {
  const matches = int(stat?.matches_scouted)
  const conf = confidenceOf(matches)
  const provisional = conf.tier === 'thin' || conf.tier === 'none'

  if (!stat || matches === 0) {
    // A pit estimate can exist before a team has played a scouted match, so the
    // section is not empty just because there is no match average yet.
    const pit = num(stat?.pit_estimate)
    return (
      <section>
        <h2 className={styles.sectionTitle}>Performance</h2>
        {pit != null ? (
          <>
            <p className={css.caption}>
              No match play scouted yet. The pit estimate below is a guess from talking to them, not
              observed play — kept separate on purpose.
            </p>
            <div className={styles.statGrid}>
              <PitTile pit={pit} visits={int(stat?.pit_visits)} />
            </div>
          </>
        ) : (
          <p className={css.caption}>Nobody has scouted a match or visited the pit for this team yet.</p>
        )}
      </section>
    )
  }

  const avg = num(stat.avg_score)
  const sd = num(stat.score_stddev)
  const min = num(stat.min_score)
  const max = num(stat.max_score)
  const pit = num(stat.pit_estimate)

  return (
    <section>
      <h2 className={styles.sectionTitle}>Performance</h2>

      {provisional && (
        <p className={`${css.caption} ${css.captionThin}`}>
          <Icon name="alert" size={14} />
          {matches < THIN_N
            ? `Only ${matches} match${matches === 1 ? '' : 'es'} scouted — treat this as a first impression, not a ranking.`
            : 'A partial sample. Enough for a picture, not enough to bet an alliance on.'}
        </p>
      )}

      <div className={`${styles.statGrid} ${provisional ? css.provisional : ''}`}>
        <div className={styles.stat}>
          <span className={styles.statLabel}>Avg match score</span>
          <span className={styles.statValue}>{f1(avg)}</span>
          <span className={css.statSub}>
            {sd != null ? `±${f1(sd)} — ` : ''}
            {consistencyLabel(avg, sd)}
          </span>
        </div>

        <div className={styles.stat}>
          <span className={styles.statLabel}>Range seen</span>
          <span className={styles.statValue}>
            {min == null && max == null ? (
              '—'
            ) : (
              <>
                {f1(min)}
                <span className={styles.statUnit}>–{f1(max)}</span>
              </>
            )}
          </span>
          <span className={css.statSub}>lowest to highest scored — context, not a rating</span>
        </div>

        <div className={`${styles.stat} ${int(stat.breakdowns) > 0 ? css.statBad : ''}`}>
          <span className={styles.statLabel}>Breakdowns</span>
          <span className={styles.statValue}>{int(stat.breakdowns)}</span>
          <span className={css.statSub}>matches scouted as broken</span>
        </div>

        <div className={`${styles.stat} ${int(stat.no_shows) > 0 ? css.statBad : ''}`}>
          <span className={styles.statLabel}>No-shows</span>
          <span className={styles.statValue}>{int(stat.no_shows)}</span>
          <span className={css.statSub}>matches they did not appear for</span>
        </div>
      </div>

      {/* Pit estimate, walled off in its own block. Merging it into the average
          above is the exact bug migration 0009 unpicked, so it is labelled as a
          different measurement and never shares a tile with match play. */}
      {pit != null && (
        <div className={css.pitBlock}>
          <div className={styles.statGrid}>
            <PitTile pit={pit} visits={int(stat.pit_visits)} />
          </div>
        </div>
      )}
    </section>
  )
}

function PitTile({ pit, visits }) {
  return (
    <div className={`${styles.stat} ${css.pitTile}`}>
      <span className={styles.statLabel}>Pit estimate</span>
      <span className={styles.statValue}>{f1(pit)}</span>
      <span className={css.statSub}>
        a guess from the pit{visits ? ` · ${visits} visit${visits === 1 ? '' : 's'}` : ''} — not
        observed match play
      </span>
    </div>
  )
}

// =============================================================================
// Entries — every pass, chronological, dynamic fields labelled by the form
// =============================================================================

function Entries({ entries, forms }) {
  if (!entries.length) {
    return (
      <section>
        <h2 className={styles.sectionTitle}>Scouting entries</h2>
        <p className={css.caption}>No entries recorded for this team yet.</p>
      </section>
    )
  }

  return (
    <section>
      <h2 className={styles.sectionTitle}>
        Scouting entries
        <span className={styles.countBadge}>{entries.length}</span>
      </h2>
      <ul className={css.entryList}>
        {entries.map((e, i) => (
          <EntryCard key={e.id ?? e.client_uuid ?? i} entry={e} fields={forms[e.kind] ?? []} index={i} />
        ))}
      </ul>
    </section>
  )
}

function EntryCard({ entry, fields, index }) {
  const rows = useMemo(() => entryRows(entry.data, fields), [entry.data, fields])
  const when = whenLabel(entry.recorded_at)
  const isMatch = entry.kind === 'match'
  const matchLabel = isMatch
    ? `${COMP_LEVEL[entry.comp_level] ?? entry.comp_level ?? ''} ${entry.match_number ?? ''}`.trim()
    : null

  return (
    <li className={css.entry} style={{ '--i': Math.min(index, 8) }}>
      <div className={css.entryHead}>
        <span className={`${css.kindTag} ${css[`kind_${entry.kind}`] ?? ''}`}>{entry.kind}</span>
        {matchLabel && <span className={css.matchTag}>{matchLabel}</span>}
        {isMatch && entry.alliance && (
          <span className={`${css.alliance} ${css[`alliance_${entry.alliance}`] ?? ''}`}>
            {entry.alliance}
          </span>
        )}
        {when && <span className={css.entryWhen}>{when}</span>}
      </div>

      {rows.length > 0 && (
        <dl className={css.dataGrid}>
          {rows.map((r) => (
            <div key={r.key} className={css.dataRow}>
              <dt className={`${css.dataKey} ${r.orphan ? css.dataKeyOrphan : ''}`}>
                {r.label}
                {r.orphan && <span className="sr-only"> (field no longer on the active form)</span>}
              </dt>
              <dd className={css.dataVal}>{r.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {entry.notes && (
        <p className={css.notes}>
          <span className={css.notesLabel}>Notes</span>
          {entry.notes}
        </p>
      )}

      {rows.length === 0 && !entry.notes && <p className={css.emptyData}>No fields recorded.</p>}
    </li>
  )
}

// =============================================================================
// Photos — grouped by angle, click to enlarge
// =============================================================================

function Photos({ groups, flat, onOpen }) {
  return (
    <section>
      <h2 className={styles.sectionTitle}>
        Robot photos
        {flat.length > 0 && <span className={styles.countBadge}>{flat.length}</span>}
      </h2>

      {!flat.length ? (
        <p className={css.caption}>
          No robot photos yet. Capture them from the pit-scouting flow on the Scout tab.
        </p>
      ) : (
        <div className={css.angleGroups}>
          {groups.map((g) => (
            <div key={g.angle} className={css.angleGroup}>
              <span className={css.angleLabel}>{g.label}</span>
              <ul className={css.thumbGrid}>
                {g.list.map((p) => {
                  const flatIndex = flat.indexOf(p)
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        className={css.thumb}
                        onClick={() => onOpen(flatIndex)}
                        aria-label={`Enlarge ${g.label} photo`}
                      >
                        {p.url ? (
                          <img
                            className={css.thumbImg}
                            src={p.url}
                            alt={`${g.label} view of the robot`}
                            loading="lazy"
                          />
                        ) : (
                          <span className={css.thumbBad} aria-hidden="true">
                            <Icon name="alert" size={18} />
                          </span>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

// A focused lightbox: the modal obligations FileViewer handles once (Escape, a
// locked page, focus returned on the way out) plus arrow-key paging across the
// gallery, kept light because there is no toolbar to trap here.
function Lightbox({ photos, index, onIndex, onClose }) {
  const photo = photos[index]
  const closeRef = useRef(null)
  const lastFocused = useRef(null)
  const hasMany = photos.length > 1

  const go = useCallback(
    (delta) => onIndex((index + delta + photos.length) % photos.length),
    [index, photos.length, onIndex]
  )

  useEffect(() => {
    lastFocused.current = document.activeElement
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'ArrowRight' && hasMany) {
        e.preventDefault()
        go(1)
      } else if (e.key === 'ArrowLeft' && hasMany) {
        e.preventDefault()
        go(-1)
      }
    }
    document.addEventListener('keydown', onKey)
    const raf = requestAnimationFrame(() => closeRef.current?.focus())

    return () => {
      document.removeEventListener('keydown', onKey)
      cancelAnimationFrame(raf)
      document.body.style.overflow = prevOverflow
      const prev = lastFocused.current
      if (prev && typeof prev.focus === 'function' && document.contains(prev)) prev.focus()
    }
  }, [onClose, go, hasMany])

  const label = ANGLE_LABEL[photo.angle] ?? prettifyKey(photo.angle ?? 'photo')
  const when = whenLabel(photo.created_at)

  return (
    <div className={css.lbOverlay} role="dialog" aria-modal="true" aria-label={`${label} photo`}>
      <div className={css.lbBackdrop} onClick={onClose} aria-hidden="true" data-lenis-prevent />

      <div className={css.lbDialog}>
        <header className={css.lbBar}>
          <span className={css.lbCaption}>
            {label}
            {when ? ` · ${when}` : ''}
            {hasMany ? ` · ${index + 1}/${photos.length}` : ''}
          </span>
          <button type="button" className={css.lbClose} onClick={onClose} ref={closeRef}>
            <Icon name="close" size={18} />
            <span className="sr-only">Close photo</span>
          </button>
        </header>

        <div className={css.lbStage}>
          {photo.url ? (
            <img className={css.lbImg} src={photo.url} alt={`${label} view of the robot`} />
          ) : (
            <p className={css.lbBadText}>That photo could not be loaded.</p>
          )}

          {hasMany && (
            <>
              <button
                type="button"
                className={`${css.lbNav} ${css.lbPrev}`}
                onClick={() => go(-1)}
                aria-label="Previous photo"
              >
                <Icon name="arrowLeft" size={22} />
              </button>
              <button
                type="button"
                className={`${css.lbNav} ${css.lbNext}`}
                onClick={() => go(1)}
                aria-label="Next photo"
              >
                <Icon name="arrowRight" size={22} />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// =============================================================================
// Workability — corroborated collaboration signal only
// =============================================================================

function Workability({ collab, team }) {
  const observers = int(collab?.observers)
  // The view nulls `workability` until two independent observers agree. Below
  // that floor we show nothing quantitative — a single opinion about another
  // school's students is precisely what migration 0008 refuses to surface.
  const corroborated = collab && observers >= 2 && collab.workability != null

  return (
    <section>
      <h2 className={styles.sectionTitle}>Workability</h2>

      {!corroborated ? (
        <p className={css.caption}>
          {observers === 1
            ? 'Only one person has logged an impression of this team. Not enough observations yet — '
            : 'No corroborated observations yet — '}
          it takes two independent observers before an average is shown, so a single interaction
          cannot stand in for a pattern.
        </p>
      ) : (
        <>
          <p className={css.caption}>
            From {observers} observers. This describes observed interaction with team {team}, not the
            people — read it as what to plan around.
          </p>
          <div className={styles.statGrid}>
            <div className={styles.stat}>
              <span className={styles.statLabel}>Communication</span>
              <span className={styles.statValue}>
                {f1(num(collab.avg_communication))}
                <span className={styles.statUnit}>/5</span>
              </span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>Coordination</span>
              <span className={styles.statValue}>
                {f1(num(collab.avg_coordination))}
                <span className={styles.statUnit}>/5</span>
              </span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>Would partner</span>
              <span className={styles.statValue}>
                {int(collab.would_partner)}
                <span className={styles.statUnit}>yes</span>
              </span>
              <span className={css.statSub}>
                {int(collab.would_not_partner)} said no · {observers} observers
              </span>
            </div>
          </div>
        </>
      )}
    </section>
  )
}

// =============================================================================
// AI note — optional, never load-bearing
// =============================================================================

function AiNote({ ai, onRun }) {
  const summary = ai.payload?.summary
  const unavailable = ai.done && (ai.error || !summary)

  return (
    <section className={css.aiBlock}>
      <h2 className={styles.sectionTitle}>Written summary</h2>

      <div className={css.aiBar}>
        <button
          type="button"
          className={`btn btn--cyan ${css.aiBtn}`}
          onClick={onRun}
          disabled={ai.running}
        >
          {ai.running ? (
            <span className={styles.spinnerSm} aria-hidden="true" />
          ) : (
            <Icon name="spark" size={16} />
          )}
          {ai.running ? 'Asking…' : ai.done ? 'Rewrite it' : 'Write it up'}
        </button>
        <span className={css.note}>Optional. Everything above is complete without it.</span>
      </div>

      {unavailable && (
        // Not an error state. A missing OPENAI_API_KEY must read as "one optional
        // extra is off", never as "this screen is broken". Whatever message did
        // arrive is shown quietly underneath rather than dressed up as a cause.
        <p className={css.aiOff}>
          <Icon name="alert" size={14} />
          AI summary unavailable.
          {ai.error && <span className={css.aiWhy}>{String(ai.error)}</span>}
        </p>
      )}

      {ai.done && summary && (
        <article className={css.aiCard}>
          {/* Verbatim. The prompt is built around forcing the model to lead with
              its sample size; re-phrasing it here would delete that. */}
          <p className={css.aiText}>{summary}</p>
          <p className={css.aiFoot}>
            {ai.payload?.model
              ? `${ai.payload.model} · generated, not verified — check it against the numbers above.`
              : 'No model was called: there was no data to summarise.'}
          </p>
        </article>
      )}
    </section>
  )
}
