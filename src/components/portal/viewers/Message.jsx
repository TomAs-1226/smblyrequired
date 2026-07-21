import Icon from '../../Icon'
import styles from './Viewers.module.css'

// The shared "nothing to show, and here is why" state for every viewer.
//
// It lives in its own module rather than in FileViewer so the viewers do not
// have to import the component that lazy-loads them. That cycle resolves fine
// today — FileViewer's module body is side-effect-free, so evaluation order
// cannot bite — but it is the kind of coupling that stops being harmless the
// moment someone renders a viewer from anywhere else.
//
// Every state here takes a reason and, where one exists, an action. A viewer
// that just goes blank teaches people the portal is broken; one that says what
// it decided and offers the download keeps them moving.
export default function Message({ icon = 'folder', title, text, action, bad = false }) {
  return (
    <div className={styles.center} role={bad ? 'alert' : undefined}>
      <span
        className={`${styles.centerIcon} ${bad ? styles.centerIconBad : ''}`}
        aria-hidden="true"
      >
        <Icon name={icon} size={24} />
      </span>
      <h3 className={styles.centerTitle}>{title}</h3>
      {text && <p className={styles.centerText}>{text}</p>}
      {action}
    </div>
  )
}
