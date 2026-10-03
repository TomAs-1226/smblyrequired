import Icon from '../Icon'
import { useOfflineQueue } from '../../hooks/useOfflineQueue'
import styles from './Portal.module.css'

/**
 * Persistent answer to "if I close this now, do I lose anything?"
 *
 * Deliberately always mounted on scouting screens rather than appearing only on
 * failure. A scout needs to know the queue is draining *before* they walk away
 * from the pit, and an indicator that only shows up when something is wrong
 * teaches people that its absence means nothing.
 */
export default function SyncBadge({ compact = false }) {
  const { online, syncing, pending, failing, sync } = useOfflineQueue()

  // Nothing queued and connected: say so quietly rather than rendering nothing.
  // "Blank" and "fine" must not look identical.
  const tone = !online ? 'off' : failing ? 'bad' : pending ? 'warn' : 'ok'

  const label = !online
    ? pending
      ? `Offline — ${pending} saved on this device`
      : 'Offline — entries will save locally'
    : syncing
      ? `Syncing ${pending}…`
      : failing
        ? `${failing} failed to sync`
        : pending
          ? `${pending} waiting to sync`
          : 'All synced'

  return (
    <button
      type="button"
      className={`${styles.syncBadge} ${styles[`sync_${tone}`]} ${compact ? styles.syncCompact : ''}`}
      onClick={() => sync()}
      // Manual retry is always available. When the network returns mid-match a
      // scout will tap this before they trust a 30-second timer, and denying
      // them that just produces frantic tapping on something else.
      title={online ? 'Tap to sync now' : 'No connection — your entries are saved on this device'}
      aria-live="polite"
    >
      <span className={styles.syncDot} aria-hidden="true" />
      {syncing ? (
        <span className={styles.spinnerSm} aria-hidden="true" />
      ) : (
        <Icon name={!online ? 'alert' : failing ? 'alert' : pending ? 'arrowUp' : 'check'} size={14} />
      )}
      <span className={styles.syncLabel}>{label}</span>
    </button>
  )
}

/**
 * What is stuck in the queue and why, with a way out.
 *
 * The badge alone said "2 failed to sync" and nothing else. The common causes
 * are not network problems at all — an entry recorded outside the scouting
 * window, against an event that is no longer the active one, or past the daily
 * pass limit. The server will refuse those forever, and a scout who cannot see
 * the reason just keeps tapping. Each row shows the server's own message and
 * offers to discard it, behind a confirm, because discarding is the one action
 * in the queue that loses data.
 */
export function SyncProblems() {
  const { problems, discard } = useOfflineQueue()
  if (!problems?.length) return null

  async function drop(p) {
    const what =
      p.entryKind === 'match' && p.match
        ? `the match ${p.match} entry for team ${p.team}`
        : p.team
          ? `this ${p.kind === 'robot_photo' ? 'photo' : (p.entryKind ?? 'entry')} for team ${p.team}`
          : 'this entry'
    if (!window.confirm(`Discard ${what}? It has not reached the server and cannot be recovered.`)) return
    await discard(p.client_uuid)
  }

  return (
    <div className={styles.syncProblems} role="alert">
      <p className={styles.syncProblemsHead}>
        <Icon name="alert" size={15} />
        {problems.length === 1 ? 'One entry is' : `${problems.length} entries are`} stuck on this
        phone. Tap the badge to retry, or discard what the server will never accept.
      </p>
      <ul className={styles.syncProblemList}>
        {problems.map((p) => (
          <li key={p.client_uuid} className={styles.syncProblem}>
            <span className={styles.syncProblemWhat}>
              {p.kind === 'robot_photo' ? 'Photo' : (p.entryKind ?? 'Entry')}
              {p.team ? ` · team ${p.team}` : ''}
              {p.match ? ` · match ${p.match}` : ''}
            </span>
            <span className={styles.syncProblemWhy}>
              {p.error ?? 'No reason recorded'}
              {!p.terminal && ` (${p.attempts} attempts — will keep retrying)`}
            </span>
            <button type="button" className={styles.syncDiscard} onClick={() => drop(p)}>
              Discard
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
