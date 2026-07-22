import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../../Icon'
import { teamStats, listEntries, listEventTeams } from '../../../lib/scoutingApi'
import { statboticsEvent } from '../../../lib/statbotics'
import { buildCatalyst, insights, predictMatch } from '../../../lib/catalyst'
import { Loading, ErrorState, Empty } from '../ui'
import { navigate } from '../../../lib/router'
import portal from '../Portal.module.css'
import styles from './Analytics.module.css'

// =============================================================================
// Analytics — the Catalyst engine, on screen.
//
// The strategy lead's home base: power rankings computed from your own scouting,
// a few one-line reads, and a match predictor. Everything here is derived in
// lib/catalyst.js from data this page also shows, so nothing is a black box —
// which is the whole point, because these numbers get argued over in an alliance
// meeting and have to survive the argument.
//
// Statbotics EPA rides along as an OPTIONAL external check (lib/statbotics.js):
// when their service answers, an EPA column appears next to Catalyst Rating so
// the two can be compared; when it does not, the page is exactly as complete
// without it. We never block on someone else's uptime.
// =============================================================================

const fmt = (n, dash = '—') => (n == null ? dash : n)
const signed = (n) => (n == null ? '' : n > 0 ? `+${n}` : `${n}`)

export default function Analytics() {
  const [eventKey] = useState(() => localStorage.getItem('frc5805.event') || '')
  const [state, setState] = useState({ loading: true, error: null })
  const [epa, setEpa] = useState(null) // team_number -> epa number, or null while unknown
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const load = useCallback(async () => {
    if (!eventKey) {
      setState({ loading: false, error: null, cat: null })
      return
    }
    setState((p) => ({ ...p, loading: true, error: null }))
    const [stats, entries, teams] = await Promise.all([
      teamStats(eventKey),
      listEntries({ eventKey, kind: 'match', limit: 4000 }),
      listEventTeams(eventKey).catch(() => ({ data: [] })),
    ])
    if (!aliveRef.current) return
    if (stats.error) {
      setState({ loading: false, error: stats.error, cat: null })
      return
    }
    const nick = new Map((teams.data ?? []).map((t) => [t.team_number, t.nickname]))
    const cat = buildCatalyst({ stats: stats.data ?? [], entries: entries.data ?? [] })
    setState({ loading: false, error: null, cat, nick, ins: insights(cat) })
  }, [eventKey])

  useEffect(() => {
    load()
  }, [load])

  // Statbotics enrichment — one batched call for the whole event, entirely
  // best-effort. It resolves to a map only if their service answered; otherwise
  // it stays null and nothing about the page depends on it.
  useEffect(() => {
    if (!eventKey) return
    let cancelled = false
    ;(async () => {
      const { data } = await statboticsEvent(eventKey)
      if (!cancelled && aliveRef.current && data) setEpa(data)
    })()
    return () => {
      cancelled = true
    }
  }, [eventKey])

  if (!eventKey) {
    return (
      <Empty icon="compass" title="No active event yet">
        Pick an event in Scout and Catalyst will rank every team on it from your scouting.
        <div className={styles.emptyAction}>
          <button type="button" className="btn btn--cyan" onClick={() => navigate('/portal/scout')}>
            Go to Scout
          </button>
        </div>
      </Empty>
    )
  }
  if (state.loading) return <Loading rows={6} label="Running Catalyst" />
  if (state.error) return <ErrorState error={state.error} onRetry={load} />

  const cat = state.cat
  const rated = cat.teams.filter((t) => t.cr != null)

  if (!rated.length) {
    return (
      <Empty icon="compass" title={`No match data yet for ${eventKey}`}>
        Catalyst ranks teams once matches are scouted. Record a few and the board fills in.
      </Empty>
    )
  }

  return (
    <div className={portal.stack}>
      <Header eventKey={eventKey} count={rated.length} base={cat.base} hasEpa={!!epa} onRefresh={load} />
      <InsightStrip ins={state.ins} nick={state.nick} />
      <PowerRankings teams={cat.teams} nick={state.nick} epa={epa} base={cat.base} />
      <Predictor teams={cat.teams} base={cat.base} nick={state.nick} />
      <p className={styles.method}>
        <Icon name="compass" size={14} />
        <span>
          <strong>Catalyst Rating (CR)</strong> is shrinkage-adjusted expected points: a team's own
          average is pulled toward the field mean ({cat.base.mean.toFixed(1)}) until it has enough
          matches to stand on, so one fluke game can't top the board. <strong>Δ</strong> is points
          above or below the field. Everything is computed from your scouting
          {epa ? '; EPA is Statbotics, shown for comparison.' : '.'}
        </span>
      </p>
    </div>
  )
}

function Header({ eventKey, count, base, hasEpa, onRefresh }) {
  return (
    <header className={styles.hero}>
      <div className={styles.heroMain}>
        <span className={styles.heroEyebrow}>
          <span className={styles.heroDot} aria-hidden="true" />
          Catalyst engine
        </span>
        <h2 className={styles.heroTitle}>Power rankings</h2>
        <p className={styles.heroSub}>
          <code className={styles.heroEvent}>{eventKey}</code>
          {count} teams rated · field average {base.mean.toFixed(1)} pts
          {hasEpa && <span className={styles.epaTag}>+ Statbotics EPA</span>}
        </p>
      </div>
      <button type="button" className={styles.refresh} onClick={onRefresh}>
        <Icon name="arrowUp" size={15} />
        Recompute
      </button>
    </header>
  )
}

function InsightStrip({ ins, nick }) {
  if (!ins) return null
  const name = (t) => (t && nick?.get(t.team_number)) || ''
  const cards = [
    ins.topRated && { icon: 'medal', label: 'Top rated', team: ins.topRated, tone: 'gold', value: `${ins.topRated.cr} CR` },
    ins.mostConsistent && {
      icon: 'check',
      label: 'Most consistent',
      team: ins.mostConsistent,
      tone: 'data',
      value: `${ins.mostConsistent.consistency}%`,
    },
    ins.biggestRiser && {
      icon: 'arrowUp',
      label: 'Biggest riser',
      team: ins.biggestRiser,
      tone: 'success',
      value: `${signed(ins.biggestRiser.trend.delta)} pts`,
    },
    ins.sleeper && { icon: 'spark', label: 'Sleeper (ceiling)', team: ins.sleeper, tone: 'data', value: `${ins.sleeper.ceiling} max` },
  ].filter(Boolean)
  if (!cards.length) return null

  return (
    <div className={styles.insights}>
      {cards.map((c) => (
        <div key={c.label} className={`${styles.insight} ${styles[`tone_${c.tone}`]}`}>
          <span className={styles.insightIcon} aria-hidden="true">
            <Icon name={c.icon} size={16} />
          </span>
          <span className={styles.insightLabel}>{c.label}</span>
          <span className={styles.insightTeam}>
            {c.team.team_number}
            {name(c.team) && <span className={styles.insightNick}>{name(c.team)}</span>}
          </span>
          <span className={styles.insightValue}>{c.value}</span>
        </div>
      ))}
    </div>
  )
}

function PowerRankings({ teams, nick, epa, base }) {
  const maxCr = Math.max(1, ...teams.filter((t) => t.cr != null).map((t) => t.cr))
  return (
    <section>
      <h3 className={portal.sectionTitle}>
        <Icon name="trophy" size={15} />
        Rankings
      </h3>
      <div className={styles.board}>
        <div className={`${styles.boardRow} ${styles.boardHead}`} aria-hidden="true">
          <span>#</span>
          <span>Team</span>
          <span className={styles.colCr}>CR</span>
          <span className={styles.colTrend}>Trend</span>
          <span className={styles.colCons}>Consistency</span>
          {epa && <span className={styles.colEpa}>EPA</span>}
        </div>
        <ul className={styles.boardList}>
          {teams.map((t, i) => (
            <RankRow
              key={t.team_number}
              t={t}
              i={i}
              nick={nick?.get(t.team_number)}
              maxCr={maxCr}
              epaOn={!!epa}
              epaVal={epa?.[t.team_number] ?? null}
              base={base}
            />
          ))}
        </ul>
      </div>
    </section>
  )
}

function RankRow({ t, i, nick, maxCr, epaOn, epaVal, base }) {
  const unrated = t.cr == null
  const pct = unrated ? 0 : Math.round((t.cr / maxCr) * 100)
  const podium = t.rank === 1 ? styles.rank1 : t.rank === 2 ? styles.rank2 : t.rank === 3 ? styles.rank3 : ''
  return (
    <li className={styles.rankRow} style={{ '--i': Math.min(i, 10) }}>
      <span className={`${styles.rankNum} ${podium}`}>{unrated ? '—' : t.rank}</span>

      <span className={styles.teamCell}>
        <span className={styles.teamNum}>{t.team_number}</span>
        {nick && <span className={styles.teamNick}>{nick}</span>}
        <span className={`${styles.conf} ${styles[`conf_${t.confidence}`]}`}>
          {t.samples} {t.samples === 1 ? 'match' : 'matches'}
        </span>
      </span>

      <span className={styles.colCr}>
        <span className={styles.crValue}>{fmt(t.cr)}</span>
        {t.crDelta != null && (
          <span className={`${styles.crDelta} ${t.crDelta >= 0 ? styles.up : styles.down}`}>
            {signed(t.crDelta)}
          </span>
        )}
        <span className={styles.crBar} aria-hidden="true">
          <span className={styles.crBarFill} style={{ '--w': `${pct}%` }} />
        </span>
      </span>

      <span className={styles.colTrend}>
        <TrendGlyph trend={t.trend} />
        <Spark points={t.trend.points} />
      </span>

      <span className={styles.colCons}>
        {t.consistency == null ? (
          <span className={styles.dim}>—</span>
        ) : (
          <>
            <span className={styles.consBar} aria-hidden="true">
              <span className={styles.consFill} style={{ '--w': `${t.consistency}%` }} />
            </span>
            <span className={styles.consPct}>{t.consistency}%</span>
          </>
        )}
      </span>

      {epaOn && (
        <span className={styles.colEpa}>
          {epaVal == null ? (
            <span className={styles.dim}>—</span>
          ) : (
            <span className={styles.epaVal}>{Math.round(epaVal)}</span>
          )}
        </span>
      )}
    </li>
  )
}

function TrendGlyph({ trend }) {
  if (!trend.enough) return <span className={`${styles.trendChip} ${styles.trendFlat}`}>·</span>
  const cls = trend.dir === 'up' ? styles.trendUp : trend.dir === 'down' ? styles.trendDown : styles.trendFlat
  const arrow = trend.dir === 'up' ? '↑' : trend.dir === 'down' ? '↓' : '→'
  return (
    <span className={`${styles.trendChip} ${cls}`} title={`${signed(trend.delta)} pts recent vs early`}>
      {arrow} {trend.enough ? Math.abs(trend.delta) : ''}
    </span>
  )
}

// A tiny inline score trace — no library, just a path. Purely a texture on the
// row that says "here is their shape", not a chart to read precisely.
function Spark({ points }) {
  const d = useMemo(() => {
    if (!points || points.length < 2) return null
    const W = 52
    const H = 18
    const min = Math.min(...points)
    const max = Math.max(...points)
    const span = max - min || 1
    return points
      .map((p, i) => {
        const x = (i / (points.length - 1)) * W
        const y = H - ((p - min) / span) * H
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')
  }, [points])
  if (!d) return <span className={styles.sparkGap} aria-hidden="true" />
  return (
    <svg className={styles.spark} viewBox="0 0 52 18" preserveAspectRatio="none" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

function Predictor({ teams, base, nick }) {
  const crOf = useMemo(() => new Map(teams.map((t) => [String(t.team_number), t.cr])), [teams])
  const [red, setRed] = useState(['', '', ''])
  const [blue, setBlue] = useState(['', '', ''])

  const lookup = (arr) => arr.map((n) => (n.trim() ? crOf.get(n.trim()) ?? null : undefined)).filter((v) => v !== undefined)
  const redCRs = lookup(red)
  const blueCRs = lookup(blue)
  const ready = redCRs.length + blueCRs.length >= 2
  const result = ready ? predictMatch(redCRs, blueCRs, base) : null

  const setSlot = (side, idx) => (e) => {
    const v = e.target.value.replace(/[^0-9]/g, '')
    if (side === 'red') setRed((r) => r.map((x, i) => (i === idx ? v : x)))
    else setBlue((b) => b.map((x, i) => (i === idx ? v : x)))
  }

  return (
    <section>
      <h3 className={portal.sectionTitle}>
        <Icon name="spark" size={15} />
        Match predictor
      </h3>
      <div className={styles.predict}>
        <div className={styles.alliances}>
          <AllianceInput side="red" values={red} onChange={setSlot} nick={nick} crOf={crOf} />
          <span className={styles.vs}>vs</span>
          <AllianceInput side="blue" values={blue} onChange={setSlot} nick={nick} crOf={crOf} />
        </div>

        {result ? (
          <div className={styles.prediction}>
            <div className={styles.predScores}>
              <span className={styles.predRed}>{result.red}</span>
              <span className={styles.predMid}>projected</span>
              <span className={styles.predBlue}>{result.blue}</span>
            </div>
            <div className={styles.winBar} role="img" aria-label={`Red ${result.redWinProb}% to win`}>
              <span className={styles.winRed} style={{ '--w': `${result.redWinProb}%` }}>
                {result.redWinProb >= 18 && `${result.redWinProb}%`}
              </span>
              <span className={styles.winBlue} style={{ '--w': `${result.blueWinProb}%` }}>
                {result.blueWinProb >= 18 && `${result.blueWinProb}%`}
              </span>
            </div>
            <p className={styles.predNote}>
              Win probability from summed Catalyst Ratings, calibrated to this event's spread. Teams
              you haven't scouted count as field-average, not zero.
            </p>
          </div>
        ) : (
          <p className={styles.predHint}>Enter at least two team numbers to project a result.</p>
        )}
      </div>
    </section>
  )
}

function AllianceInput({ side, values, onChange, nick, crOf }) {
  return (
    <div className={`${styles.alliance} ${side === 'red' ? styles.allianceRed : styles.allianceBlue}`}>
      {values.map((v, i) => {
        const cr = v.trim() ? crOf.get(v.trim()) : null
        return (
          <label key={i} className={styles.slot}>
            <input
              className={styles.slotInput}
              inputMode="numeric"
              value={v}
              onChange={onChange(side, i)}
              placeholder="—"
              aria-label={`${side} team ${i + 1}`}
            />
            {v.trim() && (
              <span className={styles.slotMeta}>
                {cr != null ? `${cr} CR` : 'unrated'}
                {nick?.get(Number(v)) && <span className={styles.slotNick}>{nick.get(Number(v))}</span>}
              </span>
            )}
          </label>
        )
      })}
    </div>
  )
}
