import { lazy, Suspense, useEffect, useState } from 'react'
import Icon from '../../Icon'
import { useAuth } from '../../../lib/auth'
import { supabase } from '../../../lib/supabase'
import { listGraphs, signedUrl } from '../../../lib/portalApi'
import Uploader, { inspectGraphFile } from '../Uploader'
import { Loading, Empty, ErrorState, Row } from '../ui'
import styles from '../Portal.module.css'

// Lazy: the viewer carries its own canvas/force-layout code, and most visits to
// this tab are to upload or check a count rather than to open a 2000-node graph.
const GraphViewer = lazy(() => import('../graph/GraphViewer'))

export default function Graphs() {
  const { atLeast } = useAuth()
  const [state, setState] = useState({ loading: true, error: null, graphs: [] })
  const [opening, setOpening] = useState(null)
  const [viewing, setViewing] = useState(null)

  async function load() {
    setState((s) => ({ ...s, loading: true, error: null }))
    const { data, error } = await listGraphs()
    setState({ loading: false, error, graphs: data })
  }

  useEffect(() => {
    load()
  }, [])

  // Prefer graphify's OWN rendered graph.html when it exists — it is what the
  // tool's authors intended, it stays correct when graphify changes, and it is
  // already tuned for the graphs it produces. The canvas viewer is the fallback
  // for graphs uploaded as bare JSON.
  async function open(g) {
    setOpening(g.id)
    setState((s) => ({ ...s, error: null }))
    try {
      if (g.html_file?.path) {
        const { data: url, error } = await signedUrl(g.html_file.bucket, g.html_file.path, 900)
        if (error || !url) throw new Error(error ?? 'could not sign the URL')
        setViewing({ mode: 'html', url, meta: g })
        return
      }
      const f = g.files
      if (!f) throw new Error('no payload attached')
      const { data: url, error } = await signedUrl(f.bucket, f.path, 600)
      if (error || !url) throw new Error(error ?? 'could not sign the URL')
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setViewing({ mode: 'canvas', graph: await res.json(), meta: g })
    } catch (err) {
      setState((s) => ({ ...s, error: `Could not open that graph: ${err.message}` }))
    } finally {
      setOpening(null)
    }
  }

  // Slug must be unique and stable; derived from the title but editable, since
  // it is what any future cross-links point at.
  const commit = async ({ fileRow, meta, season }) => {
    const slug =
      (meta.slug || meta.title || fileRow.title || 'graph')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || `graph-${season}`

    const { data: userRes } = await supabase.auth.getUser()
    const { error } = await supabase.from('graphs').insert({
      slug,
      title: (meta.title || fileRow.title || 'Untitled graph').trim(),
      summary: meta.summary || null,
      source: meta.source || null,
      node_count: meta.node_count != null ? Number(meta.node_count) : null,
      edge_count: meta.edge_count != null ? Number(meta.edge_count) : null,
      community_count: meta.community_count != null ? Number(meta.community_count) : null,
      god_nodes: Array.isArray(meta.god_nodes) ? meta.god_nodes : [],
      generated_at: new Date().toISOString(),
      file_id: fileRow.id,
      created_by: userRes?.user?.id ?? null,
    })
    if (error?.code === '23505') return { error: `A graph with the slug "${slug}" already exists.` }
    return { error: error?.message ?? null }
  }

  const uploader = atLeast('member') ? (
    <Uploader
      bucket="graphs"
      pathPrefix="graphify"
      kind="graph"
      accept=".json,.html,.svg,.gz,.tar,.zip,application/json"
      title="Upload a graph"
      hint="Pick the graphify JSON and the counts fill themselves in. Anything it cannot read, you can type."
      inspect={inspectGraphFile}
      extraFields={[
        { key: 'source', label: 'Source', placeholder: 'repo or folder it was built from' },
        { key: 'node_count', label: 'Nodes', type: 'number' },
        { key: 'edge_count', label: 'Edges', type: 'number' },
        { key: 'community_count', label: 'Communities', type: 'number' },
      ]}
      onCommit={commit}
      onDone={load}
    />
  ) : null

  if (state.loading) return <Loading rows={4} label="Loading graphs" />
  if (state.error) return <ErrorState error={state.error} onRetry={load} />
  if (state.graphs.length === 0) {
    return (
      <div className={styles.stack}>
        {uploader}
        <Empty icon="share" title="No graphs yet">
          Run <code>/graphify</code> over a repo, then upload the contents of{' '}
          <code>graphify-out/</code> here. The graph stays queryable instead of living on one
          laptop.
        </Empty>
      </div>
    )
  }

  // A 2000-node graph wants the whole panel, so it replaces the list rather than
  // opening in a cramped overlay. Back returns to exactly where they were.
  if (viewing) {
    return (
      <div className={styles.stack}>
        <div className={styles.docHead}>
          <button type="button" className={styles.backBtn} onClick={() => setViewing(null)}>
            <Icon name="arrowLeft" size={15} />
            All graphs
          </button>
          <span className={styles.rowMeta}>
            <strong>{viewing.meta.title}</strong>
            {viewing.meta.source && <code className={styles.bucketTag}>{viewing.meta.source}</code>}
          </span>
        </div>
        {viewing.mode === 'html' ? (
          /* graphify's own render. `sandbox="allow-scripts"` WITHOUT
             `allow-same-origin` is the load-bearing part: the file is 2 MB of
             author-supplied markup with scripts in it, and that exact
             combination is what stops it reaching back into the signed-in
             session. Do not add allow-same-origin to "fix" anything. */
          <iframe
            src={viewing.url}
            title={`${viewing.meta.title} — interactive graph`}
            className={styles.graphFrame}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
          />
        ) : (
          <Suspense fallback={<Loading rows={3} label="Loading the graph viewer" />}>
            <GraphViewer graph={viewing.graph} />
          </Suspense>
        )}
      </div>
    )
  }

  return (
    <div className={styles.stack}>
      {uploader}
      <ul className={styles.rows}>
      {state.graphs.map((g, i) => (
        <Row key={g.id} index={i}>
          <div className={styles.rowMain}>
            <span className={styles.rowTitle}>{g.title}</span>
            {g.summary && <span className={styles.rowDesc}>{g.summary}</span>}

            <span className={styles.rowMeta}>
              {g.source && <code className={styles.bucketTag}>{g.source}</code>}
              {g.node_count != null && <span>{g.node_count.toLocaleString()} nodes</span>}
              {g.edge_count != null && <span>{g.edge_count.toLocaleString()} edges</span>}
              {g.community_count != null && <span>{g.community_count} communities</span>}
              {g.generated_at && <span>{new Date(g.generated_at).toLocaleDateString()}</span>}
            </span>

            {/* The god nodes are the highest-centrality entities graphify found —
                the fastest read on what a graph is actually about, so they are
                shown inline rather than hidden behind opening the payload. */}
            {g.god_nodes?.length > 0 && (
              <span className={styles.godNodes}>
                <span className={styles.godLabel}>Hubs</span>
                {g.god_nodes.slice(0, 6).map((n) => (
                  <code key={n} className={styles.godNode}>
                    {n}
                  </code>
                ))}
                {g.god_nodes.length > 6 && (
                  <span className={styles.godMore}>+{g.god_nodes.length - 6}</span>
                )}
              </span>
            )}
          </div>

          <button
            type="button"
            className={styles.rowAction}
            onClick={() => open(g)}
            disabled={!g.files || opening === g.id}
            title={g.files ? 'Open graph' : 'No payload attached'}
          >
            {opening === g.id ? (
              <span className={styles.spinnerSm} aria-hidden="true" />
            ) : (
              <Icon name="arrowRight" size={16} />
            )}
            <span className="sr-only">Open {g.title}</span>
          </button>
        </Row>
      ))}
      </ul>
    </div>
  )
}
