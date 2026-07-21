import { useCallback, useEffect, useRef, useState } from 'react'
import Icon from '../../Icon'
import { formatBytes } from '../../../lib/portalApi'
import Message from './Message'
import styles from './Viewers.module.css'

// -----------------------------------------------------------------------------
// Image viewer.
//
// Opens fit-to-screen, clicks to 1:1, and pans by drag while zoomed. The natural
// dimensions are shown next to the file size because that is the actual question
// being asked of a pit-scouting photo: not "is it pretty" but "is it big enough
// to read a bumper number off", and a fitted image tells you nothing about that.
//
// Pan is a transform, never a scroll offset or a width change — the same rule
// the rest of the site follows, and the only way this stays smooth on a phone.
// -----------------------------------------------------------------------------

export default function ImageViewer({ url, name, byteSize, onRetry }) {
  const [dims, setDims] = useState(null)
  const [failed, setFailed] = useState(false)
  const [zoomed, setZoomed] = useState(false)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)

  const boxRef = useRef(null)
  const imgRef = useRef(null)
  const drag = useRef(null)

  useEffect(() => {
    setDims(null)
    setFailed(false)
    setZoomed(false)
    setOffset({ x: 0, y: 0 })
  }, [url])

  // Keep the image from being dragged completely out of view — past the edge
  // there is nothing to look at and no obvious way back.
  const clamp = useCallback((x, y) => {
    const box = boxRef.current
    const img = imgRef.current
    if (!box || !img) return { x, y }
    const maxX = Math.max(0, img.naturalWidth - box.clientWidth)
    const maxY = Math.max(0, img.naturalHeight - box.clientHeight)
    return {
      x: Math.min(0, Math.max(-maxX, x)),
      y: Math.min(0, Math.max(-maxY, y)),
    }
  }, [])

  const toggleZoom = useCallback(
    (e) => {
      if (!dims) return
      if (zoomed) {
        setZoomed(false)
        setOffset({ x: 0, y: 0 })
        return
      }
      // Zoom toward the point that was clicked rather than the top-left, so the
      // detail under the cursor is the detail you get.
      const box = boxRef.current
      const img = imgRef.current
      let next = { x: 0, y: 0 }
      if (box && img && e) {
        const rect = img.getBoundingClientRect()
        const rx = (e.clientX - rect.left) / rect.width
        const ry = (e.clientY - rect.top) / rect.height
        next = {
          x: -(dims.w * rx - box.clientWidth / 2),
          y: -(dims.h * ry - box.clientHeight / 2),
        }
      }
      setZoomed(true)
      // clamp() reads the natural size off the element, which is only correct
      // once the zoomed layout exists — defer a frame.
      requestAnimationFrame(() => setOffset(clamp(next.x, next.y)))
    },
    [zoomed, dims, clamp]
  )

  const onPointerDown = (e) => {
    if (!zoomed) return
    drag.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: offset.x,
      originY: offset.y,
      moved: 0,
    }
    setDragging(true)
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    d.moved = Math.max(d.moved, Math.abs(dx) + Math.abs(dy))
    setOffset(clamp(d.originX + dx, d.originY + dy))
  }

  const onPointerUp = (e) => {
    const d = drag.current
    drag.current = null
    setDragging(false)
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    // A drag that barely moved was a click asking to zoom back out.
    if (d && d.moved < 5) toggleZoom(null)
  }

  if (failed) {
    return (
      <Message
        bad
        icon="alert"
        title="That image didn't load"
        text="The link may have expired, or the file may not be a readable image."
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
          className={`${styles.textBtn} ${zoomed ? styles.textBtnOn : ''}`}
          onClick={() => toggleZoom(null)}
          aria-pressed={zoomed}
          disabled={!dims}
        >
          <Icon name="search" size={14} />
          {zoomed ? 'Fit to screen' : 'Zoom to 100%'}
        </button>
        <span className={styles.toolSpacer} />
        <span className={styles.toolNote}>
          {dims ? `${dims.w} × ${dims.h} px` : 'measuring…'}
          {byteSize != null && ` · ${formatBytes(byteSize)}`}
        </span>
      </div>

      <div
        className={styles.imgStage}
        ref={boxRef}
        // The stage is the scroll/pan surface; Lenis must keep its hands off it.
        data-lenis-prevent
      >
        {zoomed ? (
          <div
            className={`${styles.imgZoomBox} ${dragging ? styles.imgZoomBoxDragging : ''}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <img
              ref={imgRef}
              className={`${styles.imgFit} ${styles.imgNatural}`}
              src={url}
              alt={name}
              draggable="false"
              style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0)` }}
              onError={() => setFailed(true)}
            />
          </div>
        ) : (
          <button
            type="button"
            className={styles.imgFitBox}
            onClick={toggleZoom}
            aria-label={`Zoom ${name} to full size`}
          >
            <img
              ref={imgRef}
              className={styles.imgFit}
              src={url}
              alt={name}
              onLoad={(e) =>
                setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
              }
              onError={() => setFailed(true)}
            />
          </button>
        )}
      </div>
    </>
  )
}
