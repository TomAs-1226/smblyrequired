import { useEffect, useRef, useState } from 'react'
import Icon from './Icon'
import { scrollTo } from '../lib/smoothScroll'
import styles from './BackToTop.module.css'

// A small button back to the top of the page, on every page. It appears once the reader is more than
// a screen and a half down, and stays out of the way of the landing page's 3D story, where the
// bottom of the screen belongs to the copy.
export default function BackToTop({ path }) {
  const sentinel = useRef(null)
  const [past, setPast] = useState(false)
  const [inStory, setInStory] = useState(false)

  useEffect(() => {
    // The sentinel covers the first screen and a half; when it leaves the viewport, we are past it.
    const io = new IntersectionObserver(([e]) => setPast(!e.isIntersecting))
    io.observe(sentinel.current)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    const story = document.querySelector('[data-spine]')
    if (!story) {
      setInStory(false)
      return
    }
    const io = new IntersectionObserver(([e]) => setInStory(e.isIntersecting))
    io.observe(story)
    return () => io.disconnect()
  }, [path])

  const shown = past && !inStory
  return (
    <>
      <span ref={sentinel} className={styles.sentinel} aria-hidden="true" />
      <button
        type="button"
        className={styles.top}
        data-shown={shown || undefined}
        {...(shown ? {} : { inert: '' })}
        onClick={() => scrollTo(0)}
        aria-label="Back to top"
      >
        <Icon name="arrowUp" size={18} />
      </button>
    </>
  )
}
