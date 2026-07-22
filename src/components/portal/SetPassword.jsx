import { useState } from 'react'
import Icon from '../Icon'
import { useAuth } from '../../lib/auth'
import styles from './Portal.module.css'

// Two jobs, one form:
//   - Recovery/first-password: AuthProvider renders <SetPassword/> with no props
//     when a recovery link is active. Cancel signs out.
//   - Change password while signed in: rendered with onClose as a dismissible
//     dialog from the portal header. Cancel just closes. Either way it calls
//     updatePassword(), which works for any authenticated session with no email.
export default function SetPassword({ onClose }) {
  const { updatePassword, signOut } = useAuth()
  const dismissible = typeof onClose === 'function'
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(false)

  async function submit(e) {
    e.preventDefault()
    if (busy) return
    setError(null)
    // Checked here as well as by Supabase so the message is instant and specific,
    // rather than a round trip to be told the two fields differ.
    if (pw.length < 8) return setError('Use at least 8 characters.')
    if (pw !== confirm) return setError('The two passwords do not match.')

    setBusy(true)
    const { error: err } = await updatePassword(pw)
    setBusy(false)
    if (err) return setError(err)
    setDone(true)
  }

  if (done) {
    // In the dismissible (signed-in) case there is nothing to reload — just
    // close. In recovery, a reload lands them in the portal proper.
    return (
      <Shell dismissible={dismissible} onClose={onClose}>
        <div className={styles.center}>
          <span className={`pill ${styles.centerPill}`}>Password set</span>
          <h1 className={dismissible ? styles.authTitle : styles.title}>You're all set</h1>
          <p className={styles.centerText}>
            You can now sign in with your email and this password.
          </p>
          <button
            type="button"
            className="btn btn--gold"
            onClick={() => (dismissible ? onClose() : window.location.reload())}
          >
            {dismissible ? 'Done' : 'Continue to the portal'}
          </button>
        </div>
      </Shell>
    )
  }

  return (
    <Shell dismissible={dismissible} onClose={onClose}>
      <div className={styles.authCard}>
        <span className={styles.eyebrow}>Team Portal</span>
        <h1 className={styles.authTitle}>{dismissible ? 'Change your password' : 'Set your password'}</h1>
        <p className={styles.authLead}>Choose a password for signing in from now on.</p>

        <form className={styles.form} onSubmit={submit} noValidate>
          <label className={styles.field}>
            <span className={styles.label}>New password</span>
            <input
              type="password"
              className={styles.input}
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              autoComplete="new-password"
              required
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Confirm password</span>
            <input
              type="password"
              className={styles.input}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
            />
          </label>

          <div className={styles.errorSlot} role="alert" aria-live="polite">
            {error && (
              <span className={styles.error}>
                <Icon name="alert" size={15} />
                {error}
              </span>
            )}
          </div>

          <button type="submit" className={`btn btn--gold ${styles.submit}`} disabled={busy}>
            {busy ? (
              <>
                <span className={styles.spinnerSm} aria-hidden="true" />
                Saving…
              </>
            ) : (
              'Save password'
            )}
          </button>
        </form>

        <button
          type="button"
          className={styles.switchMode}
          onClick={() => (dismissible ? onClose() : signOut())}
        >
          {dismissible ? 'Cancel' : 'Cancel and sign out'}
        </button>
      </div>
    </Shell>
  )
}

// Full-screen page during recovery; a centered dismissible dialog when changing
// a password while signed in. The dialog keeps modal transform-origin (centered)
// per the motion rules — it is not anchored to a trigger.
function Shell({ dismissible, onClose, children }) {
  if (!dismissible) return <div className={`container ${styles.wrap}`}>{children}</div>
  return (
    <div
      className={styles.pwOverlay}
      role="dialog"
      aria-modal="true"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={styles.pwDialog}>{children}</div>
    </div>
  )
}
