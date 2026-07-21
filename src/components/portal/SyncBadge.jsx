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
