// Editorial section spine: gold rule + "01 — THE TEAM" tracked caps.
export default function Eyebrow({ num, children, className = '' }) {
  return (
    <span className={`eyebrow ${className}`}>
      {num != null && <span className="eyebrow__num">{num}</span>}
      {num != null && <span aria-hidden="true">—</span>}
      <span>{children}</span>
    </span>
  )
}
