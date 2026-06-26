import Section from './Section'
import Eyebrow from './Eyebrow'
import SplitHeading from './SplitHeading'
import MagneticButton from './MagneticButton'
import Reveal from './Reveal'
import Icon from './Icon'
import { subteams, subteamsNote } from '../data/subteams'
import styles from './Subteams.module.css'

export default function Subteams() {
  return (
    <Section id="subteams">
      {/* Asymmetric: sticky intro spine (left) + crafted subteam grid (right) */}
      <div className={styles.layout}>
        <div className={styles.intro}>
          <Eyebrow>Join the team</Eyebrow>
          <SplitHeading as="h2" className={styles.heading}>
            Find your lane.
          </SplitHeading>
          <p className="lead">{subteamsNote}</p>

          <MagneticButton
            as="a"
            href="#/contact"
            className={`btn btn--cyan ${styles.cta}`}
          >
            Get involved <Icon name="arrowRight" className="arrow" />
          </MagneticButton>
        </div>

        <Reveal className={styles.grid} stagger={0.08} y={32}>
          {subteams.map((s, i) => (
            <article className={styles.tile} key={s.name}>
              <span className={styles.index} aria-hidden="true">
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className={styles.tileIcon}>
                <Icon name={s.icon} size={26} />
              </span>
              <h3 className={styles.tileName}>{s.name}</h3>
              <p className={styles.tileBody}>{s.body}</p>
            </article>
          ))}
        </Reveal>
      </div>
    </Section>
  )
}
