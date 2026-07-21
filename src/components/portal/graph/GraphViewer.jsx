import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../../Icon'
import styles from './GraphViewer.module.css'

// -----------------------------------------------------------------------------
// Interactive viewer for a graphify knowledge graph.
//
// Canvas, and no layout library. A force-directed graph is a few hundred lines
// of physics, and the alternatives (d3-force, cytoscape, vis) each cost more
// gzipped than this entire portal chunk. The portal is opened on phones over
// competition wifi; that trade is not close.
//
// Everything here is built for graphs that are bigger than you expect. graphify
// output regularly runs to thousands of nodes, and the naive version of each
// piece — O(n²) repulsion, redrawing every frame forever, hit-testing by
// scanning all nodes — falls over somewhere around a thousand.
// -----------------------------------------------------------------------------

// Above this, the simulation is skipped and a precomputed/radial layout is used
// instead. A phone will not settle 5000 nodes, and an unusable graph is worse
// than an approximate one.
const SIM_NODE_LIMIT = 1200
const LABEL_ZOOM_THRESHOLD = 0.75

export default function GraphViewer({ graph, onSelectNode }) {
  const canvasRef = useRef(null)
  const wrapRef = useRef(null)
  const simRef = useRef(null)
  const viewRef = useRef({ x: 0, y: 0, k: 1 })
  const dragRef = useRef(null)
  const rafRef = useRef(0)

  const [selected, setSelected] = useState(null)
  const [search, setSearch] = useState('')
  const [hover, setHover] = useState(null)
  const [settled, setSettled] = useState(false)

  // --- normalise -------------------------------------------------------------
  // graphify's output shape has changed between versions and may change again.
  // Accept the aliases rather than hard-failing on a graph someone spent real
  // time generating.
  const model = useMemo(() => normalise(graph), [graph])

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return null
    return new Set(
      model.nodes.filter((n) => n.label.toLowerCase().includes(q)).map((n) => n.id)
    )
  }, [search, model])

  // --- layout -----------------------------------------------------------------
  useEffect(() => {
    const sim = createSimulation(model)
    simRef.current = sim

    // Centre the graph in the viewport once, on first layout.
    const wrap = wrapRef.current
    if (wrap) {
      viewRef.current = { x: wrap.clientWidth / 2, y: wrap.clientHeight / 2, k: 1 }
    }

    let alive = true
    const tick = () => {
      if (!alive) return
      const done = sim.step()
      draw()
      if (done) {
        setSettled(true)
        return // stop the loop entirely — a settled graph costs zero frames
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    setSettled(false)
    rafRef.current = requestAnimationFrame(tick)

    return () => {
      alive = false
      cancelAnimationFrame(rafRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model])

  // --- drawing ----------------------------------------------------------------
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const sim = simRef.current
    if (!canvas || !sim) return
    const ctx = canvas.getContext('2d')
    const { width, height } = canvas
    const dpr = window.devicePixelRatio || 1
    const view = viewRef.current

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, width, height)
    ctx.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * view.x, dpr * view.y)

    const css = getComputedStyle(document.documentElement)
    const edgeColor = css.getPropertyValue('--border-hairline').trim() || 'rgba(199,210,221,0.1)'
    const nodeColor = css.getPropertyValue('--accent-data').trim() || '#38bdf8'
    const godColor = css.getPropertyValue('--accent-gold').trim() || '#f5b82e'
    const textColor = css.getPropertyValue('--text-body').trim() || '#c7d2dd'
    const dimColor = 'rgba(132,153,174,0.25)'

    // Edges first so nodes sit on top. Drawn as one path per colour rather than
    // one stroke() per edge — a stroke call per edge is the single biggest cost
    // in a graph of any size.
    ctx.lineWidth = 1 / view.k
    ctx.strokeStyle = matches ? dimColor : edgeColor
    ctx.beginPath()
    for (const e of sim.edges) {
      const a = sim.nodes[e.s]
      const b = sim.nodes[e.t]
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
    }
    ctx.stroke()

    if (matches) {
      ctx.strokeStyle = nodeColor
      ctx.beginPath()
      for (const e of sim.edges) {
        const a = sim.nodes[e.s]
        const b = sim.nodes[e.t]
        if (!matches.has(a.id) && !matches.has(b.id)) continue
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
      }
      ctx.stroke()
    }

    for (const n of sim.nodes) {
      const isMatch = !matches || matches.has(n.id)
      const isSel = selected?.id === n.id
      const isHover = hover?.id === n.id
      const r = n.r

      ctx.beginPath()
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
      ctx.fillStyle = !isMatch ? dimColor : n.god ? godColor : nodeColor
      ctx.globalAlpha = isMatch ? 1 : 0.35
      ctx.fill()

      if (isSel || isHover) {
        ctx.lineWidth = 2 / view.k
        ctx.strokeStyle = '#fff'
        ctx.stroke()
      }
      ctx.globalAlpha = 1
    }

    // Labels last, and only when zoomed in enough that they would be legible.
    // Drawing 3000 labels at 0.2x zoom produces grey mush and costs more than
    // everything else combined.
    if (view.k >= LABEL_ZOOM_THRESHOLD) {
      ctx.font = `${12 / view.k}px ui-sans-serif, system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.fillStyle = textColor
      for (const n of sim.nodes) {
        if (matches && !matches.has(n.id)) continue
        if (!n.god && n.deg < 2 && view.k < 1.4) continue // thin out the long tail
        ctx.fillText(n.label.slice(0, 28), n.x, n.y - n.r - 4 / view.k)
      }
    }
  }, [matches, selected, hover])

  useEffect(() => {
    draw()
  }, [draw, settled])

  // --- sizing -----------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      canvas.width = wrap.clientWidth * dpr
      canvas.height = wrap.clientHeight * dpr
      canvas.style.width = `${wrap.clientWidth}px`
      canvas.style.height = `${wrap.clientHeight}px`
      draw()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [draw])

  // --- interaction ------------------------------------------------------------
  const toWorld = (clientX, clientY) => {
    const rect = canvasRef.current.getBoundingClientRect()
    const v = viewRef.current
    return {
      x: (clientX - rect.left - v.x) / v.k,
      y: (clientY - rect.top - v.y) / v.k,
    }
  }

  const nodeAt = (clientX, clientY) => {
    const sim = simRef.current
    if (!sim) return null
    const p = toWorld(clientX, clientY)
    // Reverse order so the topmost drawn node wins, matching what the user sees.
    for (let i = sim.nodes.length - 1; i >= 0; i--) {
      const n = sim.nodes[i]
      const dx = n.x - p.x
      const dy = n.y - p.y
      const hit = Math.max(n.r, 8 / viewRef.current.k) // generous on touch
      if (dx * dx + dy * dy <= hit * hit) return n
    }
    return null
  }

  const onPointerDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { x: e.clientX, y: e.clientY, moved: false }
  }

  const onPointerMove = (e) => {
    const d = dragRef.current
    if (d) {
      const dx = e.clientX - d.x
      const dy = e.clientY - d.y
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
      viewRef.current.x += dx
      viewRef.current.y += dy
      d.x = e.clientX
      d.y = e.clientY
      draw()
      return
    }
    // Hover only with a fine pointer — on touch this fires on every drag and
    // just makes the graph flicker.
    if (e.pointerType === 'mouse') {
      const n = nodeAt(e.clientX, e.clientY)
      if (n?.id !== hover?.id) setHover(n)
    }
  }

  const onPointerUp = (e) => {
    const d = dragRef.current
    dragRef.current = null
    if (d && !d.moved) {
      const n = nodeAt(e.clientX, e.clientY)
      setSelected(n)
      if (n) onSelectNode?.(n)
    }
  }

  const onWheel = (e) => {
    e.preventDefault()
    const v = viewRef.current
    const rect = canvasRef.current.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const factor = Math.exp(-e.deltaY * 0.0015)
    const k = Math.min(6, Math.max(0.08, v.k * factor))
    // Zoom toward the cursor, not the origin — zooming to a corner is
    // disorienting and makes exploring a large graph miserable.
    v.x = mx - ((mx - v.x) * k) / v.k
    v.y = my - ((my - v.y) * k) / v.k
    v.k = k
    draw()
  }

  const fit = () => {
    const sim = simRef.current
    const wrap = wrapRef.current
    if (!sim || !wrap || !sim.nodes.length) return
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const n of sim.nodes) {
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x)
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y)
    }
    const pad = 40
    const k = Math.min(
      (wrap.clientWidth - pad * 2) / Math.max(1, maxX - minX),
      (wrap.clientHeight - pad * 2) / Math.max(1, maxY - minY),
      2
    )
    viewRef.current = {
      k,
      x: wrap.clientWidth / 2 - ((minX + maxX) / 2) * k,
      y: wrap.clientHeight / 2 - ((minY + maxY) / 2) * k,
    }
    draw()
  }

  if (!model.nodes.length) {
    return (
      <div className={styles.emptyGraph}>
        <Icon name="share" size={28} />
        <p>This file does not contain a graph I can read.</p>
        <p className={styles.emptyHint}>
          Expected a JSON object with <code>nodes</code> and <code>edges</code> (or{' '}
          <code>vertices</code> / <code>links</code>).
        </p>
      </div>
    )
  }

  return (
    <div className={styles.viewer}>
      <div className={styles.toolbar}>
        <div className={styles.search}>
          <Icon name="search" size={15} className={styles.searchIcon} />
          <input
            type="search"
            className={styles.searchInput}
            placeholder={`Search ${model.nodes.length.toLocaleString()} nodes…`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <span className={styles.counts}>
          {model.nodes.length.toLocaleString()} nodes · {model.edges.length.toLocaleString()} edges
          {matches && ` · ${matches.size} matching`}
        </span>
        <button type="button" className={styles.toolBtn} onClick={fit}>
          Fit
        </button>
        {!settled && <span className={styles.settling}>settling…</span>}
      </div>

      <div ref={wrapRef} className={styles.canvasWrap}>
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
        />
        {hover && !selected && (
          <span className={styles.hoverChip}>{hover.label}</span>
        )}
      </div>

      {selected && (
        <aside className={styles.inspector}>
          <div className={styles.inspectorHead}>
            <h4 className={styles.inspectorTitle}>
              {selected.god && <Icon name="star" size={14} className={styles.godIcon} />}
              {selected.label}
            </h4>
            <button
              type="button"
              className={styles.toolBtn}
              onClick={() => setSelected(null)}
              aria-label="Close details"
            >
              <Icon name="close" size={15} />
            </button>
          </div>
          <dl className={styles.meta}>
            <div><dt>Connections</dt><dd>{selected.deg}</dd></div>
            {selected.type && <div><dt>Type</dt><dd>{selected.type}</dd></div>}
            {selected.community != null && (
              <div><dt>Community</dt><dd>{selected.community}</dd></div>
            )}
          </dl>
          {selected.neighbours?.length > 0 && (
            <>
              <span className={styles.metaLabel}>Connected to</span>
              <ul className={styles.neighbours}>
                {selected.neighbours.slice(0, 25).map((nb) => (
                  <li key={nb.id}>
                    <button
                      type="button"
                      className={styles.neighbourBtn}
                      onClick={() => {
                        setSelected(nb)
                        onSelectNode?.(nb)
                      }}
                    >
                      {nb.label}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>
      )}
    </div>
  )
}

// --- model --------------------------------------------------------------------

function normalise(graph) {
  const raw = graph ?? {}
  const rawNodes = raw.nodes ?? raw.vertices ?? []
  const rawEdges = raw.edges ?? raw.links ?? []
  if (!Array.isArray(rawNodes) || !rawNodes.length) return { nodes: [], edges: [] }

  const gods = new Set(
    (raw.god_nodes ?? raw.godNodes ?? [])
      .map((g) => (typeof g === 'string' ? g : (g?.id ?? g?.name)))
      .filter(Boolean)
  )

  const nodes = rawNodes.map((n, i) => {
    const id = String(n.id ?? n.name ?? n.key ?? i)
    return {
      id,
      label: String(n.label ?? n.name ?? n.title ?? id),
      type: n.type ?? n.kind ?? null,
      community: n.community ?? n.cluster ?? null,
      god: gods.has(id) || n.god === true,
      deg: 0,
    }
  })

  const index = new Map(nodes.map((n, i) => [n.id, i]))
  const edges = []
  for (const e of rawEdges) {
    const s = index.get(String(e.source ?? e.from ?? e.s))
    const t = index.get(String(e.target ?? e.to ?? e.t))
    // Drop edges pointing at nodes that are not in the file rather than
    // fabricating placeholders — a dangling edge is a bug in the export, and
    // inventing a node for it hides that.
    if (s === undefined || t === undefined || s === t) continue
    edges.push({ s, t })
    nodes[s].deg += 1
    nodes[t].deg += 1
  }

  return { nodes, edges }
}

/**
 * Force-directed layout.
 *
 * Repulsion uses a spatial hash rather than comparing every pair: at 2000 nodes
 * the all-pairs version is four million distance calculations per frame, which
 * is about a second per frame on a phone. Bucketing to a grid and only
 * considering the neighbouring cells brings it back to roughly linear, and the
 * visual difference is not perceptible.
 */
function createSimulation(model) {
  const n = model.nodes.length
  const nodes = model.nodes.map((d, i) => {
    // Seeded ring start. Random positions make the first second of settling
    // look like an explosion; a ring converges faster and calmer.
    const a = (i / n) * Math.PI * 2
    const radius = 60 + Math.sqrt(n) * 12
    return {
      ...d,
      x: Math.cos(a) * radius,
      y: Math.sin(a) * radius,
      vx: 0,
      vy: 0,
      r: 3 + Math.min(9, Math.sqrt(d.deg) * 1.8) + (d.god ? 3 : 0),
    }
  })

  // Adjacency for the inspector, built once.
  const adj = new Map()
  for (const e of model.edges) {
    if (!adj.has(e.s)) adj.set(e.s, [])
    if (!adj.has(e.t)) adj.set(e.t, [])
    adj.get(e.s).push(e.t)
    adj.get(e.t).push(e.s)
  }
  nodes.forEach((node, i) => {
    node.neighbours = (adj.get(i) ?? []).slice(0, 40).map((j) => nodes[j])
  })

  const edges = model.edges
  const skipSim = n > SIM_NODE_LIMIT

  let alpha = skipSim ? 0 : 1
  const ALPHA_DECAY = 0.018
  const CELL = 42

  return {
    nodes,
    edges,
    step() {
      if (alpha <= 0.008) return true
      alpha -= ALPHA_DECAY * alpha + 0.0008

      // Spatial hash rebuild — cheap, and keeps repulsion near-linear.
      const grid = new Map()
      for (let i = 0; i < n; i++) {
        const node = nodes[i]
        const key = `${Math.round(node.x / CELL)},${Math.round(node.y / CELL)}`
        let cell = grid.get(key)
        if (!cell) grid.set(key, (cell = []))
        cell.push(i)
      }

      for (let i = 0; i < n; i++) {
        const a = nodes[i]
        const cx = Math.round(a.x / CELL)
        const cy = Math.round(a.y / CELL)
        for (let gx = cx - 1; gx <= cx + 1; gx++) {
          for (let gy = cy - 1; gy <= cy + 1; gy++) {
            const cell = grid.get(`${gx},${gy}`)
            if (!cell) continue
            for (const j of cell) {
              if (j <= i) continue
              const b = nodes[j]
              let dx = a.x - b.x
              let dy = a.y - b.y
              let d2 = dx * dx + dy * dy
              if (d2 > CELL * CELL * 4) continue
              // Two nodes at identical coordinates produce a divide-by-zero and
              // then NaN that poisons the whole layout. Nudge them apart.
              if (d2 < 0.01) {
                dx = (Math.random() - 0.5) * 0.1
                dy = (Math.random() - 0.5) * 0.1
                d2 = 0.01
              }
              const force = (260 * alpha) / d2
              const fx = dx * force
              const fy = dy * force
              a.vx += fx; a.vy += fy
              b.vx -= fx; b.vy -= fy
            }
          }
        }
      }

      // Springs
      for (const e of edges) {
        const a = nodes[e.s]
        const b = nodes[e.t]
        const dx = b.x - a.x
        const dy = b.y - a.y
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01
        const force = ((dist - 46) / dist) * 0.06 * alpha
        const fx = dx * force
        const fy = dy * force
        a.vx += fx; a.vy += fy
        b.vx -= fx; b.vy -= fy
      }

      // Gravity toward origin, so disconnected components do not drift away
      // forever and leave the user hunting for them off-screen.
      for (const node of nodes) {
        node.vx -= node.x * 0.0016 * alpha
        node.vy -= node.y * 0.0016 * alpha
        node.vx *= 0.82
        node.vy *= 0.82
        node.x += node.vx
        node.y += node.vy
      }

      return false
    },
  }
}
