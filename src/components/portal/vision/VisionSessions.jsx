import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../../Icon'
import { listVisionSessions, visionFrames } from '../../../lib/scoutingApi'
import portal from '../Portal.module.css'
import styles from './Vision.module.css'

// =============================================================================
// VisionSessions — review of what the master device captured.
//
// The counterpart to VisionCapture: every capture leaves a session and a stream
// of timestamped counts, and this is where they are read back. The point of
// showing them is honesty as much as insight — a count-over-time trace makes it
// obvious at a glance what the generic model actually saw (usually: people), and
// that is exactly the feedback that tells you what a trained model needs to fix.
//
// The heavy detail (thousands of frames) is fetched only when a session is
// expanded, never for the list — the list reads the summary VIEW (migration
// 0011), which is one row per session with the aggregates already computed.
// =============================================================================

const fmtClock = (start, end) => {
  if (!start) return '—'
  const s = new Date(start)
  if (!end) return `${s.toLocaleDateString()} ${s.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · running`
  const mins = Math.max(0, Math.round((new Date(end) - s) / 60000))
  return `${s.toLocaleDateString()} ${s.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${mins} min`
}

export default function VisionSessions({ eventKey, reloadKey }) {
  const [sessions, setSessions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [openId, setOpenId] = useState(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    const { data, error: err } = await listVisionSessions(eventKey || null)
    if (!aliveRef.current) return
    setSessions(data)
    setError(err)
    setLoading(false)
  }, [eventKey])

  // reloadKey bumps when a capture ends, so a freshly-finished session shows up
  // without the reviewer reloading the page.
  useEffect(() => {
    load()
  }, [load, reloadKey])

  if (loading && sessions.length === 0) {
    return (
      <div className={styles.reviewCenter} role="status">
        <span className={portal.spinner} aria-hidden="true" />
        <p>Loading capture sessions…</p>
      </div>
    )
  }

  if (error) {
    return (
      <p className={portal.error}>
        <Icon name="alert" size={15} />
        {error}
      </p>
    )
  }

  if (sessions.length === 0) {
    return (
      <div className={styles.reviewCenter}>
        <span className={styles.emptyIcon} aria-hidden="true">
          <Icon name="cpu" size={22} />
        </span>
        <p className={styles.emptyTitle}>No capture sessions yet</p>
        <p className={styles.emptyText}>
          Start a capture on the master device and its stream of on-device detections will appear
          here for review.
        </p>
      </div>
    )
  }

  return (
    <div className={styles.sessionList}>
      {sessions.map((s) => (
        <SessionRow
          key={s.id}
          session={s}
          open={openId === s.id}
          onToggle={() => setOpenId((id) => (id === s.id ? null : s.id))}
        />
      ))}
    </div>
  )
}

function SessionRow({ session, open, onToggle }) {
  return (
    <div className={`${styles.sessionCard} ${open ? styles.sessionCardOpen : ''}`}>
      <button type="button" className={styles.sessionHead} onClick={onToggle} aria-expanded={open}>
        <span className={styles.sessionMain}>
          <span className={styles.sessionTitle}>
            {session.device_label || 'Unlabelled device'}
            {session.match_key && <span className={styles.sessionMatch}>{session.match_key}</span>}
            {!session.ended_at && <span className={styles.sessionLive}>live</span>}
          </span>
          <span className={styles.sessionSub}>{fmtClock(session.started_at, session.ended_at)}</span>
        </span>
        <span className={styles.sessionNums}>
          <span className={styles.sessionNum}>
            <strong>{session.observations ?? 0}</strong> obs
          </span>
          <span className={styles.sessionNum}>
            peak <strong>{session.peak_count ?? 0}</strong>
          </span>
          <span className={styles.sessionNum}>
            avg <strong>{session.avg_count ?? 0}</strong>
          </span>
          <Icon name={open ? 'arrowUp' : 'arrowRight'} size={16} />
        </span>
      </button>

      <p className={styles.sessionModel}>
        <Icon name="cpu" size={13} />
        {session.model}
        {session.model_note ? ` — ${session.model_note}` : ''}
        {session.operator ? ` · ${session.operator}` : ''}
      </p>

      {open && <SessionDetail session={session} />}
    </div>
  )
}

function SessionDetail({ session }) {
  const [frames, setFrames] = useState(null)
  const [error, setError] = useState(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    ;(async () => {
      const { data, error: err } = await visionFrames(session.id)
      if (!aliveRef.current) return
      setFrames(data)
      setError(err)
    })()
    return () => {
      aliveRef.current = false
    }
  }, [session.id])

  // Roll up which classes actually showed up — the single most useful honest
  // readout, because it makes plain that a generic model on a field mostly sees
  // 'person'. That gap IS the case for a trained model.
  const classTally = useMemo(() => {
    if (!frames) return []
    const tally = new Map()
    for (const f of frames) {
      for (const d of f.detections ?? []) {
        tally.set(d.class, (tally.get(d.class) ?? 0) + 1)
      }
    }
    return [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
  }, [frames])

  if (error) {
    return (
      <p className={`${portal.error} ${styles.detailPad}`}>
        <Icon name="alert" size={15} />
        {error}
      </p>
    )
  }
  if (!frames) {
    return (
      <div className={`${styles.reviewCenter} ${styles.detailPad}`} role="status">
        <span className={portal.spinnerSm} aria-hidden="true" />
        <p>Loading {session.observations ?? ''} observations…</p>
      </div>
    )
  }
  if (frames.length === 0) {
    return <p className={`${styles.detailNote} ${styles.detailPad}`}>This session recorded no observations.</p>
  }

  return (
    <div className={styles.detail}>
      <CountTrace frames={frames} />
      {classTally.length > 0 && (
        <div className={styles.tally}>
          <span className={styles.tallyLabel}>Detected classes</span>
          <div className={styles.tallyRow}>
            {classTally.map(([cls, n]) => (
              <span key={cls} className={styles.tallyChip}>
                {cls} <strong>{n}</strong>
              </span>
            ))}
          </div>
          <p className={styles.detailNote}>
            Counts of raw COCO classes across the session — a plain-language reminder that this model
            sees everyday objects, not game state.
          </p>
        </div>
      )}
    </div>
  )
}

// A dependency-free SVG trace of object_count against session time. Deliberately
// simple: it is a sanity check on the stream, not a dashboard chart.
function CountTrace({ frames }) {
  const { path, area, peak, w, h } = useMemo(() => {
    const W = 600
    const H = 120
    const pad = 6
    const counts = frames.map((f) => f.object_count ?? 0)
    const offsets = frames.map((f) => f.offset_ms ?? 0)
    const maxC = Math.max(1, ...counts)
    const maxT = Math.max(1, ...offsets)
    const x = (t) => pad + (t / maxT) * (W - pad * 2)
    const y = (c) => pad + (1 - c / maxC) * (H - pad * 2)
    let d = ''
    frames.forEach((f, i) => {
      d += `${i === 0 ? 'M' : 'L'}${x(f.offset_ms ?? 0).toFixed(1)},${y(f.object_count ?? 0).toFixed(1)} `
    })
    const areaD = `${d}L${x(maxT).toFixed(1)},${(H - pad).toFixed(1)} L${x(0).toFixed(1)},${(H - pad).toFixed(1)} Z`
    return { path: d.trim(), area: areaD, peak: maxC, w: W, h: H }
  }, [frames])

  return (
    <div className={styles.trace}>
      <div className={styles.traceHead}>
        <span className={styles.traceTitle}>Objects in frame over time</span>
        <span className={styles.tracePeak}>peak {peak}</span>
      </div>
      <svg
        className={styles.traceSvg}
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Object count over time, peak ${peak}`}
      >
        <path className={styles.traceArea} d={area} />
        <path className={styles.traceLine} d={path} />
      </svg>
      <span className={styles.traceAxis}>{frames.length} observations · left = start, right = end</span>
    </div>
  )
}
