import { useEffect, useRef, useState } from 'react'
import Icon from '../../Icon'
import { visionModelConfig, saveScoutSettings } from '../../../lib/scoutingApi'
import portal from '../Portal.module.css'
import styles from './Vision.module.css'

// =============================================================================
// VisionModel — a lead's control for WHICH detector the pipeline runs.
//
// This is the honesty lever made operable. The default is a generic model that
// cannot tell a robot from a referee; here a lead points the pipeline at a real
// FRC-trained detector instead. The model runs ON THE PHONE (migration 0012
// stores only its URL + class names), so this is not a third-party service — it
// is your model, hosted wherever you like, executed locally.
//
// Rendered for lead+ only (gated by the parent). A member sees which model is
// active in the capture screen's chip, but cannot change it — same lever pattern
// as the active event and the scouting window.
// =============================================================================

const parseLabels = (text) =>
  String(text ?? '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)

const clampSize = (v) => {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return 640
  return Math.min(2048, Math.max(64, n))
}

export default function VisionModel({ onSaved }) {
  const [open, setOpen] = useState(false)
  const [cfg, setCfg] = useState({ url: '', name: '', labelsText: '', size: 640 })
  const [current, setCurrent] = useState(null) // the saved summary, for the closed header
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [savedMsg, setSavedMsg] = useState(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    ;(async () => {
      const { data } = await visionModelConfig()
      if (!aliveRef.current) return
      if (data) {
        const labels = Array.isArray(data.vision_model_labels) ? data.vision_model_labels : []
        setCfg({
          url: data.vision_model_url ?? '',
          name: data.vision_model_name ?? '',
          labelsText: labels.join(', '),
          size: data.vision_model_size ?? 640,
        })
        setCurrent({ url: data.vision_model_url, name: data.vision_model_name, count: labels.length })
      }
      setLoading(false)
    })()
    return () => {
      aliveRef.current = false
    }
  }, [])

  const set = (k) => (e) => setCfg((c) => ({ ...c, [k]: e.target.value }))

  const persist = async (patch, nextSummary) => {
    setSaving(true)
    setError(null)
    setSavedMsg(null)
    const { error: err } = await saveScoutSettings(patch)
    if (!aliveRef.current) return
    setSaving(false)
    if (err) {
      setError(err)
      return
    }
    setCurrent(nextSummary)
    setSavedMsg('Saved — the next capture will use it.')
    onSaved?.()
  }

  const save = () => {
    const url = cfg.url.trim()
    if (url && !/^https?:\/\//i.test(url)) {
      setError('The model URL must be a full http(s) URL to a TF.js model.json.')
      return
    }
    const labels = parseLabels(cfg.labelsText)
    persist(
      {
        vision_model_url: url || null,
        vision_model_name: cfg.name.trim() || null,
        vision_model_labels: labels,
        vision_model_size: clampSize(cfg.size),
      },
      { url: url || null, name: cfg.name.trim() || null, count: labels.length }
    )
  }

  const reset = () => {
    setCfg({ url: '', name: '', labelsText: '', size: 640 })
    persist(
      { vision_model_url: null, vision_model_name: null, vision_model_labels: [], vision_model_size: 640 },
      { url: null, name: null, count: 0 }
    )
  }

  const activeLabel = loading
    ? 'Loading…'
    : current?.url
      ? `Trained model · ${current.name || 'custom'}${current.count ? ` (${current.count} classes)` : ''}`
      : 'Built-in generic model'

  return (
    <div className={`${styles.modelCard} ${open ? styles.modelCardOpen : ''}`}>
      <button type="button" className={styles.modelHead} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={styles.modelHeadMain}>
          <Icon name="cpu" size={16} />
          <span>
            <span className={styles.modelHeadLabel}>Detection model</span>
            <span className={styles.modelHeadValue}>{activeLabel}</span>
          </span>
        </span>
        <Icon name={open ? 'arrowUp' : 'arrowRight'} size={16} />
      </button>

      {open && (
        <div className={styles.modelBody}>
          <p className={styles.modelHelp}>
            The pipeline runs a generic detector by default. To actually track robots or game pieces,
            train an object detector (e.g. Ultralytics YOLO on your GPU box, or a Roboflow project —
            what other teams use), export it to <strong>TensorFlow.js</strong>, host the{' '}
            <code>model.json</code> and its weight shards anywhere reachable (the portal's own media
            bucket works), and paste the URL here. It then runs on the device, no service in the loop.
          </p>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Model URL (model.json)</span>
            <input
              className={styles.input}
              value={cfg.url}
              onChange={set('url')}
              placeholder="https://…/model.json  (blank = built-in generic model)"
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>

          <div className={styles.fieldRow}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Name</span>
              <input
                className={styles.input}
                value={cfg.name}
                onChange={set('name')}
                placeholder="FRC 2026 robots v1"
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Input size (px)</span>
              <input
                className={styles.input}
                type="number"
                inputMode="numeric"
                value={cfg.size}
                onChange={set('size')}
                placeholder="640"
              />
              <span className={styles.fieldHint}>The square size the model was exported at (YOLO: 640).</span>
            </label>
          </div>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Class names</span>
            <textarea
              className={styles.textarea}
              rows={2}
              value={cfg.labelsText}
              onChange={set('labelsText')}
              placeholder="robot, game piece   (in the model's class order, comma or line separated)"
            />
            <span className={styles.fieldHint}>
              In the exact order the model outputs them — the `names` list from training.
            </span>
          </label>

          <div className={portal.errorSlot} role="status" aria-live="polite">
            {error && (
              <span className={portal.error}>
                <Icon name="alert" size={15} />
                {error}
              </span>
            )}
            {savedMsg && !error && <span className={styles.modelSaved}>{savedMsg}</span>}
          </div>

          <div className={styles.modelActions}>
            <button type="button" className={styles.modelReset} onClick={reset} disabled={saving}>
              Use built-in model
            </button>
            <button type="button" className={styles.startBtn} onClick={save} disabled={saving}>
              {saving ? (
                <>
                  <span className={portal.spinnerSm} aria-hidden="true" />
                  Saving…
                </>
              ) : (
                <>
                  <Icon name="check" size={18} />
                  Save model
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
