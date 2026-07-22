import { useState } from 'react'
import Icon from '../Icon'
import { useAuth } from '../../lib/auth'
import styles from './Portal.module.css'

// Shown while a password-recovery link is active (AuthProvider swaps it in for
// everything else). Also the first-password path: an account provisioned without
// one gets the same recovery email, lands here, and sets its first password.
export default function SetPassword() {
  const { updatePassword, signOut } = useAuth()
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
    return (
      <div className={`container ${styles.wrap}`}>
        <div className={styles.center}>
          <span className={`pill ${styles.centerPill}`}>Password set</span>
          <h1 className={styles.title}>You're all set</h1>
          <p className={styles.centerText}>
            You can now sign in with your email and this password. Next time, use the password
            option on the sign-in screen.
          </p>
          <button type="button" className="btn btn--gold" onClick={() => window.location.reload()}>
            Continue to the portal
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={`container ${styles.wrap}`}>
      <div className={styles.authCard}>
        <span className={styles.eyebrow}>Team Portal</span>
        <h1 className={styles.authTitle}>Set your password</h1>
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

        <button type="button" className={styles.switchMode} onClick={signOut}>
          Cancel and sign out
        </button>
      </div>
    </div>
  )
}
