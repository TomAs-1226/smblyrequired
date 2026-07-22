import { useState } from 'react'
import Icon from '../Icon'
import { useAuth } from '../../lib/auth'
import styles from './Portal.module.css'

export default function SignIn() {
  const { signIn, signInWithLink, sendPasswordReset } = useAuth()
  // 'password' | 'link' | 'reset'
  const [mode, setMode] = useState('password')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [sent, setSent] = useState(false)

  async function onSubmit(e) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)

    const result =
      mode === 'password'
        ? await signIn(email.trim(), password)
        : mode === 'link'
          ? await signInWithLink(email.trim())
          : await sendPasswordReset(email.trim())

    setBusy(false)
    if (result?.error) {
      setError(result.error)
      return
    }
    // On success in password mode the auth listener swaps this whole view out.
    // The two email flows stay and explain the next step is in the inbox.
    if (mode !== 'password') setSent(true)
  }

  if (sent) {
    const isReset = mode === 'reset'
    return (
      <div className={`container ${styles.wrap}`}>
        <div className={styles.center}>
          <span className={`pill ${styles.centerPill}`}>Check your email</span>
          <h1 className={styles.title}>{isReset ? 'Reset link sent' : 'Link sent'}</h1>
          <p className={styles.centerText}>
            If <strong>{email}</strong> has an account, {isReset ? 'a link to set your password' : 'a sign-in link'}{' '}
            is on its way. It expires shortly, so use it soon.
            {isReset && ' Opening it brings you back here to choose a password.'}
          </p>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              setSent(false)
              setMode('password')
            }}
          >
            Back to sign in
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={`container ${styles.wrap}`}>
      <div className={styles.authCard}>
        <span className={styles.eyebrow}>Team Portal</span>
        <h1 className={styles.authTitle}>{mode === 'reset' ? 'Set a password' : 'Sign in'}</h1>
        <p className={styles.authLead}>
          {mode === 'reset'
            ? 'Enter your email and we will send a link to choose a password — this also works if you have never set one.'
            : 'For team members. Everything public lives on the main site — this is the internal side.'}
        </p>

        <form className={styles.form} onSubmit={onSubmit} noValidate>
          <label className={styles.field}>
            <span className={styles.label}>Email</span>
            <input
              type="email"
              className={styles.input}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
              placeholder="you@example.com"
            />
          </label>

          {mode === 'password' && (
            <label className={styles.field}>
              <span className={styles.label}>Password</span>
              <input
                type="password"
                className={styles.input}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
          )}

          {/* Reserved space, so an arriving error nudges nothing. A form that
              reflows at the moment it fails makes the failure feel worse. */}
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
                {mode === 'password' ? 'Signing in…' : 'Sending…'}
              </>
            ) : (
              <>
                {mode === 'password' ? 'Sign in' : mode === 'link' ? 'Email me a link' : 'Send the link'}
                <Icon name="arrowRight" size={17} className="arrow" />
              </>
            )}
          </button>
        </form>

        <div className={styles.authSwitches}>
          <button
            type="button"
            className={styles.switchMode}
            onClick={() => {
              setMode((m) => (m === 'link' ? 'password' : 'link'))
              setError(null)
            }}
          >
            {mode === 'link' ? 'Use a password instead' : 'Sign in with an email link instead'}
          </button>
          <button
            type="button"
            className={styles.switchMode}
            onClick={() => {
              setMode('reset')
              setError(null)
            }}
          >
            Forgot or need to set a password?
          </button>
        </div>

        <p className={styles.authFoot}>
          No account? Accounts are created by a team lead — ask in the build channel rather than
          signing up here.
        </p>
      </div>
    </div>
  )
}
