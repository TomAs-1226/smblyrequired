import { useRef } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import Section from './Section'
import Eyebrow from './Eyebrow'
import SplitHeading from './SplitHeading'
import Reveal from './Reveal'
import Icon from './Icon'
import MagneticButton from './MagneticButton'
import { catalyst } from '../data/catalyst'
import { prefersReducedMotion } from '../lib/prefersReducedMotion'
import styles from './Catalyst.module.css'

gsap.registerPlugin(ScrollTrigger, useGSAP)

/* Illustrative FRC Catalyst builder snippet — invented but plausible. Tokenized
   into typed spans so the "editor" can syntax-tint without a real highlighter:
   k = keyword (cyan), s = string/number (gold-ish), c = comment (muted),
   f = call/identifier emphasis, p = punctuation/plain. */
const C = {
  k: (t) => ({ t, c: 'k' }),
  s: (t) => ({ t, c: 's' }),
  cm: (t) => ({ t, c: 'c' }),
  f: (t) => ({ t, c: 'f' }),
  p: (t) => ({ t, c: 'p' }),
}
const code = [
  [C.cm('// 150+ lines of motor, PID, sim + feedforward scaffolding —')],
  [C.cm('// rebuilt every season. With Catalyst, it is this:')],
  [],
  [C.k('Elevator'), C.p(' lift = '), C.f('Catalyst'), C.p('.'), C.f('elevator'), C.p('()')],
  [C.p('  .'), C.f('motors'), C.p('('), C.s('20'), C.p(', '), C.s('21'), C.p(') '), C.cm('// CAN IDs, leader + follower')],
  [C.p('  .'), C.f('gearing'), C.p('('), C.s('12.0'), C.p(').'), C.f('drum'), C.p('('), C.s('1.751'), C.p(')')],
  [C.p('  .'), C.f('motionMagic'), C.p('('), C.s('120'), C.p(', '), C.s('200'), C.p(') '), C.cm('// vel, accel')],
  [C.p('  .'), C.f('gravityFF'), C.p('('), C.s('0.34'), C.p(').'), C.f('simulated'), C.p('()')],
  [C.p('  .'), C.f('softLimits'), C.p('('), C.s('0.0'), C.p(', '), C.s('1.65'), C.p(')')],
  [C.p('  .'), C.f('build'), C.p('();')],
]

export default function Catalyst() {
  const panel = useRef(null)

  useGSAP(
    () => {
      if (prefersReducedMotion()) return
      const el = panel.current
      if (!el) return
      // Editor lines type-in line-by-line as the panel scrolls into view.
      const lines = el.querySelectorAll(`.${styles.codeLine}`)
      gsap.from(lines, {
        autoAlpha: 0,
        x: -14,
        duration: 0.5,
        ease: 'power3.out',
        stagger: 0.06,
        scrollTrigger: { trigger: el, start: 'top 80%', once: true },
      })
      // The cursor blink sits on after the last line lands.
      gsap.fromTo(
        el.querySelector(`.${styles.caret}`),
        { autoAlpha: 0 },
        {
          autoAlpha: 1,
          duration: 0.2,
          delay: lines.length * 0.06 + 0.3,
          scrollTrigger: { trigger: el, start: 'top 80%', once: true },
        }
      )
    },
    { scope: panel }
  )

  const { metric, features, stack } = catalyst

  return (
    <Section id="catalyst" className={styles.section}>
      <div className={`blueprint ${styles.field}`} aria-hidden="true" />

      {/* --- Header: eyebrow (no number) + display headline + mono spec + lead --- */}
      <header className={styles.head}>
        <div className={styles.headLede}>
          <Eyebrow>Open source · built by 5805</Eyebrow>
          <SplitHeading as="h2" className={styles.heading}>
            We build tools, not just robots.
          </SplitHeading>
          <Reveal className={styles.headBody} stagger={0.1} y={24}>
            <p className={styles.tagline}>{catalyst.tagline}</p>
            <p className="lead">{catalyst.description}</p>
          </Reveal>
        </div>

        <Reveal className={styles.headMeta} y={20}>
          <span className={styles.repoName}>
            <Icon name="code" size={18} className={styles.repoIcon} />
            {catalyst.name}
          </span>
          <span className="data-tag">JAVA // PHOENIX 6 // WPILIB 2026</span>
          <span className={`data-tag data-tag--gold ${styles.licenseTag}`}>
            MIT // STUDENT IP · TEAM-OWNED
          </span>
        </Reveal>
      </header>

      {/* --- Signature: editor panel (left, wide) + reduction metric (right) --- */}
      <div className={styles.signature}>
        <div className={`hud-frame ${styles.editor}`} ref={panel}>
          <div className={styles.editorBar}>
            <span className={styles.dots} aria-hidden="true">
              <i /><i /><i />
            </span>
            <span className={styles.editorFile}>Elevator.java</span>
            <span className={styles.editorBadge}>FRC CATALYST</span>
          </div>
          <pre className={styles.code} aria-label="Example FRC Catalyst elevator builder">
            <code>
              {code.map((line, i) => (
                <span className={styles.codeLine} key={i}>
                  <span className={styles.gutter} aria-hidden="true">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span className={styles.codeText}>
                    {line.length === 0 ? (
                      ' '
                    ) : (
                      line.map((tok, j) => (
                        <span className={styles[`tok_${tok.c}`]} key={j}>
                          {tok.t}
                        </span>
                      ))
                    )}
                  </span>
                </span>
              ))}
              <span className={styles.caret} aria-hidden="true" />
            </code>
          </pre>
        </div>

        <Reveal className={styles.metric} y={28}>
          <span className={styles.metricLabel}>{metric.label}</span>
          <span className={styles.metricRow}>
            <span className={styles.metricFrom}>{metric.from}</span>
            <Icon name="arrowRight" size={34} className={styles.metricArrow} />
            <span className={styles.metricTo}>{metric.to}</span>
          </span>
          <span className={styles.metricNote}>
            Same elevator. One fluent builder, fully simulated and tuned.
          </span>
          <span className={styles.metricSpark} aria-hidden="true" />
        </Reveal>
      </div>

      {/* --- Features: non-uniform 4-up (1 lead / 3 stacked rail) --- */}
      <div className={styles.features}>
        <p className={styles.featuresLabel}>
          <span className={styles.featuresRule} aria-hidden="true" />
          <span>What ships in the box</span>
        </p>
        <Reveal className={styles.featureGrid} stagger={0.1} y={32}>
          {features.map((f, i) => (
            <article
              className={`${styles.feature} ${i === 0 ? styles.featureLead : ''}`}
              key={f.title}
            >
              <span className={styles.featureIcon}>
                <Icon name={f.icon} size={i === 0 ? 30 : 22} />
              </span>
              <span className={styles.featureNum} aria-hidden="true">
                {String(i + 1).padStart(2, '0')}
              </span>
              <h3 className={styles.featureTitle}>{f.title}</h3>
              <p className={styles.featureBody}>{f.body}</p>
            </article>
          ))}
        </Reveal>
      </div>

      {/* --- Stack chips + CTAs + community credit --- */}
      <div className={styles.foot}>
        <div className={styles.stack}>
          <span className={styles.stackLabel}>Built on</span>
          <ul className={styles.stackList}>
            {stack.map((s) => (
              <li className={`data-tag ${styles.stackChip}`} key={s}>
                {s}
              </li>
            ))}
          </ul>
        </div>

        <div className={styles.ctas}>
          <MagneticButton
            as="a"
            href={catalyst.docsUrl}
            className="btn btn--cyan"
            target="_blank"
            rel="noreferrer"
          >
            Read the docs
            <Icon name="arrowRight" className="arrow" />
          </MagneticButton>
          <MagneticButton
            as="a"
            href={catalyst.repoUrl}
            className="btn btn--ghost"
            target="_blank"
            rel="noreferrer"
          >
            View on GitHub
            <Icon name="external" size={18} />
          </MagneticButton>
        </div>

        <p className={styles.credit}>
          <Icon name="heart" size={16} className={styles.creditIcon} />
          Released free and open-source — our contribution back to the FRC
          community, so any team can build faster.
        </p>
      </div>
    </Section>
  )
}
