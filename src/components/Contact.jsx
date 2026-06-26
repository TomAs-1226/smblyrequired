import { useRef, useState } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import { contact, mentors, firstDisclaimer } from '../data/team'
import { prefersReducedMotion } from '../lib/prefersReducedMotion'
import Section from './Section'
import Eyebrow from './Eyebrow'
import SplitHeading from './SplitHeading'
import MagneticButton from './MagneticButton'
import Reveal from './Reveal'
import Icon from './Icon'
import styles from './Contact.module.css'

gsap.registerPlugin(useGSAP)

const INTERESTS = [
  { value: 'sponsor', label: 'Sponsor the team' },
  { value: 'in-kind', label: 'In-kind / materials donation' },
  { value: 'join', label: 'Join the team (student/parent)' },
  { value: 'other', label: 'Something else' },
]

const EMPTY = { name: '', org: '', email: '', interest: 'sponsor', message: '' }

// CONTACT / GET INVOLVED — final declarative close. Left column carries the
// primary ask, contact details, and mentor credits; right column is a working
// sponsor-inquiry form that resolves to a real animated success end-state.
export default function Contact() {
  const root = useRef(null)
  const [form, setForm] = useState(EMPTY)
  const [sent, setSent] = useState(false)

  const update = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))

  // Draw the SVG check once the success panel mounts (gated on reduced motion).
  useGSAP(
    () => {
      if (!sent) return
      if (prefersReducedMotion()) return
      const path = root.current.querySelector(`.${styles.checkPath}`)
      const ring = root.current.querySelector(`.${styles.checkRing}`)
      if (!path || !ring) return
      const pLen = path.getTotalLength()
      const rLen = ring.getTotalLength()
      gsap.set(path, { strokeDasharray: pLen, strokeDashoffset: pLen })
      gsap.set(ring, { strokeDasharray: rLen, strokeDashoffset: rLen })
      gsap
        .timeline()
        .to(ring, { strokeDashoffset: 0, duration: 0.6, ease: 'power2.inOut' }, 0)
        .to(path, { strokeDashoffset: 0, duration: 0.4, ease: 'power2.out' }, 0.3)
    },
    { scope: root, dependencies: [sent] }
  )

  const onSubmit = (e) => {
    e.preventDefault()
    // No backend: surface the inquiry via the visitor's mail client AND show a
    // confirmed in-page end-state so the action is never a no-op.
    const subject = `[5805 ${INTERESTS.find((i) => i.value === form.interest)?.label || 'Inquiry'}] ${
      form.org || form.name || 'Website inquiry'
    }`
    const body = [
      `Name: ${form.name}`,
      `Organization: ${form.org}`,
      `Email: ${form.email}`,
      `Interest: ${INTERESTS.find((i) => i.value === form.interest)?.label}`,
      '',
      form.message,
    ].join('\n')
    const href = `mailto:${contact.sponsorEmail}?subject=${encodeURIComponent(
      subject
    )}&body=${encodeURIComponent(body)}`
    // Open the user's mail client without leaving the success state behind.
    window.location.href = href
    setSent(true)
  }

  return (
    <Section id="contact" className={styles.section}>
      <div ref={root} className={styles.inner}>
      <div className={styles.head}>
        <Eyebrow num="06">Get involved</Eyebrow>
        <SplitHeading as="h2" className={styles.heading}>
          Let&rsquo;s build something
          <br />
          <span className={styles.accent}>championship-worthy.</span>
        </SplitHeading>
      </div>

      <div className={styles.grid}>
        {/* ---- LEFT: the primary ask + details + mentors ------------------ */}
        <Reveal className={styles.ask} y={28} stagger={0.08}>
          <p className={`lead ${styles.lead}`}>
            Every robot we build is <strong>100% student-funded and student-built</strong>. Your
            partnership puts tools in their hands and engineers in the making.
          </p>

          <div className={styles.cta}>
            <MagneticButton
              as="a"
              href={`mailto:${contact.sponsorEmail}?subject=${encodeURIComponent(
                'Sponsoring FRC Team 5805'
              )}`}
              className="btn btn--gold"
            >
              Sponsor the team
              <Icon name="arrowRight" className="arrow" size={18} />
            </MagneticButton>
            <span className={styles.ctaNote}>
              Talk to {contact.overseer}, {contact.overseerRole}
            </span>
          </div>

          <ul className={styles.details}>
            <li>
              <span className={styles.dIcon} aria-hidden="true">
                <Icon name="mail" size={18} />
              </span>
              <span className={styles.dBody}>
                <span className={styles.dLabel}>Sponsorship</span>
                <a href={`mailto:${contact.sponsorEmail}`} className={styles.dLink}>
                  {contact.sponsorEmail}
                </a>
                <span className={styles.dSub}>
                  {contact.overseer} · {contact.overseerRole}
                </span>
              </span>
            </li>
            <li>
              <span className={styles.dIcon} aria-hidden="true">
                <Icon name="megaphone" size={18} />
              </span>
              <span className={styles.dBody}>
                <span className={styles.dLabel}>General &amp; team inquiries</span>
                <a href={`mailto:${contact.generalEmail}`} className={styles.dLink}>
                  {contact.generalEmail}
                </a>
              </span>
            </li>
            <li>
              <span className={styles.dIcon} aria-hidden="true">
                <Icon name="user" size={18} />
              </span>
              <span className={styles.dBody}>
                <span className={styles.dLabel}>Program office</span>
                <a href={`tel:${contact.phone.replace(/[^\d+]/g, '')}`} className={styles.dLink}>
                  {contact.phone}
                </a>
              </span>
            </li>
            <li>
              <span className={styles.dIcon} aria-hidden="true">
                <Icon name="pin" size={18} />
              </span>
              <span className={styles.dBody}>
                <span className={styles.dLabel}>Build space</span>
                <span className={styles.dText}>{contact.address}</span>
              </span>
            </li>
          </ul>

          <div className={styles.mentors}>
            <span className={styles.mentorsLabel}>Coached &amp; mentored by</span>
            <ul className={styles.mentorList}>
              {mentors.map((m) => (
                <li key={m.name} className={styles.mentor}>
                  <span className={styles.mentorName}>{m.name}</span>
                  <span className={styles.mentorRole}>{m.role}</span>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>

        {/* ---- RIGHT: the inquiry form / success end-state --------------- */}
        <div className={styles.formWrap}>
          <div className={styles.formHeader}>
            <span className="pill">
              <span className={styles.live} aria-hidden="true" />
              Start a conversation
            </span>
          </div>

          {!sent ? (
            <form className={styles.form} onSubmit={onSubmit} noValidate>
              <div className={styles.row}>
                <div className={styles.field}>
                  <label htmlFor="c-name">Your name</label>
                  <input
                    id="c-name"
                    name="name"
                    type="text"
                    autoComplete="name"
                    required
                    value={form.name}
                    onChange={update('name')}
                    placeholder="Jordan Rivera"
                  />
                </div>
                <div className={styles.field}>
                  <label htmlFor="c-org">Organization</label>
                  <input
                    id="c-org"
                    name="org"
                    type="text"
                    autoComplete="organization"
                    value={form.org}
                    onChange={update('org')}
                    placeholder="Acme Robotics (optional)"
                  />
                </div>
              </div>

              <div className={styles.field}>
                <label htmlFor="c-email">Email</label>
                <input
                  id="c-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={form.email}
                  onChange={update('email')}
                  placeholder="you@company.com"
                />
              </div>

              <div className={styles.field}>
                <label htmlFor="c-interest">I&rsquo;m interested in</label>
                <div className={styles.selectWrap}>
                  <select
                    id="c-interest"
                    name="interest"
                    value={form.interest}
                    onChange={update('interest')}
                  >
                    {INTERESTS.map((i) => (
                      <option key={i.value} value={i.value}>
                        {i.label}
                      </option>
                    ))}
                  </select>
                  <Icon name="arrowUp" size={16} className={styles.selectCaret} />
                </div>
              </div>

              <div className={styles.field}>
                <label htmlFor="c-message">Message</label>
                <textarea
                  id="c-message"
                  name="message"
                  rows={4}
                  required
                  value={form.message}
                  onChange={update('message')}
                  placeholder="Tell us a little about how you'd like to get involved…"
                />
              </div>

              <button type="submit" className={`btn btn--gold ${styles.submit}`}>
                Send inquiry
                <Icon name="arrowRight" className="arrow" size={18} />
              </button>
              <p className={styles.formNote}>
                Opens in your mail app, addressed to {contact.sponsorEmail}.
              </p>
            </form>
          ) : (
            <div className={styles.success} role="status" aria-live="polite">
              <svg className={styles.checkMark} viewBox="0 0 80 80" aria-hidden="true">
                <circle className={styles.checkRing} cx="40" cy="40" r="36" />
                <path className={styles.checkPath} d="M24 41.5l11 11L57 28" />
              </svg>
              <h3 className={styles.successTitle}>Message ready to send</h3>
              <p className={styles.successBody}>
                Thanks, {form.name ? form.name.split(' ')[0] : 'friend'} — your draft just opened in
                your mail app. Hit send and {contact.overseer} will be in touch.
              </p>
              <button
                type="button"
                className={`btn btn--ghost ${styles.reset}`}
                onClick={() => {
                  setForm(EMPTY)
                  setSent(false)
                }}
              >
                Send another
              </button>
            </div>
          )}
        </div>
      </div>

      {/* On-ramp note for students & parents */}
      <div className={styles.onramp}>
        <Icon name="spark" size={20} className={styles.onrampIcon} />
        <p>
          <strong>Students &amp; parents:</strong> want to join the build? New-member interest and
          applications go to{' '}
          <a href={`mailto:${contact.generalEmail}`} className={styles.dLink}>
            {contact.generalEmail}
          </a>
          . No experience required — just curiosity.
        </p>
      </div>

      <p className={styles.disclaimer}>{firstDisclaimer}</p>
      </div>
    </Section>
  )
}
