import { useState, useId } from 'react'
import Section from './Section'
import Eyebrow from './Eyebrow'
import SplitHeading from './SplitHeading'
import Icon from './Icon'
import { faqs, faqNote } from '../data/faq'
import styles from './Faq.module.css'

// Accordion row. The answer lives in a CSS grid-rows track that animates from
// 0fr → 1fr; the inner wrapper clips overflow so height/opacity ease smoothly.
// Motion is disabled via the reduced-motion media query in the stylesheet.
function FaqItem({ item, index, open, onToggle, baseId }) {
  const btnId = `${baseId}-q-${index}`
  const panelId = `${baseId}-a-${index}`

  return (
    <div className={`${styles.item} ${open ? styles.itemOpen : ''}`}>
      <h3 className={styles.qHeading}>
        <button
          type="button"
          id={btnId}
          className={styles.trigger}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
        >
          <span className={styles.qIndex} aria-hidden="true">
            {String(index + 1).padStart(2, '0')}
          </span>
          <span className={styles.qText}>{item.q}</span>
          <span className={`${styles.qTag} tag`}>{item.tag}</span>
          <span className={styles.chev} aria-hidden="true">
            <Icon name="arrowUp" size={18} />
          </span>
        </button>
      </h3>

      <div
        id={panelId}
        role="region"
        aria-labelledby={btnId}
        className={styles.panel}
        hidden={!open}
      >
        <div className={styles.panelInner}>
          <p className={styles.answer}>{item.a}</p>
        </div>
      </div>
    </div>
  )
}

export default function Faq() {
  const [openIdx, setOpenIdx] = useState(0) // first item starts open
  const baseId = useId()

  const toggle = (i) => setOpenIdx((cur) => (cur === i ? -1 : i))

  return (
    <Section id="faq">
      <div className={styles.layout}>
        {/* Left rail: editorial spine — sticky on wide viewports */}
        <header className={styles.aside}>
          <Eyebrow>FAQ</Eyebrow>
          <SplitHeading as="h2" className={styles.heading}>
            Questions, answered.
          </SplitHeading>
          <p className={`lead ${styles.note}`}>{faqNote}</p>
          <p className={styles.count} aria-hidden="true">
            <span className={styles.countTick} />
            {String(faqs.length).padStart(2, '0')} entries
          </p>
        </header>

        {/* Right: accordion column (7-col) */}
        <div className={styles.list}>
          {faqs.map((item, i) => (
            <FaqItem
              key={item.q}
              item={item}
              index={i}
              open={openIdx === i}
              onToggle={() => toggle(i)}
              baseId={baseId}
            />
          ))}
        </div>
      </div>
    </Section>
  )
}
