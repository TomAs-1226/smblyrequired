import { useCallback, useEffect, useState } from 'react'
import Icon from '../../Icon'
import { useAuth } from '../../../lib/auth'
import { listEvents, scoutControl, saveScoutSettings } from '../../../lib/scoutingApi'
import { Loading, ErrorState } from '../ui'
import styles from '../Portal.module.css'
import css from './Control.module.css'

// -----------------------------------------------------------------------------
// Event control — leadership sets the active event and the scouting window.
//
// These are the two levers migration 0010 enforces in the database. This screen
// only presents them; a scout who never sees it is still held to whatever a lead
// sets here, because the trigger — not this form — is the authority. min: 'lead'
// keeps it out of a scout's tabs, but that is convenience, not the boundary.
// -----------------------------------------------------------------------------

const SEASON = new Date().getFullYear()

export default function Control() {
  const { atLeast } = useAuth()
  const canEdit = atLeast('lead')

  const [events, setEvents] = useState([])
  const [ctrl, setCtrl] = useState(null)
  const [form, setForm] = useState(null)
  const [state, setState] = useState({ loading: true, error: null })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const load = useCallback(async () => {
    setState({ loading: true, error: null })
    const [{ data: evs }, { data: c, error }] = await Promise.all([
      listEvents(SEASON),
      scoutControl(),
    ])
    setEvents(evs)
    setCtrl(c)
    setForm(
      c
        ? {
            active_event_key: c.active_event_key ?? '',
            lock_enabled: c.lock_enabled,
            window_start: (c.window_start ?? '08:00').slice(0, 5),
            window_end: (c.window_end ?? '18:00').slice(0, 5),
            timezone: c.timezone ?? 'America/Los_Angeles',
          }
        : null
    )
    setState({ loading: false, error })
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function save() {
    setSaving(true)
    setSaved(false)
    const { error } = await saveScoutSettings({
      active_event_key: form.active_event_key || null,
      lock_enabled: form.lock_enabled,
      window_start: form.window_start,
      window_end: form.window_end,
      timezone: form.timezone,
    })
    setSaving(false)
    if (error) {
      setState((s) => ({ ...s, error }))
      return
    }
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
    load()
  }

  if (state.loading) return <Loading rows={4} label="Loading control" />
  if (state.error) return <ErrorState error={state.error} onRetry={load} />
  if (!form) return <ErrorState error="No settings row found." onRetry={load} />

  const openNow = ctrl?.open_now
  const activeName =
    events.find((e) => e.key === ctrl?.active_event_key)?.short_name ?? ctrl?.active_event_key

  return (
    <div className={styles.stack}>
      {/* Live status, the same computation the enforcement trigger uses, so this
          card and the database can never disagree about whether scouting is open. */}
      <div className={`${css.status} ${openNow ? css.statusOpen : css.statusClosed}`}>
        <span className={css.statusDot} aria-hidden="true" />
        <div>
          <span className={css.statusHead}>
            Scouting is {openNow ? 'open' : 'closed'} right now
          </span>
          <span className={css.statusSub}>
            {ctrl?.active_event_key
              ? `Active event: ${activeName}`
              : 'No active event set — scouts can record against any event.'}
            {ctrl?.lock_enabled &&
              ` · window ${form.window_start}–${form.window_end} ${form.timezone.split('/')[1]?.replace('_', ' ')}`}
          </span>
        </div>
      </div>

      {!canEdit && (
        <p className={styles.uploadNote}>
          Only a lead, mentor, or admin can change these. You are seeing the current settings.
        </p>
      )}

      <section>
        <h2 className={styles.sectionTitle}>Active event</h2>
        <p className={styles.uploadNote}>
          The event scouts record against. They are held to it — one shared event keeps everyone's
          data in the same pool.
        </p>
        <select
          className={styles.input}
          value={form.active_event_key}
          disabled={!canEdit}
          onChange={(e) => setForm({ ...form, active_event_key: e.target.value })}
        >
          <option value="">— none (scouts may pick any event) —</option>
          {events.map((e) => (
            <option key={e.key} value={e.key}>
              {e.short_name || e.name} — {e.start_date}
            </option>
          ))}
        </select>
      </section>

      <section>
        <h2 className={styles.sectionTitle}>Scouting window</h2>
        <p className={styles.uploadNote}>
          When on, entries can only be recorded between these times (checked against when the scout
          saved, so offline entries still sync afterwards). Enforced in the database.
        </p>

        <label className={css.toggleRow}>
          <button
            type="button"
            role="switch"
            aria-checked={form.lock_enabled}
            disabled={!canEdit}
            className={`${css.switch} ${form.lock_enabled ? css.switchOn : ''}`}
            onClick={() => setForm({ ...form, lock_enabled: !form.lock_enabled })}
          >
            <span className={css.switchKnob} />
          </button>
          <span>{form.lock_enabled ? 'Window enforced' : 'No window — scouting always open'}</span>
        </label>

        {form.lock_enabled && (
          <div className={css.windowGrid}>
            <label className={styles.field}>
              <span className={styles.label}>Opens</span>
              <input
                type="time"
                className={styles.input}
                value={form.window_start}
                disabled={!canEdit}
                onChange={(e) => setForm({ ...form, window_start: e.target.value })}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Closes</span>
              <input
                type="time"
                className={styles.input}
                value={form.window_end}
                disabled={!canEdit}
                onChange={(e) => setForm({ ...form, window_end: e.target.value })}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Time zone</span>
              <select
                className={styles.input}
                value={form.timezone}
                disabled={!canEdit}
                onChange={(e) => setForm({ ...form, timezone: e.target.value })}
              >
                {[
                  'America/Los_Angeles',
                  'America/Denver',
                  'America/Chicago',
                  'America/New_York',
                ].map((tz) => (
                  <option key={tz} value={tz}>
                    {tz.split('/')[1].replace('_', ' ')}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </section>

      {canEdit && (
        <div className={css.actions}>
          <button type="button" className="btn btn--gold" onClick={save} disabled={saving}>
            {saving ? (
              <>
                <span className={styles.spinnerSm} aria-hidden="true" /> Saving…
              </>
            ) : (
              'Save control settings'
            )}
          </button>
          {saved && (
            <span className={css.savedNote}>
              <Icon name="check" size={15} /> Saved
            </span>
          )}
        </div>
      )}
    </div>
  )
}
