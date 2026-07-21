import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'
import Icon from '../../Icon'
import { formatBytes } from '../../../lib/portalApi'
import Message from './Message'
import styles from './Viewers.module.css'

// -----------------------------------------------------------------------------
// JSON tree.
//
// The scaling property here is that a collapsed node renders *nothing* for its
// subtree — not a hidden node, not a display:none node. Expansion is the only
// thing that puts rows in the DOM, so a 50,000-node graph export opens as one
// row and stays responsive. Nodes with very wide child lists additionally page
// their children rather than dumping 8,000 array items at once.
//
// Everything rendered is a React text node. There is no innerHTML path in this
// file, so a JSON string containing markup shows up as that markup's characters.
// -----------------------------------------------------------------------------

const CodeViewer = lazy(() => import('./CodeViewer'))

// Parsing is synchronous and blocks the tab. 8 MB of JSON parses in well under a
// second; past that the honest answer is to download it.
const MAX_JSON = 8 * 1024 * 1024
// Children rendered per container before a "show more" appears.
const PAGE = 200
// Levels auto-expanded on open, so the file is not a single closed brace.
const AUTO_DEPTH = 2
// Ceiling on the search walk, so filtering a pathological document cannot hang.
const SEARCH_BUDGET = 200000

function kindOf(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

function isContainer(v) {
  const k = kindOf(v)
  return k === 'array' || k === 'object'
}

function childrenOf(v) {
  return Array.isArray(v) ? v.map((val, i) => [String(i), val]) : Object.entries(v)
}

export default function JsonViewer({ url, name, byteSize, onRetry }) {
  const [state, setState] = useState({ loading: true, text: null, data: null, error: null })
  const [open, setOpen] = useState(() => new Set())
  const [pages, setPages] = useState(() => new Map())
  const [query, setQuery] = useState('')
  const [raw, setRaw] = useState(false)

  useEffect(() => {
    if (!url) return
    if (byteSize != null && byteSize > MAX_JSON) {
      setState({ loading: false, text: null, data: null, error: 'TOO_BIG' })
      return
    }

    let cancelled = false
    const ac = new AbortController()
    ;(async () => {
      setState({ loading: true, text: null, data: null, error: null })
      try {
        const res = await fetch(url, { signal: ac.signal })
        if (!res.ok) throw new Error(`The storage server said ${res.status}.`)
        const blob = await res.blob()
        if (cancelled) return
        if (blob.size > MAX_JSON) {
          setState({ loading: false, text: null, data: null, error: 'TOO_BIG' })
          return
        }
        const text = await blob.text()
        if (cancelled) return
        try {
          const data = JSON.parse(text)
          // Seed the expansion set so the top of the document is already open.
          const seed = new Set()
          const walk = (value, path, depth) => {
            if (depth > AUTO_DEPTH || !isContainer(value)) return
            seed.add(path)
            for (const [k, v] of childrenOf(value).slice(0, PAGE)) {
              walk(v, `${path}/${k}`, depth + 1)
            }
          }
          walk(data, '', 0)
          setOpen(seed)
          setState({ loading: false, text, data, error: null })
        } catch (err) {
          // Keep the text: an invalid JSON file is exactly the case where you
          // want to look at the raw bytes, so the raw view still works.
          setState({
            loading: false,
            text,
            data: null,
            error: `PARSE:${err?.message ?? 'not valid JSON'}`,
          })
          setRaw(true)
        }
      } catch (err) {
        if (cancelled || err?.name === 'AbortError') return
        setState({
          loading: false,
          text: null,
          data: null,
          error: err?.message ?? 'Could not read that file.',
        })
      }
    })()

    return () => {
      cancelled = true
      ac.abort()
    }
  }, [url, byteSize])

  const toggle = useCallback((path) => {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const showMore = useCallback((path) => {
    setPages((prev) => {
      const next = new Map(prev)
      next.set(path, (next.get(path) ?? PAGE) + PAGE)
      return next
    })
  }, [])

  // --- search ---------------------------------------------------------------
  // Returns the set of paths that matched, plus every ancestor of a match so the
  // tree can open itself down to the hit.

  const search = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q || !state.data) return null

    const hits = new Set()
    const reveal = new Set()
    let budget = SEARCH_BUDGET
    let exhausted = false

    const walk = (value, path, key) => {
      if (budget-- <= 0) {
        exhausted = true
        return false
      }
      let matched = String(key ?? '').toLowerCase().includes(q)
      if (!isContainer(value)) {
        if (!matched && String(value).toLowerCase().includes(q)) matched = true
      } else {
        for (const [k, v] of childrenOf(value)) {
          if (walk(v, `${path}/${k}`, k)) matched = true
        }
      }
      if (matched) {
        hits.add(path)
        // Open every ancestor so the match is actually reachable on screen.
        let p = path
        while (p) {
          p = p.slice(0, p.lastIndexOf('/'))
          reveal.add(p)
        }
      }
      return matched
    }

    walk(state.data, '', null)
    return { hits, reveal, exhausted }
  }, [query, state.data])

  const effectiveOpen = useMemo(() => {
    if (!search) return open
    const merged = new Set(open)
    for (const p of search.reveal) merged.add(p)
    return merged
  }, [open, search])

  // --- render ---------------------------------------------------------------

  if (state.loading) {
    return (
      <div className={styles.center} role="status" aria-live="polite">
        <span className={styles.spinner} aria-hidden="true" />
        <p className={styles.centerText}>Reading {name}…</p>
      </div>
    )
  }

  if (state.error === 'TOO_BIG') {
    return (
      <Message
        icon="alert"
        title="Too big to parse in the browser"
        text={`This file is ${formatBytes(byteSize)}. The tree stops at ${formatBytes(MAX_JSON)} because parsing blocks the tab. Download it and open it locally.`}
      />
    )
  }

  if (state.error && !state.error.startsWith('PARSE:') ) {
    return (
      <Message
        bad
        icon="alert"
        title="That didn't load"
        text={state.error}
        action={
          onRetry && (
            <button type="button" className={styles.textBtn} onClick={onRetry}>
              Try again
            </button>
          )
        }
      />
    )
  }

  const parseError = state.error?.startsWith('PARSE:') ? state.error.slice(6) : null

  return (
    <>
      <div className={styles.toolRow}>
        <button
          type="button"
          className={`${styles.textBtn} ${raw ? styles.textBtnOn : ''}`}
          aria-pressed={raw}
          onClick={() => setRaw((v) => !v)}
          disabled={!!parseError}
        >
          <Icon name="code" size={14} />
          {raw ? 'Tree' : 'Raw'}
        </button>

        {!raw && (
          <input
            type="search"
            className={styles.filterInput}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a key or value…"
            aria-label="Filter JSON by key or value"
          />
        )}

        <span className={styles.toolSpacer} />
        <span className={styles.toolNote}>
          {search ? `${search.hits.size.toLocaleString()} matches` : formatBytes(byteSize)}
        </span>
      </div>

      {parseError && (
        <p className={`${styles.notice} ${styles.noticeBad}`} role="alert">
          <Icon name="alert" size={15} className={styles.noticeIcon} />
          <span>This file is not valid JSON — {parseError}. Showing the raw text instead.</span>
        </p>
      )}

      {search?.exhausted && (
        <p className={styles.notice}>
          <Icon name="alert" size={15} className={styles.noticeIcon} />
          <span>
            This document is large enough that the search stopped early. Results above are real,
            but there may be more further down.
          </span>
        </p>
      )}

      {raw || parseError ? (
        <Suspense
          fallback={
            <div className={styles.center} role="status">
              <span className={styles.spinner} aria-hidden="true" />
            </div>
          }
        >
          <CodeViewer text={state.text ?? ''} name={name} path={name} />
        </Suspense>
      ) : (
        <div className={styles.tree} data-lenis-prevent>
          <Node
            label={null}
            value={state.data}
            path=""
            depth={0}
            open={effectiveOpen}
            pages={pages}
            toggle={toggle}
            showMore={showMore}
            hits={search?.hits}
          />
        </div>
      )}
    </>
  )
}

function Node({ label, value, path, depth, open, pages, toggle, showMore, hits }) {
  const container = isContainer(value)
  const isOpen = container && open.has(path)
  const hit = hits?.has(path)

  const rows = []
  if (container && isOpen) {
    const all = childrenOf(value)
    const limit = pages.get(path) ?? PAGE
    for (const [k, v] of all.slice(0, limit)) {
      rows.push(
        <Node
          key={k}
          label={k}
          value={v}
          path={`${path}/${k}`}
          depth={depth + 1}
          open={open}
          pages={pages}
          toggle={toggle}
          showMore={showMore}
          hits={hits}
        />
      )
    }
    if (all.length > limit) {
      rows.push(
        <div
          key="__more"
          className={styles.jsonRow}
          style={{ paddingLeft: `calc(var(--sp-3) * ${depth + 1})` }}
        >
          <span className={styles.twistySpacer} />
          <button type="button" className={styles.moreBtn} onClick={() => showMore(path)}>
            {(all.length - limit).toLocaleString()} more…
          </button>
        </div>
      )
    }
  }

  return (
    <>
      <div
        className={`${styles.jsonRow} ${hit ? styles.jsonHit : ''}`}
        style={{ paddingLeft: `calc(var(--sp-3) * ${depth})` }}
      >
        {container ? (
          <button
            type="button"
            className={`${styles.twisty} ${isOpen ? styles.twistyOpen : ''}`}
            onClick={() => toggle(path)}
            aria-expanded={isOpen}
            aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${label ?? 'root'}`}
          >
            <Icon name="arrowRight" size={12} className={styles.twistyGlyph} />
          </button>
        ) : (
          <span className={styles.twistySpacer} />
        )}

        {label !== null && (
          <>
            <span className={styles.jsonKey}>{label}</span>
            <span className={styles.jsonPunct}>:</span>
          </>
        )}

        <Value value={value} open={isOpen} />
      </div>
      {rows}
    </>
  )
}

function Value({ value, open }) {
  const kind = kindOf(value)

  if (kind === 'array' || kind === 'object') {
    const n = kind === 'array' ? value.length : Object.keys(value).length
    const braces = kind === 'array' ? ['[', ']'] : ['{', '}']
    if (open) return <span className={styles.jsonPunct}>{braces[0]}</span>
    return (
      <span className={styles.jsonSummary}>
        {braces[0]}
        {n.toLocaleString()} {kind === 'array' ? (n === 1 ? 'item' : 'items') : n === 1 ? 'key' : 'keys'}
        {braces[1]}
      </span>
    )
  }

  if (kind === 'string') return <span className={styles.jsonStr}>&quot;{value}&quot;</span>
  if (kind === 'number') return <span className={styles.jsonNum}>{String(value)}</span>
  if (kind === 'boolean') return <span className={styles.jsonBool}>{String(value)}</span>
  return <span className={styles.jsonNull}>null</span>
}
