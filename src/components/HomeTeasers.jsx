import { useRef } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import Section from './Section'
import Eyebrow from './Eyebrow'
import SplitHeading from './SplitHeading'
import StatNumeral from './StatNumeral'
import Reveal from './Reveal'
import MagneticButton from './MagneticButton'
import Icon from './Icon'
import { pageTeasers } from '../data/navigation'
import { stats } from '../data/team'
import { achievements } from '../data/achievements'
import { prefersReducedMotion } from '../lib/prefersReducedMotion'
import styles from './HomeTeasers.module.css'

gsap.registerPlugin(ScrollTrigger, useGSAP)

// The flagship championship row sources the real record (Ventura 2025 win).
const champ =
  achievements.find((a) => a.year === 2025 && a.kind === 'winner' && a.flagship) ||
  achievements.find((a) => a.kind === 'winner')

// Editorial size map for the explore grid — break the 6-identical-cards trap:
// one wide lead tile, one tall feature, the rest standard.
const teaserSpan = {
  '/team': styles.cardLead, // wide hero tile, top-left
  '/catalyst': styles.cardTall, // tall feature, right rail
}

export default function HomeTeasers() {
  const root = useRef(null)
  const photo = useRef(null)

  useGSAP(
    () => {
      if (prefersReducedMotion()) return
      const img = photo.current
      if (!img) return
      // Slow parallax settle on the championship photo as the band scrolls by.
      gsap.fromTo(
        img,
        { scale: 1.08, yPercent: -4 },
        {
          scale: 1.0,
          yPercent: 4,
          ease: 'none',
          scrollTrigger: {
            trigger: img.parentElement,
            start: 'top bottom',
            end: 'bottom top',
            scrub: true,
          },
        }
      )
    },
    { scope: root }
  )

  return (
    <div ref={root} id="explore" className={styles.wrap}>
      {/* ---------------------------------------------------------------------
          1 — KEY STATS STRIP (sourced: The Blue Alliance)
          --------------------------------------------------------------------- */}
      <Section rule={false} tight>
        <div className={styles.statsHead}>
          <Eyebrow>By the numbers</Eyebrow>
          <p className={styles.statsSource}>
            <span className="data-tag">Source: The Blue Alliance</span>
          </p>
        </div>

        <Reveal className={styles.statStrip} stagger={0.09} y={24}>
          {stats.map((s, i) => (
            <div className={styles.statCell} key={s.label}>
              <StatNumeral
                to={s.to}
                suffix={s.suffix || ''}
                label={s.label}
                gold={i === 0}
              />
            </div>
          ))}
        </Reveal>
      </Section>

      {/* ---------------------------------------------------------------------
          2 — FEATURED CHAMPIONSHIP BAND (Ventura County Regional, 2025)
          --------------------------------------------------------------------- */}
      <Section rule={false} tight>
        <Reveal className={styles.featureWrap} y={36}>
          <article className={`hud-frame ${styles.feature}`}>
            <div className={styles.featureMedia}>
              <img
                ref={photo}
                className={styles.featureImg}
                src="photos/ventura-2025.jpg"
                alt={`Team 5805 with ${champ?.robot || 'Genesis'} after winning the ${champ?.event || 'Ventura County Regional'}`}
                loading="lazy"
                decoding="async"
              />
              <span className={styles.featureScrim} aria-hidden="true" />
            </div>

            <div className={styles.featureBody}>
              <span className={`pill ${styles.featurePill}`}>
                <Icon name="trophy" size={15} />
                Regional Champions
              </span>

              <SplitHeading as="h2" className={styles.featureHeading}>
                {champ?.event || 'Ventura County Regional'} — champions.
              </SplitHeading>

              <p className={styles.featureLede}>
                Our 2025 flagship robot, {champ?.robot || 'Genesis'}, drove 5805 to
                a banner against the best of Southern California — the latest win in
                a record that goes back to our rookie year.
              </p>

              <p className={styles.featureMeta}>
                <span className="data-tag data-tag--gold">
                  REEFSCAPE // VENTURA // 2025
                </span>
              </p>

              <a className={styles.featureLink} href="#/season">
                See our full record
                <Icon name="arrowRight" size={18} className={styles.linkArrow} />
              </a>
            </div>
          </article>
        </Reveal>
      </Section>

      {/* ---------------------------------------------------------------------
          3 — EXPLORE GRID (asymmetric: lead tile + tall feature + standard)
          --------------------------------------------------------------------- */}
      <Section rule={false}>
        <div className={styles.exploreHead}>
          <Eyebrow>Explore the program</Eyebrow>
          <p className="lead">
            Six ways into 5805 — from the students and the robots to the open-source
            tools we build for the whole FIRST community.
          </p>
        </div>

        <Reveal className={styles.grid} stagger={0.08} y={32}>
          {pageTeasers.map((t) => (
            <a
              key={t.path}
              href={'#' + t.path}
              className={`${styles.card} ${teaserSpan[t.path] || ''}`}
            >
              <span className={styles.cardIcon}>
                <Icon name={t.icon} size={24} />
              </span>

              <span className={styles.cardMain}>
                <span className={styles.cardLabel}>{t.label}</span>
                <span className={styles.cardBlurb}>{t.blurb}</span>
              </span>

              <span className={styles.cardGo} aria-hidden="true">
                <Icon name="arrowRight" size={18} />
              </span>
            </a>
          ))}
        </Reveal>
      </Section>

      {/* ---------------------------------------------------------------------
          4 — SPONSOR CTA BAND
          --------------------------------------------------------------------- */}
      <Section rule={false} tight>
        <div className={`blueprint ${styles.cta}`}>
          <span className={styles.ctaField} aria-hidden="true" />
          <div className={styles.ctaInner}>
            <p className={styles.ctaKicker}>
              <span className="data-tag data-tag--gold">PARTNER // 2026</span>
            </p>
            <SplitHeading as="h2" className={styles.ctaHeading}>
              Build the future with us.
            </SplitHeading>
            <p className={styles.ctaLede}>
              Every sponsor puts tools in students&rsquo; hands and sends another
              engineer to college. Partner with 5805, or come see what we build.
            </p>
            <div className={styles.ctaActions}>
              <MagneticButton as="a" href="#/sponsor" className="btn btn--gold">
                Sponsor the team
                <Icon name="arrowRight" size={18} className="arrow" />
              </MagneticButton>
              <a href="#/contact" className="btn btn--ghost">
                Get involved
              </a>
            </div>
          </div>
        </div>
      </Section>
    </div>
  )
}
