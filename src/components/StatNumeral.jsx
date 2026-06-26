import Counter from './Counter'

// Oversized Oswald stat + label beneath, with a count-up on scroll-in.
// Use gold sparingly — at most one gold numeral per section.
export default function StatNumeral({ to, prefix = '', suffix = '', label, gold = false }) {
  return (
    <div className="stat-numeral">
      <div className={`stat-numeral__n${gold ? ' is-gold' : ''}`}>
        <Counter to={to} prefix={prefix} suffix={suffix} />
      </div>
      <div className="stat-numeral__l">{label}</div>
    </div>
  )
}
