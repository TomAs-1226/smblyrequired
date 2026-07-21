import { Component, Suspense, lazy, useCallback, useState } from 'react'
import { createPortal } from 'react-dom'

// -----------------------------------------------------------------------------
// The wiring surface for the file viewers.
//
// This is the ONLY module a panel should import. It is deliberately tiny and
// carries no CSS, because it is the one piece that rides along in the Portal
// chunk — everything it reaches is behind the lazy() below, so the viewers, the
// highlighter, and fflate are all separate chunks that a member downloads the
// first time they actually open a file.
//
// Importing ./Viewers.module.css here would drag the whole viewer stylesheet
// into the Portal chunk's CSS and defeat that. The scrim below is therefore
// styled inline — still with tokens, never with raw values.
//
// Usage:
//
//   const { open, element } = useFileViewer({ onSaved: reload })
//   …
//   <button onClick={() => open({ bucket, path, title, mime, byteSize })}>Preview</button>
//   {element}
// -----------------------------------------------------------------------------

const FileViewer = lazy(() => import('./FileViewer'))

export { canPreview, pickViewer, extensionOf, baseName } from './fileTypes'

function Scrim({ children, onClose }) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--sp-3)',
        flexDirection: 'column',
        background: 'rgba(4, 11, 22, 0.9)',
        color: 'var(--text-muted)',
        fontSize: 'var(--fs-small)',
      }}
      role="status"
      aria-live="polite"
      onClick={onClose}
    >
      {children}
    </div>
  )
}

// A lazy chunk that fails to load throws during render. Without a boundary that
// takes the whole portal down, which — on the venue wifi this is most often used
// on — is a realistic way to lose someone's session over a dropped request.
class ViewerBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error) {
    console.warn('[portal] file viewer failed to load:', error?.message ?? error)
  }

  render() {
    if (this.state.failed) {
      return (
        <Scrim onClose={this.props.onClose}>
          <p>The viewer could not load. Check your connection and try again.</p>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={this.props.onClose}
          >
            Close
          </button>
        </Scrim>
      )
    }
    return this.props.children
  }
}

/**
 * Host a file viewer from a panel.
 *
 * @param {{onSaved?: (info: {bucket: string, path: string}) => void}} options
 *   onSaved fires after the code editor writes a new version, so the calling
 *   panel can refresh its list — the new file will not be in it otherwise.
 * @returns {{open: Function, close: Function, element: React.ReactNode, current: object|null}}
 */
export function useFileViewer({ onSaved } = {}) {
  const [file, setFile] = useState(null)

  const open = useCallback((next) => {
    if (!next?.bucket || !next?.path) {
      console.warn('[portal] openFile needs at least { bucket, path }')
      return
    }
    setFile(next)
  }, [])

  const close = useCallback(() => setFile(null), [])

  const element = file
    ? createPortal(
        // Rendered into document.body so the overlay is not clipped by the
        // panel's own stacking or overflow context.
        <ViewerBoundary onClose={close}>
          <Suspense fallback={<Scrim onClose={close}>Opening…</Scrim>}>
            <FileViewer
              bucket={file.bucket}
              path={file.path}
              title={file.title}
              mime={file.mime}
              byteSize={file.byteSize ?? file.byte_size}
              onClose={close}
              onSaved={onSaved}
            />
          </Suspense>
        </ViewerBoundary>,
        document.body
      )
    : null

  return { open, close, element, current: file }
}
