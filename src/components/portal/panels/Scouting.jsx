import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import Icon from '../../Icon'
import { useAuth } from '../../../lib/auth'
import {
  listEvents,
  listEventTeams,
  activeForm,
  recordEntry,
  syncFromTba,
  passesRemaining,
  scoutControl,
} from '../../../lib/scoutingApi'
import FormRenderer, { missingRequired } from '../scouting/FormRenderer'
import MatchTimer from '../scouting/MatchTimer'
import NexusLive from '../live/NexusLive'
import SyncBadge from '../SyncBadge'
import { Loading, Empty, ErrorState } from '../ui'
import styles from '../Portal.module.css'
import scout from '../scouting/Scouting.module.css'

// Lazy so TensorFlow (~1.9 MB across three chunks) is fetched only when a scout
// actually opens the camera, never as part of the portal.
const RobotCapture = lazy(() => import('../RobotCapture'))

const MODES = [
  { id: 'match', label: 'Match', icon: 'flag', blurb: 'One entry per team per match' },
  { id: 'pit', label: 'Pit', icon: 'wrench', blurb: 'Once per team — specs and photos' },
  { id: 'strategy', label: 'Notes', icon: 'book', blurb: 'Free-form observations' },
]

const SEASON = new Date().getFullYear()

export default function Scouting() {
  const { profile, atLeast } = useAuth()
  const [mode, setMode] = useState('match')
  const [eventKey, setEventKey] = useState(() => localStorage.getItem('frc5805.event') ?? '')
  const [events, setEvents] = useState([])
  const [teams, setTeams] = useState([])
  const [form, setForm] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [syncing, setSyncing] = useState(false)

  // Entry state
  const [teamNumber, setTeamNumber] = useState('')
  const [matchNumber, setMatchNumber] = useState('')
  const [alliance, setAlliance] = useState('')
  const [data, setData] = useState({})
  const [notes, setNotes] = useState('')
  const [saved, setSaved] = useState(null)
  const [saveError, setSaveError] = useState(null)
  const [capturing, setCapturing] = useState(false)
  const [photoCount, setPhotoCount] = useState(0)
  const [passesLeft, setPassesLeft] = useState(null)
  const [control, setControl] = useState(null)

  // The active event and scouting window are leadership's to set (migration
  // 0010). A scout follows them: the event picker locks to the active event, and
  // saving is blocked when the window is closed. This is the friendly mirror of
  // the database trigger — the trigger is what actually enforces it.
  useEffect(() => {
    let alive = true
    scoutControl().then(({ data }) => {
      if (!alive || !data) return
      setControl(data)
      // Snap the scout to the active event unless they are a lead who may roam.
      if (data.active_event_key && !atLeast('lead')) setEventKey(data.active_event_key)
    })
    return () => {
      alive = false
    }
  }, [atLeast])

  const lockedToEvent = control?.active_event_key && !atLeast('lead')
  const scoutingClosed = control?.lock_enabled && control?.open_now === false

  // Pit and strategy are capped at 2 per team per day (migration 0007). Check
  // the remaining allowance when the team changes, so the scout learns the limit
  // before filling the form rather than at submit. Match scouting is unlimited.
  useEffect(() => {
    if (mode === 'match' || !teamNumber) {
      setPassesLeft(null)
      return
    }
    let alive = true
    passesRemaining(teamNumber, mode, eventKey || null).then(({ data }) => {
      if (alive) setPassesLeft(data)
    })
    return () => {
      alive = false
    }
  }, [teamNumber, mode, eventKey, saved])

  useEffect(() => {
    let alive = true
    ;(async () => {
      setLoading(true)
      const { data: evs, error: err } = await listEvents(SEASON)
      if (!alive) return
      setEvents(evs)
      setError(err)
      setLoading(false)
    })()
    return () => {
      alive = false
    }
  }, [])

  // The chosen event persists across reloads. A scout who backgrounds the app
  // between matches should not have to re-pick it forty times a day.
  useEffect(() => {
    if (eventKey) localStorage.setItem('frc5805.event', eventKey)
  }, [eventKey])

  useEffect(() => {
    if (!eventKey) return
    let alive = true
    ;(async () => {
      const { data: t } = await listEventTeams(eventKey)
      if (alive) setTeams(t)
    })()
    return () => {
      alive = false
    }
  }, [eventKey])

  useEffect(() => {
    let alive = true
    ;(async () => {
      const { data: f } = await activeForm(SEASON, mode)
      if (alive) setForm(f)
    })()
    return () => {
      alive = false
    }
  }, [mode])

  const pullEvents = useCallback(async () => {
    setSyncing(true)
    setError(null)
    const { error: err } = await syncFromTba('events', { year: SEASON })
    if (err) setError(err)
    else {
      const { data: evs } = await listEvents(SEASON)
      setEvents(evs)
    }
    setSyncing(false)
  }, [])

  const pullTeams = useCallback(async () => {
    if (!eventKey) return
    setSyncing(true)
    const { error: err } = await syncFromTba('event_teams', { eventKey })
    if (err) setError(err)
    else {
      const { data: t } = await listEventTeams(eventKey)
      setTeams(t)
    }
    setSyncing(false)
  }, [eventKey])

  function resetEntry() {
    setData({})
    setNotes('')
    setSaveError(null)
    // Team and match deliberately survive a save. In match scouting you follow
    // ONE team across the whole event, so clearing it would mean re-entering
    // the same number sixty times.
    if (mode === 'match') setMatchNumber((m) => (m ? String(Number(m) + 1) : ''))
    else setTeamNumber('')
  }

  async function save() {
    setSaveError(null)
    const missing = missingRequired(form?.fields, data)
    if (missing.length) {
      setSaveError(`Still needed: ${missing.join(', ')}`)
      return
    }
    if (!teamNumber) {
      setSaveError('Which team is this?')
      return
    }
    if (mode === 'match' && (!matchNumber || !alliance)) {
      setSaveError('Match number and alliance are both required for match scouting.')
      return
    }

    try {
      await recordEntry({
        form,
        kind: mode,
        eventKey: eventKey || null,
        teamNumber: Number(teamNumber),
        matchKey: mode === 'match' && eventKey ? `${eventKey}_qm${matchNumber}` : null,
        matchNumber: mode === 'match' ? Number(matchNumber) : null,
        compLevel: mode === 'match' ? 'qm' : null,
        alliance: mode === 'match' ? alliance : null,
        data,
        notes,
        scoutId: profile?.id,
      })
      // Saved means "durably on this device", not "uploaded" — SyncBadge is what
      // communicates the difference, and conflating them is how a scout walks
      // away from a pit believing data left the phone when it has not.
      setSaved({ team: teamNumber, at: Date.now() })
      resetEntry()
      setTimeout(() => setSaved(null), 2600)
    } catch (err) {
      setSaveError(String(err.message ?? err))
    }
  }

  if (loading) return <Loading rows={4} label="Loading events" />
  if (error && !events.length) return <ErrorState error={error} onRetry={pullEvents} />

  return (
    <div className={styles.stack}>
      {/* Always visible. The scout's standing question is "if I close this now,
          do I lose anything?" and it must never require navigating to find. */}
      <div className={scout.statusRow}>
        <SyncBadge />
        {saved && (
          <span className={scout.savedChip} role="status">
            <Icon name="check" size={14} />
            Saved team {saved.team}
          </span>
        )}
      </div>

      {/* Scouting window closed — say so plainly and stop the form being filled
          for nothing. The database refuses the entry regardless; this is the
          courtesy that saves a scout twenty taps first. */}
      {scoutingClosed && (
        <div className={scout.closedBanner}>
          <Icon name="alert" size={17} />
          <span>
            Scouting is closed right now. A lead has set the window to{' '}
            {String(control.window_start).slice(0, 5)}–{String(control.window_end).slice(0, 5)}. Your
            entries will not save until it opens.
          </span>
        </div>
      )}

      {/* --- Event --- */}
      <section>
        <h2 className={styles.sectionTitle}>Event</h2>
        <div className={styles.toolbar}>
          {lockedToEvent ? (
            // A scout is held to the active event, so it is shown as a fixed
            // label, not a picker they cannot really use.
            <div className={scout.fixedEvent}>
              <Icon name="flag" size={15} />
              {events.find((e) => e.key === eventKey)?.short_name ??
                events.find((e) => e.key === eventKey)?.name ??
                eventKey}
              <span className={scout.fixedEventTag}>set by a lead</span>
            </div>
          ) : (
            <select
              className={styles.input}
              value={eventKey}
              onChange={(e) => setEventKey(e.target.value)}
            >
              <option value="">Select an event…</option>
              {events.map((e) => (
                <option key={e.key} value={e.key}>
                  {e.short_name || e.name} — {e.start_date}
                </option>
              ))}
            </select>
          )}
          {atLeast('lead') && (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={events.length ? pullTeams : pullEvents}
              disabled={syncing}
            >
              {syncing ? (
                <span className={styles.spinnerSm} aria-hidden="true" />
              ) : (
                <Icon name="download" size={15} />
              )}
              {events.length ? 'Refresh teams' : 'Pull events from TBA'}
            </button>
          )}
        </div>
        {eventKey && (
          <p className={styles.uploadNote}>
            {teams.length
              ? `${teams.length} teams cached for this event.`
              : 'No teams cached yet — pull them before you lose signal at the venue.'}
          </p>
        )}
      </section>

      {/* Live field status from Nexus — "which match is queuing now" is the
          question asked between matches, so it belongs right under the event the
          scout picked. Renders nothing until an event is chosen, polls on its
          own, and degrades quietly to a setup hint when the Nexus key is unset. */}
      {eventKey && <NexusLive eventKey={eventKey} />}

      {/* --- Mode --- */}
      <section>
        <h2 className={styles.sectionTitle}>What are you scouting?</h2>
        <div className={scout.modeRow}>
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              aria-pressed={mode === m.id}
              className={`${scout.modeBtn} ${mode === m.id ? scout.modeOn : ''}`}
              onClick={() => {
                setMode(m.id)
                setData({})
                setSaveError(null)
              }}
            >
              <Icon name={m.icon} size={18} />
              <span className={scout.modeLabel}>{m.label}</span>
              <span className={scout.modeBlurb}>{m.blurb}</span>
            </button>
          ))}
        </div>
      </section>

      {/* --- Entry --- */}
      <section>
        <h2 className={styles.sectionTitle}>
          {mode === 'match' ? 'Match entry' : mode === 'pit' ? 'Pit entry' : 'Notes'}
        </h2>

        <div className={scout.identityRow}>
          <label className={styles.field}>
            <span className={styles.label}>Team</span>
            <input
              type="number"
              inputMode="numeric"
              list="team-list"
              className={scout.bigInput}
              value={teamNumber}
              onChange={(e) => setTeamNumber(e.target.value)}
              placeholder="5805"
            />
            <datalist id="team-list">
              {teams.map((t) => (
                <option key={t.team_number} value={t.team_number}>
                  {t.nickname}
                </option>
              ))}
            </datalist>
          </label>

          {mode === 'match' && (
            <>
              <label className={styles.field}>
                <span className={styles.label}>Match</span>
                <input
                  type="number"
                  inputMode="numeric"
                  className={scout.bigInput}
                  value={matchNumber}
                  onChange={(e) => setMatchNumber(e.target.value)}
                  placeholder="12"
                />
              </label>
              <div className={styles.field}>
                <span className={styles.label}>Alliance</span>
                <div className={scout.allianceRow}>
                  {['red', 'blue'].map((a) => (
                    <button
                      key={a}
                      type="button"
                      aria-pressed={alliance === a}
                      className={`${scout.allianceBtn} ${scout[`alliance_${a}`]} ${
                        alliance === a ? scout.allianceOn : ''
                      }`}
                      onClick={() => setAlliance(a)}
                    >
                      {a}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {/* The match timer sits with the match entry — it is only meaningful
            while watching a match, and having it here means a scout starts it
            with the same thumb that just set the alliance. */}
        {mode === 'match' && form && <MatchTimer />}

        {/* Daily-limit heads-up for pit/strategy, shown before the form is filled. */}
        {passesLeft != null && passesLeft <= 0 && (
          <p className={`${styles.uploadNote} ${scout.limitHit}`}>
            <Icon name="alert" size={14} /> You have used both {mode} passes on team {teamNumber}{' '}
            today. Edit an existing entry instead — the allowance resets tomorrow.
          </p>
        )}
        {passesLeft != null && passesLeft === 1 && (
          <p className={styles.uploadNote}>1 {mode} pass left on team {teamNumber} today.</p>
        )}

        {teamNumber && teams.length > 0 && (
          <p className={styles.uploadNote}>
            {teams.find((t) => String(t.team_number) === String(teamNumber))?.nickname ??
              'Not on this event’s team list — double-check the number.'}
          </p>
        )}

        {/* Pit scouting is where photos belong — one robot, standing in front of
            it, with time to walk around it. Gated on a team number because a
            photo with no team attached is unfilable later. */}
        {mode === 'pit' && (
          <div className={scout.photoRow}>
            <button
              type="button"
              className={`btn btn--cyan ${scout.photoBtn}`}
              onClick={() => setCapturing(true)}
              disabled={!teamNumber}
              title={teamNumber ? 'Open the camera' : 'Enter a team number first'}
            >
              <Icon name="spark" size={17} />
              {photoCount ? `Photos (${photoCount})` : 'Take robot photos'}
            </button>
            {!teamNumber && (
              <span className={styles.uploadNote}>Enter a team number to enable the camera.</span>
            )}
          </div>
        )}

        {capturing && (
          <Suspense
            fallback={
              <p className={styles.uploadNote}>
                <span className={styles.spinnerSm} aria-hidden="true" /> Loading the camera…
              </p>
            }
          >
            <RobotCapture
              eventKey={eventKey || null}
              teamNumber={Number(teamNumber)}
              onSaved={() => setPhotoCount((n) => n + 1)}
              onDone={() => setCapturing(false)}
            />
          </Suspense>
        )}

        {!form ? (
          <Empty icon="alert" title={`No active ${mode} form for ${SEASON}`}>
            {atLeast('lead')
              ? 'Build one in the Forms tab and mark it active. Scouts cannot record anything until a form exists.'
              : 'Ask a mentor or lead to publish one — nothing can be recorded until they do.'}
          </Empty>
        ) : (
          <>
            <FormRenderer fields={form.fields} value={data} onChange={setData} />

            <label className={styles.field}>
              <span className={styles.label}>Notes</span>
              <textarea
                className={scout.textarea}
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Anything the form does not cover"
              />
            </label>

            <div className={styles.errorSlot} role="alert" aria-live="polite">
              {saveError && (
                <span className={styles.error}>
                  <Icon name="alert" size={15} />
                  {saveError}
                </span>
              )}
            </div>

            {/* Full-width and unmissable, and STICKY: the pit form is 30 fields,
                so a static button at the bottom means scrolling a screen and a
                half to save between every team. Sticking it to the bottom of the
                viewport keeps the one action a scout repeats all day always under
                the thumb. */}
            <div className={scout.saveDock}>
              <button
                type="button"
                className={scout.saveBtn}
                onClick={save}
                disabled={scoutingClosed}
              >
                <Icon name={scoutingClosed ? 'alert' : 'check'} size={20} />
                {scoutingClosed
                  ? 'Scouting closed'
                  : `Save ${mode === 'match' && matchNumber ? `match ${matchNumber}` : 'entry'}`}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  )
}
