// Editorial section spine: a gold rule + tracked-caps label. (Numbers were
// dropped when the site went multi-page — a global 01–06 sequence no longer
// makes sense across separate pages. `num` is accepted but ignored.)
export default function Eyebrow({ children, className = '' }) {
  return (
    <span className={`eyebrow ${className}`}>
      <span>{children}</span>
    </span>
  )
}
