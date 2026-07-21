import { useRef, useState } from 'react'
import Icon from '../Icon'
import { supabase } from '../../lib/supabase'
import { uploadFile, sha256Hex, formatBytes } from '../../lib/portalApi'
import styles from './Portal.module.css'

// -----------------------------------------------------------------------------
// Reusable manual upload.
//
// Every automated path here has a manual counterpart on purpose. The repo timer
// pulls code nightly, the camera captures pit photos, graphify writes graphs —
// and all three will, at some point, not be the way something arrives. A file
// someone was emailed, a graph generated on a laptop with no portal access, an
// archive from before the timer existed. Automation that cannot be bypassed
// just means the odd case never gets recorded at all.
//
// `extraFields` describes the domain metadata to collect alongside the file, and
// `onCommit` writes the domain row after the file lands.
// -----------------------------------------------------------------------------

export default function Uploader({
  bucket,
  pathPrefix,
  kind,
  accept,
  title = 'Upload a file',
  hint,
  extraFields = [],
  onCommit,
  onDone,
  // Given the picked File, may return metadata to prefill the form. Used to
  // read counts straight out of a graphify payload rather than making someone
  // transcribe numbers they already have in the file.
  inspect,
}) {
  const [open, setOpen] = useState(false)
  const [file, setFile] = useState(null)
  const [meta, setMeta] = useState({})
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState(null)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)

  function reset() {
    setFile(null)
    setMeta({})
    setError(null)
    setStage(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  async function pick(f) {
    setFile(f)
    setError(null)
    if (!f || !inspect) return
    try {
      const found = await inspect(f)
      if (found) setMeta((m) => ({ ...m, ...found }))
    } catch {
      // Inspection is a convenience. A payload we cannot parse is still a file
      // worth storing — the user just fills the fields in themselves.
    }
  }

  async function submit(e) {
    e.preventDefault()
    if (!file || busy) return
    setBusy(true)
    setError(null)

    try {
      setStage('Checksumming…')
      const sha256 = await sha256Hex(file)

      setStage('Uploading…')
      const year = Number(meta.season) || new Date().getFullYear()
      const safeName = file.name.replace(/[^\w.\-]+/g, '_')
      const path = `${pathPrefix}/${year}/${crypto.randomUUID().slice(0, 8)}-${safeName}`

      const { data: fileRow, error: upErr } = await uploadFile({
        bucket,
        path,
        file,
        metadata: {
          title: (meta.title || '').trim() || file.name,
          description: meta.description || null,
          kind,
          season: year,
          sha256,
        },
      })
      if (upErr) throw new Error(upErr)

      if (onCommit) {
        setStage('Recording…')
        const { error: commitErr } = await onCommit({ fileRow, meta, file, sha256, season: year })
        if (commitErr) {
          // The bytes are stored but the domain row failed. Remove the orphan
          // rather than leaving a file that nothing references and no listing
          // will ever show.
          await supabase.storage.from(bucket).remove([path])
          await supabase.from('files').delete().eq('id', fileRow.id)
          throw new Error(commitErr)
        }
      }

      reset()
      setOpen(false)
      onDone?.()
    } catch (err) {
      setError(String(err.message ?? err))
    } finally {
      setBusy(false)
      setStage(null)
    }
  }

  if (!open) {
    return (
      <button type="button" className={`btn btn--cyan ${styles.addBtn}`} onClick={() => setOpen(true)}>
        <Icon name="plus" size={16} />
        {title}
      </button>
    )
  }

  return (
    <form className={styles.uploader} onSubmit={submit}>
      <div className={styles.uploaderGrid}>
        <label className={styles.field}>
          <span className={styles.label}>File</span>
          <input
            ref={inputRef}
            type="file"
            className={styles.fileInput}
            accept={accept}
            onChange={(e) => pick(e.target.files?.[0] ?? null)}
            required
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Title</span>
          <input
            type="text"
            className={styles.input}
            value={meta.title ?? ''}
            onChange={(e) => setMeta({ ...meta, title: e.target.value })}
            placeholder={file?.name ?? 'Defaults to the filename'}
          />
        </label>

        {extraFields.map((f) => (
          <label key={f.key} className={styles.field}>
            <span className={styles.label}>{f.label}</span>
            {f.options ? (
              <select
                className={styles.input}
                value={meta[f.key] ?? ''}
                onChange={(e) => setMeta({ ...meta, [f.key]: e.target.value })}
                required={f.required}
              >
                <option value="">—</option>
                {f.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={f.type ?? 'text'}
                inputMode={f.type === 'number' ? 'numeric' : undefined}
                className={styles.input}
                value={meta[f.key] ?? ''}
                onChange={(e) => setMeta({ ...meta, [f.key]: e.target.value })}
                placeholder={f.placeholder}
                pattern={f.pattern}
                required={f.required}
              />
            )}
          </label>
        ))}
      </div>

      {hint && <p className={styles.uploadNote}>{hint}</p>}

      {file && (
        <p className={styles.uploadNote}>
          {formatBytes(file.size)} → <code className={styles.bucketTag}>{bucket}</code>
          {' · checksummed in the browser before upload, so the nightly backup can prove the copy matches'}
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
              {stage ?? 'Working…'}
            </>
          ) : (
            'Upload'
          )}
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => {
            reset()
            setOpen(false)
          }}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

/**
 * Best-effort read of a graphify payload so counts are not retyped by hand.
 *
 * Tolerant of shape: graphify output has changed format before, and a slightly
 * different key name should degrade to "fill it in yourself", never to an error.
 */
export async function inspectGraphFile(file) {
  if (!/\.json$/i.test(file.name)) return null
  // Guard against loading a very large graph fully into memory just to peek.
  if (file.size > 25 * 1024 * 1024) return null

  const text = await file.text()
  let g
  try {
    g = JSON.parse(text)
  } catch {
    return null
  }

  const nodes = g.nodes ?? g.vertices ?? []
  const edges = g.edges ?? g.links ?? []
  const communities = g.communities ?? g.clusters ?? null

  const godNodes = (g.god_nodes ?? g.godNodes ?? [])
    .map((n) => (typeof n === 'string' ? n : (n?.id ?? n?.name)))
    .filter(Boolean)
    .slice(0, 12)

  return {
    node_count: Array.isArray(nodes) ? nodes.length : undefined,
    edge_count: Array.isArray(edges) ? edges.length : undefined,
    community_count: Array.isArray(communities) ? communities.length : undefined,
    god_nodes: godNodes,
    source: g.source ?? g.root ?? undefined,
  }
}
