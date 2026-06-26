import { team, contact, firstDisclaimer } from '../data/team'
import { titleSponsors } from '../data/sponsors'
import Reveal from './Reveal'
import Icon from './Icon'
import MagneticButton from './MagneticButton'
import styles from './Footer.module.css'

// Section anchors mirrored from the page nav (a couple are still being built).
const NAV = [
  { href: '#/team', label: 'Team' },
  { href: '#/robots', label: 'Robots' },
  { href: '#/season', label: 'Season' },
  { href: '#/sponsor', label: 'Sponsor' },
  { href: '#/catalyst', label: 'Catalyst' },
  { href: '#/gallery', label: 'Gallery' },
  { href: '#/contact', label: 'Contact' },
]

// School/program socials — generic hrefs for now, wired later.
const SOCIALS = [
  { label: 'Facebook', href: '#' },
  { label: 'Instagram', href: '#' },
  { label: 'YouTube', href: '#' },
  { label: 'LinkedIn', href: '#' },
]

// FOOTER — the page ends calm. One quiet enter-reveal, no continuous motion.
// Asymmetric multi-column lockup over --bg-void with a giant faded "5805"
// watermark bleeding off the bottom edge.
export default function Footer() {
  return (
    <footer className={styles.footer}>
      {/* Decorative oversized team number bleeding off the bottom edge */}
      <span className={styles.watermark} aria-hidden="true">
        {team.number}
      </span>

      <div className={`container ${styles.inner}`}>
        <Reveal className={styles.grid} stagger={0.07} y={26}>
          {/* (1) Brand lockup — heavy left column */}
          <div className={styles.brandCol}>
            <a href="#/" className={styles.brand} aria-label={`${team.name} — home`}>
              {/* Full color logo lives on a light plate — it's blue artwork */}
              <span className={styles.logoPlate}>
                <img
                  src="photos/logo.png"
                  alt={`${team.name} — FRC Team ${team.number}`}
                  className={styles.logo}
                />
              </span>
              <span className={styles.brandKicker}>FRC Team {team.number}</span>
              <span className={styles.brandName}>{team.name}</span>
            </a>
            <p className={styles.brandMeta}>
              {team.school}
            </p>
            <p className={styles.brandLoc}>
              <Icon name="pin" size={15} className={styles.pin} />
              {team.location}
            </p>
            <a
              className={styles.siteLink}
              href={team.website}
              target="_blank"
              rel="noopener noreferrer"
            >
              {team.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}
              <Icon name="external" size={13} className={styles.siteIcon} />
            </a>
            <p className={styles.motto}>{team.motto}</p>
            <p className={styles.presents}>
              Presented by{' '}
              {titleSponsors.map((s, i) => (
                <span key={s}>
                  <span className={styles.presentsName}>{s}</span>
                  {i < titleSponsors.length - 1 ? ' & ' : ''}
                </span>
              ))}
            </p>
          </div>

          {/* (2) Navigate */}
          <nav className={styles.navCol} aria-label="Footer">
            <h2 className={styles.colTitle}>Navigate</h2>
            <ul className={styles.navList}>
              {NAV.map((l) => (
                <li key={l.href}>
                  <a href={l.href} className={styles.navLink}>
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          {/* (3) Connect — single primary CTA + contact emails */}
          <div className={styles.connectCol}>
            <h2 className={styles.colTitle}>Connect</h2>
            <MagneticButton
              as="a"
              href="#/sponsor"
              className={`btn btn--gold ${styles.cta}`}
            >
              Sponsor Us
              <Icon name="arrowRight" size={18} className="arrow" />
            </MagneticButton>

            <ul className={styles.contactList}>
              <li>
                <a className={styles.contactLink} href={`mailto:${contact.sponsorEmail}`}>
                  <Icon name="mail" size={16} className={styles.contactIcon} />
                  <span>
                    <span className={styles.contactRole}>Sponsorship</span>
                    {contact.sponsorEmail}
                  </span>
                </a>
              </li>
              <li>
                <a className={styles.contactLink} href={`mailto:${contact.generalEmail}`}>
                  <Icon name="mail" size={16} className={styles.contactIcon} />
                  <span>
                    <span className={styles.contactRole}>General</span>
                    {contact.generalEmail}
                  </span>
                </a>
              </li>
            </ul>

            <ul className={styles.socials} aria-label="Social media">
              {SOCIALS.map((s) => (
                <li key={s.label}>
                  {/* TODO: replace '#' with live school/program social URLs */}
                  <a
                    href={s.href}
                    className={styles.social}
                    data-social-pending="true"
                  >
                    {s.label}
                    <Icon name="external" size={13} className={styles.socialIcon} />
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>

        {/* Legal baseline */}
        <div className={styles.legal}>
          <p className={styles.disclaimer}>{firstDisclaimer}</p>
          <p className={styles.tax}>
            Supported through {team.schoolShort}; tax-deductible to the extent
            allowed — EIN on request.
          </p>
          <p className={styles.copy}>
            © {team.currentSeason} FRC Team {team.number} · {team.name}
          </p>
        </div>
      </div>
    </footer>
  )
}
