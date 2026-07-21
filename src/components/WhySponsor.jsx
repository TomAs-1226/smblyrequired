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
import { prefersReducedMotion } from '../lib/prefersReducedMotion'
import { budget, seasonCost, sponsorBenefits, inKind, packetUrl } from '../data/sponsors'
import styles from './WhySponsor.module.css'

gsap.registerPlugin(ScrollTrigger, useGSAP)

// 03 — WHY SPONSOR US + WHERE THE MONEY GOES.
// Cost-as-hero stat + investment copy on the left, animated budget telemetry on
// the right, a benefits band, in-kind chips, then the packet/contact CTAs.
export default function WhySponsor() {
  const ref = useRef(null)

  useGSAP(
    () => {
      const bars = gsap.utils.toArray(`.${styles.barFill}`)
      if (!bars.length) return

      if (prefersReducedMotion()) {
        gsap.set(bars, { scaleX: 1 })
        return
      }

      gsap.set(bars, { scaleX: 0, transformOrigin: 'left center' })
      ScrollTrigger.batch(bars, {
        start: 'top 88%',
        once: true,
        onEnter: (batch) =>
          gsap.to(batch, {
            scaleX: 1,
            duration: 1.1,
            ease: 'power3.out',
            stagger: 0.12,
          }),
      })
    },
    { scope: ref }
  )

  const peak = Math.max(...budget.map((b) => b.pct))

  return (
    <Section id="sponsor" className={styles.root}>
      <span className="num-ghost" aria-hidden="true">
        03
      </span>

      <div ref={ref} className={styles.grid}>
        {/* LEFT — cost as hero stat + investment copy */}
        <div className={styles.lede}>
          <Eyebrow num="03">Why sponsor us</Eyebrow>

          <SplitHeading as="h2" className={styles.heading}>
            Competing costs <span className={styles.cost}>{seasonCost}</span> a year.
          </SplitHeading>

          <Reveal as="div" className={styles.copy} y={28}>
            <p className="lead">
              Sponsoring Team 5805 is a direct investment in{' '}
              <strong>local students</strong> learning to design, build, and compete with
              real engineering — and a season of <strong>visible brand exposure</strong> on
              the jerseys, the robot, and the field in front of thousands.
            </p>
            <p className={styles.subcopy}>
              Every dollar is accounted for. Here is exactly where your contribution goes
              across a single competitive season.
            </p>
          </Reveal>
        </div>

        {/* RIGHT — budget telemetry */}
        <div className={styles.telemetry} role="img" aria-label="Where sponsorship dollars go, by share of season budget.">
          <div className={styles.telemetryHead}>
            <span className={styles.telemetryTitle}>Where your money goes</span>
            <span className={styles.telemetryMeta}>Season allocation</span>
          </div>

          <ul className={styles.bars}>
            {budget.map((b) => (
              <li
                key={b.label}
                className={`${styles.barRow}${b.pct === peak ? ' ' + styles.barRowPeak : ''}`}
              >
                <div className={styles.barLabel}>
                  <span className={styles.barName}>{b.label}</span>
                  <span className={styles.barPct}>{b.pct}%</span>
                </div>
                <div className={styles.barTrack}>
                  <span className={styles.barFill} style={{ width: `${b.pct}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* BENEFITS BAND */}
      {/* The stagger belongs on the list, not the band: Reveal cascades its
          DIRECT children, so putting it here would only step the head and the
          list as two blocks and land every benefit in the same frame. */}
      <div className={styles.benefits}>
        <Reveal as="div" className={styles.benefitsHead}>
          <h3 className={styles.benefitsTitle}>What sponsors get</h3>
          <p className={styles.benefitsNote}>
            Every sponsor gets their logo on our team jerseys —{' '}
            <span className={styles.foreshadow}>logo on the robot begins at Platinum.</span>
          </p>
        </Reveal>
        <Reveal as="ul" className={styles.benefitsList} stagger={0.08}>
          {sponsorBenefits.map((b) => (
            <li key={b} className={styles.benefit}>
              <span className={styles.benefitCheck}>
                <Icon name="check" size={16} strokeWidth={2.2} />
              </span>
              <span>{b}</span>
            </li>
          ))}
        </Reveal>
      </div>

      {/* IN-KIND + CTAS */}
      <div className={styles.footer}>
        <Reveal as="div" className={styles.inkind} y={24}>
          <span className={styles.inkindLabel}>
            <Icon name="gift" size={16} /> In-kind donations welcome
          </span>
          <ul className={styles.chips}>
            {inKind.map((k) => (
              <li key={k} className="tag">
                {k}
              </li>
            ))}
          </ul>
        </Reveal>

        <div className={styles.ctas}>
          <MagneticButton
            as="a"
            href={'./' + packetUrl}
            download
            className="btn btn--gold"
          >
            <Icon name="download" size={18} />
            Download the 2026 packet
          </MagneticButton>
          <MagneticButton as="a" href="#partnership" className="btn btn--cyan">
            Become a sponsor
            <Icon name="arrowRight" className="arrow" size={18} />
          </MagneticButton>
        </div>
      </div>
    </Section>
  )
}
