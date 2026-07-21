import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../../Icon'
import { useAuth } from '../../../lib/auth'
import { uploadFile, sha256Hex, formatBytes } from '../../../lib/portalApi'
import { renderMarkdown } from '../../../lib/markdown'
import { languageFor, baseName, extensionOf, bumpVersion } from './fileTypes'
import Message from './Message'
import styles from './Viewers.module.css'

// -----------------------------------------------------------------------------
// Source viewer, with an opt-in editor.
//
// Highlighting comes from ./syntax, which is dynamically import()-ed so it lands
// in its own chunk, and which returns a *token stream* rather than HTML. Each
// token's text is rendered as a React text node, so file content is never
// interpreted as markup — a .js file containing `</script><img onerror=…>`
// renders as those literal characters. See the header of syntax.js.
//
// The one place markup is produced is the Markdown preview, and that goes
// through lib/markdown.js, which escapes before it formats.
// -----------------------------------------------------------------------------

// Above this, the file is not pulled into memory at all — it is a viewer, not a
// download manager, and a 40 MB log will hang the tab long before it renders.
const MAX_TEXT = 2 * 1024 * 1024
// Tokenizing is a single pass, but it is still work; past this the file renders
// unhighlighted rather than making the user wait to read it.
const MAX_HIGHLIGHT = 400 * 1024
// One <span> per line is cheap but not free. 20k lines is far past what anyone
// reads in a modal, and it keeps the DOM from becoming the bottleneck.
const MAX_LINES = 20000
// Editing ceiling. A textarea holding more than this stops being responsive on
// a school Chromebook, which is the machine that matters here.
const MAX_EDIT = 512 * 1024

const TOKEN_CLASS = {
  k: styles.tk,
  s: styles.ts,
  c: styles.tc,
  n: styles.tn,
  a: styles.ta,
}

function seasonFromPath(path) {
  const m = String(path ?? '').match(/(?:^|\/)(20\d{2})(?:\/|$)/)
  const year = m ? Number(m[1]) : new Date().getFullYear()
  return year >= 2000 && year <= 2100 ? year : null
}

function kindFor(name) {
  const ext = extensionOf(name)
  if (ext === 'md' || ext === 'markdown' || ext === 'txt') return 'doc'
  return 'code'
}

export default function CodeViewer({
  url,
  text: providedText,
  name,
  path,
  bucket,
  title,
  byteSize,
  onRetry,
  onSaved,
}) {
  const { atLeast } = useAuth()
  const [state, setState] = useState(() =>
    providedText != null
      ? { loading: false, text: providedText, error: null }
      : { loading: true, text: null, error: null }
  )
  const [lines, setLines] = useState(null)
  const [copied, setCopied] = useState(false)
  const [preview, setPreview] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [save, setSave] = useState({ busy: false, error: null, done: null })
  const copyTimer = useRef(null)

  const lang = useMemo(() => languageFor(name || path), [name, path])
  const isMarkdown = lang === 'markdown'

  // --- load ----------------------------------------------------------------

  useEffect(() => {
    if (providedText != null) {
      setState({ loading: false, text: providedText, error: null })
      return
    }
    if (!url) return
    if (byteSize != null && byteSize > MAX_TEXT) {
      setState({ loading: false, text: null, error: 'TOO_BIG' })
      return
    }

    let cancelled = false
    const ac = new AbortController()
    ;(async () => {
      setState({ loading: true, text: null, error: null })
      try {
        const res = await fetch(url, { signal: ac.signal })
        if (!res.ok) throw new Error(`The storage server said ${res.status}.`)
        const blob = await res.blob()
        if (cancelled) return
        if (blob.size > MAX_TEXT) {
          setState({ loading: false, text: null, error: 'TOO_BIG' })
          return
        }
        const body = await blob.text()
        if (cancelled) return
        // A NUL in the first few KB means this is not text, whatever the
        // extension claimed. Rendering it would paint a screen of replacement
        // characters and look like corruption rather than a routing mistake.
        if (body.slice(0, 4096).includes('\u0000')) {
          setState({ loading: false, text: null, error: 'BINARY' })
          return
        }
        setState({ loading: false, text: body, error: null })
      } catch (err) {
        if (cancelled || err?.name === 'AbortError') return
        setState({
          loading: false,
          text: null,
          error: err?.message ?? 'Could not read that file.',
        })
      }
    })()

    return () => {
      cancelled = true
      ac.abort()
    }
  }, [url, providedText, byteSize])

  // --- highlight (lazy chunk) ----------------------------------------------

  const text = state.text
  const truncated = useMemo(() => {
    if (text == null) return false
    return text.split('\n').length > MAX_LINES
  }, [text])

  // Rendered immediately so the file is readable before the highlighter chunk
  // lands; the tokenized version replaces it in place when it arrives.
  const plain = useMemo(() => {
    if (text == null) return []
    const all = text.split('\n')
    const kept = all.length > MAX_LINES ? all.slice(0, MAX_LINES) : all
    return kept.map((l) => (l ? [{ t: 'x', v: l }] : []))
  }, [text])

  useEffect(() => {
    if (text == null || editing) return
    let cancelled = false
    ;(async () => {
      try {
        const mod = await import('./syntax')
        if (cancelled) return
        const body =
          text.split('\n').length > MAX_LINES
            ? text.split('\n').slice(0, MAX_LINES).join('\n')
            : text
        setLines(
          body.length > MAX_HIGHLIGHT ? mod.plainLines(body) : mod.highlightLines(body, lang)
        )
      } catch {
        // Highlighting is decoration. If its chunk fails to load, the plain
        // render is already on screen and the user loses nothing that matters.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [text, lang, editing])

  const shown = lines ?? plain

  useEffect(() => () => clearTimeout(copyTimer.current), [])

  // --- copy ----------------------------------------------------------------

  const copy = useCallback(async () => {
    if (text == null) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard access needs a secure context and a user gesture. Both hold
      // here, but a policy can still refuse — say so rather than silently
      // appearing to have worked.
      setSave((s) => ({ ...s, error: 'The browser blocked clipboard access.' }))
    }
  }, [text])

  // --- save as a new version ------------------------------------------------

  const canEdit =
    atLeast('member') &&
    text != null &&
    !providedText && // an entry read out of an archive has nowhere to be saved back to
    text.length <= MAX_EDIT

  const startEdit = useCallback(() => {
    setDraft(text ?? '')
    setEditing(true)
    setPreview(false)
    setSave({ busy: false, error: null, done: null })
  }, [text])

  const commit = useCallback(async () => {
    if (save.busy) return
    setSave({ busy: true, error: null, done: null })

    const file0 = baseName(path)
    const kind = kindFor(file0)
    const season = seasonFromPath(path)

    // The unique(bucket, path) constraint is the real arbiter of which version
    // number is free. Rather than querying for siblings — and racing anyone who
    // is saving at the same moment — walk forward until one lands.
    let attemptN
    let lastError = null
    for (let i = 0; i < 25; i += 1) {
      const next = bumpVersion(path, attemptN)
      attemptN = next.n
      const nextName = baseName(next.path)
      const blob = new File([draft], nextName, { type: 'text/plain;charset=utf-8' })
      // Checksummed in the browser, like every other upload, so the nightly
      // mirror can prove the copy it pulled is byte-identical.
      const sha256 = await sha256Hex(blob)

      const { error } = await uploadFile({
        bucket,
        path: next.path,
        file: blob,
        metadata: {
          title: `${title || file0} (v${next.n})`,
          kind,
          season,
          sha256,
          description: `Edited in the portal from ${file0}.`,
        },
      })

      if (!error) {
        setSave({ busy: false, error: null, done: next.path })
        setState((s) => ({ ...s, text: draft }))
        setEditing(false)
        setLines(null)
        onSaved?.({ bucket, path: next.path })
        return
      }

      lastError = error
      // Someone else took this version number between our check and our write.
      // Step past them and try again; anything else is a real failure.
      if (/exists|duplicate|conflict|unique/i.test(error)) {
        attemptN += 1
        continue
      }
      break
    }

    setSave({ busy: false, error: lastError ?? 'Could not save that.', done: null })
  }, [save.busy, draft, path, bucket, title, onSaved])

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
        title="Too big to open in the browser"
        text={`This file is ${formatBytes(byteSize)}. The viewer stops at ${formatBytes(MAX_TEXT)} so a large log cannot lock up the tab. Download it and open it locally.`}
      />
    )
  }

  if (state.error === 'BINARY') {
    return (
      <Message
        icon="alert"
        title="That isn't a text file"
        text="It has a text extension but binary content, so there is nothing readable to show. Download it and check what it actually is."
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
      <div className={styles.toolRow}>
        <button
          type="button"
          className={`${styles.textBtn} ${copied ? styles.textBtnOn : ''}`}
          onClick={copy}
          disabled={editing}
        >
          <Icon name={copied ? 'check' : 'code'} size={14} />
          {copied ? 'Copied' : 'Copy'}
        </button>

        {isMarkdown && !editing && (
          <button
            type="button"
            className={`${styles.textBtn} ${preview ? styles.textBtnOn : ''}`}
            aria-pressed={preview}
            onClick={() => setPreview((v) => !v)}
          >
            <Icon name="book" size={14} />
            {preview ? 'Source' : 'Preview'}
          </button>
        )}

        {canEdit && !editing && (
          <button type="button" className={styles.textBtn} onClick={startEdit}>
            <Icon name="wrench" size={14} />
            Edit
          </button>
        )}

        {editing && (
          <>
            <button
              type="button"
              className={`${styles.textBtn} ${styles.textBtnPrimary}`}
              onClick={commit}
              disabled={save.busy || draft === text}
            >
              {save.busy ? (
                <>
                  <span className={styles.spinnerSm} aria-hidden="true" />
                  Saving…
                </>
              ) : (
                <>
                  <Icon name="check" size={14} />
                  Save as new version
                </>
              )}
            </button>
            <button
              type="button"
              className={styles.textBtn}
              onClick={() => {
                setEditing(false)
                setSave({ busy: false, error: null, done: null })
              }}
              disabled={save.busy}
            >
              Cancel
            </button>
          </>
        )}

        <span className={styles.toolSpacer} />
        <span className={styles.toolNote}>
          {lang !== 'text' && `${lang} · `}
          {shown.length.toLocaleString()} lines
        </span>
      </div>

      {editing && (
        <p className={styles.notice}>
          <Icon name="alert" size={15} className={styles.noticeIcon} />
          <span>
            Saving writes a <strong>new file</strong> alongside this one — the original is never
            modified. The nightly backup records a checksum per stored object, so changing one in
            place would break the ability to verify a restore.
          </span>
        </p>
      )}

      {save.done && (
        <p className={styles.notice}>
          <Icon name="check" size={15} className={styles.noticeIcon} />
          <span>
            Saved as <code>{save.done}</code>. The original is untouched.
          </span>
        </p>
      )}

      {save.error && (
        <p className={`${styles.notice} ${styles.noticeBad}`} role="alert">
          <Icon name="alert" size={15} className={styles.noticeIcon} />
          <span>{save.error}</span>
        </p>
      )}

      {truncated && !editing && (
        <p className={styles.notice}>
          <Icon name="alert" size={15} className={styles.noticeIcon} />
          <span>
            Showing the first {MAX_LINES.toLocaleString()} lines. Download the file to read the
            rest.
          </span>
        </p>
      )}

      {editing ? (
        <textarea
          className={styles.editArea}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck="false"
          autoComplete="off"
          aria-label={`Edit ${name}`}
        />
      ) : preview && isMarkdown ? (
        <div className={styles.proseScroll}>
          {/* Safe: renderMarkdown escapes all input before applying any
              formatting, so nothing in an uploaded file can reach the DOM as
              markup. See lib/markdown.js. */}
          <div
            className={styles.prose}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
          />
        </div>
      ) : (
        <div className={styles.codeScroll} data-lenis-prevent>
          <div className={styles.codeInner}>
            <div className={styles.gutter} aria-hidden="true">
              {shown.map((_, i) => (
                <span key={i} className={styles.lineNo}>
                  {i + 1}
                </span>
              ))}
            </div>
            <pre className={styles.code}>
              <code>
                {shown.map((tokens, i) => (
                  <span key={i} className={styles.line}>
                    {tokens.map((tok, j) =>
                      tok.t === 'x' ? (
                        tok.v
                      ) : (
                        <span key={j} className={TOKEN_CLASS[tok.t]}>
                          {tok.v}
                        </span>
                      )
                    )}
                  </span>
                ))}
              </code>
            </pre>
          </div>
        </div>
      )}
    </>
  )
}
