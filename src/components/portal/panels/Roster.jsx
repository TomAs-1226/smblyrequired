import { useEffect, useState } from 'react'
import { useAuth } from '../../../lib/auth'
import { listMembers } from '../../../lib/portalApi'
import { supabase } from '../../../lib/supabase'
import { ROLES } from '../../../lib/auth'
import { Loading, Empty, ErrorState, Row } from '../ui'
import styles from '../Portal.module.css'

export default function Roster() {
  const { atLeast, user } = useAuth()
  const [state, setState] = useState({ loading: true, error: null, members: [] })
  const [saving, setSaving] = useState(null)

  async function load() {
    setState((s) => ({ ...s, loading: true, error: null }))
    const { data, error } = await listMembers()
    setState({ loading: false, error, members: data })
  }

  useEffect(() => {
    load()
  }, [])

  // Goes through the set_member_role RPC, not a direct UPDATE: no client has a
  // column grant on profiles.role, so this is the only path that can write it,
  // and it re-checks that the caller is an admin server-side. Hiding the control
  // from non-admins is cosmetic — the database is what actually refuses.
  async function setRole(id, role) {
    setSaving(id)
    const { error } = await supabase.rpc('set_member_role', {
      target_id: id,
      new_role: role,
    })
    setSaving(null)
    if (error) {
      setState((s) => ({ ...s, error: error.message }))
      return
    }
    load()
  }

  if (state.loading) return <Loading rows={6} label="Loading roster" />
  if (state.error) return <ErrorState error={state.error} onRetry={load} />
  if (state.members.length === 0) return <Empty icon="users" title="No one on the roster yet" />

  const pending = state.members.filter((m) => m.role === 'pending')
  const active = state.members.filter((m) => m.role !== 'pending')
  const canManage = atLeast('admin')

  return (
    <div className={styles.stack}>
      {/* Leads can open this page but cannot act on it — role changes are
          admin-only. Saying so beats leaving them to wonder where the control
          is, or to conclude the page is broken. */}
      {!canManage && (
        <p className={styles.uploadNote}>
          You can see the roster, but only an <strong>admin</strong> can change someone's role.
        </p>
      )}

      {pending.length > 0 && (
        <section>
          <h2 className={styles.sectionTitle}>
            Awaiting approval
            <span className={styles.countBadge}>{pending.length}</span>
          </h2>
          <ul className={styles.rows}>
            {pending.map((m, i) => (
              <MemberRow
                key={m.id}
                member={m}
                index={i}
                canManage={canManage}
                saving={saving === m.id}
                isSelf={m.id === user?.id}
                onRole={setRole}
              />
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className={styles.sectionTitle}>Team</h2>
        <ul className={styles.rows}>
          {active.map((m, i) => (
            <MemberRow
              key={m.id}
              member={m}
              index={i}
              canManage={canManage}
              saving={saving === m.id}
              isSelf={m.id === user?.id}
              onRole={setRole}
            />
          ))}
        </ul>
      </section>
    </div>
  )
}

function MemberRow({ member, index, canManage, saving, isSelf, onRole }) {
  return (
    <Row index={index}>
      <div className={styles.rowMain}>
        <span className={styles.rowTitle}>
          {member.full_name || 'Unnamed member'}
          {isSelf && <span className={styles.selfTag}>you</span>}
        </span>
        <span className={styles.rowMeta}>
          {member.subteam && <code className={styles.bucketTag}>{member.subteam}</code>}
          {member.grad_year && <span>Class of {member.grad_year}</span>}
        </span>
      </div>

      {canManage && !isSelf ? (
        <label className={styles.roleSelect}>
          <span className="sr-only">Role for {member.full_name || 'this member'}</span>
          <select
            className={styles.input}
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
      ) : (
        <span className={`${styles.roleTag} ${styles[`role_${member.role}`] ?? ''}`}>
          {member.role}
        </span>
      )}
    </Row>
  )
}
