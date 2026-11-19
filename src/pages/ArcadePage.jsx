import Section from '../components/Section'
import Eyebrow from '../components/Eyebrow'
import Arcade3D from '../components/Arcade3D'
import { arcade } from '../data/arcade'
import styles from './ArcadePage.module.css'

// Cycle Rush: a 3D robot match with real physics, in the browser, no download.
export default function ArcadePage() {
  return (
    <Section>
      <header className={styles.head}>
        <Eyebrow>{arcade.eyebrow}</Eyebrow>
        <h1 className={styles.title}>{arcade.title}</h1>
        <p className="lead">{arcade.lead}</p>
      </header>

      <Arcade3D />

      <div className={styles.info}>
        <div>
          <h2 className={styles.h2}>How it scores</h2>
          <dl className={styles.list}>
            {arcade.rules.map((r) => (
              <div key={r.label} className={styles.item}>
                <dt>{r.label}</dt>
                <dd>{r.text}</dd>
              </div>
            ))}
          </dl>
          <p className={styles.note}>{arcade.aiming}</p>
        </div>
        <div>
          <h2 className={styles.h2}>Controls</h2>
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
        </div>
      </div>
    </Section>
  )
}
