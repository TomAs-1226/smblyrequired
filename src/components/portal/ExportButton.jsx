import { useState } from 'react'
import Icon from '../Icon'
import { toCsv, downloadCsv } from '../../lib/exportCsv'
import styles from './Portal.module.css'

// A reusable "download this as a CSV" button.
//
// It owns the whole gesture: fetch on click, build the CSV, trigger the
// download, show a spinner meanwhile, and surface an error if the fetch fails. It
// knows nothing about what it is exporting — `load` returns the rows and
// `columns` says how to lay them out. `columns` may be a function of the rows,
// for when the column set is only known after fetching; the union of dynamic
// jsonb keys is exactly that case.
//
// The button itself is a global `.btn` (default: the ghost variant), so its
// hover / :active / focus-visible / reduced-motion states all come from the one
// place those live. Nothing new to keep in sync.
export default function ExportButton({
  load,
  columns,
  filename = 'export.csv',
  children = 'Export CSV',
  disabled = false,
  className = 'btn btn--ghost',
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function run() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const rows = (await load()) ?? []
      const cols = typeof columns === 'function' ? columns(rows) : columns
      const name = typeof filename === 'function' ? filename(rows) : filename
      // An empty result still downloads — a header-only file is an honest answer
      // ("nothing matched"), and far better than a button that silently does
      // nothing the user cannot tell apart from broken.
      downloadCsv(name, toCsv(rows, cols))
    } catch (e) {
      setError(e?.message || 'Could not build the export.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className={styles.exportButton}>
      <button
        type="button"
        className={className}
        onClick={run}
        disabled={disabled || busy}
        aria-busy={busy}
      >
        {busy ? (
          <span className={styles.spinnerSm} aria-hidden="true" />
        ) : (
          <Icon name="download" size={16} />
        )}
        {children}
      </button>
      {error && (
        <span className={styles.error} role="alert">
          <Icon name="alert" size={14} />
          {error}
        </span>
      )}
    </span>
  )
}
