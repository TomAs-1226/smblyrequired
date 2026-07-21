import { useCallback, useEffect, useMemo, useState } from 'react'
import Icon from '../../Icon'
import { useAuth } from '../../../lib/auth'
import { listDocs, getDoc, saveDoc } from '../../../lib/portalApi'
import { renderMarkdown } from '../../../lib/markdown'
import { Loading, Empty, ErrorState, Toolbar, Search, Row } from '../ui'
import styles from '../Portal.module.css'

export default function Knowledge() {
  const { atLeast } = useAuth()
  const [search, setSearch] = useState('')
  const [state, setState] = useState({ loading: true, error: null, docs: [] })
  const [openSlug, setOpenSlug] = useState(null)
  const [editing, setEditing] = useState(null)

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }))
    const { data, error } = await listDocs({ search })
    setState({ loading: false, error, docs: data })
  }, [search])

  useEffect(() => {
    const id = setTimeout(load, search ? 250 : 0)
    return () => clearTimeout(id)
  }, [load, search])

  if (editing !== null) {
    return (
      <Editor
        initial={editing}
        onCancel={() => setEditing(null)}
        onSaved={() => {
          setEditing(null)
          load()
        }}
      />
    )
  }

  if (openSlug) {
    return (
      <Reader
        slug={openSlug}
        onBack={() => setOpenSlug(null)}
        onEdit={(doc) => setEditing(doc)}
        canEdit={atLeast('member')}
      />
    )
  }

  return (
    <div className={styles.stack}>
      <Toolbar>
        <Search value={search} onChange={setSearch} placeholder="Search the knowledge base…" />
        {atLeast('member') && (
          <button
            type="button"
            className={`btn btn--cyan ${styles.addBtn}`}
            onClick={() => setEditing({ slug: '', title: '', body_md: '', category: '' })}
          >
            <Icon name="plus" size={16} />
            New doc
          </button>
        )}
      </Toolbar>

      {state.loading ? (
        <Loading rows={5} label="Loading docs" />
      ) : state.error ? (
        <ErrorState error={state.error} onRetry={load} />
      ) : state.docs.length === 0 ? (
        <Empty
          icon="book"
          title={search ? 'Nothing matches that' : 'The knowledge base is empty'}
        >
          {search
            ? 'Try different words — this searches titles and body text.'
            : 'Team conventions, the build process, why decisions were made. Write down what the next roster will otherwise have to rediscover.'}
        </Empty>
      ) : (
        <ul className={styles.rows}>
          {state.docs.map((d, i) => (
            <Row key={d.id} index={i}>
              <button type="button" className={styles.rowLink} onClick={() => setOpenSlug(d.slug)}>
                <span className={styles.rowMain}>
                  <span className={styles.rowTitle}>
                    {d.is_pinned && (
                      <Icon name="star" size={13} className={styles.pinIcon} aria-label="Pinned" />
                    )}
                    {d.title}
                  </span>
                  <span className={styles.rowMeta}>
                    {d.category && <code className={styles.bucketTag}>{d.category}</code>}
                    <span>Updated {new Date(d.updated_at).toLocaleDateString()}</span>
                  </span>
                </span>
                <Icon name="arrowRight" size={16} className={styles.rowChevron} />
              </button>
            </Row>
          ))}
        </ul>
      )}
    </div>
  )
}

function Reader({ slug, onBack, onEdit, canEdit }) {
  const [state, setState] = useState({ loading: true, error: null, doc: null })

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data, error } = await getDoc(slug)
      if (cancelled) return
      setState({ loading: false, error, doc: data })
    })()
    return () => {
      cancelled = true
    }
  }, [slug])

  const html = useMemo(
    () => (state.doc ? renderMarkdown(state.doc.body_md) : ''),
    [state.doc]
  )

  if (state.loading) return <Loading rows={6} label="Loading doc" />
  if (state.error) return <ErrorState error={state.error} />
  if (!state.doc) return <Empty title="That doc no longer exists" />

  return (
    <article className={styles.stack}>
      <div className={styles.docHead}>
        <button type="button" className={styles.backBtn} onClick={onBack}>
          <Icon name="arrowLeft" size={15} />
          All docs
        </button>
        {canEdit && (
          <button type="button" className="btn btn--ghost" onClick={() => onEdit(state.doc)}>
            Edit
          </button>
        )}
      </div>
      <h2 className={styles.docTitle}>{state.doc.title}</h2>
      {/* Safe: renderMarkdown escapes all input before applying any formatting,
          so nothing author-supplied can reach the DOM as markup. See markdown.js. */}
      <div className={styles.prose} dangerouslySetInnerHTML={{ __html: html }} />
    </article>
  )
}

function Editor({ initial, onCancel, onSaved }) {
  const [title, setTitle] = useState(initial.title ?? '')
  const [slug, setSlug] = useState(initial.slug ?? '')
  const [category, setCategory] = useState(initial.category ?? '')
  const [body, setBody] = useState(initial.body_md ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [preview, setPreview] = useState(false)

  const isNew = !initial.id

  // Slug follows the title while the doc is new. Once saved, the slug is a
  // stable identifier that other docs may link to, so it stops moving.
  function onTitle(v) {
    setTitle(v)
    if (isNew) {
      setSlug(
        v
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 60)
      )
    }
  }

  async function submit(e) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    const { error: err } = await saveDoc({
      id: initial.id,
      slug,
      title: title.trim(),
      body_md: body,
      category: category.trim(),
    })
    setBusy(false)
    if (err) {
      setError(err)
      return
    }
    onSaved()
  }

  return (
    <form className={styles.stack} onSubmit={submit}>
      <div className={styles.docHead}>
        <button type="button" className={styles.backBtn} onClick={onCancel}>
          <Icon name="arrowLeft" size={15} />
          Cancel
        </button>
        <button
          type="button"
          className={styles.previewToggle}
          aria-pressed={preview}
          onClick={() => setPreview((p) => !p)}
        >
          {preview ? 'Write' : 'Preview'}
        </button>
      </div>

      <div className={styles.uploaderGrid}>
        <label className={styles.field}>
          <span className={styles.label}>Title</span>
          <input
            type="text"
            className={styles.input}
            value={title}
            onChange={(e) => onTitle(e.target.value)}
            required
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Slug</span>
          <input
            type="text"
            className={styles.input}
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            pattern="[a-z0-9][a-z0-9-]*"
            required
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Category</span>
          <input
            type="text"
            className={styles.input}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="build, strategy, outreach…"
          />
        </label>
      </div>

      {preview ? (
        <div
          className={styles.prose}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }}
        />
      ) : (
        <label className={styles.field}>
          <span className={styles.label}>Body — Markdown</span>
          <textarea
            className={styles.textarea}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={18}
            spellCheck
          />
        </label>
      )}

      <p className={styles.uploadNote}>
        No IPs, hostnames, ports, keys, or tokens. The database rejects the obvious patterns on
        save, but it only catches what it has a pattern for — read what you are about to store.
      </p>

      <div className={styles.errorSlot} role="alert" aria-live="polite">
        {error && (
          <span className={styles.error}>
            <Icon name="alert" size={15} />
            {error}
          </span>
        )}
      </div>

      <div className={styles.uploaderActions}>
        <button type="submit" className="btn btn--gold" disabled={busy || !title.trim()}>
          {busy ? (
            <>
              <span className={styles.spinnerSm} aria-hidden="true" />
              Saving…
            </>
          ) : (
            'Save'
          )}
        </button>
      </div>
    </form>
  )
}
