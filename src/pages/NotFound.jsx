import Section from '../components/Section'
import Eyebrow from '../components/Eyebrow'
import Icon from '../components/Icon'
import { navLinks } from '../data/navigation'

// On-brand 404. Hash router lands here for any unknown #/route.
export default function NotFound() {
  return (
    <Section>
      <div style={{ maxWidth: '44rem', paddingBlock: 'clamp(32px, 7vh, 96px)' }}>
        <Eyebrow>Error 404</Eyebrow>
        <h1
          style={{
            fontSize: 'var(--fs-display)',
            lineHeight: 0.95,
            letterSpacing: '-0.02em',
            margin: 'var(--sp-4) 0 var(--sp-4)',
          }}
        >
          Off the <span style={{ color: 'var(--accent-gold)' }}>field</span>.
        </h1>
        <p className="lead" style={{ marginBottom: 'var(--sp-6)' }}>
          That page doesn’t exist — let’s get you back to the pit.
        </p>
        <a href="#/" className="btn btn--gold">
          Back home
          <Icon name="arrowRight" className="arrow" size={18} />
        </a>

        <nav
          aria-label="Site"
          style={{
            marginTop: 'var(--sp-7)',
            paddingTop: 'var(--sp-5)',
            borderTop: '1px solid var(--border-hairline)',
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--sp-4) var(--sp-5)',
          }}
        >
          {navLinks.map((l) => (
            <a
              key={l.path}
              href={`#${l.path}`}
              style={{
                color: 'var(--text-muted)',
                fontFamily: 'var(--font-display)',
                fontSize: '0.9rem',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
              }}
            >
              {l.label}
            </a>
          ))}
        </nav>
      </div>
    </Section>
  )
}
