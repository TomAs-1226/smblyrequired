import { useRef } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import Section from './Section'
import Eyebrow from './Eyebrow'
import SplitHeading from './SplitHeading'
import MagneticButton from './MagneticButton'
import Reveal from './Reveal'
import Icon from './Icon'
import { tiers, inKind, taxNote, packetUrl, sponsorSteps } from '../data/sponsors'
import { contact, team } from '../data/team'
import { prefersReducedMotion } from '../lib/prefersReducedMotion'
import styles from './Donate.module.css'

gsap.registerPlugin(ScrollTrigger, useGSAP)

const usd = (n) => `$${n.toLocaleString('en-US')}`

// Smallest tier doubles as a friendly "any size helps" anchor for individuals.
const entryTier = tiers[0]

// One-time / recurring gift — opens the visitor's mail client, pre-addressed.
const giveHref = `mailto:${contact.sponsorEmail}?subject=${encodeURIComponent(
  `Donation — ${team.shortName}`
)}&body=${encodeURIComponent(
  [
    `I'd like to make a gift to FIRST ${team.shortName}.`,
    '',
    'Amount: ',
    'One-time or recurring: ',
    'Name (as it should appear): ',
    '',
    'Thanks!',
  ].join('\n')
)}`

const checkMemo = contact.checkMemo || 'Robotics – Team 5805'

// DONATE — the individual / family / quick-give counterpart to the corporate
// Sponsor page. Editorial "ways to give" board: an oversized primary gift card,
// a check card, an in-kind card, and a corporate hand-off — plus a gold tax bar
// and the same 3-step "how it works" row used on the Sponsor page.
export default function Donate() {
  const root = useRef(null)

  // Ways-to-give cards rise & settle in sequence on scroll-in (over real DOM).
  useGSAP(
    () => {
      if (prefersReducedMotion()) return
      const cards = root.current.querySelectorAll(`.${styles.card}`)
      if (!cards.length) return
      gsap.from(cards, {
        autoAlpha: 0,
        y: 30,
        duration: 0.7,
        ease: 'expo.out',
        stagger: 0.08,
        // See Reveal.jsx — without this the tween leaves an inline transform
        // that outranks the stylesheet and kills `.card:hover`'s lift.
        clearProps: 'transform',
        scrollTrigger: { trigger: `.${styles.board}`, start: 'top 82%', once: true },
      })
    },
    { scope: root }
  )

  return (
    <Section id="donate" className={styles.section}>
      <div ref={root}>
        <div className={styles.field} aria-hidden="true" />

        {/* --- Header: ask (left) + season-cost data plate (right) --------- */}
        <header className={styles.head}>
          <div className={styles.headLede}>
            <Eyebrow>Ways to give</Eyebrow>
            <SplitHeading as="h2" className={styles.heading}>
              Every gift puts tools in students&rsquo; hands.
            </SplitHeading>
            <p className={`lead ${styles.lead}`}>
              A competitive FRC season runs{' '}
              <strong>~$25,000&ndash;$35,000</strong> — registration, materials,
              tools, and travel for a 100% student-built robot. A gift of any size
              helps, and contributions are <strong>tax-deductible</strong> through
              the school.
            </p>
          </div>

          <aside className={styles.costPlate}>
            <p className={styles.costLabel}>What a season costs</p>
            <p className={styles.costNum}>
              $25k<span className={styles.costDash}>–</span>$35k
            </p>
            <p className={styles.costSub}>
              <span className="data-tag data-tag--gold">
                100% student-built · {team.currentGame} {team.currentSeason}
              </span>
            </p>
            <p className={styles.costNote}>
              Funded entirely by donors, sponsors, and the families behind{' '}
              {team.shortName}.
            </p>
          </aside>
        </header>

        {/* --- The board: four editorial, non-identical "ways to give" ----- */}
        <div className={styles.board}>
          {/* (1) PRIMARY — one-time or recurring gift. The single gold CTA. */}
          <article className={`${styles.card} ${styles.cardGive} hud-frame`}>
            <div className={styles.cardTop}>
              <span className={`${styles.cardIcon} ${styles.cardIconGold}`}>
                <Icon name="heart" size={26} />
              </span>
              <span className={styles.cardTag}>Most popular</span>
            </div>
            <h3 className={styles.cardTitle}>One-time or recurring gift</h3>
            <p className={styles.cardBody}>
              Give once, or set up a monthly gift that keeps the shop stocked all
              season. Even {usd(entryTier.amount)} buys real parts — and your name
              joins our supporters.
            </p>
            <ul className={styles.giveChips}>
              <li>$25</li>
              <li>$50</li>
              <li>$100</li>
              <li>{usd(entryTier.amount)}</li>
              <li>Any amount</li>
            </ul>
            <MagneticButton
              as="a"
              href={giveHref}
              className={`btn btn--gold ${styles.giveBtn}`}
            >
              <Icon name="heart" size={18} />
              Make a gift
              <Icon name="arrowRight" className="arrow" size={18} />
            </MagneticButton>
            <p className={styles.cardNote}>
              Opens your mail app to {contact.sponsorEmail} — {contact.overseer}{' '}
              will confirm and send a receipt.
            </p>
          </article>

          {/* (2) BY CHECK — payable / mailing details. */}
          <article className={styles.card}>
            <span className={styles.cardIcon}>
              <Icon name="mail" size={24} />
            </span>
            <h3 className={styles.cardTitle}>By check</h3>
            <p className={styles.cardBody}>
              Prefer to mail it? Make checks payable to the school and we&rsquo;ll
              route it straight to the team.
            </p>
            <dl className={styles.checkRows}>
              <div className={styles.checkRow}>
                <dt>Payable to</dt>
                <dd>{team.school}</dd>
              </div>
              <div className={styles.checkRow}>
                <dt>Memo line</dt>
                <dd className={styles.checkMemo}>{checkMemo}</dd>
              </div>
              <div className={styles.checkRow}>
                <dt>Mail to</dt>
                <dd>{contact.address}</dd>
              </div>
            </dl>
          </article>

          {/* (3) IN-KIND — materials & expertise as chips. */}
          <article className={styles.card}>
            <span className={styles.cardIcon}>
              <Icon name="gift" size={24} />
            </span>
            <h3 className={styles.cardTitle}>In-kind donations</h3>
            <p className={styles.cardBody}>
              Materials, machine time, and expertise move us forward just like
              dollars do. We gratefully accept:
            </p>
            <ul className={styles.inKind}>
              {inKind.map((item) => (
                <li key={item} className={styles.inKindChip}>
                  <Icon name="check" size={14} className={styles.inKindCheck} />
                  {item}
                </li>
              ))}
            </ul>
            <a href={`mailto:${contact.sponsorEmail}?subject=${encodeURIComponent(
              `In-kind donation — ${team.shortName}`
            )}`} className={styles.cardLink}>
              Offer materials or time
              <Icon name="arrowRight" className="arrow" size={16} />
            </a>
          </article>

          {/* (4) CORPORATE — hand-off to the Sponsor page + packet. */}
          <article className={`${styles.card} ${styles.cardCorporate}`}>
            <span className={styles.cardIcon}>
              <Icon name="building" size={24} />
            </span>
            <h3 className={styles.cardTitle}>Giving as a business?</h3>
            <p className={styles.cardBody}>
              Companies get logo placement on our jerseys, robot, and banner —
              plus a tax-deductible receipt. See the tiers, or take the packet to
              your team.
            </p>
            <div className={styles.cardActions}>
              <a href="#/sponsor" className={`btn btn--cyan ${styles.cardCta}`}>
                View sponsorship
                <Icon name="arrowRight" className="arrow" size={18} />
              </a>
              <a
                href={'./' + packetUrl}
                download
                className={`btn btn--ghost ${styles.cardCta}`}
              >
                <Icon name="download" size={18} />
                Download the packet
              </a>
            </div>
          </article>
        </div>

        {/* --- Gold-accented tax / receipt note bar ----------------------- */}
        <Reveal className={styles.tax} as="aside" y={22}>
          <span className={styles.taxIcon} aria-hidden="true">
            <Icon name="medal" size={20} />
          </span>
          <div className={styles.taxBody}>
            <p className={styles.taxLine}>{taxNote}</p>
            <p className={styles.taxMeta}>
              <span className={styles.taxPill}>501(c)(3)</span>
              <span className={styles.taxPill}>EIN available on request</span>
              <span className={styles.taxPill}>Receipt for every gift</span>
            </p>
          </div>
        </Reveal>

        {/* --- How it works — reuse the sponsor 3-step flow ---------------- */}
        <div className={styles.steps}>
          <p className={styles.stepsLabel}>
            <span className={styles.stepsRule} aria-hidden="true" />
            <span>How it works</span>
          </p>
          <Reveal className={styles.stepGrid} stagger={0.08} y={24}>
            {sponsorSteps.map((step) => (
              <div key={step.n} className={styles.step}>
                <span className={styles.stepNum}>
                  {String(step.n).padStart(2, '0')}
                </span>
                <h4 className={styles.stepName}>{step.title}</h4>
                <p className={styles.stepBody}>{step.body}</p>
              </div>
            ))}
          </Reveal>
        </div>
      </div>
    </Section>
  )
}
