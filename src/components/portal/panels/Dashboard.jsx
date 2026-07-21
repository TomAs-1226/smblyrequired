import { useEffect, useState } from 'react'
import Icon from '../../Icon'
import { useAuth } from '../../../lib/auth'
import { backupHealth, listFiles, formatBytes } from '../../../lib/portalApi'
import { Loading, ErrorState, StatTile, Empty } from '../ui'
import styles from '../Portal.module.css'

// Kept generic on purpose — this repo is public, so machine names stay out of
// it. Rename here if the team prefers something more specific internally.
const LEG_LABEL = {
  'supabase->server': 'Cloud → backup server',
  'server->optiplex': 'Backup server → OptiPlex',
}

export default function Dashboard() {
  const { atLeast } = useAuth()
  // backup_runs is member+ in RLS, so a viewer legitimately reads zero rows.
  // Without this gate an empty result would render as "No backup has ever run",
  // which is alarming, wrong, and unactionable for the person seeing it. Not
  // being allowed to see something is not the same as it not existing.
  const canSeeBackups = atLeast('member')
  const [state, setState] = useState({ loading: true, error: null, health: [], recent: [] })

  async function load() {
    setState((s) => ({ ...s, loading: true, error: null }))
    const [h, f] = await Promise.all([
      canSeeBackups ? backupHealth() : Promise.resolve({ data: [], error: null }),
      listFiles({ limit: 6 }),
    ])
    const error = h.error ?? f.error
    setState({ loading: false, error, health: h.data, recent: f.data })
  }

  useEffect(() => {
    load()
  }, [canSeeBackups])

  if (state.loading) return <Loading rows={5} label="Loading overview" />
  if (state.error) return <ErrorState error={state.error} onRetry={load} />

  // backup_health returns one row per leg, and both legs describe the SAME
  // snapshot. Summing byte_total across them reported roughly double the real
  // figure; max is correct for both, exactly as it already was for objects.
  const totalBytes = Math.max(0, ...state.health.map((r) => r.byte_total ?? 0))
  const objects = Math.max(0, ...state.health.map((r) => r.object_count ?? 0))

  return (
    <div className={styles.stack}>
      {/* These totals are derived from the last backup run, not from a live
          count — so they are gated with it and labelled as such. Showing a
          viewer "0 objects" because RLS hid the source rows would be a lie. */}
      {canSeeBackups && (
        <section>
          <h2 className={styles.sectionTitle}>Storage — as of last backup</h2>
          <div className={styles.statGrid}>
            <StatTile label="Objects stored" value={objects.toLocaleString()} />
            <StatTile label="Total size" value={formatBytes(totalBytes)} />
            <StatTile label="Buckets" value="5" />
          </div>
        </section>
      )}

      {canSeeBackups && (
        <section>
          <h2 className={styles.sectionTitle}>Backup</h2>
          {state.health.length === 0 ? (
            <Empty icon="alert" title="No backup has ever run">
              The nightly mirror has not reported in. Until it does, everything here exists in
              exactly one place. See <code>docs/BACKUP.md</code> to install it.
            </Empty>
          ) : (
            <ul className={styles.legList}>
              {state.health.map((leg) => (
                <BackupLeg key={leg.leg} leg={leg} />
              ))}
            </ul>
          )}
        </section>
      )}

      <section>
        <h2 className={styles.sectionTitle}>Recently added</h2>
        {state.recent.length === 0 ? (
          <Empty title="Nothing uploaded yet">
            Files added through the Files tab show up here.
          </Empty>
        ) : (
          <ul className={styles.miniList}>
            {state.recent.map((f, i) => (
              <li key={f.id} className={styles.miniRow} style={{ '--i': Math.min(i, 8) }}>
                <span className={styles.miniTitle}>{f.title}</span>
                <span className={styles.miniMeta}>
                  <code className={styles.bucketTag}>{f.bucket}</code>
                  {formatBytes(f.byte_size)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function BackupLeg({ leg }) {
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
