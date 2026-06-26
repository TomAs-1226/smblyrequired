import { useRef } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { team } from '../data/team'
import { prefersReducedMotion } from '../lib/prefersReducedMotion'
import SplitHeading from './SplitHeading'
import Eyebrow from './Eyebrow'
import MagneticButton from './MagneticButton'
import Reveal from './Reveal'
import Icon from './Icon'
import styles from './Hero.module.css'

gsap.registerPlugin(ScrollTrigger, useGSAP)

// HERO — full-viewport first paint. Canonical style reference for the site.
// Left-anchored copy over an off-axis full-bleed robot photo with a cool navy
// scrim. Headline reveal is handled by SplitHeading; the image gets a light
// parallax on scroll; CTAs + proof fade up after the headline lands.
export default function Hero() {
  const root = useRef(null)
  const image = useRef(null)

  useGSAP(
    () => {
      if (prefersReducedMotion()) return

      // Parallax: drift the robot image as the hero scrolls out of view.
      gsap.to(image.current, {
        yPercent: -10,
        ease: 'none',
        scrollTrigger: {
          trigger: root.current,
          start: 'top top',
          end: 'bottom top',
          scrub: true,
        },
      })

      // Gentle drift on the floating game-piece accents.
      gsap.utils.toArray(`.${styles.ball}`).forEach((ball, i) => {
        gsap.to(ball, {
          yPercent: i % 2 === 0 ? -22 : 18,
          xPercent: i % 2 === 0 ? 10 : -8,
          duration: 6 + i * 1.5,
          ease: 'sine.inOut',
          repeat: -1,
          yoyo: true,
        })
      })
    },
    { scope: root }
  )

  return (
    <section id="top" className={styles.hero} ref={root}>
      {/* Full-bleed imagery, off-axis to the right, behind the copy */}
      <div className={styles.media} aria-hidden="true">
        <img
          ref={image}
          className={styles.image}
          src="photos/hero.jpg"
          alt=""
          fetchpriority="high"
        />
        <div className={styles.scrim} />
        <div className={styles.vignette} />
        {/* Subtle drifting game-piece accents */}
        <span className={`${styles.ball} ${styles.ball1}`} />
        <span className={`${styles.ball} ${styles.ball2}`} />
        <span className={`${styles.ball} ${styles.ball3}`} />
      </div>

      <div className={`container ${styles.inner}`}>
        <Eyebrow num="00">{team.shortName} · {team.program}</Eyebrow>

        <SplitHeading as="h1" className={styles.headline}>
          Built to compete.
          <br />
          Built to <span className={styles.accent}>last</span>.
        </SplitHeading>

        <Reveal className={styles.copy} stagger={0.1} delay={0.15} y={28}>
          <p className={`lead ${styles.lead}`}>{team.lead}</p>

          <div className={styles.ctas}>
            <MagneticButton as="a" href="#/sponsor" className="btn btn--gold">
              Sponsor the team
              <Icon name="arrowRight" className="arrow" size={18} />
            </MagneticButton>
            <a href="#/season" className="btn btn--cyan">
              Our record
            </a>
            <a href="#/team" className="btn btn--ghost">
              Join the team
            </a>
          </div>

          <p className={styles.proof}>
            <span className={styles.dot} aria-hidden="true" />
            2025 Ventura County Regional champions
            <span className={styles.sep} aria-hidden="true">·</span>
            Competing since {team.founded}
          </p>
        </Reveal>
      </div>

      <a className={styles.scrollCue} href="#explore" aria-label="Scroll to content">
        <span>Scroll</span>
        <Icon name="arrowUp" size={18} className={styles.scrollChevron} />
      </a>
    </section>
  )
}
