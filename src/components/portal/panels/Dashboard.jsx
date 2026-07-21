import { useCallback, useEffect, useState } from 'react'
import Icon from '../../Icon'
import { useAuth } from '../../../lib/auth'
import { supabase } from '../../../lib/supabase'
import { backupHealth, listFiles, formatBytes } from '../../../lib/portalApi'
import { navigate } from '../../../lib/router'
import { Loading, ErrorState, StatTile, Empty } from '../ui'
import styles from '../Portal.module.css'

// Kept generic on purpose — this repo is public, so machine names stay out of
// it. Rename here if the team prefers something more specific internally.
const LEG_LABEL = {
  'supabase->server': 'Cloud → backup server',
  'server->optiplex': 'Backup server → OptiPlex',
}

// The overview answers "what is the state of things?" in one screen. Every item
// on it is either a number somebody acts on, or a link to where they act.
export default function Dashboard() {
  const { atLeast, profile } = useAuth()
  // backup_runs is member+ in RLS, so a viewer legitimately reads zero rows.
  // Without this gate an empty result would render as "No backup has ever run",
  // which is alarming, wrong, and unactionable for the person seeing it. Not
  // being allowed to see something is not the same as it not existing.
  const canSeeBackups = atLeast('member')
  const [s, setS] = useState({ loading: true, error: null })

  const load = useCallback(async () => {
    setS((p) => ({ ...p, loading: true, error: null }))
    const eventKey = localStorage.getItem('frc5805.event') || null

    const [health, recent, counts, coverage, activity] = await Promise.all([
      canSeeBackups ? backupHealth() : Promise.resolve({ data: [], error: null }),
      listFiles({ limit: 5 }),
      // head:true returns the count without transferring the rows. This runs on
      // every portal visit; there is no reason to pull a thousand entries down
      // in order to display the number 1000.
      Promise.all([
        supabase.from('scout_entries').select('id', { count: 'exact', head: true }),
        supabase.from('graphs').select('id', { count: 'exact', head: true }),
        supabase.from('code_archives').select('id', { count: 'exact', head: true }),
        supabase.from('knowledge_docs').select('id', { count: 'exact', head: true }),
        supabase.from('profiles').select('id', { count: 'exact', head: true }),
        supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'pending'),
      ]),
      eventKey
        ? supabase.from('event_scout_coverage').select('*').eq('event_key', eventKey).maybeSingle()
        : Promise.resolve({ data: null }),
      supabase
        .from('scout_entries')
        .select('team_number, kind, recorded_at')
        .order('recorded_at', { ascending: false })
        .limit(6),
    ])

    const [entries, graphs, archives, docs, members, pending] = counts
    setS({
      loading: false,
      error: health.error ?? recent.error ?? null,
      health: health.data ?? [],
      recent: recent.data ?? [],
      eventKey,
      counts: {
        entries: entries.count ?? 0,
        graphs: graphs.count ?? 0,
        archives: archives.count ?? 0,
        docs: docs.count ?? 0,
        members: members.count ?? 0,
        pending: pending.count ?? 0,
      },
      coverage: coverage?.data ?? null,
      activity: activity.data ?? [],
    })
  }, [canSeeBackups])

  useEffect(() => {
    load()
  }, [load])

  if (s.loading) return <Loading rows={6} label="Loading overview" />
  if (s.error) return <ErrorState error={s.error} onRetry={load} />

  const c = s.counts
  const bytes = Math.max(0, ...s.health.map((r) => r.byte_total ?? 0))
  const objects = Math.max(0, ...s.health.map((r) => r.object_count ?? 0))
  const first = profile?.full_name?.split(' ')[0]

  return (
    <div className={styles.stack}>
      {first && <p className={styles.greeting}>Hello, {first}.</p>}

      {/* Pending approvals lead, because this is the only item here that blocks
          another person from working — and it is invisible unless someone looks. */}
      {atLeast('admin') && c.pending > 0 && (
        <button type="button" className={styles.alertRow} onClick={() => navigate('/portal/roster')}>
          <Icon name="users" size={17} />
          <span>
            <strong>{c.pending}</strong> {c.pending === 1 ? 'person is' : 'people are'} waiting for
            approval — they can see nothing until promoted.
          </span>
          <Icon name="arrowRight" size={15} />
        </button>
      )}

      <section>
        <h2 className={styles.sectionTitle}>Scouting</h2>
        <div className={styles.statGrid}>
          <StatTile label="Entries recorded" value={c.entries.toLocaleString()} />
          <StatTile
            label="Teams covered"
            value={s.coverage ? `${s.coverage.teams_scouted}/${s.coverage.teams_at_event}` : '—'}
          />
          <StatTile label="Team members" value={c.members} />
        </div>
        {s.coverage && !s.coverage.fully_covered && (
          <button
            type="button"
            className={styles.alertRow}
            onClick={() => navigate('/portal/checklist')}
          >
            <Icon name="alert" size={16} />
            <span>
              <strong>{s.coverage.teams_unscouted}</strong> teams at {s.eventKey} still have no
              match data.
            </span>
            <Icon name="arrowRight" size={15} />
          </button>
        )}
      </section>

      <section>
        <h2 className={styles.sectionTitle}>Archive</h2>
        <div className={styles.statGrid}>
          <StatTile label="Knowledge docs" value={c.docs} />
          <StatTile label="Code archives" value={c.archives} />
          <StatTile label="Graphs" value={c.graphs} />
        </div>
      </section>

      {canSeeBackups && (
        <section>
          <h2 className={styles.sectionTitle}>Backup — as of last run</h2>
          <div className={styles.statGrid}>
            <StatTile label="Objects stored" value={objects.toLocaleString()} />
            <StatTile label="Total size" value={formatBytes(bytes)} />
            <StatTile label="Buckets" value="5" />
          </div>
          {s.health.length === 0 ? (
            <Empty icon="alert" title="No backup has ever run">
              Everything here exists in exactly one place until the nightly mirror reports in.
            </Empty>
          ) : (
            <ul className={styles.legList}>
              {s.health.map((leg) => (
                <BackupLeg key={leg.leg} leg={leg} />
              ))}
            </ul>
          )}
        </section>
      )}

      <div className={styles.twoCol}>
        <section>
          <h2 className={styles.sectionTitle}>Latest scouting</h2>
          {s.activity.length === 0 ? (
            <Empty title="Nothing scouted yet">Entries appear as soon as a phone syncs.</Empty>
          ) : (
            <ul className={styles.miniList}>
              {s.activity.map((a, i) => (
                <li key={i} className={styles.miniRow} style={{ '--i': Math.min(i, 8) }}>
                  <span className={styles.miniTitle}>Team {a.team_number}</span>
                  <span className={styles.miniMeta}>
                    <code className={styles.bucketTag}>{a.kind}</code>
                    {new Date(a.recorded_at).toLocaleDateString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2 className={styles.sectionTitle}>Recently added</h2>
          {s.recent.length === 0 ? (
            <Empty title="Nothing uploaded yet">Files added anywhere show up here.</Empty>
          ) : (
            <ul className={styles.miniList}>
              {s.recent.map((f, i) => (
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

      <section>
        <h2 className={styles.sectionTitle}>Jump to</h2>
        <div className={styles.quickGrid}>
          {[
            { to: '/portal/scout', icon: 'flag', label: 'Scout a match' },
            { to: '/portal/checklist', icon: 'check', label: 'Coverage' },
            { to: '/portal/compare', icon: 'bars', label: 'Compare teams' },
            { to: '/portal/picks', icon: 'trophy', label: 'Pick list' },
            { to: '/portal/graphs', icon: 'share', label: 'Graphs' },
            { to: '/portal/kb', icon: 'book', label: 'Knowledge' },
          ].map((q) => (
            <a key={q.to} href={`#${q.to}`} className={styles.quickCard}>
              <Icon name={q.icon} size={18} />
              {q.label}
            </a>
          ))}
        </div>
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
