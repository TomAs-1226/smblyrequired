import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import Icon from '../../Icon'
import { signedUrl, formatBytes } from '../../../lib/portalApi'
import { pickViewer, baseName, extensionOf } from './fileTypes'
import Message from './Message'
import styles from './Viewers.module.css'

// -----------------------------------------------------------------------------
// The viewer shell.
//
// Mints a short-lived signed URL for a private object, picks a viewer by
// extension/MIME, and hosts it in a full-screen overlay with the modal
// obligations handled once here rather than six times in the viewers: Escape to
// close, a focus trap, a locked body scroll, and focus returned to whatever
// opened it.
//
// Every concrete viewer is lazy()-loaded. Opening a PNG must not download the
// zip reader, and neither must ever reach the entry bundle — see openFile.jsx
// for how this component itself stays out of the Portal chunk.
// -----------------------------------------------------------------------------

const CodeViewer = lazy(() => import('./CodeViewer'))
const JsonViewer = lazy(() => import('./JsonViewer'))
const ImageViewer = lazy(() => import('./ImageViewer'))
const PdfViewer = lazy(() => import('./PdfViewer'))
const ArchiveViewer = lazy(() => import('./ArchiveViewer'))
const HtmlViewer = lazy(() => import('./HtmlViewer'))

// Long enough to read a file, short enough that a URL pasted into a group chat
// is dead by the time anyone clicks it. Archives get longer because the entry
// lister issues range requests against the same URL over the session.
const TTL_DEFAULT = 600
const TTL_ARCHIVE = 900

// Supabase honours `?download=` on a signed URL by setting Content-Disposition;
// it is what the SDK's own `download` option appends, and it is not covered by
// the signature (which signs the object path, not the query string). Appending
// it here avoids having to change lib/portalApi's signature.
function withDownload(url, filename) {
  if (!url) return url
  try {
    const u = new URL(url)
    u.searchParams.set('download', filename)
    return u.toString()
  } catch {
    // A URL that does not parse is not one worth decorating — hand back the
    // original so the button still does something useful.
    return url
  }
}

export default function FileViewer({
  bucket,
  path,
  title,
  mime,
  byteSize,
  onClose,
  onSaved,
}) {
  const [state, setState] = useState({ loading: true, url: null, error: null })
  // Bumped to force a re-mint after an expiry or a transient failure.
  const [attempt, setAttempt] = useState(0)
  // html/svg open in one mode and can be flipped to the other. Rendering only
  // ever happens inside HtmlViewer's sandboxed iframe.
  const [rendered, setRendered] = useState(false)

  const overlayRef = useRef(null)
  const closeBtnRef = useRef(null)
  const lastFocused = useRef(null)

  const name = baseName(path) || title || 'file'
  const kind = pickViewer({ path, mime })
  const ext = extensionOf(path)

  // SVG is a picture to most people, so it opens rendered; HTML is usually
  // being read as source in a portal full of code, so it opens as source.
  useEffect(() => {
    setRendered(ext === 'svg')
  }, [ext])

  const reload = useCallback(() => setAttempt((a) => a + 1), [])

  useEffect(() => {
    let cancelled = false
    setState({ loading: true, url: null, error: null })
    ;(async () => {
      const ttl = kind === 'archive' ? TTL_ARCHIVE : TTL_DEFAULT
      const { data, error } = await signedUrl(bucket, path, ttl)
      if (cancelled) return
      if (error || !data) {
        setState({ loading: false, url: null, error: error ?? 'Could not open that file.' })
        return
      }
      setState({ loading: false, url: data, error: null })
    })()
    return () => {
      cancelled = true
    }
  }, [bucket, path, kind, attempt])

  // Modal obligations: remember what opened this, lock the page behind it, trap
  // Tab inside it, and hand focus back on the way out.
  useEffect(() => {
    lastFocused.current = document.activeElement

    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'Tab') return

      const node = overlayRef.current
      if (!node) return
      const focusables = Array.from(
        node.querySelectorAll(
          'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])'
        )
        // getClientRects() rather than offsetParent: it also catches
        // visibility:hidden and collapsed elements, and it does not go null just
        // because an ancestor is position:fixed.
      ).filter((el) => !el.disabled && el.getClientRects().length > 0)
      if (!focusables.length) return

      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKey)
    const raf = requestAnimationFrame(() => closeBtnRef.current?.focus())

    return () => {
      document.removeEventListener('keydown', onKey)
      cancelAnimationFrame(raf)
      document.body.style.overflow = prevOverflow
      const prev = lastFocused.current
      if (prev && typeof prev.focus === 'function' && document.contains(prev)) prev.focus()
    }
  }, [onClose])

  const download = withDownload(state.url, name)

  return (
    <div
      className={styles.overlay}
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={`${name} — file viewer`}
    >
      <div
        className={styles.backdrop}
        onClick={onClose}
        aria-hidden="true"
        data-lenis-prevent
      />

      <div className={styles.dialog}>
        <header className={styles.bar}>
          <div className={styles.barMain}>
            <span className={styles.barTitle} title={path}>
              {title || name}
            </span>
            <span className={styles.barMeta}>
              <span>{name}</span>
              {byteSize != null && <span>· {formatBytes(byteSize)}</span>}
              <span>· {bucket}</span>
            </span>
          </div>

          <div className={styles.barActions}>
            {(ext === 'html' || ext === 'htm' || ext === 'svg') && (
              <button
                type="button"
                className={`${styles.textBtn} ${rendered ? styles.textBtnOn : ''}`}
                aria-pressed={rendered}
                onClick={() => setRendered((v) => !v)}
              >
                {rendered ? 'Source' : 'Render'}
              </button>
            )}

            {download && (
              <a
                className={styles.iconBtn}
                href={download}
                download={name}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Icon name="download" size={16} />
                <span className="sr-only">Download {name}</span>
              </a>
            )}

            <button
              type="button"
              className={`${styles.iconBtn} ${styles.closeBtn}`}
              onClick={onClose}
              ref={closeBtnRef}
            >
              <Icon name="close" size={16} />
              <span className="sr-only">Close viewer</span>
            </button>
          </div>
        </header>

        <div className={styles.stage}>
          <Body
            state={state}
            kind={kind}
            rendered={rendered}
            name={name}
            path={path}
            bucket={bucket}
            title={title}
            mime={mime}
            byteSize={byteSize}
            download={download}
            onRetry={reload}
            onSaved={onSaved}
          />
        </div>
      </div>
    </div>
  )
}

function Body({
  state,
  kind,
  rendered,
  name,
  path,
  bucket,
  title,
  mime,
  byteSize,
  download,
  onRetry,
  onSaved,
}) {
  if (state.loading) {
    return (
      <div className={styles.center} role="status" aria-live="polite">
        <span className={styles.spinner} aria-hidden="true" />
        <p className={styles.centerText}>Opening {name}…</p>
      </div>
    )
  }

  if (state.error) {
    return (
      <Message
        bad
        icon="alert"
        title="That didn't open"
        text={state.error}
        action={
          <button type="button" className={styles.textBtn} onClick={onRetry}>
            Try again
          </button>
        }
      />
    )
  }

  // Unknown type. Never a blank screen — say so and give them the file.
  if (!kind) {
    return (
      <Message
        icon="folder"
        title="No preview for this kind of file"
        text={`The portal can't render ${extensionOf(path) ? `.${extensionOf(path)}` : 'this'} files in the browser yet. Download it and open it locally.`}
        action={
          download && (
            <a className={styles.textBtn} href={download} download={name} target="_blank" rel="noopener noreferrer">
              <Icon name="download" size={14} />
              Download
            </a>
          )
        }
      />
    )
  }

  const common = { url: state.url, name, path, bucket, title, mime, byteSize, onRetry, onSaved }

  return (
    <Suspense
      fallback={
        <div className={styles.center} role="status" aria-live="polite">
          <p className={styles.centerText}>Loading viewer…</p>
        </div>
      }
    >
      {kind === 'code' && <CodeViewer {...common} />}
      {kind === 'json' && <JsonViewer {...common} />}
      {kind === 'image' && <ImageViewer {...common} />}
      {kind === 'pdf' && <PdfViewer {...common} download={download} />}
      {kind === 'archive' && <ArchiveViewer {...common} />}
      {kind === 'markup' &&
        (rendered ? <HtmlViewer {...common} /> : <CodeViewer {...common} />)}
    </Suspense>
  )
}

