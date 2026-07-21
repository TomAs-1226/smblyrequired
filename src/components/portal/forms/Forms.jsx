import { useCallback, useEffect, useMemo, useState } from 'react'
import Icon from '../../Icon'
import { useAuth } from '../../../lib/auth'
import {
  activateForm,
  deleteForm,
  formEntryCount,
  listForms,
  saveForm,
} from '../../../lib/scoutingApi'
import FormBuilder, { Confirm, KINDS, PROTECTED, PROTECTED_KEYS } from './FormBuilder'
import { Empty, ErrorState, Loading } from '../ui'
import styles from '../Portal.module.css'
import b from './FormBuilder.module.css'

// -----------------------------------------------------------------------------
// The Forms panel: every season's scouting forms, and the way into the builder.
//
// Duplicate is the button that matters. Next season's form is last season's with
// edits — never a blank page — and the alternative to duplicating is retyping
// thirty fields, which is not merely slow: it is the single most reliable way to
// introduce a mistyped key that nothing notices until the data is already wrong.
// -----------------------------------------------------------------------------

const THIS_SEASON = new Date().getFullYear()

/** Which of the three the analysis reads are absent. Empty for `strategy`. */
function missingStandard(form) {
  if (form.kind === 'strategy') return []
  const have = new Set((form.fields ?? []).map((f) => f.key))
  return PROTECTED_KEYS.filter((k) => !have.has(k))
}

function sectionCount(fields) {
  let n = 0
  let prev = null
  for (const f of fields ?? []) {
    const s = f.section || ''
    if (s !== prev) n += 1
    prev = s
  }
  return n
}

export default function Forms() {
  const { atLeast } = useAuth()
  const canWrite = atLeast('lead')

  const [state, setState] = useState({ loading: true, error: null, forms: [] })
  const [editing, setEditing] = useState(null) // { form } — null means the list
  const [season, setSeason] = useState('all')
  const [busy, setBusy] = useState(null)
  const [confirm, setConfirm] = useState(null)
  const [actionError, setActionError] = useState(null)

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }))
    const { data, error } = await listForms()
    setState({ loading: false, error, forms: data })
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const seasons = useMemo(
    () => [...new Set(state.forms.map((f) => f.season))].sort((x, y) => y - x),
    [state.forms]
  )

  // season -> kind -> forms. Rebuilt rather than sorted in place so the source
  // list stays in the order the API returned it.
  const grouped = useMemo(() => {
    const out = new Map()
    for (const f of state.forms) {
      if (season !== 'all' && f.season !== season) continue
      if (!out.has(f.season)) out.set(f.season, new Map())
      const byKind = out.get(f.season)
      if (!byKind.has(f.kind)) byKind.set(f.kind, [])
      byKind.get(f.kind).push(f)
    }
    return [...out.entries()].sort((x, y) => y[0] - x[0])
  }, [state.forms, season])

  // --- actions ----------------------------------------------------------------

  /**
   * Next season's form, pre-loaded with this one's questions.
   *
   * Opened UNSAVED. A duplicate that wrote itself to the database immediately
   * would leave a half-edited near-copy behind every time somebody opened one to
   * look at it, and two forms with almost the same name is exactly the confusion
   * this screen is supposed to prevent.
   */
  function duplicate(form) {
    const rolling = form.season < THIS_SEASON
    setEditing({
      form: {
        id: null,
        season: rolling ? THIS_SEASON : form.season,
        kind: form.kind,
        // Rolling a form into a new season keeps its name — it is that season's
        // form now. Copying within a season needs a name that differs, or the
        // list shows two identical rows.
        name: rolling ? form.name : `${form.name} (copy)`,
        description: form.description,
        // Deep-cloned: the builder mutates blocks freely, and sharing the option
        // arrays with the row still sitting in the list would edit both.
        fields: JSON.parse(JSON.stringify(form.fields ?? [])),
        // Never inherited. Publishing is a decision, and inheriting it would
        // silently retire the form scouts are using right now.
        is_active: false,
      },
    })
  }

  async function publish(form) {
    setBusy(form.id)
    setActionError(null)
    const { error } = await activateForm(form)
    setBusy(null)
    if (error) setActionError(error)
    else load()
  }

  async function unpublish(form) {
    setBusy(form.id)
    setActionError(null)
    const { error } = await saveForm({ ...form, is_active: false })
    setBusy(null)
    if (error) setActionError(error)
    else load()
  }

  async function askDelete(form) {
    setBusy(form.id)
    setActionError(null)
    const { data: count } = await formEntryCount(form.id)
    setBusy(null)

    setConfirm({
      title: `Delete “${form.name}”?`,
      danger: true,
      // A form with entries takes a typed confirmation. The entries survive the
      // delete (form_id is ON DELETE SET NULL) but lose the only record of what
      // the questions were, which is not something to click through by accident.
      typed: count > 0 ? form.name : undefined,
      confirmLabel: 'Delete the form',
      body: (
        <>
          {count > 0 ? (
            <>
              <p>
                {count} {count === 1 ? 'entry has' : 'entries have'} been recorded on this form.
                Deleting it does <strong>not</strong> delete them — they stay in the database, but
                they lose the definition that says what their keys meant.
              </p>
              <p>Duplicating and editing is almost always the better move.</p>
            </>
          ) : (
            <p>Nothing has been recorded on this form yet, so nothing is lost.</p>
          )}
          {form.is_active && (
            <p>
              It is also the <strong>live</strong> form for {form.season}{' '}
              {form.kind}. Deleting it leaves scouts with nothing to fill in until another is
              published.
            </p>
          )}
        </>
      ),
      onConfirm: async () => {
        setConfirm(null)
        setBusy(form.id)
        const { error } = await deleteForm(form.id)
        setBusy(null)
        if (error) setActionError(error)
        else load()
      },
    })
  }

  // --- render -----------------------------------------------------------------

  if (editing) {
    return (
      <FormBuilder
        // Remounts on a different form so the builder never carries one form's
        // block state into another.
        key={editing.form?.id ?? 'new'}
        form={editing.form}
        canWrite={canWrite}
        onSaved={load}
        onDone={() => {
          setEditing(null)
          load()
        }}
      />
    )
  }

  if (state.loading) return <Loading rows={5} label="Loading forms" />
  if (state.error) return <ErrorState error={state.error} onRetry={load} />

  return (
    <div className={styles.stack}>
      {!canWrite && (
        <p className={b.note}>
          You can read these but not change them — authoring is limited to leads and mentors, and
          the database enforces that whatever this screen offers.
        </p>
      )}

      <div className={styles.toolbar}>
        {seasons.length > 1 && (
          <div className={styles.chips}>
            <button
              type="button"
              className={`${styles.chip} ${season === 'all' ? styles.chipOn : ''}`}
              aria-pressed={season === 'all'}
              onClick={() => setSeason('all')}
            >
              All seasons
            </button>
            {seasons.map((s) => (
              <button
                key={s}
                type="button"
                className={`${styles.chip} ${season === s ? styles.chipOn : ''}`}
                aria-pressed={season === s}
                onClick={() => setSeason(s)}
              >
                {s}
              </button>
            ))}
          </div>
        )}
        {canWrite && (
          <button
            type="button"
            className={`btn btn--cyan ${styles.addBtn}`}
            onClick={() => setEditing({ form: null })}
          >
            <Icon name="plus" size={16} />
            New form
          </button>
        )}
      </div>

      <div className={styles.errorSlot} role="alert" aria-live="polite">
        {actionError && (
          <span className={styles.error}>
            <Icon name="alert" size={15} />
            {actionError}
          </span>
        )}
      </div>

      {state.forms.length === 0 ? (
        <Empty
          icon="flag"
          title="No scouting forms yet"
          action={
            canWrite ? (
              <button type="button" className="btn btn--gold" onClick={() => setEditing({ form: null })}>
                Build the first one
              </button>
            ) : null
          }
        >
          Scouts cannot record anything until a form exists and is published.
        </Empty>
      ) : (
        grouped.map(([yr, byKind]) => (
          <section key={yr}>
            <h2 className={b.seasonHead}>
              {yr}
              {yr === THIS_SEASON && <span className={b.seasonNow}>this season</span>}
            </h2>

            {KINDS.filter((k) => byKind.has(k.id)).map((k) => (
              <div key={k.id} className={b.kindBlock}>
                <h3 className={styles.sectionTitle}>
                  {k.label}
                  <span className={styles.countBadge}>{byKind.get(k.id).length}</span>
                </h3>
                <ul className={styles.rows}>
                  {byKind.get(k.id).map((form, i) => (
                    <FormRow
                      key={form.id}
                      form={form}
                      index={i}
                      busy={busy === form.id}
                      canWrite={canWrite}
                      onEdit={() => setEditing({ form })}
                      onDuplicate={() => duplicate(form)}
                      onPublish={() => publish(form)}
                      onUnpublish={() => unpublish(form)}
                      onDelete={() => askDelete(form)}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </section>
        ))
      )}

      {confirm && <Confirm {...confirm} onCancel={() => setConfirm(null)} />}
    </div>
  )
}

function FormRow({ form, index, busy, canWrite, onEdit, onDuplicate, onPublish, onUnpublish, onDelete }) {
  const missing = missingStandard(form)
  const count = (form.fields ?? []).length
  const sections = sectionCount(form.fields)

  return (
    <li className={`${styles.row} ${b.formRow}`} style={{ '--i': Math.min(index, 8) }}>
      <div className={styles.rowMain}>
        <span className={styles.rowTitle}>
          {form.name}
          {form.is_active && <span className={b.liveTag}>Live</span>}
        </span>
        {form.description && <span className={styles.rowDesc}>{form.description}</span>}
        <span className={styles.rowMeta}>
          <span>
            {count} {count === 1 ? 'block' : 'blocks'}
          </span>
          <span>
            {sections} {sections === 1 ? 'screen' : 'screens'}
          </span>
          {form.updated_at && <span>edited {new Date(form.updated_at).toLocaleDateString()}</span>}
        </span>
        {missing.length > 0 && (
          <span className={b.missingTag}>
            <Icon name="alert" size={13} />
            missing {missing.map((k) => PROTECTED[k].key).join(', ')} — entries on this form stay
            invisible to the pick list
          </span>
        )}
      </div>

      <div className={b.rowActions}>
        <button type="button" className={b.actionBtn} onClick={onEdit} disabled={busy}>
          {canWrite ? 'Edit' : 'View'}
        </button>
        {canWrite && (
          <>
            <button type="button" className={b.actionBtn} onClick={onDuplicate} disabled={busy}>
              Duplicate
            </button>
            {form.is_active ? (
              <button type="button" className={b.actionBtn} onClick={onUnpublish} disabled={busy}>
                Unpublish
              </button>
            ) : (
              <button
                type="button"
                className={`${b.actionBtn} ${b.actionBtnGo}`}
                onClick={onPublish}
                disabled={busy}
              >
                Publish
              </button>
            )}
            <button
              type="button"
              className={`${b.actionBtn} ${b.actionBtnBad}`}
              onClick={onDelete}
              disabled={busy}
              aria-label={`Delete ${form.name}`}
            >
              {busy ? <span className={styles.spinnerSm} aria-hidden="true" /> : <Icon name="close" size={15} />}
            </button>
          </>
        )}
      </div>
    </li>
  )
}
