import { useMemo } from 'react'
import Icon from '../../Icon'
import styles from './Scouting.module.css'

// -----------------------------------------------------------------------------
// Renders a scout_forms.fields definition as inputs, grouped into sections.
//
// The design constraint is not "look nice" — it is a student holding a phone in
// one hand, in a loud room, watching a robot they must not look away from. Tap
// targets are large, the counter never animates, and nothing here can lose a
// value mid-match.
// -----------------------------------------------------------------------------

export default function FormRenderer({ fields, value, onChange, disabled = false }) {
  // Group by `section` while preserving definition order — a mentor's ordering
  // is deliberate and usually mirrors the order things happen in a match.
  const sections = useMemo(() => {
    const out = []
    let current = null
    for (const f of fields ?? []) {
      const name = f.section || ''
      if (!current || current.name !== name) {
        current = { name, fields: [] }
        out.push(current)
      }
      current.fields.push(f)
    }
    return out
  }, [fields])

  const set = (key, v) => onChange({ ...value, [key]: v })

  return (
    <div className={styles.form}>
      {sections.map((section, i) => (
        <section key={section.name || i} className={styles.section}>
          {section.name && <h3 className={styles.sectionHead}>{section.name}</h3>}
          <div className={styles.fields}>
            {section.fields.map((f) => (
              <Field
                key={f.key}
                field={f}
                value={value?.[f.key]}
                onChange={(v) => set(f.key, v)}
                disabled={disabled}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function Field({ field, value, onChange, disabled }) {
  const { type, label, help, required } = field

  if (type === 'heading') {
    return <h4 className={styles.fieldHeading}>{label}</h4>
  }

  return (
    <div className={`${styles.field} ${type === 'counter' ? styles.fieldWide : ''}`}>
      <label className={styles.fieldLabel} htmlFor={`f-${field.key}`}>
        {label}
        {required && <span className={styles.req} aria-label="required"> *</span>}
      </label>
      {help && <span className={styles.fieldHelp}>{help}</span>}
      <Control field={field} value={value} onChange={onChange} disabled={disabled} />
    </div>
  )
}

function Control({ field, value, onChange, disabled }) {
  const id = `f-${field.key}`

  switch (field.type) {
    case 'counter':
      return <Counter field={field} value={value} onChange={onChange} disabled={disabled} />

    case 'boolean':
      // A two-state toggle rather than a checkbox: a checkbox has one clear
      // state and one ambiguous one ("unchecked" reads as both "no" and "not
      // answered"). Scouting needs that distinction to survive.
      return (
        <div className={styles.toggle} role="group" aria-labelledby={id}>
          {[
            { v: true, label: 'Yes' },
            { v: false, label: 'No' },
          ].map((o) => (
            <button
              key={String(o.v)}
              type="button"
              disabled={disabled}
              aria-pressed={value === o.v}
              className={`${styles.toggleBtn} ${value === o.v ? styles.toggleOn : ''}`}
              onClick={() => onChange(value === o.v ? undefined : o.v)}
            >
              {o.label}
            </button>
          ))}
        </div>
      )

    case 'rating': {
      const max = field.max ?? 5
      return (
        <div className={styles.rating} role="group">
          {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              type="button"
              disabled={disabled}
              aria-label={`${n} of ${max}`}
              aria-pressed={value === n}
              className={`${styles.ratingBtn} ${value >= n ? styles.ratingOn : ''}`}
              onClick={() => onChange(value === n ? undefined : n)}
            >
              {n}
            </button>
          ))}
        </div>
      )
    }

    case 'select':
      return (
        <div className={styles.chipRow} role="group">
          {(field.options ?? []).map((o) => (
            <button
              key={o}
              type="button"
              disabled={disabled}
              aria-pressed={value === o}
              className={`${styles.optChip} ${value === o ? styles.optOn : ''}`}
              onClick={() => onChange(value === o ? undefined : o)}
            >
              {o}
            </button>
          ))}
        </div>
      )

    case 'multiselect': {
      const arr = Array.isArray(value) ? value : []
      return (
        <div className={styles.chipRow} role="group">
          {(field.options ?? []).map((o) => {
            const on = arr.includes(o)
            return (
              <button
                key={o}
                type="button"
                disabled={disabled}
                aria-pressed={on}
                className={`${styles.optChip} ${on ? styles.optOn : ''}`}
                onClick={() => onChange(on ? arr.filter((x) => x !== o) : [...arr, o])}
              >
                {o}
              </button>
            )
          })}
        </div>
      )
    }

    case 'timer':
      return <Timer value={value} onChange={onChange} disabled={disabled} />

    case 'textarea':
      return (
        <textarea
          id={id}
          className={styles.textarea}
          rows={3}
          disabled={disabled}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />
      )

    case 'number':
      return (
        <input
          id={id}
          type="number"
          inputMode="numeric"
          className={styles.input}
          disabled={disabled}
          min={field.min}
          max={field.max}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        />
      )

    default:
      return (
        <input
          id={id}
          type="text"
          className={styles.input}
          disabled={disabled}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />
      )
  }
}

/**
 * The counter. Tapped more than everything else on this screen combined.
 *
 * Deliberately un-animated: per the project's own motion rules, an action
 * repeated dozens of times per match must not animate — it makes the interface
 * feel laggy and disconnected precisely when the scout is trying to keep up
 * with the field. The only feedback is an instant press scale, which the CSS
 * keeps at var(--dur-press).
 */
function Counter({ field, value, onChange, disabled }) {
  const n = Number.isFinite(value) ? value : 0
  const min = field.min ?? 0
  const max = field.max ?? 999

  const bump = (d) => {
    const next = Math.min(max, Math.max(min, n + d))
    if (next !== n) {
      onChange(next)
      // A short haptic tick where supported. In a loud room this is often the
      // only confirmation the scout actually perceives — they are watching the
      // field, not the screen.
      if (navigator.vibrate) navigator.vibrate(8)
    }
  }

  return (
    <div className={styles.counter}>
      <button
        type="button"
        className={styles.counterBtn}
        onClick={() => bump(-1)}
        disabled={disabled || n <= min}
        aria-label={`Decrease ${field.label}`}
      >
        <Icon name="close" size={20} />
      </button>
      <output className={styles.counterValue} aria-live="off">
        {n}
      </output>
      <button
        type="button"
        className={`${styles.counterBtn} ${styles.counterPlus}`}
        onClick={() => bump(1)}
        disabled={disabled || n >= max}
        aria-label={`Increase ${field.label}`}
      >
        <Icon name="plus" size={22} />
      </button>
    </div>
  )
}

function Timer({ value, onChange, disabled }) {
  const running = value?.startedAt != null
  const total = value?.total ?? 0

  const toggle = () => {
    if (running) {
      onChange({ total: total + (Date.now() - value.startedAt) / 1000, startedAt: null })
    } else {
      onChange({ total, startedAt: Date.now() })
    }
  }

  return (
    <div className={styles.counter}>
      <button
        type="button"
        className={`${styles.counterBtn} ${running ? styles.timerOn : ''}`}
        onClick={toggle}
        disabled={disabled}
      >
        {running ? 'Stop' : 'Start'}
      </button>
      <output className={styles.counterValue}>{total.toFixed(1)}s</output>
      <button
        type="button"
        className={styles.counterBtn}
        onClick={() => onChange({ total: 0, startedAt: null })}
        disabled={disabled || (!total && !running)}
        aria-label="Reset timer"
      >
        <Icon name="close" size={18} />
      </button>
    </div>
  )
}

/** Required-field check, shared by every scouting flow so they agree. */
export function missingRequired(fields, value) {
  return (fields ?? [])
    .filter((f) => f.required && f.type !== 'heading')
    .filter((f) => {
      const v = value?.[f.key]
      if (v === undefined || v === null || v === '') return true
      if (Array.isArray(v) && v.length === 0) return true
      return false
    })
    .map((f) => f.label)
}
