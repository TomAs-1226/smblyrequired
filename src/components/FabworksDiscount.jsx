import { useState } from 'react'
import Section from './Section'
import Eyebrow from './Eyebrow'
import Reveal from './Reveal'
import Icon from './Icon'
import styles from './FabworksDiscount.module.css'

// Our title sponsor's discount, made obvious. Fabworks sponsors Team 5805 and
// gives a 5% code (FRC5805) — this band puts the code on the landing page and
// links to the dedicated, SEO-optimised /fabworks-discount/ page. The code is
// real text (crawlable, selectable) with one-tap copy layered on top.
const CODE = 'FRC5805'

export default function FabworksDiscount() {
  const [copied, setCopied] = useState(false)

  const copy = () => {
    const done = () => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    }
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(CODE).then(done, done)
    else done()
  }

  return (
    <Section id="fabworks-discount">
      <Reveal className={styles.band} y={28}>
        <span className={styles.field} aria-hidden="true" />

        <div className={styles.copyCol}>
          <Eyebrow>Our sponsor · Fabworks</Eyebrow>
          <h2 className={styles.heading}>
            Get <span className={styles.gold}>5% off Fabworks</span> with code{' '}
            <span className={styles.codeInline}>FRC5805</span>
          </h2>
          <p className={styles.body}>
            <strong>Fabworks</strong> — instant-quote, laser-cut &amp; bent sheet-metal parts — proudly
            sponsors Team&nbsp;5805. Use our Fabworks discount code at checkout to take 5% off your
            order.
          </p>
        </div>

        <div className={styles.actionCol}>
          <button type="button" className={styles.codeBtn} onClick={copy} aria-label={`Copy Fabworks discount code ${CODE}`}>
            <span className={styles.codeLabel}>Discount code</span>
            <span className={styles.codeVal}>{CODE}</span>
            <span className={styles.codeHint}>
              <Icon name={copied ? 'check' : 'external'} size={13} />
              {copied ? 'Copied' : 'Tap to copy'}
            </span>
          </button>

          <div className={styles.links}>
            <a
              className={`btn btn--gold ${styles.shop}`}
              href="https://www.fabworks.com/"
              target="_blank"
              rel="noopener"
            >
              Shop Fabworks <Icon name="arrowRight" className="arrow" />
            </a>
            {/* A real (non-hash) URL: the dedicated, indexable discount page. */}
            <a className={styles.more} href="/fabworks-discount/">
              How the code works
              <Icon name="arrowRight" size={14} />
            </a>
          </div>
        </div>
      </Reveal>
    </Section>
  )
}
