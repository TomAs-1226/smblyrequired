import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../../Icon'
import { formatBytes } from '../../../lib/portalApi'
import { extensionOf, isTextLike } from './fileTypes'
import Message from './Message'
import styles from './Viewers.module.css'

// -----------------------------------------------------------------------------
// Archive browser.
//
// Lists what is inside a .zip / .tar.gz without making anyone download it, and
// lets a text entry be opened in the code viewer. fflate and the parsers in
// ./archive are import()-ed on mount, so neither reaches the portal bundle.
//
// The caps live in ./archive (LIMITS) and every one of them is surfaced in the
// UI when it fires. A viewer that silently shows you 1,500 of 40,000 files is
// worse than one that refuses, because you will believe the list.
// -----------------------------------------------------------------------------

const CodeViewer = lazy(() => import('./CodeViewer'))

// The list is a scan target, not a document — render a window of it and extend
// on demand rather than putting 1,500 rows in the DOM at once.
const PAGE = 300

export default function ArchiveViewer({ url, name, byteSize, onRetry }) {
  const [state, setState] = useState({ loading: true, error: null, data: null })
  const [filter, setFilter] = useState('')
  const [shown, setShown] = useState(PAGE)
  const [entry, setEntry] = useState(null)
  const libs = useRef(null)
  const abort = useRef(null)

  const ext = extensionOf(name)
  const isZip = ext === 'zip'
  const isGzip = ext === 'tar.gz' || ext === 'tgz'

  useEffect(() => {
    if (!url) return
    let cancelled = false
    const ac = new AbortController()
    abort.current = ac

    ;(async () => {
      setState({ loading: true, error: null, data: null })
      try {
        // Both land in their own chunks; nothing above this component pays for
        // them unless an archive is actually opened.
        const [fflate, archive] = await Promise.all([import('fflate'), import('./archive')])
        if (cancelled) return
        libs.current = { fflate, archive }

        const data = isZip
          ? await archive.listZip(url, ac.signal)
          : await archive.listTar(
              url,
              { gzip: isGzip, byteSize, isTextLike },
              fflate,
              ac.signal
            )
        if (cancelled) return
        setState({ loading: false, error: null, data })
      } catch (err) {
        if (cancelled || err?.name === 'AbortError') return
        setState({ loading: false, error: err?.code ?? err?.message ?? 'Could not read that archive.', data: null })
      }
    })()

    return () => {
      cancelled = true
      ac.abort()
    }
  }, [url, isZip, isGzip, byteSize])

  const entries = state.data?.entries ?? []

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return entries
    return entries.filter((e) => e.name.toLowerCase().includes(q))
  }, [entries, filter])

  useEffect(() => {
    setShown(PAGE)
  }, [filter])

  const openEntry = useCallback(
    async (e) => {
      const { fflate, archive } = libs.current ?? {}
      if (!fflate || !archive) return
      setEntry({ name: e.name, loading: true, text: null, error: null })
      try {
        let bytes
        if (isZip) {
          bytes = await archive.readZipEntry(url, e, fflate, abort.current?.signal)
        } else {
          const cached = state.data?.cache?.get(e.name)
          if (!cached) {
            setEntry({
              name: e.name,
              loading: false,
              text: null,
              error:
                'That entry was not kept in memory during the scan — it is either too large to preview or past the cache budget. Download the archive to read it.',
            })
            return
          }
          bytes = cached
        }
        const text = new TextDecoder().decode(bytes)
        if (text.slice(0, 4096).includes('\u0000')) {
          setEntry({
            name: e.name,
            loading: false,
            text: null,
            error: 'That entry is binary, so there is nothing readable to show.',
          })
          return
        }
        setEntry({ name: e.name, loading: false, text, error: null })
      } catch (err) {
        setEntry({
          name: e.name,
          loading: false,
          text: null,
          error:
            err?.code === 'TOO_BIG'
              ? 'That entry is larger than the 2 MB preview cap. Download the archive to read it.'
              : err?.message ?? 'Could not read that entry.',
        })
      }
    },
    [isZip, url, state.data]
  )

  // --- entry preview --------------------------------------------------------

  if (entry) {
    return (
      <>
        <div className={styles.toolRow}>
          <button type="button" className={styles.textBtn} onClick={() => setEntry(null)}>
            <Icon name="arrowLeft" size={14} />
            Back to archive
          </button>
          <span className={styles.toolSpacer} />
          <span className={styles.toolNote}>{entry.name}</span>
        </div>

        {entry.loading && (
          <div className={styles.center} role="status" aria-live="polite">
            <span className={styles.spinner} aria-hidden="true" />
            <p className={styles.centerText}>Extracting {entry.name}…</p>
          </div>
        )}

        {entry.error && <Message bad icon="alert" title="That entry didn't open" text={entry.error} />}

        {entry.text != null && (
          <Suspense
            fallback={
              <div className={styles.center} role="status">
                <span className={styles.spinner} aria-hidden="true" />
              </div>
            }
          >
            {/* `text` is passed directly, so CodeViewer neither fetches nor
                offers to save — an entry inside an archive has no path of its
                own to write a new version to. */}
            <CodeViewer text={entry.text} name={entry.name} path={entry.name} />
          </Suspense>
        )}
      </>
    )
  }

  // --- listing --------------------------------------------------------------

  if (state.loading) {
    return (
      <div className={styles.center} role="status" aria-live="polite">
        <span className={styles.spinner} aria-hidden="true" />
        <p className={styles.centerText}>
          {isZip
            ? 'Reading the archive index…'
            : 'Streaming the archive — gzip has no index, so this reads it through once.'}
        </p>
      </div>
    )
  }

  if (state.error) {
    const known = {
      RANGE_UNSUPPORTED:
        'The storage server will not serve partial downloads, so the index cannot be read without pulling the whole archive. Download it instead.',
      NOT_A_ZIP: 'This does not look like a ZIP file — its central directory is missing.',
      STREAM_TOO_BIG: `This archive is ${formatBytes(byteSize)}. A .tar.gz has no index, so listing it means decompressing all of it; past 60 MB that is the wrong thing to do in a browser. Download it instead.`,
    }
    return (
      <Message
        bad
        icon="alert"
        title="That archive didn't open"
        text={known[state.error] ?? state.error}
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

  const data = state.data
  const visible = filtered.slice(0, shown)

  return (
    <>
      <div className={styles.toolRow}>
        <input
          type="search"
          className={styles.filterInput}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter entries…"
          aria-label="Filter archive entries"
        />
        <span className={styles.toolSpacer} />
        <span className={styles.toolNote}>
          {filtered.length.toLocaleString()}
          {filter ? ` of ${entries.length.toLocaleString()}` : ''} entries
          {data.method === 'range' && ' · index read without downloading'}
        </span>
      </div>

      {data.truncated && (
        <p className={styles.notice}>
          <Icon name="alert" size={15} className={styles.noticeIcon} />
          <span>
            Stopped after the first {entries.length.toLocaleString()} entries
            {data.declared ? ` of ${data.declared.toLocaleString()}` : ''}. This is a listing cap,
            not the end of the archive — download it to see everything.
          </span>
        </p>
      )}

      {data.aborted && (
        <p className={`${styles.notice} ${styles.noticeBad}`}>
          <Icon name="alert" size={15} className={styles.noticeIcon} />
          <span>
            This archive expanded past 64 MB while being read, so the scan was stopped. That ratio
            is what a decompression bomb looks like — treat the file with suspicion, and check
            where it came from before downloading it.
          </span>
        </p>
      )}

      {entries.length === 0 ? (
        <Message icon="folder" title="Nothing inside" text="This archive has no readable entries." />
      ) : (
        <ul className={styles.entries} data-lenis-prevent>
          {visible.map((e) => {
            const readable = isTextLike(e.name) && !e.encrypted
            return (
              <li key={e.name} className={styles.entry}>
                <button
                  type="button"
                  className={styles.entryBtn}
                  onClick={() => readable && openEntry(e)}
                  disabled={!readable}
                  title={readable ? `Preview ${e.name}` : 'No preview for this kind of entry'}
                >
                  <Icon
                    name={readable ? 'code' : 'folder'}
                    size={15}
                    className={styles.entryIcon}
                  />
                  <span className={`${styles.entryName} ${readable ? '' : styles.entryDir}`}>
                    {e.name}
                  </span>
                  <span className={styles.entrySize}>{formatBytes(e.size)}</span>
                  {readable && (
                    <Icon name="arrowRight" size={14} className={styles.entryChevron} />
                  )}
                </button>
              </li>
            )
          })}

          {filtered.length > shown && (
            <li className={styles.entry}>
              <button
                type="button"
                className={styles.moreBtn}
                onClick={() => setShown((n) => n + PAGE)}
              >
                Show {Math.min(PAGE, filtered.length - shown).toLocaleString()} more
              </button>
            </li>
          )}
        </ul>
      )}
    </>
  )
}
