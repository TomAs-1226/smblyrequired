import Icon from '../Icon'
import { formatBytes } from '../../lib/portalApi'
import styles from './Portal.module.css'

// Kept generic on purpose — this repo is public, so machine names stay out of
// it. Rename here if the team prefers something more specific internally.
const LEG_LABEL = {
  'supabase->server': 'Cloud → backup server',
  'server->optiplex': 'Backup server → OptiPlex',
}

// One leg of the nightly mirror. Shared by the overview and the admin panel so
// the two report backup state identically — a run that reads "Current" in one
// place must never read "Stale" in the other.
export default function BackupLeg({ leg }) {
  const ok = leg.healthy
  // "Ran successfully" and "was proven restorable" are different claims. A run
  // that has never been restore-tested is reported as unverified rather than
  // green, because an untested backup is a hypothesis.
  const verified = Boolean(leg.restore_tested_at)
  const when = leg.started_at ? new Date(leg.started_at) : null

  return (
    <li className={`${styles.leg} ${ok ? styles.legOk : styles.legBad}`}>
      <span className={styles.legDot} aria-hidden="true" />
      <div className={styles.legMain}>
        <span className={styles.legName}>{LEG_LABEL[leg.leg] ?? leg.leg}</span>
        <span className={styles.legWhen}>
          {when
            ? `${when.toLocaleDateString()} ${when.toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}`
            : 'never'}
          {leg.object_count != null && ` · ${leg.object_count.toLocaleString()} objects`}
          {leg.byte_total != null && ` · ${formatBytes(leg.byte_total)}`}
        </span>
        {/* The scripts record why a run degraded. Surfacing it here is the
            difference between "something is wrong" and knowing what to fix. */}
        {leg.error && <span className={styles.legError}>{leg.error}</span>}
      </div>
      <span className={styles.legFlags}>
        {/* "Failed last night" and "hasn't run in a week" are different problems
            needing different responses, and both used to render as "Stale". */}
        <span className={`${styles.legState} ${ok ? styles.legStateOk : styles.legStateBad}`}>
          {ok
            ? 'Current'
            : leg.status === 'running'
              ? 'Running'
              : leg.status === 'failed'
                ? 'Failed'
                : leg.status === 'partial'
                  ? 'Partial'
                  : 'Stale'}
        </span>
        <span
          className={`${styles.legState} ${verified ? styles.legStateOk : styles.legStateWarn}`}
          title={
            verified
              ? `Restore tested ${new Date(leg.restore_tested_at).toLocaleDateString()}`
              : 'This copy has never been restore-tested'
          }
        >
          <Icon name={verified ? 'check' : 'alert'} size={13} />
          {verified ? 'Verified' : 'Unverified'}
        </span>
      </span>
    </li>
  )
}
