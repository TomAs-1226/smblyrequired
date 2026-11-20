import Section from '../components/Section'
import Eyebrow from '../components/Eyebrow'
import Arcade3D from '../components/Arcade3D'
import ArcadeGate from '../components/ArcadeGate'
import { arcade } from '../data/arcade'
import styles from './ArcadePage.module.css'

// Cycle Rush: a 3D robot match with real physics, in the browser, no download.
// The game fills the screen under the nav; what it is and how to play follow below.
export default function ArcadePage() {
  return (
    <>
      <h1 className="sr-only">{arcade.title}</h1>
      <ArcadeGate>
        <Arcade3D />
      </ArcadeGate>
      <Section>
      <header className={styles.head}>
        <div className={styles.intro}>
          <Eyebrow>{arcade.eyebrow}</Eyebrow>
          <h2 className={styles.title}>{arcade.title}</h2>
          <p className="lead">{arcade.lead}</p>
        </div>
        <dl className={styles.facts}>
          {arcade.facts.map((f) => (
            <div key={f.label} className={styles.fact}>
              <dt className={styles.factValue}>{f.value}</dt>
              <dd className={styles.factLabel}>{f.label}</dd>
            </div>
          ))}
        </dl>
      </header>

      <div className={styles.cards}>
        <section className={styles.card} aria-labelledby="arcade-rules">
          <h2 id="arcade-rules" className={styles.h2}>How it scores</h2>
          <dl className={styles.list}>
            {arcade.rules.map((r) => (
              <div key={r.label} className={styles.item}>
                <dt>{r.label}</dt>
                <dd>{r.text}</dd>
              </div>
            ))}
          </dl>
          <p className={styles.note}>{arcade.aiming}</p>
        </section>

        <section className={styles.card} aria-labelledby="arcade-controls">
          <h2 id="arcade-controls" className={styles.h2}>Controls</h2>
          <dl className={styles.list}>
            {arcade.controls.keyboard.map(([k, v]) => (
              <div key={k} className={styles.item}>
                <dt><kbd className={styles.kbd}>{k}</kbd></dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          <h3 className={styles.h3}>On a phone or tablet</h3>
          <dl className={styles.list}>
            {arcade.controls.touch.map(([k, v]) => (
              <div key={k} className={styles.item}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className={styles.card} aria-labelledby="arcade-problems">
          <h2 id="arcade-problems" className={styles.h2}>{arcade.problems.title}</h2>
          <p className={styles.cardIntro}>{arcade.problems.intro}</p>
          <dl className={styles.list}>
            {arcade.problems.items.map(([k, v]) => (
              <div key={k} className={styles.item}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>

      <p className={styles.credits}>{arcade.credits}</p>
      </Section>
    </>
  )
}
