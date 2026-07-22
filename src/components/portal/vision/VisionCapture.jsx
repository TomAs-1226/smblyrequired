import { useCallback, useEffect, useRef, useState } from 'react'
import Icon from '../../Icon'
import { useAuth } from '../../../lib/auth'
import {
  startVisionSession,
  endVisionSession,
  pushVisionObservations,
  scoutControl,
  visionModelConfig,
} from '../../../lib/scoutingApi'
import { loadDetector } from '../../../lib/visionDetector'
import portal from '../Portal.module.css'
import styles from './Vision.module.css'

// =============================================================================
// VisionCapture — the "master device" running a detector ON THE PHONE.
//
// A phone points at the field and, frame by frame, an object detector runs
// LOCALLY in the browser. The video never leaves the device; only the numbers
// do — a per-instant object count and the boxes that produced it, timestamped so
// they can be lined up against a match later.
//
// WHICH detector runs is a SETTING now (migration 0012), not a constant. Out of
// the box it is COCO-SSD, a GENERIC model that counts everyday objects and knows
// nothing about robots or game pieces — a pipeline stand-in and training-data
// collector. A lead can point it at a real FRC-trained YOLO model (the format
// other teams deploy), and then it genuinely tracks that model's classes. Either
// way every session records the model that made it (see start()), so the numbers
// stay honestly attributable when the model is swapped.
//
// The "focus class" selector adapts to the model: for the generic model it is the
// closest COCO stand-ins (e.g. 'sports ball' for a game piece); for a trained
// model it is that model's own classes.
//
// The camera + lazy-detector machinery mirrors RobotCapture.jsx. The NEW problem
// here is a *continuous* loop: a detector that never overlaps itself, a bounded
// send buffer that survives a dead venue network, a wake lock so the screen does
// not sleep mid-match, and a cadence that does not melt a mid-range Android.
// =============================================================================

// --- Cadence -----------------------------------------------------------------
// One detection every 500ms — two per second. Fast enough that the overlay reads
// as live and a ball crossing the frame is caught; slow enough that a phone is
// not pinned at 100% all competition. The loop is self-clocking (see runLoop):
// it schedules the NEXT detection only after the current one resolves, so a slow
// frame slows the cadence instead of piling up.
const DETECT_INTERVAL_MS = 500

// Per observation we keep at most this many boxes. The count is the headline; the
// boxes are evidence + training data, but persisting every box every 500ms is a
// lot of jsonb over a venue uplink, so we keep the most confident dozen.
const STORE_BOXES = 12

// --- Send buffer -------------------------------------------------------------
const FLUSH_INTERVAL_MS = 6000
const FLUSH_MAX_ROWS = 24 // flush early if a batch fills before the timer
// A buffer cannot grow forever on a phone. Past this the OLDEST rows drop: a live
// count is worth more than a stale one, and the alternative is an OOM crash.
const MAX_BUFFER_ROWS = 4000

// A YOLO GraphModel over venue wifi can be slow; the timeout only flips the UI to
// "unavailable", and a load that finishes later still flips it back to ready.
const MODEL_LOAD_TIMEOUT_MS = 25000

const round2 = (n) => Math.round(n * 100) / 100

// A loose event-key check, same family the server enforces (2026casd). Kept
// permissive because the operator may be typing a key TBA has not cached yet.
const looksLikeEventKey = (s) => /^\d{4}[a-z0-9]{1,20}$/.test(String(s ?? '').trim().toLowerCase())

// Focus options follow the loaded model: curated COCO stand-ins for the generic
// detector, the model's own classes for a trained one.
function focusOptionsFor(meta) {
  if (!meta) return [{ id: 'all', label: 'All objects', note: 'Every detection' }]
  if (meta.generic) {
    return [
      { id: 'all', label: 'All objects', note: 'Every detection, any class' },
      { id: 'sports ball', label: 'Game pieces (stand-in)', note: "COCO 'sports ball' — closest to a game piece" },
      { id: 'person', label: 'People', note: 'Drivers, refs, human players' },
    ]
  }
  const labels = Array.isArray(meta.labels) ? meta.labels : []
  return [
    { id: 'all', label: 'All classes', note: 'Every detection' },
    ...labels.map((l) => ({ id: l, label: l, note: 'Model class' })),
  ]
}

export default function VisionCapture({ onSessionEnd }) {
  const { user } = useAuth()

  const videoRef = useRef(null)
  const overlayRef = useRef(null)
  const streamRef = useRef(null)
  const detectorRef = useRef(null)
  const aliveRef = useRef(true)
  const wakeLockRef = useRef(null)

  // Live-session refs — mutated by the loop without forcing a re-render. State
  // mirrors are pushed on a slow tick (see the stats interval) so the 2Hz loop
  // does not drive React at 2Hz.
  const sessionRef = useRef(null)
  const startedAtRef = useRef(0)
  const bufferRef = useRef([])
  const framesRef = useRef(0)
  const sentRef = useRef(0)
  const lastCountRef = useRef(0)
  const focusRef = useRef('all')
  const loopRef = useRef(false)
  const loopTimerRef = useRef(null)
  const flushTimerRef = useRef(null)
  const statsTimerRef = useRef(null)

  const [phase, setPhase] = useState('config') // config | starting | live | stopping
  const [camera, setCamera] = useState({ status: 'idle', message: null })
  const [model, setModel] = useState('loading') // loading | ready | unavailable
  const [detectorMeta, setDetectorMeta] = useState(null) // { id, name, note, generic, labels }
  const [config, setConfig] = useState({ eventKey: '', matchKey: '', deviceLabel: '', focus: 'all' })
  const [stats, setStats] = useState({ count: 0, frames: 0, sent: 0, buffered: 0, elapsedMs: 0 })
  const [error, setError] = useState(null)
  const [netWarn, setNetWarn] = useState(null)

  // --- Lifecycle -------------------------------------------------------------

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // Default the event to whatever leadership set active, so the common case is
  // zero typing. The operator can still override it below.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data } = await scoutControl()
      if (!cancelled && data?.active_event_key) {
        setConfig((c) => (c.eventKey ? c : { ...c, eventKey: data.active_event_key }))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // --- Camera (same contract as RobotCapture) --------------------------------

  const stopCamera = useCallback(() => {
    const stream = streamRef.current
    if (stream) stream.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
  }, [])

  const startCamera = useCallback(async () => {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setCamera({
        status: 'unsupported',
        message:
          'A camera needs an HTTPS page and a browser that allows it. Open the portal over https on a phone with a rear camera.',
      })
      return
    }
    setCamera({ status: 'starting', message: null })
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // 'ideal', not 'exact': a laptop with only a front camera should still get
        // one rather than an OverconstrainedError. Higher capture resolution helps
        // the detector resolve small, distant objects.
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      })
      if (!aliveRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play().catch(() => {})
      }
      setCamera({ status: 'live', message: null })
    } catch (err) {
      if (!aliveRef.current) return
      const name = err?.name ?? ''
      const message =
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Camera access was refused. Reload and choose Allow.'
          : name === 'NotFoundError' || name === 'OverconstrainedError'
            ? 'No camera found on this device.'
            : name === 'NotReadableError' || name === 'AbortError'
              ? 'Another app is holding the camera. Close it and reload.'
              : (err?.message ?? 'The camera would not start.')
      setCamera({ status: 'unsupported', message })
    }
  }, [])

  useEffect(() => {
    startCamera()
    return stopCamera
  }, [startCamera, stopCamera])

  // --- Detector (lazy, pluggable — see lib/visionDetector.js) -----------------
  // The detector module does all the dynamic import()ing of TensorFlow, so TF
  // stays in its own lazy chunk and never touches the public bundle. We just ask
  // it to load whatever the settings configured — a trained model if a lead set
  // one, the generic model otherwise (and it falls back to generic on any error).
  useEffect(() => {
    let cancelled = false
    let settled = false
    const timer = setTimeout(() => {
      if (!settled && !cancelled) {
        settled = true
        setModel('unavailable')
      }
    }, MODEL_LOAD_TIMEOUT_MS)

    ;(async () => {
      try {
        const { data: cfg } = await visionModelConfig()
        const modelConfig = cfg?.vision_model_url
          ? {
              url: cfg.vision_model_url,
              name: cfg.vision_model_name,
              labels: cfg.vision_model_labels,
              size: cfg.vision_model_size,
            }
          : null
        const det = await loadDetector(modelConfig)
        if (cancelled) {
          det.dispose?.()
          return
        }
        detectorRef.current = det
        setDetectorMeta({ id: det.id, name: det.name, note: det.note, generic: det.generic, labels: det.labels })
        // A new model has different classes, so reset the focus to a safe default.
        focusRef.current = 'all'
        setConfig((c) => ({ ...c, focus: 'all' }))
        settled = true
        setModel('ready')
      } catch (err) {
        console.warn('[vision] detector unavailable:', err?.message ?? err)
        if (!cancelled) {
          settled = true
          setModel('unavailable')
        }
      }
    })()

    return () => {
      cancelled = true
      clearTimeout(timer)
      detectorRef.current?.dispose?.()
      detectorRef.current = null
    }
  }, [])

  // --- Overlay ---------------------------------------------------------------
  // The canvas carries the video's INTRINSIC pixel dimensions and is stretched by
  // CSS over the video with the same object-fit, so boxes drawn in intrinsic
  // coordinates line up without any manual letterbox maths.
  const drawOverlay = useCallback((preds, video, focus) => {
    const canvas = overlayRef.current
    if (!canvas || !video.videoWidth) return
    if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth
    if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const scale = canvas.width / 320
    ctx.lineWidth = Math.max(2, scale * 2)
    ctx.font = `${Math.max(12, Math.round(scale * 12))}px system-ui, sans-serif`
    ctx.textBaseline = 'top'
    for (const p of preds) {
      const hit = focus === 'all' || p.class === focus
      const [x, y, w, h] = p.bbox
      ctx.strokeStyle = hit ? 'rgba(126, 224, 168, 0.95)' : 'rgba(180, 200, 220, 0.35)'
      ctx.strokeRect(x, y, w, h)
      if (!hit) continue
      const label = `${p.class} ${Math.round(p.score * 100)}%`
      const tw = ctx.measureText(label).width
      const th = Math.max(14, Math.round(scale * 14))
      ctx.fillStyle = 'rgba(18, 26, 22, 0.82)'
      ctx.fillRect(x, Math.max(0, y - th - 2), tw + 8, th + 2)
      ctx.fillStyle = 'rgba(230, 255, 240, 0.98)'
      ctx.fillText(label, x + 4, Math.max(0, y - th))
    }
  }, [])

  // --- Sending ---------------------------------------------------------------
  // Declared before the loop that calls it; stable identity so the loop can close
  // over it safely.
  const flush = useCallback(async (final) => {
    const sessionId = sessionRef.current
    const batch = bufferRef.current
    if (!sessionId || batch.length === 0) return
    bufferRef.current = [] // take the batch; new detections accumulate behind it

    const { error: sendErr } = await pushVisionObservations(sessionId, batch)
    if (!aliveRef.current && !final) return
    if (sendErr) {
      // Put the batch back at the FRONT and cap the buffer — a dead network must
      // not silently eat the stream, but it also must not OOM the phone.
      bufferRef.current = batch.concat(bufferRef.current).slice(-MAX_BUFFER_ROWS)
      setNetWarn('Saving is behind — holding observations until the network returns.')
    } else {
      sentRef.current += batch.length
      setNetWarn(null)
    }
  }, [])

  // --- The detection loop ----------------------------------------------------
  const detectOnce = useCallback(async () => {
    const video = videoRef.current
    const det = detectorRef.current
    // No detector yet (still loading) or no frame yet: skip this tick silently.
    if (!video || !video.videoWidth || !det) return

    // The detector returns a unified [{ class, score, bbox:[x,y,w,h] }] in source
    // pixels, whichever model is behind it.
    const preds = await det.detect(video)
    const focus = focusRef.current
    drawOverlay(preds, video, focus)

    const counted = focus === 'all' ? preds : preds.filter((p) => p.class === focus)
    lastCountRef.current = counted.length
    framesRef.current += 1

    // Store the most confident boxes as evidence + training data. `hit` marks
    // which the focus counted, so a later pass can re-derive the count under a
    // different focus without re-running the model.
    const boxes = [...preds]
      .sort((a, b) => b.score - a.score)
      .slice(0, STORE_BOXES)
      .map((p) => ({
        class: p.class,
        score: round2(p.score),
        bbox: p.bbox.map((n) => Math.round(n)),
        hit: focus === 'all' ? true : p.class === focus,
      }))

    bufferRef.current.push({
      offsetMs: performance.now() - startedAtRef.current,
      objectCount: counted.length,
      detections: boxes,
    })
    if (bufferRef.current.length >= FLUSH_MAX_ROWS) flush(false)
  }, [drawOverlay, flush])

  const runLoop = useCallback(() => {
    if (!loopRef.current) return
    const startedAt = performance.now()
    detectOnce()
      .catch((err) => console.warn('[vision] detect failed:', err?.message ?? err))
      .finally(() => {
        if (!loopRef.current) return
        const wait = Math.max(0, DETECT_INTERVAL_MS - (performance.now() - startedAt))
        loopTimerRef.current = setTimeout(runLoop, wait)
      })
  }, [detectOnce])

  // --- Wake lock -------------------------------------------------------------
  const acquireWakeLock = useCallback(async () => {
    try {
      wakeLockRef.current = (await navigator.wakeLock?.request('screen')) ?? null
    } catch {
      wakeLockRef.current = null
    }
  }, [])

  const releaseWakeLock = useCallback(() => {
    wakeLockRef.current?.release?.().catch(() => {})
    wakeLockRef.current = null
  }, [])

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && loopRef.current) acquireWakeLock()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [acquireWakeLock])

  // --- Stats mirror ----------------------------------------------------------
  const updateStats = useCallback(() => {
    if (!aliveRef.current) return
    setStats({
      count: lastCountRef.current,
      frames: framesRef.current,
      sent: sentRef.current,
      buffered: bufferRef.current.length,
      elapsedMs: startedAtRef.current ? performance.now() - startedAtRef.current : 0,
    })
  }, [])

  // --- Start / stop ----------------------------------------------------------
  const start = useCallback(async () => {
    if (!user?.id) {
      setError('Your session expired. Sign in again before starting a capture.')
      return
    }
    if (!detectorRef.current || !detectorMeta) {
      setError('The detection model is still loading. Give it a moment.')
      return
    }
    const eventKey = config.eventKey.trim().toLowerCase()
    if (eventKey && !looksLikeEventKey(eventKey)) {
      setError('That event key does not look right (expected something like 2026casd). Clear it to run without an event.')
      return
    }

    setError(null)
    setNetWarn(null)
    setPhase('starting')

    // The session is attributed to the model that will actually make its numbers.
    const { data, error: startErr } = await startVisionSession({
      eventKey: eventKey || null,
      matchKey: config.matchKey.trim() || null,
      deviceLabel: config.deviceLabel.trim() || null,
      model: detectorMeta.id,
      modelNote: detectorMeta.note,
      userId: user.id,
    })
    if (!aliveRef.current) return
    if (startErr || !data) {
      setError(startErr || 'Could not start a capture session.')
      setPhase('config')
      return
    }

    sessionRef.current = data.id
    startedAtRef.current = performance.now()
    bufferRef.current = []
    framesRef.current = 0
    sentRef.current = 0
    lastCountRef.current = 0
    focusRef.current = config.focus

    await acquireWakeLock()
    loopRef.current = true
    runLoop()
    flushTimerRef.current = setInterval(() => flush(false), FLUSH_INTERVAL_MS)
    statsTimerRef.current = setInterval(updateStats, 500)
    setPhase('live')
  }, [user, detectorMeta, config, acquireWakeLock, runLoop, flush, updateStats])

  const teardown = useCallback(
    async (announce) => {
      loopRef.current = false
      clearTimeout(loopTimerRef.current)
      clearInterval(flushTimerRef.current)
      clearInterval(statsTimerRef.current)
      loopTimerRef.current = null
      flushTimerRef.current = null
      statsTimerRef.current = null

      const sessionId = sessionRef.current
      // Final flush BEFORE closing the session, so the last seconds are not lost.
      await flush(true)
      if (sessionId) await endVisionSession(sessionId, framesRef.current)
      sessionRef.current = null
      releaseWakeLock()
      if (overlayRef.current) {
        const ctx = overlayRef.current.getContext('2d')
        ctx?.clearRect(0, 0, overlayRef.current.width, overlayRef.current.height)
      }
      if (announce && aliveRef.current) {
        setPhase('config')
        onSessionEnd?.()
      }
    },
    [flush, releaseWakeLock, onSessionEnd]
  )

  const stop = useCallback(async () => {
    setPhase('stopping')
    await teardown(true)
  }, [teardown])

  useEffect(() => {
    return () => {
      if (loopRef.current || sessionRef.current) teardown(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setFocus = useCallback((id) => {
    focusRef.current = id
    setConfig((c) => ({ ...c, focus: id }))
  }, [])

  // --- Render ----------------------------------------------------------------

  const live = phase === 'live' || phase === 'stopping'
  const cameraLive = camera.status === 'live'
  const canStart = cameraLive && model === 'ready' && phase === 'config'
  const focusOptions = focusOptionsFor(detectorMeta)
  const focusOption = focusOptions.find((f) => f.id === config.focus) ?? focusOptions[0]
  const isCustom = detectorMeta && !detectorMeta.generic

  return (
    <div className={styles.capture}>
      <p className={styles.honest}>
        <Icon name="cpu" size={16} />
        {isCustom ? (
          <span>
            <strong>On-device model.</strong> Running <strong>{detectorMeta.name}</strong> locally on
            this phone — video never leaves the device, only detections are saved. The count reflects
            this model's own classes; pick one to focus on below.
          </span>
        ) : (
          <span>
            <strong>On-device pipeline.</strong> A general detector runs on this phone — video never
            leaves it, only counts and boxes are saved. It counts everyday objects, <em>not</em> game
            pieces or robots yet. A lead can load a trained FRC model in the Model section above; until
            then, pick a focus class below for a meaningful stand-in.
          </span>
        )}
      </p>

      <div className={styles.stage}>
        <video
          ref={videoRef}
          className={`${styles.media} ${cameraLive ? '' : styles.mediaHidden}`}
          playsInline
          muted
          autoPlay
        />
        <canvas ref={overlayRef} className={`${styles.overlay} ${cameraLive ? '' : styles.mediaHidden}`} />

        {camera.status === 'starting' && (
          <div className={styles.stageNote} role="status">
            <span className={portal.spinner} aria-hidden="true" />
            <p>Opening the camera…</p>
          </div>
        )}
        {(camera.status === 'unsupported' || camera.status === 'denied') && (
          <div className={styles.stageNote}>
            <span className={styles.stageIcon} aria-hidden="true">
              <Icon name="alert" size={22} />
            </span>
            <p className={styles.stageNoteTitle}>No live camera</p>
            <p className={styles.stageNoteText}>{camera.message}</p>
          </div>
        )}

        {live && cameraLive && (
          <div className={styles.hud} aria-hidden="true">
            <span className={styles.hudDot} />
            <span className={styles.hudCount}>{stats.count}</span>
            <span className={styles.hudLabel}>
              {focusOption.id === 'all' ? 'objects' : focusOption.label.toLowerCase()}
            </span>
          </div>
        )}
      </div>

      <p
        className={`${styles.modelChip} ${
          model === 'ready' ? styles.modelReady : model === 'unavailable' ? styles.modelOff : ''
        }`}
      >
        <Icon name={model === 'ready' ? 'check' : model === 'unavailable' ? 'alert' : 'cpu'} size={14} />
        {model === 'loading' && 'Loading the detection model…'}
        {model === 'ready' &&
          detectorMeta &&
          `${detectorMeta.generic ? 'Generic model' : 'Trained model'} · ${detectorMeta.name}`}
        {model === 'unavailable' &&
          'Detection model unavailable on this device/connection — a trained-model URL may be unreachable, or WebGL is blocked. The built-in model is the safe fallback.'}
      </p>

      {live ? (
        <LivePanel
          stats={stats}
          focus={config.focus}
          focusOptions={focusOptions}
          onFocus={setFocus}
          netWarn={netWarn}
          onStop={stop}
          stopping={phase === 'stopping'}
        />
      ) : (
        <ConfigPanel
          config={config}
          setConfig={setConfig}
          focusOptions={focusOptions}
          onFocus={setFocus}
          canStart={canStart}
          starting={phase === 'starting'}
          modelLoading={model === 'loading'}
          onStart={start}
          error={error}
        />
      )}
    </div>
  )
}

// --- Config (pre-capture) ------------------------------------------------------

function ConfigPanel({ config, setConfig, focusOptions, onFocus, canStart, starting, modelLoading, onStart, error }) {
  const set = (k) => (e) => setConfig((c) => ({ ...c, [k]: e.target.value }))
  return (
    <div className={styles.config}>
      <div className={styles.fieldRow}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Event key</span>
          <input
            className={styles.input}
            value={config.eventKey}
            onChange={set('eventKey')}
            placeholder="2026casd"
            inputMode="text"
            autoCapitalize="none"
            spellCheck={false}
          />
          <span className={styles.fieldHint}>Defaults to the active event. Clear to capture with no event.</span>
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Match (optional)</span>
          <input
            className={styles.input}
            value={config.matchKey}
            onChange={set('matchKey')}
            placeholder="qm42"
            autoCapitalize="none"
            spellCheck={false}
          />
          <span className={styles.fieldHint}>Label these frames with the match they cover.</span>
        </label>
      </div>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>Device label</span>
        <input
          className={styles.input}
          value={config.deviceLabel}
          onChange={set('deviceLabel')}
          placeholder="Stands phone"
        />
        <span className={styles.fieldHint}>So a reviewer knows which phone this came from.</span>
      </label>

      <fieldset className={styles.focusSet}>
        <legend className={styles.fieldLabel}>Count</legend>
        <div className={styles.focusGrid}>
          {focusOptions.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`${styles.focusBtn} ${config.focus === f.id ? styles.focusBtnOn : ''}`}
              onClick={() => onFocus(f.id)}
              aria-pressed={config.focus === f.id}
            >
              <span className={styles.focusLabel}>{f.label}</span>
              <span className={styles.focusNote}>{f.note}</span>
            </button>
          ))}
        </div>
      </fieldset>

      <div className={portal.errorSlot} role="alert" aria-live="assertive">
        {error && (
          <span className={portal.error}>
            <Icon name="alert" size={15} />
            {error}
          </span>
        )}
      </div>

      <button type="button" className={styles.startBtn} onClick={onStart} disabled={!canStart || starting}>
        {starting ? (
          <>
            <span className={portal.spinnerSm} aria-hidden="true" />
            Starting…
          </>
        ) : (
          <>
            <Icon name="cpu" size={18} />
            Start capture
          </>
        )}
      </button>
      {!canStart && !starting && (
        <p className={styles.startWait}>
          {modelLoading ? 'Waiting for the model to load…' : 'Waiting for the camera before capture can start.'}
        </p>
      )}
    </div>
  )
}

// --- Live panel ----------------------------------------------------------------

function LivePanel({ stats, focus, focusOptions, onFocus, netWarn, onStop, stopping }) {
  const secs = Math.floor(stats.elapsedMs / 1000)
  const clock = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`
  const fps = secs > 0 ? (stats.frames / secs).toFixed(1) : '0.0'
  return (
    <div className={styles.liveWrap}>
      <div className={styles.statGrid}>
        <Stat label="Elapsed" value={clock} />
        <Stat label="Frames" value={stats.frames} />
        <Stat label="Rate" value={`${fps}/s`} />
        <Stat label="Saved" value={stats.sent} />
        <Stat label="Unsent" value={stats.buffered} warn={stats.buffered > 200} />
      </div>

      {/* Focus is switchable mid-capture — the model runs the same, only what the
          count counts changes, and every stored frame keeps all its boxes. */}
      <div className={styles.focusRow}>
        {focusOptions.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`${styles.focusPill} ${focus === f.id ? styles.focusPillOn : ''}`}
            onClick={() => onFocus(f.id)}
            aria-pressed={focus === f.id}
          >
            {f.label}
          </button>
        ))}
      </div>

      {netWarn && (
        <p className={styles.netWarn} role="status">
          <Icon name="alert" size={15} />
          {netWarn}
        </p>
      )}

      <button type="button" className={styles.stopBtn} onClick={onStop} disabled={stopping}>
        {stopping ? (
          <>
            <span className={portal.spinnerSm} aria-hidden="true" />
            Saving the last frames…
          </>
        ) : (
          <>
            <Icon name="close" size={18} />
            Stop capture
          </>
        )}
      </button>
    </div>
  )
}

function Stat({ label, value, warn = false }) {
  return (
    <div className={`${styles.stat} ${warn ? styles.statWarn : ''}`}>
      <span className={styles.statValue}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  )
}
