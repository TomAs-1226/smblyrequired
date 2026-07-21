import { useEffect, useRef, useState } from 'react'
import Icon from '../../Icon'
import styles from './Viewers.module.css'

// -----------------------------------------------------------------------------
// PDF viewer.
//
// An <iframe> and nothing else. Every browser the team uses ships a competent
// PDF reader already, and pdf.js would add more to the bundle than the entire
// rest of the portal — for a worse reader.
//
// The cost of that choice is that some browsers (and some extension/policy
// combinations) refuse to frame a PDF and render a blank rectangle instead.
// There is no reliable event for that, so the escape hatch is always visible
// rather than conditional on detecting a failure we cannot detect.
// -----------------------------------------------------------------------------

export default function PdfViewer({ url, name, download }) {
  const [slow, setSlow] = useState(false)
  const loaded = useRef(false)

  // If nothing has loaded after a couple of seconds, surface the fallback more
  // loudly. This is a hint, not a diagnosis — a large PDF on venue wifi trips it
  // too, and the wording says so.
  useEffect(() => {
    loaded.current = false
    setSlow(false)
    const id = setTimeout(() => {
      if (!loaded.current) setSlow(true)
    }, 2500)
    return () => clearTimeout(id)
  }, [url])

  return (
    <>
      <div className={styles.toolRow}>
        <a
          className={styles.textBtn}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Icon name="external" size={14} />
          Open in a new tab
        </a>
        {download && (
          <a className={styles.textBtn} href={download} download={name} target="_blank" rel="noopener noreferrer">
            <Icon name="download" size={14} />
            Download
          </a>
        )}
        <span className={styles.toolSpacer} />
        <span className={styles.toolNote}>rendered by your browser</span>
      </div>

      {slow && (
        <p className={styles.notice}>
          <Icon name="alert" size={15} className={styles.noticeIcon} />
          <span>
            Still blank? Some browsers refuse to display a PDF inside a frame. Open it in a new tab
            instead — the link above works either way.
          </span>
        </p>
      )}

      <iframe
        className={styles.frame}
        src={url}
        title={name}
        onLoad={() => {
          loaded.current = true
        }}
      />
    </>
  )
}
