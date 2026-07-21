import { useEffect, useState } from 'react'
import Icon from '../../Icon'
import { extensionOf } from './fileTypes'
import Message from './Message'
import styles from './Viewers.module.css'

// -----------------------------------------------------------------------------
// Sandboxed renderer for HTML and SVG.
//
// THIS IS THE ONLY PLACE AN UPLOADED DOCUMENT IS EVER RENDERED AS MARKUP, and
// it happens inside an iframe carrying `sandbox="allow-scripts"` *without*
// `allow-same-origin`. That exact combination is the security boundary:
//
//   - Omitting allow-same-origin forces the framed document into an opaque
//     origin. It cannot read this page's DOM, its cookies, its localStorage, or
//     the Supabase session sitting in it. It cannot call our fetch wrappers or
//     reuse our access token.
//   - Adding allow-same-origin back — for any reason, including "the styles
//     looked wrong" — cancels that, because a same-origin sandboxed frame can
//     simply reach up and remove its own sandbox attribute.
//
// Nothing else is granted: no allow-forms, no allow-popups, no allow-modals, no
// allow-top-navigation. An uploaded page cannot navigate the portal away from
// itself or spawn anything.
//
// The document is loaded from a blob: URL built here rather than from the signed
// URL, so the Content-Type is ours and not whatever the storage layer guessed —
// an SVG served as text/plain renders as source, and an HTML file served as
// octet-stream tries to download. The opaque origin holds either way.
//
// A file's bytes are NEVER passed to dangerouslySetInnerHTML. Not here, not
// anywhere in this directory.
// -----------------------------------------------------------------------------

// Big enough for any diagram or exported report, small enough that a hostile
// upload cannot make the tab allocate its way into a crash.
const MAX_BYTES = 5 * 1024 * 1024

export default function HtmlViewer({ url, name, byteSize, onRetry }) {
  const [state, setState] = useState({ loading: true, blob: null, error: null })

  const ext = extensionOf(name)
  const type = ext === 'svg' ? 'image/svg+xml' : 'text/html'

  useEffect(() => {
    if (!url) return
    if (byteSize != null && byteSize > MAX_BYTES) {
      setState({ loading: false, blob: null, error: 'TOO_BIG' })
      return
    }

    let cancelled = false
    let objectUrl = null
    const ac = new AbortController()

    ;(async () => {
      setState({ loading: true, blob: null, error: null })
      try {
        const res = await fetch(url, { signal: ac.signal })
        if (!res.ok) throw new Error(`The storage server said ${res.status}.`)
        const raw = await res.blob()
        if (cancelled) return
        if (raw.size > MAX_BYTES) {
          setState({ loading: false, blob: null, error: 'TOO_BIG' })
          return
        }
        objectUrl = URL.createObjectURL(new Blob([raw], { type }))
        setState({ loading: false, blob: objectUrl, error: null })
      } catch (err) {
        if (cancelled || err?.name === 'AbortError') return
        setState({
          loading: false,
          blob: null,
          error: err?.message ?? 'Could not read that file.',
        })
      }
    })()

    return () => {
      cancelled = true
      ac.abort()
      // A blob URL pins its data in memory until it is revoked. Leaking one per
      // file opened turns a browsing session into a slow memory leak.
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [url, type, byteSize])

  if (state.loading) {
    return (
      <div className={styles.center} role="status" aria-live="polite">
        <span className={styles.spinner} aria-hidden="true" />
        <p className={styles.centerText}>Preparing a sandbox for {name}…</p>
      </div>
    )
  }

  if (state.error === 'TOO_BIG') {
    return (
      <Message
        icon="alert"
        title="Too big to render safely"
        text="The viewer stops at 5 MB for documents it has to render. Download it and open it locally."
      />
    )
  }

  if (state.error) {
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

  return (
    <>
      <p className={styles.notice}>
        <Icon name="alert" size={15} className={styles.noticeIcon} />
        <span>
          Rendered inside a sandbox with no access to your session. Scripts in this file run
          isolated and cannot read the portal, so anything it claims about your account is coming
          from the file, not from us. Switch to <strong>Source</strong> in the title bar to read it
          as text.
        </span>
      </p>

      <iframe
        className={`${styles.frame} ${styles.frameLight}`}
        src={state.blob}
        title={`${name} (sandboxed)`}
        /* allow-scripts WITHOUT allow-same-origin. Read the header of this file
           before touching this attribute. */
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
      />
    </>
  )
}
