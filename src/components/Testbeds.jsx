import Section from './Section'
import Eyebrow from './Eyebrow'
import Reveal from './Reveal'
import Icon from './Icon'
import RobotViewer from './RobotViewer'
import { testbeds } from '../data/robots'
import styles from './Testbeds.module.css'

// The robots that are not competition robots: today, Catalyst X1. Drawn the way Catalyst Console
// draws it — from the dimensions it publishes — with its modules steering through a bench test.
export default function Testbeds() {
  return (
    <Section id="bench" className={styles.section}>
      {testbeds.map((t) => (
        <article className={styles.bench} key={t.name}>
          <Reveal className={styles.copy}>
            <Eyebrow>{t.kicker}</Eyebrow>
            <h2 className={styles.name}>{t.name}</h2>
            <p className={styles.subtitle}>{t.subtitle}</p>
            <p className={styles.blurb}>{t.blurb}</p>
            <dl className={styles.specs}>
              {t.specs.map((s) => (
                <div key={s.label}>
                  <dt>{s.label}</dt>
                  <dd>{s.value}</dd>
                </div>
              ))}
            </dl>
            {t.link && (
              <a className={styles.cta} href={t.link.href}>
                <span>{t.link.label}</span>
                <span className={styles.ctaIcon} aria-hidden="true">
                  <Icon name="arrowRight" size={16} />
                </span>
              </a>
            )}
          </Reveal>
          <div className={styles.device}>
            <div className={styles.core}>
              <span className={styles.floor} aria-hidden="true" />
              <RobotViewer
                model={t.model}
                az={0.95}
                label={`${t.name}, our swerve test drivebase, its modules steering through a bench test. Drag to turn it.`}
              />
            </div>
          </div>
        </article>
      ))}
    </Section>
  )
}
