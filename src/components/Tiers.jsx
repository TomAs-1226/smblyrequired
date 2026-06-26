import { useRef } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import Section from './Section'
import Eyebrow from './Eyebrow'
import SplitHeading from './SplitHeading'
import Reveal from './Reveal'
import Marquee from './Marquee'
import Icon from './Icon'
import { prefersReducedMotion } from '../lib/prefersReducedMotion'
import {
  tiers,
  tierNote,
  currentSponsors,
  sponsorSteps,
  taxNote,
} from '../data/sponsors'
import styles from './Tiers.module.css'

gsap.registerPlugin(ScrollTrigger, useGSAP)

const usd = (n) => `$${n.toLocaleString('en-US')}`

// Logo-wall ranking: title sponsors lead (largest), then major, then families.
const titleCos = currentSponsors.filter((s) => s.level === 'title')
const majorCos = currentSponsors.filter((s) => s.level === 'major')
const families = currentSponsors.filter((s) => s.level === 'family')

export default function Tiers() {
  const root = useRef(null)

  // Tier cards rise & brighten in sequence on scroll-in (layered over real DOM).
  useGSAP(
    () => {
      if (prefersReducedMotion()) return
      const cards = root.current.querySelectorAll(`.${styles.card}`)
      if (!cards.length) return
      gsap.from(cards, {
        autoAlpha: 0,
        y: 34,
        duration: 0.7,
        ease: 'expo.out',
        stagger: 0.07,
        scrollTrigger: { trigger: `.${styles.rail}`, start: 'top 82%', once: true },
      })
    },
    { scope: root }
  )

  return (
    <Section id="partnership" className={styles.root}>
      <div ref={root}>
      <header className={styles.head}>
        <div>
          <Eyebrow num="04">Partnership</Eyebrow>
          <SplitHeading as="h2" className={styles.title}>
            Choose your level.
          </SplitHeading>
        </div>
        <p className={`lead ${styles.intro}`}>
          Five ways to back the team — each builds on the one below it. Pick a
          level, and your brand goes <strong>onto the field</strong> with us.
        </p>
      </header>

      {/* Prominent gold-accented placement note */}
      <Reveal className={styles.note} as="aside" y={24}>
        <span className={styles.noteIcon} aria-hidden="true">
          <Icon name="star" size={20} />
        </span>
        <p>{tierNote}</p>
      </Reveal>

      {/* Five tiers — graduated emphasis ascending; horizontal rail on mobile */}
      <div className={styles.railWrap}>
        <ul className={styles.rail} aria-label="Sponsorship tiers">
          {tiers.map((tier, i) => {
            const featured = tier.key === 'title'
            const raised = tier.key === 'platinum' || tier.key === 'title'
            return (
              <li
                key={tier.key}
                className={[
                  styles.card,
                  raised && styles.cardRaised,
                  featured && styles.cardFeatured,
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={{
                  '--tier': `var(--tier-${tier.key})`,
                  '--step': i,
                }}
              >
                <span className={styles.cardRule} aria-hidden="true" />
                {featured && <span className={styles.flag}>Presenting</span>}
                <p className={styles.tierName}>{tier.name}</p>
                <p className={styles.amount}>
                  {usd(tier.amount)}
                  <span className={styles.plus}>+</span>
                </p>
                <ul className={styles.perks}>
                  {tier.perks.map((perk, j) => (
                    <li
                      key={j}
                      className={perk.strong ? styles.perkStrong : undefined}
                    >
                      <Icon name="check" size={16} className={styles.check} />
                      <span>{perk.text}</span>
                    </li>
                  ))}
                </ul>
              </li>
            )
          })}
        </ul>
      </div>
      <p className={styles.railHint} aria-hidden="true">
        Swipe tiers <Icon name="arrowRight" size={14} />
      </p>

      {/* Logo wall */}
      <div className={styles.wall}>
        <div className={styles.wallHead}>
          <h3 className={styles.wallTitle}>Proudly supported by</h3>
          <p className={styles.wallSub}>
            The partners already putting Team 5805 on the field.
          </p>
        </div>

        {/* Title sponsors lead — full-width feature plates */}
        <Reveal className={styles.platesTitle} stagger={0.06}>
          {titleCos.map((s) => (
            <div
              key={s.name}
              className={`${styles.plate} ${styles.plateTitle} hud-frame`}
            >
              <span className={styles.plateFlag}>Title Sponsor</span>
              <span className={styles.plateName}>{s.name}</span>
            </div>
          ))}
        </Reveal>

        {/* Major partners, then families — graduated down in scale */}
        <Reveal className={styles.plates} stagger={0.05}>
          {majorCos.map((s) => (
            <div key={s.name} className={`${styles.plate} ${styles.plateCo}`}>
              <span className={styles.plateName}>{s.name}</span>
              <span className={styles.plateType}>Major Partner</span>
            </div>
          ))}
          {families.map((s) => (
            <div key={s.name} className={`${styles.plate} ${styles.plateFam}`}>
              <span className={styles.plateName}>{s.name}</span>
              <span className={styles.plateType}>Supporter</span>
            </div>
          ))}
        </Reveal>
      </div>

      <Marquee
        className={styles.marquee}
        items={['Our partners', ...currentSponsors.map((s) => s.name)]}
      />

      {/* How to sponsor */}
      <div className={styles.steps}>
        <h3 className={styles.stepsTitle}>How to sponsor</h3>
        <Reveal className={styles.stepGrid} stagger={0.08}>
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

      <p className={styles.tax}>{taxNote}</p>
      </div>
    </Section>
  )
}
