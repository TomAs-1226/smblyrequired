import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../Icon'
import { useAuth } from '../../lib/auth'
import { supabase } from '../../lib/supabase'
import { uploadFile, sha256Hex, formatBytes } from '../../lib/portalApi'
import { enqueue, isOnline } from '../../lib/offlineQueue'
import portal from './Portal.module.css'
import styles from './RobotCapture.module.css'

// =============================================================================
// Guided robot photo capture for pit scouting.
//
// A scout walks a sequence of angles, and every frame is graded ON THE DEVICE
// before it is accepted. The reason is scheduling, not perfectionism: a blurry
// photo discovered at 11pm cannot be retaken, because the pit closed at 6 and
// the robot is in a trailer. The check has to happen while the scout is still
// standing in front of the robot.
//
// The grader never blocks. It argues — loudly, with a specific instruction —
// and the scout can still override it. A pit scout cannot debug a false
// negative, and a photo that a threshold dislikes is strictly better than no
// photo at all.
// =============================================================================

// --- The sequence ------------------------------------------------------------
// The ids are exactly the values allowed by the `robot_photos.angle` check
// constraint in supabase/migrations/0005_scouting.sql. Adding one here without
// adding it there produces a row the database rejects at insert time.
const ANGLES = [
  { id: 'front', label: 'Front', hint: 'Square on to the front bumper. Whole robot in frame.' },
  { id: 'side', label: 'Side', hint: 'One full side profile. Get the bumper number if you can.' },
  { id: 'rear', label: 'Rear', hint: 'Straight on from behind. Show the back of the chassis.' },
  { id: 'drivetrain', label: 'Drivetrain', hint: 'Crouch low. Wheels, tread, gearboxes.' },
  { id: 'intake', label: 'Intake', hint: 'The pickup mechanism, close enough to see the rollers.' },
  { id: 'scoring', label: 'Scoring', hint: 'Shooter, arm or elevator — whatever scores.' },
  { id: 'other', label: 'Other', hint: 'Anything unusual worth a photo. Skip if nothing stands out.' },
]

// A skip has to be a decision, so it has to have a reason. These are buttons
// rather than a text field on purpose: typing one-handed in a loud pit is how
// "skipped, no reason given" becomes the most common reason.
const SKIP_REASONS = [
  { id: 'not_present', label: "Robot doesn't have one" },
  { id: 'blocked', label: 'Blocked / can’t reach' },
  { id: 'declined', label: 'Team said no' },
  { id: 'no_time', label: 'Out of time' },
]

// --- Upload shape ------------------------------------------------------------
// A modern phone shoots 3–8 MB per frame. Seven of those per team, times fifty
// teams, is a bucket full of pixels nobody will ever look at at full size — the
// photos are viewed on a laptop in an alliance-selection meeting. 1600px on the
// long edge at q0.85 lands around 200–400 kB and still resolves a bumper number.
const MAX_UPLOAD_DIM = 1600
const JPEG_QUALITY = 0.85

// --- Analysis resolution -----------------------------------------------------
// CRITICAL: every threshold below is expressed in the units produced at THIS
// resolution. Variance-of-Laplacian is not scale invariant — the same photo
// measured at 256px and at 4032px yields numbers an order of magnitude apart —
// so the analysis size is a fixed constant rather than "whatever the camera
// gave us", and it is recorded in the stored `quality` jsonb so a future
// calibration pass knows what the numbers meant.
//
// Running the grader at full resolution is also just slow: a 12MP getImageData
// plus a JS convolution is seconds of blocked main thread on a mid-range
// Android, i.e. a frozen viewfinder at the exact moment the scout expects
// feedback.
const ANALYSIS_DIM = 256

// COCO-SSD resizes its input to 300x300 internally, so feeding it anything much
// larger is wasted decode time. Kept separate from ANALYSIS_DIM so that tuning
// the sharpness threshold and tuning the detector cannot silently affect each
// other.
const DETECT_DIM = 320

// --- Quality thresholds ------------------------------------------------------
// NOTE — ALL FOUR OF THESE ARE EDUCATED GUESSES AND NEED CALIBRATING AGAINST
// REAL PIT PHOTOS. That is precisely why `robot_photos.quality` stores the
// measured values rather than just a pass/fail: after one event there will be a
// few hundred real measurements, some of them attached to photos a human later
// judged unusable, and these numbers should be re-derived from that data
// instead of from this comment. Until then they are deliberately LENIENT —
// a false reject costs a scout a retake and their trust in the tool; a false
// accept costs one mediocre photo.

// Variance of the 4-neighbour Laplacian over the 256px greyscale frame.
// Reference points from the usual OpenCV blur-detection recipe, rescaled to
// this analysis size: a well-focused indoor photo lands in the low hundreds,
// a hand-shake blur or a focus hunt lands under ~30. 55 sits in the gap, closer
// to the blurry end so that a legitimately flat subject (a plain white bumper
// filling the frame) is not rejected for being boring rather than soft.
const SHARPNESS_MIN = 55

// Mean luma, 0..1. Pit lighting is dim and phones expose for it, so the floor
// is low — this is meant to catch "shot with a finger over the lens" and
// "shot in the shadow under the field", not to enforce studio lighting.
const BRIGHTNESS_MIN = 0.18
const BRIGHTNESS_MAX = 0.88

// Venue ceiling lights behind the robot produce a frame whose MEAN brightness
// is perfectly reasonable while the robot itself is a silhouette. The mean
// cannot see that; the clipped fraction can.
const CLIP_LEVEL = 250 // 0..255 — a pixel this bright has no recoverable detail
const CLIP_FRACTION_MAX = 0.22

// Largest detected box as a fraction of frame area. A robot shot from a normal
// standing distance fills far more than this; 12% is the "you photographed the
// whole pit and the robot is in the middle of it" line.
const SUBJECT_MIN_AREA = 0.12

// COCO-SSD's own default is 0.5. It is lowered here because nothing in the
// COCO label set IS a robot, so every detection on a robot is the model
// reaching for the nearest thing it knows. See detectSubject() below.
const DETECT_MIN_SCORE = 0.35
const MAX_DETECTIONS = 8

// Venue wifi behind a captive portal will accept a TCP connection and then
// never deliver the weights. Without a deadline the "checking…" state is
// indistinguishable from a hang.
const MODEL_LOAD_TIMEOUT_MS = 15000

// --- Offline: what the queue does and does not cover --------------------------
//
// Saving a photo is TWO writes, not one:
//   1. the bytes    -> Storage object + a `files` row   (portalApi.uploadFile)
//   2. the link     -> a `robot_photos` row referencing files.id
//
// src/lib/offlineQueue.js covers step 2 and only step 2. Its `push()` does
// `supabase.from(table).insert(row.payload)`, so the payload handed to
// `enqueue('robot_photo', …)` must BE a valid `robot_photos` row — it is
// inserted verbatim. Handing it a `{ bucket, path, file }` envelope would queue
// a row the database rejects with 22P02/42703, which that queue classifies as
// terminal, i.e. the photo would be discarded rather than retried.
//
// So the order here is: upload the bytes, then either insert the link directly
// or hand the link to the queue. That makes the link durable and idempotent
// (client_uuid is unique; a duplicate delivery is treated as success), and it
// is a correct use of the existing queue rather than a second one.
//
// TODO(offlineQueue): step 1 has no offline path. There is no queue `kind` that
// uploads to Storage, and the queue cannot invent one — its whole push model is
// "insert this row". Until offlineQueue.js grows a storage-aware handler (a
// `robot_photo_upload` kind that puts the Blob in IndexedDB, uploads it on
// drain, then chains the robot_photos insert with the resulting file_id), a
// photo taken with genuinely no connectivity CANNOT be banked. This component
// therefore refuses to lose it: the frame stays on screen with a plain message
// and the scout can retry. Do NOT work around this by building a second queue
// here — extend that one.

// A failed upload should not read as "you did something wrong". These are the
// shapes a dead or captive-portal network produces.
function looksLikeNetworkFailure(message) {
  return /failed to fetch|network|timeout|timed out|offline|load failed|connection/i.test(
    message ?? ''
  )
}

// =============================================================================
// Pure image helpers — no React, no side effects, testable in isolation.
// =============================================================================

function fit(w, h, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(w, h))
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) }
}

// Draws any drawable source (video frame, decoded <img>, another canvas) into a
// fresh canvas no larger than maxDim on its long edge.
function drawToCanvas(source, sw, sh, maxDim) {
  const { w, h } = fit(sw, sh, maxDim)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, w, h)
  return canvas
}

function canvasToJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The browser could not encode that frame.'))),
      'image/jpeg',
      quality
    )
  })
}

// Sharpness + exposure in a single pass over the pixels.
function measure(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const w = canvas.width
  const h = canvas.height
  const { data } = ctx.getImageData(0, 0, w, h)

  // Rec.601 luma, cached into a Float32Array so the convolution below reads a
  // neighbour once instead of re-deriving it from three subpixels four times.
  const grey = new Float32Array(w * h)
  let sum = 0
  let clipped = 0
  for (let i = 0, p = 0; p < grey.length; i += 4, p += 1) {
    const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    grey[p] = y
    sum += y
    if (y >= CLIP_LEVEL) clipped += 1
  }

  // 4-neighbour Laplacian [0 1 0 / 1 -4 1 / 0 1 0]. Interior pixels only: a
  // border pixel has no complete neighbourhood, and padding it would invent a
  // hard edge at the frame boundary that inflates the variance of every photo
  // equally — which is worse than a slightly smaller sample.
  let lapSum = 0
  let lapSqSum = 0
  let n = 0
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x
      const lap = grey[i - w] + grey[i + w] + grey[i - 1] + grey[i + 1] - 4 * grey[i]
      lapSum += lap
      lapSqSum += lap * lap
      n += 1
    }
  }
  const lapMean = n ? lapSum / n : 0
  const variance = n ? Math.max(0, lapSqSum / n - lapMean * lapMean) : 0

  return {
    sharpness: Math.round(variance * 10) / 10,
    brightness: Math.round((sum / grey.length / 255) * 1000) / 1000,
    clipped: Math.round((clipped / grey.length) * 1000) / 1000,
  }
}

// -----------------------------------------------------------------------------
// THIS IS NOT ROBOT RECOGNITION.
//
// COCO has eighty classes and not one of them is a robot. What this actually
// answers is "does a general-purpose object detector find ANY confident,
// reasonably-sized thing in this frame" — a framing and liveness check. A real
// robot typically trips 'chair', 'suitcase', 'oven', 'truck' or 'motorcycle',
// because those are the nearest shapes the model owns. The returned class is
// recorded for curiosity and calibration only; nothing branches on it, and no
// string shown to the scout ever claims a robot was identified.
//
// So this catches: a photo of the floor, a photo of the inside of a pocket, a
// lens cap, a photo of the far wall of the venue. It does not and cannot
// verify that the thing photographed is the right team's robot.
// -----------------------------------------------------------------------------
async function detectSubject(detector, canvas) {
  const predictions = await detector.detect(canvas, MAX_DETECTIONS, DETECT_MIN_SCORE)
  if (!predictions?.length) {
    return { detected: false, confidence: null, label: null, subject_area: null }
  }
  const frameArea = canvas.width * canvas.height
  // Largest box, not highest score: subject size is the question being asked,
  // and the biggest confident thing in frame is the thing being photographed.
  let best = predictions[0]
  let bestArea = 0
  for (const p of predictions) {
    const area = (p.bbox[2] * p.bbox[3]) / frameArea
    if (area > bestArea) {
      bestArea = area
      best = p
    }
  }
  return {
    detected: true,
    confidence: Math.round(best.score * 100) / 100,
    label: best.class,
    subject_area: Math.round(bestArea * 1000) / 1000,
  }
}

// Turns measurements into instructions. Each issue is phrased as the physical
// thing to do next, not as the property that failed — "move closer" is
// actionable at arm's length from a robot; "subject area 0.07" is not.
function grade(q) {
  const issues = []

  if (q.sharpness != null && q.sharpness < SHARPNESS_MIN) {
    issues.push({ id: 'sharp', text: 'Too blurry. Hold steady, tap the robot to focus, shoot again.' })
  }

  if (q.brightness != null && q.brightness < BRIGHTNESS_MIN) {
    issues.push({ id: 'dark', text: 'Too dark. Move to better light or open the pit curtain.' })
  } else if (q.brightness > BRIGHTNESS_MAX || q.clipped > CLIP_FRACTION_MAX) {
    issues.push({ id: 'blown', text: 'Blown out. Put the ceiling lights behind you, not behind the robot.' })
  }

  // Both of these are skipped entirely when the detector is unavailable
  // (detected === null), which is the whole point of it degrading gracefully.
  if (q.detected === false) {
    issues.push({ id: 'empty', text: "Can't find a subject. Point at the robot and fill more of the frame." })
  } else if (q.detected === true && q.subject_area != null && q.subject_area < SUBJECT_MIN_AREA) {
    issues.push({ id: 'small', text: 'Subject is small in frame. Move closer.' })
  }

  return issues
}

function uuid() {
  // crypto.randomUUID needs a secure context. So does getUserMedia, so on the
  // camera path this always exists — but the file-picker fallback can run on
  // plain http on a school device, and a scout losing their work to a missing
  // API is not an acceptable trade for four lines.
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  const hex = [...crypto.getRandomValues(new Uint8Array(16))].map((b) =>
    b.toString(16).padStart(2, '0')
  )
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-4${hex
    .slice(6, 8)
    .join('')
    .slice(1)}-a${hex.slice(8, 10).join('').slice(1)}-${hex.slice(10, 16).join('')}`
}

// =============================================================================
// Component
// =============================================================================

export default function RobotCapture({ eventKey = null, teamNumber, onDone, onSaved }) {
  const { user } = useAuth()

  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const detectorRef = useRef(null)
  const fileInputRef = useRef(null)
  const aliveRef = useRef(true)
  const previewUrlRef = useRef(null)

  const [index, setIndex] = useState(0)
  // { [angleId]: { status: 'captured' | 'skipped', ... } }
  const [shots, setShots] = useState({})
  // 'live' | 'checking' | 'review' | 'saving'
  const [stage, setStage] = useState('live')
  const [pending, setPending] = useState(null)
  const [camera, setCamera] = useState({ status: 'idle', message: null })
  const [model, setModel] = useState('loading')
  const [saveError, setSaveError] = useState(null)
  const [skipOpen, setSkipOpen] = useState(false)
  const [finished, setFinished] = useState(false)

  const angle = ANGLES[index]
  const resolved = Object.keys(shots).length
  const capturedCount = useMemo(
    () => Object.values(shots).filter((s) => s.status === 'captured').length,
    [shots]
  )

  // --- Lifecycle -------------------------------------------------------------

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const stopCamera = useCallback(() => {
    // Every track, explicitly. A stream with a stopped video track but a live
    // audio track still shows the recording indicator, and a component that
    // leaves the camera light on gets uninstalled by the first scout who
    // notices — deservedly.
    const stream = streamRef.current
    if (stream) stream.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
  }, [])

  const startCamera = useCallback(async () => {
    if (!window.isSecureContext) {
      setCamera({
        status: 'unsupported',
        message:
          'Browsers only open a camera over HTTPS. This page is not on a secure connection, so use the photo picker below.',
      })
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setCamera({
        status: 'unsupported',
        message: 'This browser will not open a camera from a web page. Use the photo picker below.',
      })
      return
    }

    setCamera({ status: 'starting', message: null })
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // A bare string is an `ideal` constraint, not `exact` — a laptop with
        // only a front camera gets that camera instead of an
        // OverconstrainedError, which is the right failure mode for a tool that
        // also gets used at a build-season practice table.
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1440 } },
        audio: false,
      })
      if (!aliveRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        // iOS rejects play() outside a gesture in some contexts; the element is
        // muted + playsInline so it normally autoplays, and a rejection here is
        // recoverable by the scout tapping the frame.
        await videoRef.current.play().catch(() => {})
      }
      setCamera({ status: 'live', message: null })
    } catch (err) {
      if (!aliveRef.current) return
      const name = err?.name ?? ''
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setCamera({
          status: 'denied',
          message:
            'Camera access was refused. If you tapped “Don’t allow”, reload and choose Allow — or just use the photo picker below, which works everywhere.',
        })
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        setCamera({ status: 'unsupported', message: 'No camera found on this device.' })
      } else if (name === 'NotReadableError' || name === 'AbortError') {
        setCamera({
          status: 'unsupported',
          message: 'Another app is holding the camera. Close it, or use the photo picker below.',
        })
      } else {
        setCamera({ status: 'unsupported', message: err?.message ?? 'The camera would not start.' })
      }
    }
  }, [])

  useEffect(() => {
    startCamera()
    return stopCamera
  }, [startCamera, stopCamera])

  // Lazy-load the detector. THIS IS THE ONLY REFERENCE TO TENSORFLOW IN THE
  // TREE, and it is inside a dynamic import() inside an effect, so Rollup emits
  // it as its own async chunk that is fetched when this component mounts and
  // never lands in the entry bundle or the portal chunk. Anything that turns
  // these into static imports adds several megabytes to every visitor's first
  // page load, including sponsors reading the public site.
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
        const [tf, cocoSsd] = await Promise.all([
          import('@tensorflow/tfjs'),
          import('@tensorflow-models/coco-ssd'),
        ])
        await tf.ready()
        // lite_mobilenet_v2 is the smallest of the three bases and the only one
        // worth putting on a phone over venue wifi.
        const net = await cocoSsd.load({ base: 'lite_mobilenet_v2' })
        if (cancelled) {
          net.dispose?.()
          return
        }
        detectorRef.current = net
        settled = true
        // A load that finishes AFTER the deadline is still a win — it flips the
        // banner back off and later shots get the smart check.
        setModel('ready')
      } catch (err) {
        // Never rethrown, never surfaced as an error state. The scout keeps
        // shooting with sharpness + brightness and is simply told the smart
        // check is off. Nobody is debugging a WebGL context failure in a pit.
        console.warn('[capture] object detector unavailable:', err?.message ?? err)
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

  const clearPreview = useCallback(() => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = null
    }
  }, [])

  useEffect(() => clearPreview, [clearPreview])

  // --- Capture ---------------------------------------------------------------

  const runChecks = useCallback(
    async (source, sw, sh) => {
      setSaveError(null)
      setStage('checking')

      // Downscale FIRST, then measure the downscaled copy. Everything after
      // this point works on at most a 1600px image.
      const full = drawToCanvas(source, sw, sh, MAX_UPLOAD_DIM)
      const small = drawToCanvas(full, full.width, full.height, ANALYSIS_DIM)

      const metrics = measure(small)

      let detection = { detected: null, confidence: null, label: null, subject_area: null }
      if (detectorRef.current) {
        try {
          const detCanvas = drawToCanvas(full, full.width, full.height, DETECT_DIM)
          detection = await detectSubject(detectorRef.current, detCanvas)
        } catch (err) {
          // A detector that throws mid-session is treated exactly like one that
          // never loaded: unknown, not failed.
          console.warn('[capture] detection failed:', err?.message ?? err)
          setModel('unavailable')
        }
      }

      const blob = await canvasToJpeg(full, JPEG_QUALITY)
      const quality = {
        ...metrics,
        ...detection,
        // Recorded so the thresholds above can be re-derived later. A sharpness
        // number without the resolution it was measured at is not data.
        analysis_dim: ANALYSIS_DIM,
      }
      const issues = grade(quality)

      if (!aliveRef.current) return
      clearPreview()
      previewUrlRef.current = URL.createObjectURL(blob)
      setPending({
        blob,
        url: previewUrlRef.current,
        quality,
        issues,
        width: full.width,
        height: full.height,
      })
      setStage('review')
    },
    [clearPreview]
  )

  const shoot = useCallback(async () => {
    const video = videoRef.current
    if (!video || !video.videoWidth) return
    try {
      await runChecks(video, video.videoWidth, video.videoHeight)
    } catch (err) {
      setSaveError(err?.message ?? 'That frame could not be processed.')
      setStage('live')
    }
  }, [runChecks])

  const pickFile = useCallback(
    async (file) => {
      if (!file) return
      const url = URL.createObjectURL(file)
      try {
        const img = new Image()
        img.src = url
        // decode() rather than onload: it resolves only once the bitmap is
        // actually usable, so drawImage below cannot land on an empty frame.
        // Browsers apply EXIF orientation during this decode, so a portrait
        // phone photo arrives upright.
        await img.decode()
        await runChecks(img, img.naturalWidth, img.naturalHeight)
      } catch (err) {
        setSaveError(err?.message ?? 'That image could not be read.')
        setStage('live')
      } finally {
        URL.revokeObjectURL(url)
      }
    },
    [runChecks]
  )

  // --- Sequence navigation ---------------------------------------------------

  const advance = useCallback(
    (from, next) => {
      const total = ANGLES.length
      for (let step = 1; step <= total; step += 1) {
        const i = (from + step) % total
        if (!next[ANGLES[i].id]) {
          setIndex(i)
          setStage('live')
          return
        }
      }
      setFinished(true)
    },
    []
  )

  const retake = useCallback(() => {
    clearPreview()
    setPending(null)
    setSaveError(null)
    setStage('live')
  }, [clearPreview])

  // NOTE: retaking an angle that already SAVED adds a second robot_photos row
  // rather than replacing the first — there is no unique index on
  // (event_key, team_number, angle), and the RLS policies give a `member`
  // insert and select but not delete, so this component cannot clean up after
  // itself without a lead's privileges. Anything reading these photos should
  // take the newest row per angle by created_at. The alternative — refusing to
  // retake a saved angle — trades a duplicate row for an unusable photo, which
  // is the worse end of the deal.
  const jumpTo = useCallback(
    (i) => {
      clearPreview()
      setPending(null)
      setSaveError(null)
      setSkipOpen(false)
      setFinished(false)
      setIndex(i)
      setStage('live')
    },
    [clearPreview]
  )

  // --- Save ------------------------------------------------------------------

  const accept = useCallback(async () => {
    if (!pending || stage === 'saving') return
    if (!supabase) {
      setSaveError('The portal is not connected to a backend, so photos cannot be saved.')
      return
    }
    if (!user?.id) {
      setSaveError('Your session expired. Sign in again before saving photos.')
      return
    }

    setStage('saving')
    setSaveError(null)

    const shortId = uuid().slice(0, 8)
    const clientUuid = uuid()
    const path = `pit/${eventKey ?? 'no-event'}/${teamNumber}/${angle.id}-${shortId}.jpg`
    // A File, not a Blob: uploadFile reads .name for the default title and
    // sha256Hex reads .arrayBuffer(), and a bare Blob has no name.
    const file = new File([pending.blob], `${teamNumber}-${angle.id}-${shortId}.jpg`, {
      type: 'image/jpeg',
    })
    const sha256 = await sha256Hex(file)

    const finish = (delivery) => {
      if (!aliveRef.current) return
      const next = {
        ...shots,
        [angle.id]: {
          status: 'captured',
          delivery,
          quality: pending.quality,
          bytes: pending.blob.size,
          client_uuid: clientUuid,
          path,
        },
      }
      setShots(next)
      clearPreview()
      setPending(null)
      onSaved?.({ angle: angle.id, delivery, quality: pending.quality, path })
      advance(index, next)
    }

    const fail = (message) => {
      if (!aliveRef.current) return
      // Back to review, NOT forward. The frame stays on screen and the shot is
      // not marked done, so a failure can never quietly consume a photo.
      setStage('review')
      setSaveError(message)
    }

    // --- 1. the bytes --------------------------------------------------------
    // Attempted even when isOnline() is false: that flag only reports whether a
    // network interface exists, and it is wrong in both directions at a venue.
    // A doomed attempt costs a second; a skipped attempt that would have worked
    // costs the photo.
    const { data: fileRow, error: upErr } = await uploadFile({
      bucket: 'media',
      path,
      file,
      metadata: {
        title: `Team ${teamNumber} — ${angle.label}`,
        kind: 'photo',
        season: new Date().getFullYear(),
        sha256,
      },
    })

    if (upErr || !fileRow) {
      // See the TODO(offlineQueue) note above: there is no queue kind that can
      // carry image bytes, so this is the one case that cannot be banked. Say
      // so in words a scout can act on rather than surfacing "Failed to fetch".
      if (!isOnline() || looksLikeNetworkFailure(upErr)) {
        fail(
          'No connection, so the photo could not be uploaded. It is still on screen — move somewhere with signal and press Use again. Do not leave this team until it saves.'
        )
      } else {
        fail(upErr ?? 'The upload did not complete.')
      }
      return
    }

    // --- 2. the link ---------------------------------------------------------
    const row = {
      client_uuid: clientUuid,
      event_key: eventKey,
      team_number: Number(teamNumber),
      angle: angle.id,
      file_id: fileRow.id,
      quality: pending.quality,
      taken_by: user.id,
    }

    // The bytes are already safe in the bucket, so from here the row is the only
    // thing at risk — and the row is exactly what offlineQueue can carry.
    const queueRow = async () => {
      try {
        await enqueue('robot_photo', row)
        return true
      } catch (err) {
        console.warn('[capture] could not queue the photo row:', err?.message ?? err)
        return false
      }
    }

    if (!isOnline()) {
      if (await queueRow()) {
        finish('queued')
        return
      }
      fail('The photo uploaded but could not be saved to this phone to sync later.')
      return
    }

    const { error: rowErr } = await supabase.from('robot_photos').insert(row)
    if (!rowErr) {
      finish('uploaded')
      return
    }

    // A transport failure between the upload and the insert is exactly what the
    // queue exists for. A rejection by the database (RLS, a bad angle value) is
    // not, and retrying it forever would only hide it.
    if (looksLikeNetworkFailure(rowErr.message) && (await queueRow())) {
      finish('queued')
      return
    }

    // The object and its `files` row exist; only the robot_photos link failed.
    // Stated plainly, because "uploaded but not attached to this team" is a
    // genuinely different situation from "did not upload", and the recovery is
    // different too.
    fail(
      `The photo uploaded but was not linked to team ${teamNumber}: ${rowErr.message} A lead can re-link it from Files.`
    )
  }, [pending, stage, user, eventKey, teamNumber, angle, shots, index, advance, clearPreview, onSaved])

  const skip = useCallback(
    (reason) => {
      const next = {
        ...shots,
        [angle.id]: { status: 'skipped', reason: reason.id, reasonLabel: reason.label },
      }
      setShots(next)
      setSkipOpen(false)
      clearPreview()
      setPending(null)
      advance(index, next)
    },
    [shots, angle, index, advance, clearPreview]
  )

  // --- Render ----------------------------------------------------------------

  if (finished) {
    return (
      <Summary
        teamNumber={teamNumber}
        shots={shots}
        onReview={(i) => jumpTo(i)}
        onDone={() => {
          stopCamera()
          onDone?.({ teamNumber, eventKey, shots })
        }}
      />
    )
  }

  const busy = stage === 'checking' || stage === 'saving'
  const reviewing = stage === 'review' && pending
  const passed = reviewing && pending.issues.length === 0
  const cameraLive = camera.status === 'live'
  const cameraBlocked = camera.status === 'denied' || camera.status === 'unsupported'

  return (
    <div className={styles.capture}>
      <header className={styles.head}>
        <div className={styles.headMain}>
          <span className={styles.eyebrow}>Pit photos</span>
          <h2 className={styles.team}>
            Team {teamNumber}
            {eventKey && <span className={styles.event}>{eventKey}</span>}
          </h2>
        </div>
        <span className={styles.count}>
          <strong>{resolved}</strong> / {ANGLES.length}
          <span className={styles.countSub}>{capturedCount} shot</span>
        </span>
      </header>

      <div
        className={styles.progress}
        role="progressbar"
        aria-valuenow={resolved}
        aria-valuemin={0}
        aria-valuemax={ANGLES.length}
        aria-label="Angles completed"
      >
        <span
          className={styles.progressFill}
          style={{ '--p': resolved / ANGLES.length }}
          aria-hidden="true"
        />
      </div>

      <nav className={styles.strip} aria-label="Capture sequence">
        {ANGLES.map((a, i) => {
          const shot = shots[a.id]
          const isCurrent = i === index
          return (
            <button
              key={a.id}
              type="button"
              className={[
                styles.step,
                isCurrent ? styles.stepCurrent : '',
                shot?.status === 'captured' ? styles.stepDone : '',
                shot?.status === 'skipped' ? styles.stepSkipped : '',
              ]
                .filter(Boolean)
                .join(' ')}
              aria-current={isCurrent ? 'step' : undefined}
              onClick={() => jumpTo(i)}
              disabled={busy}
            >
              <span className={styles.stepMark} aria-hidden="true">
                {shot?.status === 'captured' ? (
                  <Icon name="check" size={13} />
                ) : shot?.status === 'skipped' ? (
                  <Icon name="close" size={13} />
                ) : (
                  i + 1
                )}
              </span>
              {a.label}
              {shot?.status === 'skipped' && <span className="sr-only"> — skipped</span>}
              {shot?.status === 'captured' && <span className="sr-only"> — captured</span>}
            </button>
          )
        })}
      </nav>

      {/* The one thing the scout must not have to hunt for. */}
      <div className={styles.instruction}>
        <span className={styles.instructionLabel}>{angle.label}</span>
        <p className={styles.instructionHint}>{angle.hint}</p>
      </div>

      {model === 'unavailable' && (
        <p className={styles.notice}>
          <Icon name="alert" size={15} />
          <span>
            Smart framing check is unavailable on this connection. Focus and lighting are still
            checked — shoot as normal.
          </span>
        </p>
      )}

      <div className={styles.stage}>
        {/* object-fit: contain on BOTH the live view and the review image. With
            cover, the scout frames against a cropped preview and the saved
            photo is wider than what they composed — and the "move closer"
            check would be measuring a frame they never saw. */}
        <video
          ref={videoRef}
          className={`${styles.media} ${reviewing || !cameraLive ? styles.mediaHidden : ''}`}
          playsInline
          muted
          autoPlay
        />

        {reviewing && (
          <img className={styles.media} src={pending.url} alt={`${angle.label} — captured frame`} />
        )}

        {camera.status === 'starting' && (
          <div className={styles.stageNote} role="status">
            <span className={portal.spinner} aria-hidden="true" />
            <p>Opening the camera…</p>
          </div>
        )}

        {cameraBlocked && !reviewing && (
          <div className={styles.stageNote}>
            <span className={styles.stageIcon} aria-hidden="true">
              <Icon name="alert" size={22} />
            </span>
            <p className={styles.stageNoteTitle}>No live camera</p>
            <p className={styles.stageNoteText}>{camera.message}</p>
          </div>
        )}

        {stage === 'checking' && (
          <div className={styles.checking} role="status" aria-live="polite">
            <span className={portal.spinner} aria-hidden="true" />
            <p>Checking the shot…</p>
          </div>
        )}
      </div>

      {reviewing && (
        <div
          className={`${styles.verdict} ${passed ? styles.verdictPass : styles.verdictFail}`}
          role="status"
          aria-live="polite"
        >
          <p className={styles.verdictTitle}>
            <Icon name={passed ? 'check' : 'alert'} size={17} />
            {passed ? 'Looks good' : pending.issues.length === 1 ? 'One problem' : `${pending.issues.length} problems`}
          </p>
          {pending.issues.length > 0 && (
            <ul className={styles.issues}>
              {pending.issues.map((it) => (
                <li key={it.id} className={styles.issue}>
                  {it.text}
                </li>
              ))}
            </ul>
          )}
          <dl className={styles.metrics}>
            <Metric
              label="Focus"
              value={pending.quality.sharpness}
              bad={pending.quality.sharpness < SHARPNESS_MIN}
            />
            <Metric
              label="Light"
              value={pending.quality.brightness}
              bad={
                pending.quality.brightness < BRIGHTNESS_MIN ||
                pending.quality.brightness > BRIGHTNESS_MAX
              }
            />
            <Metric
              label="Subject"
              value={
                pending.quality.detected === null
                  ? '—'
                  : pending.quality.detected
                    ? `${Math.round((pending.quality.subject_area ?? 0) * 100)}%`
                    : 'none'
              }
              bad={
                pending.quality.detected === false ||
                (pending.quality.detected === true &&
                  (pending.quality.subject_area ?? 0) < SUBJECT_MIN_AREA)
              }
            />
            <Metric label="Size" value={formatBytes(pending.blob.size)} />
          </dl>
        </div>
      )}

      <div className={portal.errorSlot} role="alert" aria-live="assertive">
        {saveError && (
          <span className={portal.error}>
            <Icon name="alert" size={15} />
            {saveError}
          </span>
        )}
      </div>

      {/* Sticky so the decision is always under the thumb, however far the
          verdict list pushes the page down. */}
      <div className={styles.bar}>
        {reviewing ? (
          <>
            <button
              type="button"
              className={`${styles.action} ${styles.actionGhost}`}
              onClick={retake}
              disabled={stage === 'saving'}
            >
              <Icon name="close" size={18} />
              Retake
            </button>
            <button
              type="button"
              className={`${styles.action} ${passed ? styles.actionPrimary : styles.actionOverride}`}
              onClick={accept}
              disabled={stage === 'saving'}
            >
              {stage === 'saving' ? (
                <>
                  <span className={portal.spinnerSm} aria-hidden="true" />
                  Saving…
                </>
              ) : (
                <>
                  <Icon name="check" size={18} />
                  {passed ? 'Use this shot' : 'Use anyway'}
                </>
              )}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className={`${styles.action} ${styles.actionGhost}`}
              onClick={() => setSkipOpen((v) => !v)}
              aria-expanded={skipOpen}
              disabled={busy}
            >
              Skip
            </button>

            {cameraLive ? (
              <button
                type="button"
                className={styles.shutter}
                onClick={shoot}
                disabled={busy}
                aria-label={`Capture the ${angle.label.toLowerCase()} photo`}
              >
                <span className={styles.shutterCore} aria-hidden="true" />
              </button>
            ) : (
              <span className={styles.shutterGap} aria-hidden="true" />
            )}

            {/* Always present, not only on failure: some school devices grant
                the camera and then hand back a black stream, and the scout
                needs an escape hatch that does not depend on us detecting
                that. */}
            <button
              type="button"
              className={`${styles.action} ${cameraLive ? styles.actionGhost : styles.actionPrimary}`}
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
            >
              <Icon name="folder" size={18} />
              {cameraLive ? 'Photo' : 'Take a photo'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0]
                // Cleared so picking the same file twice still fires a change.
                e.target.value = ''
                pickFile(f)
              }}
            />
          </>
        )}
      </div>

      {skipOpen && !reviewing && (
        <div className={styles.skipSheet}>
          <p className={styles.skipTitle}>Why is there no {angle.label.toLowerCase()} photo?</p>
          <div className={styles.skipGrid}>
            {SKIP_REASONS.map((r) => (
              <button key={r.id} type="button" className={styles.skipBtn} onClick={() => skip(r)}>
                {r.label}
              </button>
            ))}
          </div>
          <button type="button" className={styles.skipCancel} onClick={() => setSkipOpen(false)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}

function Metric({ label, value, bad = false }) {
  return (
    <div className={`${styles.metric} ${bad ? styles.metricBad : ''}`}>
      <dt className={styles.metricLabel}>{label}</dt>
      <dd className={styles.metricValue}>{value}</dd>
    </div>
  )
}

// NOTE for whoever wires this in: skips are reported here and handed to
// onDone({ shots }) rather than written to the database. `robot_photos` has no
// column for "deliberately absent", and inserting a row with a null file_id
// would put a photo-less photo in front of every gallery that joins on it.
// Persist skips wherever the pit form for this team lives.
function Summary({ teamNumber, shots, onReview, onDone }) {
  const captured = ANGLES.filter((a) => shots[a.id]?.status === 'captured')
  const skipped = ANGLES.filter((a) => shots[a.id]?.status === 'skipped')
  const queued = captured.filter((a) => shots[a.id].delivery === 'queued')

  return (
    <div className={styles.capture}>
      <div className={styles.doneCard}>
        <span className={styles.doneIcon} aria-hidden="true">
          <Icon name="check" size={26} />
        </span>
        <h2 className={styles.doneTitle}>Team {teamNumber} done</h2>
        <p className={styles.doneText}>
          {captured.length} photo{captured.length === 1 ? '' : 's'}
          {skipped.length > 0 && `, ${skipped.length} angle${skipped.length === 1 ? '' : 's'} skipped`}.
          {queued.length > 0 && ` ${queued.length} still waiting to upload — keep the portal open when you get signal.`}
        </p>
      </div>

      <ul className={styles.doneList}>
        {ANGLES.map((a, i) => {
          const shot = shots[a.id]
          return (
            <li key={a.id} className={styles.doneRow}>
              <span className={styles.doneRowMain}>
                <span className={styles.doneRowLabel}>{a.label}</span>
                <span className={styles.doneRowMeta}>
                  {shot?.status === 'captured'
                    ? `${formatBytes(shot.bytes)} · ${shot.delivery === 'queued' ? 'queued' : 'uploaded'}`
                    : shot?.status === 'skipped'
                      ? `skipped — ${shot.reasonLabel}`
                      : 'not taken'}
                </span>
              </span>
              <button type="button" className={styles.doneRedo} onClick={() => onReview(i)}>
                {shot?.status === 'captured' ? 'Retake' : 'Shoot'}
              </button>
            </li>
          )
        })}
      </ul>

      <div className={styles.bar}>
        <button type="button" className={`${styles.action} ${styles.actionPrimary}`} onClick={onDone}>
          <Icon name="check" size={18} />
          Finish this team
        </button>
      </div>
    </div>
  )
}
