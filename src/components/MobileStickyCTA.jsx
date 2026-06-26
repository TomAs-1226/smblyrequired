import Icon from './Icon'
import { useRoute } from '../hooks/useRoute'
import styles from './MobileStickyCTA.module.css'

// Bottom-docked primary action on mobile (hidden on desktop via CSS). Persists
// across pages, except on the Sponsor/Contact pages where it'd be redundant.
export default function MobileStickyCTA() {
  const raw = useRoute()
  const path = raw !== '/' ? raw.replace(/\/+$/, '') : '/'
  const hide = path === '/sponsor' || path === '/contact'

  return (
    <div className={`${styles.dock} ${hide ? '' : styles.show}`} aria-hidden={hide}>
      <a href="#/sponsor" className="btn btn--gold" tabIndex={hide ? -1 : 0}>
        Become a sponsor
        <Icon name="arrowRight" className="arrow" size={18} />
      </a>
    </div>
  )
}
