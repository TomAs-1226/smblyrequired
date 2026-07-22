import { useCallback, useEffect, useState } from 'react'
import Icon from '../../Icon'
import { useAuth, ROLES } from '../../../lib/auth'
import { supabase } from '../../../lib/supabase'
import {
  listMembers,
  listAuditLog,
  storageSummary,
  backupHealth,
  formatBytes,
} from '../../../lib/portalApi'
import { Loading, Empty, ErrorState, StatTile, Row } from '../ui'
import BackupLeg from '../BackupLeg'
import styles from '../Portal.module.css'

// The admin panel is the one place role changes, approvals, and the security
// record all live. It is admin-only in PANELS, but that gate is cosmetic — RLS
// and the set_member_role() RPC are the real boundary, and every write here goes
// through them. Nothing on this screen trusts the UI's own idea of who you are.
export default function Admin() {
  const { user } = useAuth()
  const [s, setS] = useState({ loading: true, error: null })
  // The id of the member currently being written, so exactly one row shows a
  // busy state instead of the whole list freezing.
  const [saving, setSaving] = useState(null)
  // Guard-rail errors (self-demotion, last admin) are expected outcomes, not
  // page failures — they surface in a banner and leave the panel standing.
  const [actionError, setActionError] = useState(null)

  const load = useCallback(async () => {
    setS((p) => ({ ...p, loading: true, error: null }))
    const [members, audit, storage, health] = await Promise.all([
      listMembers(),
      listAuditLog({ limit: 50 }),
      storageSummary(),
      backupHealth(),
    ])
    setS({
      loading: false,
      // Members is the spine of this panel; if it fails there is nothing to act
      // on. The other three each fall back to their own inline state so one
      // slow or denied query never blanks the whole screen.
      error: members.error ?? null,
      members: members.data ?? [],
      audit: audit.data ?? [],
      auditError: audit.error,
      storage: storage.data ?? [],
      storageError: storage.error,
      health: health.data ?? [],
    })
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Role changes go through the RPC exactly as the roster does: no client holds
  // a column grant on profiles.role, and the function re-checks admin server-
  // side. The errors it raises are already written for a person to read, so they
  // pass through verbatim.
  async function setRole(id, role) {
    setSaving(id)
    setActionError(null)
    const { error } = await supabase.rpc('set_member_role', { target_id: id, new_role: role })
    setSaving(null)
    if (error) {
      setActionError(error.message)
      return
    }
    load()
  }

  // subteam and grad_year DO carry a column grant (migration 0001), and the
  // admins-manage-all policy lets an admin write any member's row, so these are
  // a plain update rather than an RPC.
  async function saveField(id, patch) {
    setSaving(id)
    setActionError(null)
    const { error } = await supabase.from('profiles').update(patch).eq('id', id)
    setSaving(null)
    if (error) {
      setActionError(error.message)
      return
    }
    load()
  }

  if (s.loading) return <Loading rows={8} label="Loading admin tools" />
  if (s.error) return <ErrorState error={s.error} onRetry={load} />

  const pending = s.members.filter((m) => m.role === 'pending')
  const active = s.members.filter((m) => m.role !== 'pending')
  // An audit row's entity_id is the target profile's id as bare text (it is not
  // a foreign key, so it cannot be embedded). Resolve it against the roster we
  // already hold rather than a second round trip.
  const nameById = new Map(s.members.map((m) => [m.id, m.full_name]))
  const totalObjects = s.storage.reduce((sum, b) => sum + b.objects, 0)
  const totalBytes = s.storage.reduce((sum, b) => sum + b.bytes, 0)

  return (
    <div className={styles.stack}>
      {actionError && (
        <div className={styles.adminAlert} role="alert">
          <Icon name="alert" size={16} />
          <span>{actionError}</span>
        </div>
      )}

      {/* Pending approvals lead, and are set apart when non-empty: this is the
          only block here another person is actually waiting on. */}
      {pending.length > 0 && (
        <section className={styles.adminCallout}>
          <h2 className={styles.sectionTitle}>
            <Icon name="users" size={15} />
            Pending approvals
            <span className={styles.countBadge}>{pending.length}</span>
          </h2>
          <ul className={styles.rows}>
            {pending.map((m, i) => (
              <li
                key={m.id}
                className={`${styles.row} ${styles.adminRow}`}
                style={{ '--i': Math.min(i, 8) }}
              >
                <div className={styles.rowMain}>
                  <span className={styles.rowTitle}>{m.full_name || 'Unnamed member'}</span>
                  <span className={styles.rowMeta}>
                    {m.subteam && <code className={styles.bucketTag}>{m.subteam}</code>}
                    {m.grad_year && <span>Class of {m.grad_year}</span>}
                    <span>awaiting a role</span>
                  </span>
                </div>
                <div className={styles.adminActions}>
                  <button
                    type="button"
                    className="btn btn--gold"
                    onClick={() => setRole(m.id, 'member')}
                    disabled={saving === m.id}
                  >
                    {saving === m.id ? (
                      <span className={styles.spinnerSm} aria-hidden="true" />
                    ) : (
                      <Icon name="check" size={16} />
                    )}
                    Approve as member
                  </button>
                  <label className={styles.roleSelect}>
                    <span className="sr-only">
                      Or grant another role to {m.full_name || 'this member'}
                    </span>
                    <select
                      className={`${styles.input} ${styles.adminInput}`}
                      value={m.role}
                      disabled={saving === m.id}
                      onChange={(e) => setRole(m.id, e.target.value)}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className={styles.sectionTitle}>
          <Icon name="users" size={15} />
          Members
          <span className={styles.countBadge}>{active.length}</span>
        </h2>
        {active.length === 0 ? (
          <Empty icon="users" title="No approved members yet">
            Approve someone above and they will appear here.
          </Empty>
        ) : (
          <ul className={styles.rows}>
            {active.map((m, i) => (
              <AdminMemberRow
                key={m.id}
                member={m}
                index={i}
                isSelf={m.id === user?.id}
                saving={saving === m.id}
                onRole={setRole}
                onField={saveField}
              />
            ))}
          </ul>
        )}
      </section>

      {/* The audit trail is a security record, so it is presented plainly — no
          colour-coding that could editorialise who did what. */}
      <section>
        <h2 className={styles.sectionTitle}>
          <Icon name="book" size={15} />
          Activity log
        </h2>
        {s.auditError ? (
          <Empty icon="alert" title="Couldn't load the log">
            {s.auditError}
          </Empty>
        ) : s.audit.length === 0 ? (
          <Empty icon="book" title="Nothing recorded yet">
            Role changes and other audited actions show up here as they happen.
          </Empty>
        ) : (
          <ul className={styles.rows}>
            {s.audit.map((row, i) => (
              <AuditRow key={row.id} row={row} index={i} nameById={nameById} />
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className={styles.sectionTitle}>
          <Icon name="folder" size={15} />
          Storage
        </h2>
        {s.storageError ? (
          <Empty icon="alert" title="Couldn't total storage">
            {s.storageError}
          </Empty>
        ) : (
          <>
            <div className={styles.statGrid}>
              <StatTile label="Objects indexed" value={totalObjects.toLocaleString()} />
              <StatTile label="Total size" value={formatBytes(totalBytes)} />
              <StatTile label="Buckets" value={s.storage.length} />
            </div>
            <ul className={styles.miniList}>
              {s.storage.map((b, i) => (
                <li key={b.bucket} className={styles.miniRow} style={{ '--i': Math.min(i, 8) }}>
                  <span className={styles.miniTitle}>
                    <code className={styles.bucketTag}>{b.bucket}</code>
                  </span>
                  <span className={styles.miniMeta}>
                    <span>
                      {b.objects.toLocaleString()} {b.objects === 1 ? 'object' : 'objects'}
                    </span>
                    <span>{formatBytes(b.bytes)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section>
        <h2 className={styles.sectionTitle}>
          <Icon name="check" size={15} />
          Backup — as of last run
        </h2>
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
    </div>
  )
}

// A member row with inline editing. Role goes through the RPC; subteam and
// grad_year are plain column writes. Text fields commit on blur (or Enter) so a
// write fires once per edit, not once per keystroke.
function AdminMemberRow({ member, index, isSelf, saving, onRole, onField }) {
  const [subteam, setSubteam] = useState(member.subteam ?? '')
  const [gradYear, setGradYear] = useState(member.grad_year != null ? String(member.grad_year) : '')

  // Saving reloads the roster, replacing this member object. Pull the server's
  // values back into the inputs so a field can never sit showing something that
  // was never stored.
  useEffect(() => {
    setSubteam(member.subteam ?? '')
    setGradYear(member.grad_year != null ? String(member.grad_year) : '')
  }, [member.subteam, member.grad_year])

  function commitSubteam() {
    const next = subteam.trim()
    if (next === (member.subteam ?? '')) return
    onField(member.id, { subteam: next || null })
  }

  function commitGradYear() {
    const raw = gradYear.trim()
    const next = raw === '' ? null : Number(raw)
    if (next === (member.grad_year ?? null)) return
    // The column is checked 2000–2100 in the database. Reject junk here rather
    // than firing a write that will only bounce, and snap the field back so it
    // does not keep showing an invalid value.
    if (next !== null && (!Number.isInteger(next) || next < 2000 || next > 2100)) {
      setGradYear(member.grad_year != null ? String(member.grad_year) : '')
      return
    }
    onField(member.id, { grad_year: next })
  }

  return (
    <li className={`${styles.row} ${styles.adminRow}`} style={{ '--i': Math.min(index, 8) }}>
      <div className={styles.rowMain}>
        <span className={styles.rowTitle}>
          {member.full_name || 'Unnamed member'}
          {isSelf && <span className={styles.selfTag}>you</span>}
        </span>
        <div className={styles.adminFields}>
          <label className={styles.adminField}>
            <span className="sr-only">Subteam for {member.full_name || 'this member'}</span>
            <input
              type="text"
              className={`${styles.input} ${styles.adminInput}`}
              value={subteam}
              placeholder="Subteam"
              disabled={saving}
              onChange={(e) => setSubteam(e.target.value)}
              onBlur={commitSubteam}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            />
          </label>
          <label className={styles.adminField}>
            <span className="sr-only">Graduation year for {member.full_name || 'this member'}</span>
            <input
              type="number"
              inputMode="numeric"
              min="2000"
              max="2100"
              className={`${styles.input} ${styles.adminInput}`}
              value={gradYear}
              placeholder="Grad year"
              disabled={saving}
              onChange={(e) => setGradYear(e.target.value)}
              onBlur={commitGradYear}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            />
          </label>
        </div>
      </div>

      {isSelf ? (
        // The database blocks an admin changing their own role (set_member_role
        // and the guard trigger both refuse it). The UI says so plainly instead
        // of offering a control that would only ever error.
        <span
          className={`${styles.roleTag} ${styles[`role_${member.role}`] ?? ''}`}
          title="You cannot change your own role"
        >
          {member.role}
        </span>
      ) : (
        <label className={styles.roleSelect}>
          <span className="sr-only">Role for {member.full_name || 'this member'}</span>
          <select
            className={`${styles.input} ${styles.adminInput}`}
            value={member.role}
            disabled={saving}
            onChange={(e) => onRole(member.id, e.target.value)}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
      )}
    </li>
  )
}

// One audit entry. "role.change — {who} — {from} → {to}", with actor and time.
function AuditRow({ row, index, nameById }) {
  const actor = row.actor?.full_name || 'System'
  const when = new Date(row.created_at)
  const isRole = row.action === 'role.change'
  const from = row.detail?.from
  const to = row.detail?.to
  const target =
    row.entity === 'profiles'
      ? nameById.get(row.entity_id) || 'a former member'
      : row.entity_id || row.entity

  return (
    <Row index={index}>
      <div className={styles.rowMain}>
        <span className={styles.rowTitle}>
          <code className={styles.hash}>{row.action}</code>
          {isRole && from && to ? (
            <span className={styles.auditChange}>
              {target}
              {' · '}
              {from}
              <Icon name="arrowRight" size={13} className={styles.auditArrow} />
              {to}
            </span>
          ) : (
            <span className={styles.auditChange}>
              {row.entity}
              {row.entity === 'profiles' ? ` · ${target}` : ''}
            </span>
          )}
        </span>
        <span className={styles.rowMeta}>
          <span>{actor}</span>
          <span>·</span>
          <span>
            {when.toLocaleDateString()}{' '}
            {when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </span>
      </div>
    </Row>
  )
}
