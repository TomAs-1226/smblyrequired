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
// Left-anchored copy over an off-axis full-bleed robot photo. The robot doesn't
// sit on a flat block: a multi-stop cool-navy scrim grades the left text zone to
// deep void while the robot emerges from it, lit by a soft spotlight and grounded
// by a floor gradient + vignette + atmosphere grain. SplitHeading reveals the
// headline; the image gets a gentle scrub parallax + scale; CTAs + proof fade up.
export default function Hero() {
  const root = useRef(null)
  const image = useRef(null)

  useGSAP(
    () => {
      if (prefersReducedMotion()) return

      // A soft entrance for the whole media stage so the robot resolves in
      // rather than popping — scale + fade, expo-eased, transforms only.
      gsap.from(image.current, {
        scale: 1.08,
        autoAlpha: 0,
        duration: 1.6,
        ease: 'expo.out',
      })

      // Scrub parallax: drift + a touch of scale as the hero scrolls out, so the
      // robot reads as a deeper plane behind the type. Gentle, linear, no jank.
      gsap.fromTo(
        image.current,
        { yPercent: 0, scale: 1.02 },
        {
          yPercent: -8,
          scale: 1.08,
          ease: 'none',
          scrollTrigger: {
            trigger: root.current,
            start: 'top top',
            end: 'bottom top',
            scrub: 1,
          },
        }
      )

      // Game-piece accents: each drifts on its own organic path with independent
      // x/y/rotation timings (different periods → no visible loop sync).
      gsap.utils.toArray(`.${styles.ball}`).forEach((ball, i) => {
        const dir = i % 2 === 0 ? 1 : -1
        gsap.to(ball, {
          yPercent: -28 * dir - 6 * i,
          duration: 7 + i * 1.7,
          ease: 'sine.inOut',
          repeat: -1,
          yoyo: true,
        })
        gsap.to(ball, {
          xPercent: 14 * dir,
          duration: 9 + i * 1.3,
          ease: 'sine.inOut',
          repeat: -1,
          yoyo: true,
          delay: 0.4 * i,
        })
        gsap.to(ball, {
          rotation: 18 * dir,
          duration: 11 + i * 2,
          ease: 'sine.inOut',
          repeat: -1,
          yoyo: true,
        })
      })

      // Polished scroll cue: the chevron breathes via GSAP (smoother than the CSS
      // keyframe) and the whole cue lifts in once the hero has settled.
      gsap.from(`.${styles.scrollCue}`, {
        autoAlpha: 0,
        y: 14,
        duration: 0.9,
        delay: 0.9,
        ease: 'power3.out',
      })
      gsap.to(`.${styles.scrollChevron}`, {
        y: 5,
        duration: 1.2,
        ease: 'sine.inOut',
        repeat: -1,
        yoyo: true,
      })
    },
    { scope: root }
  )

  return (
    <section id="top" className={styles.hero} ref={root}>
      {/* Full-bleed imagery, off-axis to the right, behind the copy. The stack is
          layered: photo → cool-navy grade → directional scrim → spotlight glow →
          vignette → atmosphere grain, so the robot is composed into the scene. */}
      <div className={styles.media} aria-hidden="true">
        <div className={styles.imageWrap}>
          <img
            ref={image}
            className={styles.image}
            src="photos/hero.jpg"
            alt=""
            fetchpriority="high"
            decoding="async"
          />
          {/* Cool-navy colour grade locked to the photo so the snapshot matches
              the palette and its hard right edge dissolves into the void. */}
          <div className={styles.grade} />
        </div>

        {/* Soft spotlight: brighter behind the robot, falling off toward the type. */}
        <div className={styles.spotlight} />
        {/* Directional scrim: deep void at the text zone → clear over the robot. */}
        <div className={styles.scrim} />
        {/* Cinematic vignette + grounding floor. */}
        <div className={styles.vignette} />
        {/* Faint film grain for atmosphere (very low opacity). */}
        <div className={styles.grain} />

        {/* Subtle drifting game-piece accents */}
        <span className={`${styles.ball} ${styles.ball1}`} />
        <span className={`${styles.ball} ${styles.ball2}`} />
        <span className={`${styles.ball} ${styles.ball3}`} />
      </div>

      <div className={`container ${styles.inner}`}>
        <Eyebrow num="00">{team.shortName} · {team.program}</Eyebrow>

        <SplitHeading
          as="h1"
          className={styles.headline}
          start="top 95%"
          stagger={0.12}
          duration={1.05}
        >
          Built to compete.
          <br />
          Built to <span className={styles.accent}>last</span>.
        </SplitHeading>

        <Reveal className={styles.copy} stagger={0.1} delay={0.4} y={26}>
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
