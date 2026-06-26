import Section from './Section'
import Eyebrow from './Eyebrow'
import SplitHeading from './SplitHeading'
import Reveal from './Reveal'
import Icon from './Icon'
import { resources, resourcesNote, openAllianceNote } from '../data/resources'
import styles from './Resources.module.css'

export default function Resources() {
  return (
    <Section id="resources">
      <div className={styles.head}>
        <Eyebrow>Open source &amp; resources</Eyebrow>
        <SplitHeading as="h2" className={styles.heading}>
          Built in the open.
        </SplitHeading>
        <Reveal className={styles.leadWrap} y={24}>
          <p className="lead">{resourcesNote}</p>
        </Reveal>
      </div>

      <Reveal className={styles.grid} stagger={0.08} y={28}>
        {resources.map((r) => {
          const isExternal = r.external === true
          const linkProps = isExternal
            ? { target: '_blank', rel: 'noreferrer' }
            : {}
          return (
            <a
              key={r.title}
              className={styles.card}
              href={r.href}
              {...linkProps}
            >
              <span className={styles.cardIcon} aria-hidden="true">
                <Icon name={r.icon} size={24} />
              </span>
              <h3 className={styles.cardTitle}>{r.title}</h3>
              <p className={styles.cardDesc}>{r.desc}</p>
              <span className={styles.cardCta}>
                {r.cta}
                <Icon
                  name={isExternal ? 'external' : 'arrowRight'}
                  size={16}
                  className="arrow"
                />
                {isExternal && (
                  <span className="sr-only"> (opens in a new tab)</span>
                )}
              </span>
            </a>
          )
        })}
      </Reveal>

      <Reveal className={styles.noteWrap} y={24}>
        <aside className={styles.note}>
          <span className={styles.noteIcon} aria-hidden="true">
            <Icon name="spark" size={22} />
          </span>
          <p className={styles.noteText}>
            <span className={styles.noteLabel}>Open Alliance</span>
            {openAllianceNote}
          </p>
        </aside>
      </Reveal>
    </Section>
  )
}
