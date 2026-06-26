import { useEffect, useState } from 'react'
import { scrollTo } from '../lib/smoothScroll'
import Icon from './Icon'
import styles from './MobileStickyCTA.module.css'

// Bottom-docked single primary action on mobile. Appears after the hero,
// hides near the contact section so it never covers the form/footer.
export default function MobileStickyCTA() {
  const [show, setShow] = useState(false)

  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY
      const contact = document.getElementById('contact')
      const nearEnd = contact ? y + window.innerHeight > contact.offsetTop + 80 : false
      setShow(y > window.innerHeight * 0.8 && !nearEnd)
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <div className={`${styles.dock} ${show ? styles.show : ''}`} aria-hidden={!show}>
      <button
        type="button"
        className="btn btn--gold"
        tabIndex={show ? 0 : -1}
        onClick={() => scrollTo('#sponsor')}
      >
        Become a sponsor
        <Icon name="arrowRight" className="arrow" size={18} />
      </button>
    </div>
  )
}
