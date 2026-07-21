import { useCallback, useEffect, useState } from 'react'
import Icon from '../../Icon'
import { useAuth } from '../../../lib/auth'
import { listFiles, signedUrl, uploadFile, sha256Hex, formatBytes } from '../../../lib/portalApi'
import { useFileViewer, canPreview } from '../viewers/openFile'
import { Loading, Empty, ErrorState, Toolbar, Search, Row } from '../ui'
import styles from '../Portal.module.css'

const KINDS = [
  { id: '', label: 'All' },
  { id: 'graph', label: 'Graphs' },
  { id: 'code', label: 'Code' },
  { id: 'cad', label: 'CAD' },
  { id: 'doc', label: 'Docs' },
  { id: 'photo', label: 'Photos' },
  { id: 'video', label: 'Video' },
]

export default function Files() {
  const { atLeast } = useAuth()
  const [kind, setKind] = useState('')
  const [search, setSearch] = useState('')
  const [state, setState] = useState({ loading: true, error: null, files: [] })
  const [opening, setOpening] = useState(null)

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }))
    const { data, error } = await listFiles({ kind: kind || undefined, search })
    setState({ loading: false, error, files: data })
  }, [kind, search])

  // Debounced so typing does not fire a query per keystroke.
  useEffect(() => {
    const id = setTimeout(load, search ? 250 : 0)
    return () => clearTimeout(id)
  }, [load, search])

  // Previewing reloads the list afterwards, because the code editor saves edits
  // as a NEW version rather than overwriting — the new file would otherwise be
  // invisible until a manual refresh.
  const viewer = useFileViewer({ onSaved: load })

  // Anything we can render opens in the viewer. Everything else falls back to a
  // signed URL in a new tab, which is the honest outcome for a 400 MB CAD export
  // that no browser is going to display.
  async function open(file) {
    if (canPreview(file.path)) {
      viewer.open({
        bucket: file.bucket,
        path: file.path,
        title: file.title,
        byteSize: file.byte_size,
      })
      return
    }
    setOpening(file.id)
    const { data, error } = await signedUrl(file.bucket, file.path)
    setOpening(null)
    if (error || !data) {
      setState((s) => ({ ...s, error: error ?? 'Could not open that file.' }))
      return
    }
    window.open(data, '_blank', 'noopener,noreferrer')
  }

  return (
    <div className={styles.stack}>
      <Toolbar>
        <Search value={search} onChange={setSearch} placeholder="Search files…" />
        <div className={styles.chips} role="group" aria-label="Filter by kind">
          {KINDS.map((k) => (
            <button
              key={k.id || 'all'}
              type="button"
              className={`${styles.chip} ${kind === k.id ? styles.chipOn : ''}`}
              aria-pressed={kind === k.id}
              onClick={() => setKind(k.id)}
            >
              {k.label}
            </button>
          ))}
        </div>
      </Toolbar>

      {atLeast('member') && <Uploader onDone={load} />}

      {state.loading ? (
        <Loading rows={5} label="Loading files" />
      ) : state.error ? (
        <ErrorState error={state.error} onRetry={load} />
      ) : state.files.length === 0 ? (
        <Empty title={search || kind ? 'Nothing matches that' : 'No files yet'}>
          {search || kind
            ? 'Try a different search or clear the filter.'
            : 'Upload robot photos, CAD exports, or season documents to get started.'}
        </Empty>
      ) : (
        <ul className={styles.rows}>
          {state.files.map((f, i) => (
            <Row key={f.id} index={i}>
              <div className={styles.rowMain}>
                <span className={styles.rowTitle}>{f.title}</span>
                {f.description && <span className={styles.rowDesc}>{f.description}</span>}
                <span className={styles.rowMeta}>
                  <code className={styles.bucketTag}>{f.bucket}</code>
                  {f.season && <span>{f.season}</span>}
                  <span>{formatBytes(f.byte_size)}</span>
                  {f.sha256 && (
                    <code className={styles.hash} title={f.sha256}>
                      {f.sha256.slice(0, 8)}
                    </code>
                  )}
                </span>
              </div>
              <button
                type="button"
                className={styles.rowAction}
                onClick={() => open(f)}
                disabled={opening === f.id}
              >
                {opening === f.id ? (
                  <span className={styles.spinnerSm} aria-hidden="true" />
                ) : (
                  <Icon name={canPreview(f.path) ? 'search' : 'download'} size={16} />
                )}
                <span className="sr-only">
                  {canPreview(f.path) ? 'Preview' : 'Download'} {f.title}
                </span>
              </button>
            </Row>
          ))}
        </ul>
      )}
      {/* Rendered into document.body via a portal, so it is not clipped by the
          panel's own stacking context. */}
      {viewer.element}
    </div>
  )
}

function Uploader({ onDone }) {
  const [file, setFile] = useState(null)
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState('doc')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [open, setOpen] = useState(false)

  const BUCKET_FOR = { graph: 'graphs', code: 'code', cad: 'code', doc: 'knowledge' }

  async function submit(e) {
    e.preventDefault()
    if (!file || busy) return
    setBusy(true)
    setError(null)

    const bucket = BUCKET_FOR[kind] ?? 'media'
    // Prefix with the year and a random segment so two people uploading
    // "robot.jpg" on the same day cannot collide, and so the bucket stays
    // browsable by season rather than being one flat pile.
    const year = new Date().getFullYear()
    const safeName = file.name.replace(/[^\w.\-]+/g, '_')
    const path = `${year}/${crypto.randomUUID().slice(0, 8)}-${safeName}`

    const sha256 = await sha256Hex(file)
    const { error: err } = await uploadFile({
      bucket,
      path,
      file,
      metadata: { title: title.trim() || file.name, kind, season: year, sha256 },
    })

    setBusy(false)
    if (err) {
      setError(err)
      return
    }
    setFile(null)
    setTitle('')
    setOpen(false)
    onDone()
  }

  if (!open) {
    return (
      <button type="button" className={`btn btn--cyan ${styles.addBtn}`} onClick={() => setOpen(true)}>
        <Icon name="plus" size={16} />
        Add a file
      </button>
    )
  }

  return (
    <form className={styles.uploader} onSubmit={submit}>
      <div className={styles.uploaderGrid}>
        <label className={styles.field}>
          <span className={styles.label}>File</span>
          <input
            type="file"
            className={styles.fileInput}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            required
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Title</span>
          <input
            type="text"
            className={styles.input}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={file?.name ?? 'Optional — defaults to the filename'}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Kind</span>
          <select className={styles.input} value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.filter((k) => k.id).map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {file && (
        <p className={styles.uploadNote}>
          {formatBytes(file.size)} → <code className={styles.bucketTag}>{BUCKET_FOR[kind] ?? 'media'}</code>
          {' · checksummed in the browser before upload'}
        </p>
      )}

      <div className={styles.errorSlot} role="alert" aria-live="polite">
        {error && (
          <span className={styles.error}>
            <Icon name="alert" size={15} />
            {error}
          </span>
        )}
      </div>

      <div className={styles.uploaderActions}>
        <button type="submit" className="btn btn--gold" disabled={!file || busy}>
          {busy ? (
            <>
              <span className={styles.spinnerSm} aria-hidden="true" />
              Uploading…
            </>
          ) : (
            'Upload'
          )}
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => {
            setOpen(false)
            setError(null)
          }}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
