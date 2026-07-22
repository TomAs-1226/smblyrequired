import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../../Icon'
import { nexusStatus } from '../../../lib/scoutingApi'
import css from './NexusLive.module.css'

// -----------------------------------------------------------------------------
// Live event status from Nexus for FRC, via the nexus-proxy edge function.
//
// This card lives in a pit: loud, and on a venue network that is a captive
// portal about as often as it is real internet. Three rules follow from that:
//
//  1. Never blank good data to a spinner on a poll. A scout who glances up
//     mid-match must still see the last truth, so a failed refetch keeps the
//     previous payload on screen and only annotates that it is stale.
//  2. Never crash on a field. The exact Nexus JSON is confirmed against a live
//     key we do not have yet, so every field is read through a defensive helper
//     that tolerates a rename or an absence — a wrong guess is a "not shown",
//     never a white screen.
//  3. Don't poll from a pocket. Polling pauses while the tab is hidden and
//     catches up the instant it comes back.
// -----------------------------------------------------------------------------

const HOME_TEAM = '5805' // SMbly Required — the one number a scout scans a match for.
const POLL_MS = 30000
const MAX_MATCHES = 8
const MAX_ANNOUNCEMENTS = 5

// --- Defensive readers -------------------------------------------------------
// Each tries the documented Nexus key first, then plausible aliases, then gives
// up quietly. They exist because the field names above are unverified (see the
// file header), so the cost of a rename must be borne here, not by the render.

const asArray = (v) => (Array.isArray(v) ? v : [])

function teamStr(t) {
  if (t == null) return ''
  // Usually a bare "254" string, but tolerate a wrapped { teamNumber } shape.
  if (typeof t === 'object') return String(t.teamNumber ?? t.team ?? t.number ?? t.key ?? '')
  return String(t)
}

function matchLabel(m) {
  return m?.label ?? m?.name ?? ''
}

function matchStatus(m) {
  return m?.status ?? ''
}

function matchTeams(m, side) {
  const raw =
    side === 'red'
      ? (m?.redTeams ?? m?.red ?? m?.alliances?.red?.teams ?? m?.alliances?.red)
      : (m?.blueTeams ?? m?.blue ?? m?.alliances?.blue?.teams ?? m?.alliances?.blue)
  return asArray(raw).map(teamStr).filter(Boolean)
}

function matchTime(m) {
  return (
    m?.times?.estimatedStartTime ??
    m?.estimatedStartTime ??
    m?.times?.scheduledStartTime ??
    m?.scheduledStartTime ??
    null
  )
}

function annText(a) {
  return a?.announcement ?? a?.message ?? a?.text ?? ''
}

function annTime(a) {
  return a?.postedTime ?? a?.postedAt ?? a?.time ?? null
}

// Nexus status strings are free-form, so match on substrings rather than an
// enum and let the pill colour fall out of the family. Order matters: a done
// match is decided before "field" could pull a completed one back to green.
function statusFamily(status) {
  const s = String(status || '').toLowerCase()
  if (!s) return 'idle'
  if (/complet|final|played|posted|over|result/.test(s)) return 'done'
  if (/on field|in progress|playing|field/.test(s)) return 'active'
  if (/queu|deck|staging/.test(s)) return 'queuing'
  return 'idle'
}

// --- Time formatting ---------------------------------------------------------
// Server stamps are epoch-ms; the phone clock is the only "now" we have, so
// every relative time is measured against a Date.now() that a 1s tick refreshes.

function fmtAgo(ms, now) {
  if (ms == null) return null
  const d = Math.max(0, now - ms)
  const s = Math.round(d / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

function fmtIn(ms, now) {
  if (ms == null) return null
  const d = ms - now
  if (d <= 0) return null // only annotate genuinely-future times
  const s = Math.round(d / 1000)
  if (s < 60) return 'in <1 min'
  const m = Math.round(s / 60)
  if (m < 60) return `in ${m} min`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem ? `in ${h}h ${rem}m` : `in ${h}h`
}

function fmtClock(ms) {
  if (ms == null) return null
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

// The proxy surfaces the server's own message. An unconfigured key is a setup
// state ("a lead needs to add it"), not the red error a dead network deserves.
const isSetupError = (e) => !!e && /NEXUS_KEY|rejected our API key/i.test(e)

export default function NexusLive({ eventKey }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const aliveRef = useRef(true)
  // The buttons and timers all call through this, so no closure can ever fetch
  // for an event that has already been replaced.
  const runRef = useRef(null)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // Fetch + poll, rebuilt whenever the event changes.
  useEffect(() => {
    let cancelled = false
    // New event: drop the old one's data so its matches can't flash under the
    // new key while the first request is still in flight.
    setData(null)
    setError(null)
    setRefreshing(false)

    if (!eventKey) {
      runRef.current = null
      return undefined
    }

    const run = async ({ force = false, manual = false } = {}) => {
      if (manual) setRefreshing(true)
      const { data: d, error: e } = await nexusStatus(eventKey, { force })
      if (cancelled || !aliveRef.current) return
      // A failed poll keeps the last good data on screen (rule 1); only the
      // error line changes.
      if (e) setError(e)
      else {
        setData(d)
        setError(null)
      }
      if (manual) setRefreshing(false)
    }
    runRef.current = run
    run()

    // One interval, but it only touches the network while the tab is actually
    // visible — a phone face-down in a pocket must not poll all afternoon.
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') run()
    }, POLL_MS)
    // Returning to the tab should feel current, not "wait up to 30s".
    const onVisible = () => {
      if (document.visibilityState === 'visible') run()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [eventKey])

  // "in 4 min" / "updated 12s ago" have to stay honest without a round-trip, so
  // a local 1s tick re-renders them. No tick without an event — nothing to age.
  useEffect(() => {
    if (!eventKey) return undefined
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [eventKey])

  const view = useMemo(() => {
    const nexus = data?.nexus ?? {}
    const summary = data?.summary ?? {}
    const matches = asArray(nexus.matches)

    // Prefer the next/active matches. Fall back to "first 8 of everything" only
    // when a status filter would leave nothing — i.e. the event is over, or the
    // statuses are strings we can't read.
    const live = matches.filter((m) => statusFamily(matchStatus(m)) !== 'done')
    const shownMatches = (live.length ? live : matches).slice(0, MAX_MATCHES)

    const announcements = [...asArray(nexus.announcements)]
      .sort((a, b) => (annTime(b) ?? 0) - (annTime(a) ?? 0))
      .slice(0, MAX_ANNOUNCEMENTS)

    // Trust the proxy's convenience field; if it's null, read it off the matches.
    let nowQueuing = summary.now_queuing ?? null
    if (!nowQueuing) {
      const q = matches.find((m) => /queu/i.test(String(matchStatus(m))))
      nowQueuing = q ? matchLabel(q) || null : null
    }

    return {
      eventKeyShown: data?.event_key ?? nexus.eventKey ?? '',
      cached: !!data?.cached,
      dataAsOf: summary.data_as_of ?? nexus.dataAsOfTime ?? null,
      nowQueuing,
      matches: shownMatches,
      announcements,
      hasAny: shownMatches.length > 0 || announcements.length > 0,
    }
  }, [data])

  const refresh = () => runRef.current?.({ force: true, manual: true })

  // No event selected: a hint, not a fetch.
  if (!eventKey) {
    return (
      <p className={css.placeholder}>
        <Icon name="compass" size={16} />
        Set an active event to see live field status.
      </p>
    )
  }

  // Nothing on screen yet — the only time the big spinner is allowed.
  if (!data) {
    if (isSetupError(error)) {
      return (
        <div className={css.state}>
          <span className={css.stateIcon} aria-hidden="true">
            <Icon name="compass" size={24} />
          </span>
          <h3 className={css.stateTitle}>Live data isn’t connected yet</h3>
          <p className={css.stateText}>
            Live event data isn’t connected yet — a team lead needs to add the Nexus API key.
          </p>
        </div>
      )
    }
    if (error) {
      return (
        <div className={css.state} role="alert">
          <span className={`${css.stateIcon} ${css.stateIconBad}`} aria-hidden="true">
            <Icon name="alert" size={24} />
          </span>
          <h3 className={css.stateTitle}>Couldn’t reach the field</h3>
          <p className={css.stateText}>{error}</p>
          <button type="button" className="btn btn--ghost" onClick={refresh}>
            Try again
          </button>
        </div>
      )
    }
    return (
      <div className={css.center} role="status" aria-live="polite">
        <span className={css.spinner} aria-hidden="true" />
        <p className={css.centerText}>Connecting to the field…</p>
      </div>
    )
  }

  const updatedAgo = fmtAgo(view.dataAsOf, now)

  return (
    <div className={css.card}>
      <header className={css.head}>
        <div className={css.headMain}>
          <span className={css.live}>
            <span className={css.liveDot} aria-hidden="true" />
            LIVE
          </span>
          {view.eventKeyShown && <span className={css.eventKey}>{view.eventKeyShown}</span>}
          {view.cached && <span className={css.cachedTag}>cached</span>}
        </div>
        <div className={css.headSide}>
          {/* Decorative + ticking every second: kept out of the live region so a
              screen reader isn't spammed with a new "updated Ns ago" each tick. */}
          {updatedAgo && (
            <span className={css.updated} aria-hidden="true">
              updated {updatedAgo}
            </span>
          )}
          <button type="button" className={css.refresh} onClick={refresh} disabled={refreshing}>
            {refreshing && <span className={css.spinnerSm} aria-hidden="true" />}
            {refreshing ? 'Refreshing' : 'Refresh'}
          </button>
        </div>
      </header>

      {/* The one thing a scout needs first — announced when it changes. */}
      <p className={css.queuing} role="status" aria-live="polite">
        {view.nowQueuing ? (
          <>
            Now queuing <strong>{view.nowQueuing}</strong>
          </>
        ) : (
          'Waiting for the next match to queue'
        )}
      </p>

      {error && (
        <p className={css.stale} role="status">
          <Icon name="alert" size={14} />
          {isSetupError(error)
            ? 'Live key was removed — showing the last update.'
            : `Showing the last update — that refresh didn’t go through. ${error}`}
        </p>
      )}

      {view.matches.length > 0 && (
        <section className={css.section}>
          <h3 className={css.sectionTitle}>Up next</h3>
          <ul className={css.matchList}>
            {view.matches.map((m, i) => (
              <MatchRow key={matchLabel(m) || i} match={m} now={now} />
            ))}
          </ul>
        </section>
      )}

      {view.announcements.length > 0 && (
        <section className={css.section}>
          <h3 className={css.sectionTitle}>
            <Icon name="megaphone" size={15} />
            Announcements
          </h3>
          <ul className={css.annList}>
            {view.announcements.map((a, i) => {
              const t = annTime(a)
              return (
                <li key={a?.id ?? i} className={css.ann}>
                  <p className={css.annBody}>{annText(a) || '—'}</p>
                  {t != null && (
                    <span className={css.annTime} aria-hidden="true">
                      {fmtAgo(t, now)}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {/* Fetch was fine, the field just has nothing to report yet. */}
      {!view.hasAny && (
        <div className={css.state}>
          <span className={css.stateIcon} aria-hidden="true">
            <Icon name="compass" size={24} />
          </span>
          <h3 className={css.stateTitle}>No live field data yet</h3>
          <p className={css.stateText}>
            No live field data for {view.eventKeyShown || eventKey} yet — this event may not be
            running Nexus.
          </p>
        </div>
      )}
    </div>
  )
}

function MatchRow({ match, now }) {
  const family = statusFamily(matchStatus(match))
  const status = String(matchStatus(match) || '').trim()
  const red = matchTeams(match, 'red')
  const blue = matchTeams(match, 'blue')
  const ts = matchTime(match)
  const clock = fmtClock(ts)
  const inLabel = fmtIn(ts, now)

  return (
    <li className={css.match}>
      <div className={css.matchTop}>
        <span className={css.matchLabel}>{matchLabel(match) || 'Match'}</span>
        {status && <span className={`${css.pill} ${css[`pill_${family}`] ?? ''}`}>{status}</span>}
      </div>

      {(red.length > 0 || blue.length > 0) && (
        <div className={css.alliances}>
          {red.length > 0 && (
            <div className={`${css.alliance} ${css.allianceRed}`}>
              {red.map((t, i) => (
                <TeamChip key={`r${i}-${t}`} team={t} />
              ))}
            </div>
          )}
          {blue.length > 0 && (
            <div className={`${css.alliance} ${css.allianceBlue}`}>
              {blue.map((t, i) => (
                <TeamChip key={`b${i}-${t}`} team={t} />
              ))}
            </div>
          )}
        </div>
      )}

      {(clock || inLabel) && (
        <div className={css.matchTime}>
          {clock && <span className={css.matchClock}>{clock}</span>}
          {inLabel && <span className={css.matchIn}>{inLabel}</span>}
        </div>
      )}
    </li>
  )
}

function TeamChip({ team }) {
  const home = team === HOME_TEAM
  return (
    <span className={`${css.team} ${home ? css.teamHome : ''}`}>
      {team}
      {home && <span className="sr-only"> (our team)</span>}
    </span>
  )
}
