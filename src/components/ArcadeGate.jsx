import { useCallback, useEffect, useRef, useState } from 'react'
import { accessState, unlock, serverConfigured } from '../lib/arcade/leaderboard'
import { arcade } from '../data/arcade'
import styles from './ArcadeGate.module.css'

/**
 * The weekly code, in front of the game. The server (server/arcade) checks it
 * and hands back a pass for the rest of the week; the game, and its 3D code,
 * load only after that. With no server configured there is no code to ask for.
 */
export default function ArcadeGate({ children }) {
  const [state, setState] = useState(serverConfigured ? 'checking' : 'open')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef(null)

  const check = useCallback(() => {
    setState('checking')
    accessState().then(setState)
  }, [])

  useEffect(() => {
    if (serverConfigured) check()
  }, [check])

  useEffect(() => {
    if (state === 'locked') inputRef.current?.focus({ preventScroll: true })
  }, [state])

  const onSubmit = async (e) => {
    e.preventDefault()
    if (!code.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      await unlock(code)
      setState('unlocked')
    } catch (err) {
      setError(err.message || 'That code did not work.')
      inputRef.current?.select()
    } finally {
      setBusy(false)
    }
  }

  if (state === 'open' || state === 'unlocked') return children

  const lock = arcade.lock
  return (
    <div className={styles.gate}>
      <div className={styles.card}>
        <span className={styles.eyebrow}>FRC 5805 Arcade</span>
        <span className={styles.brand}>Cycle Rush</span>

        {state === 'checking' && <p className={styles.note}>{lock.checking}</p>}

        {state === 'offline' && (
          <>
            <p className={styles.note}>{lock.offline}</p>
            <button type="button" className="btn btn--ghost" onClick={check}>{lock.retry}</button>
          </>
        )}

        {state === 'locked' && (
          <form className={styles.form} onSubmit={onSubmit}>
            <h2 className={styles.title}>{lock.title}</h2>
            <p className={styles.note}>{lock.text}</p>
            <label className="sr-only" htmlFor="arcade-code">This week’s code</label>
            <input
              ref={inputRef}
              id="arcade-code"
              className={styles.input}
              value={code}
              onChange={(e) => { setCode(e.target.value); setError('') }}
              placeholder={lock.placeholder}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={12}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'arcade-code-error' : undefined}
            />
            <button type="submit" className={`btn btn--gold ${styles.button}`} disabled={busy || !code.trim()}>
              {busy ? lock.checking : lock.button}
            </button>
            <p id="arcade-code-error" className={styles.error} role="alert">{error}</p>
          </form>
        )}
      </div>
    </div>
  )
}
