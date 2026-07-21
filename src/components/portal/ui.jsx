import Icon from '../Icon'
import styles from './Portal.module.css'

// -----------------------------------------------------------------------------
// Shared panel states.
//
// Every panel loads, can be empty, and can fail. Centralising the three means
// they look and behave identically everywhere — and that each one is written
// carefully once instead of hastily six times.
// -----------------------------------------------------------------------------

// Skeleton rows rather than a spinner: they occupy the same space the real rows
// will, so content does not jump when it arrives. The shimmer is a background
// animation, not a transform, so it never triggers layout.
export function Loading({ rows = 4, label = 'Loading' }) {
  return (
    <div className={styles.skeletonList} role="status" aria-live="polite">
      <span className="sr-only">{label}…</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={styles.skeletonRow} style={{ '--i': i }} aria-hidden="true">
          <div className={styles.skeletonBar} />
          <div className={`${styles.skeletonBar} ${styles.skeletonBarShort}`} />
        </div>
      ))}
    </div>
  )
}

// An empty state that only says "nothing here" wastes the one moment the user
// is definitely looking. Each takes an action so the page is a next step rather
// than a dead end.
export function Empty({ icon = 'folder', title, children, action }) {
  return (
    <div className={styles.empty}>
      <span className={styles.emptyIcon} aria-hidden="true">
        <Icon name={icon} size={24} />
      </span>
      <h3 className={styles.emptyTitle}>{title}</h3>
      {children && <p className={styles.emptyText}>{children}</p>}
      {action}
    </div>
  )
}

export function ErrorState({ error, onRetry }) {
  return (
    <div className={styles.empty} role="alert">
      <span className={`${styles.emptyIcon} ${styles.emptyIconBad}`} aria-hidden="true">
        <Icon name="alert" size={24} />
      </span>
      <h3 className={styles.emptyTitle}>That didn't load</h3>
      <p className={styles.emptyText}>{error}</p>
      {onRetry && (
        <button type="button" className="btn btn--ghost" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  )
}

export function StatTile({ label, value, unit, tone = 'data' }) {
  return (
    <div className={`${styles.stat} ${styles[`stat_${tone}`] ?? ''}`}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>
        {value}
        {unit && <span className={styles.statUnit}>{unit}</span>}
      </span>
    </div>
  )
}

// Rows stagger in on mount. The delay is capped so a long list never turns into
// a slow one — past the cap everything lands together, which is correct: by
// then the cascade has already done its job of showing that a list arrived.
export function Row({ index = 0, children, ...rest }) {
  return (
    <li className={styles.row} style={{ '--i': Math.min(index, 8) }} {...rest}>
      {children}
    </li>
  )
}

export function Toolbar({ children }) {
  return <div className={styles.toolbar}>{children}</div>
}

export function Search({ value, onChange, placeholder = 'Search…' }) {
  return (
    <div className={styles.search}>
      <Icon name="search" size={16} className={styles.searchIcon} />
      <input
        type="search"
        className={styles.searchInput}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  )
}
