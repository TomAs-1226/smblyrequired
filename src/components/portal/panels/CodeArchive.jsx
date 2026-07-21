import { useEffect, useState } from 'react'
import Icon from '../../Icon'
import { useAuth } from '../../../lib/auth'
import { supabase } from '../../../lib/supabase'
import { listCodeArchives, signedUrl, formatBytes } from '../../../lib/portalApi'
import Uploader from '../Uploader'
import { Loading, Empty, ErrorState, Row } from '../ui'
import styles from '../Portal.module.css'

export default function CodeArchive() {
  const { atLeast } = useAuth()
  const [state, setState] = useState({ loading: true, error: null, items: [] })
  const [opening, setOpening] = useState(null)

  async function load() {
    setState((s) => ({ ...s, loading: true, error: null }))
    const { data, error } = await listCodeArchives()
    setState({ loading: false, error, items: data })
  }

  useEffect(() => {
    load()
  }, [])

  async function open(item) {
    if (!item.files) return
    setOpening(item.id)
    const { data, error } = await signedUrl(item.files.bucket, item.files.path, 600)
    setOpening(null)
    if (error || !data) {
      setState((s) => ({ ...s, error: error ?? 'Could not open that archive.' }))
      return
    }
    window.open(data, '_blank', 'noopener,noreferrer')
  }

  const commit = async ({ fileRow, meta, season }) => {
    const { data: userRes } = await supabase.auth.getUser()
    const { error } = await supabase.from('code_archives').insert({
      repo: (meta.repo || fileRow.title || 'unknown').trim(),
      ref: meta.ref || null,
      // The check constraint wants 7–40 hex chars, so an empty or malformed
      // value has to become null rather than being sent through and rejected.
      commit_sha: /^[a-f0-9]{7,40}$/i.test(meta.commit_sha ?? '')
        ? meta.commit_sha.toLowerCase()
        : null,
      season,
      notes: meta.notes || null,
      file_id: fileRow.id,
      created_by: userRes?.user?.id ?? null,
    })
    return { error: error?.message ?? null }
  }

  const uploader = atLeast('member') ? (
    <Uploader
      bucket="code"
      pathPrefix="manual"
      kind="code"
      accept=".zip,.gz,.tgz,.tar,.7z,.step,.stp,.f3d,.stl,application/zip,application/gzip"
      title="Upload an archive"
      hint="For anything the nightly repo pull will not catch — a CAD export, a build artifact, or code from before the timer was configured."
      extraFields={[
        { key: 'repo', label: 'Repo / name', placeholder: '5805-exodus-code', required: true },
        { key: 'ref', label: 'Tag or branch', placeholder: 'v1.0.0 or main' },
        { key: 'commit_sha', label: 'Commit SHA', placeholder: 'optional, 7–40 hex' },
        { key: 'season', label: 'Season', type: 'number', placeholder: String(new Date().getFullYear()) },
        { key: 'notes', label: 'Notes' },
      ]}
      onCommit={commit}
      onDone={load}
    />
  ) : null

  if (state.loading) return <Loading rows={4} label="Loading archives" />
  if (state.error) return <ErrorState error={state.error} onRetry={load} />
  if (state.items.length === 0) {
    return (
      <div className={styles.stack}>
        {uploader}
        <Empty icon="code" title="No archives yet">
          Season snapshots and CAD exports live here. Git holds the history; this holds the built
          artifacts and the large binaries git should not carry.
        </Empty>
      </div>
    )
  }

  // Grouped by season so the list reads as a timeline, newest first.
  //
  // The query's ORDER BY does not survive the grouping: integer-like object keys
  // are enumerated in ascending numeric order regardless of insertion order, so
  // relying on it silently produced an oldest-first list. Sort explicitly.
  const bySeason = state.items.reduce((acc, item) => {
    const key = item.season ?? 'Undated'
    ;(acc[key] ??= []).push(item)
    return acc
  }, {})
  const seasons = Object.entries(bySeason).sort(([a], [b]) => {
    if (a === 'Undated') return 1 // undated sinks to the bottom
    if (b === 'Undated') return -1
    return Number(b) - Number(a)
  })

  return (
    <div className={styles.stack}>
      {uploader}
      {seasons.map(([season, items]) => (
        <section key={season}>
          <h2 className={styles.sectionTitle}>{season}</h2>
          <ul className={styles.rows}>
            {items.map((item, i) => (
              <Row key={item.id} index={i}>
                <div className={styles.rowMain}>
                  <span className={styles.rowTitle}>{item.repo}</span>
                  {item.notes && <span className={styles.rowDesc}>{item.notes}</span>}
                  <span className={styles.rowMeta}>
                    {item.ref && <code className={styles.bucketTag}>{item.ref}</code>}
                    {item.commit_sha && (
                      <code className={styles.hash} title={item.commit_sha}>
                        {item.commit_sha.slice(0, 7)}
                      </code>
                    )}
                    {item.files?.byte_size != null && (
                      <span>{formatBytes(item.files.byte_size)}</span>
                    )}
                  </span>
                </div>
                <button
                  type="button"
                  className={styles.rowAction}
                  onClick={() => open(item)}
                  disabled={!item.files || opening === item.id}
                >
                  {opening === item.id ? (
                    <span className={styles.spinnerSm} aria-hidden="true" />
                  ) : (
                    <Icon name="download" size={16} />
                  )}
                  <span className="sr-only">Download {item.repo}</span>
                </button>
              </Row>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
