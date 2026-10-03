import { useState } from 'react'
import Reveal from './Reveal'
import { AutonomyDemo, StatesDemo } from './CatalystDemos'
import {
  catalyst, catalystLines, catalystPillars, catalystExample, catalystConsole, catalystApp, catalystTools,
} from '../data/catalyst'
import styles from './Catalyst.module.css'

// The Catalyst page: what the library is, the two lines a team can install today, what 2.0 adds (by
// the names the code uses), and the tools around it. Every claim comes from src/data/catalyst.js,
// which says where each one was checked.

/* A small Java tint — enough to read the README's example, not a highlighter. */
const TOKENS = /(\/\/[^\n]*)|("(?:[^"\\]|\\.)*")|(\b\d+(?:\.\d+)?\b)|(\b(?:new|true|false|null)\b)|(\b[A-Z][A-Za-z0-9_]*\b)|(\.[a-z][A-Za-z0-9_]*(?=\())/g
function Java({ code }) {
  const out = []
  let last = 0
  for (const m of code.matchAll(TOKENS)) {
    if (m.index > last) out.push(code.slice(last, m.index))
    const cls = m[1] ? styles.tComment : m[2] ? styles.tString : m[3] ? styles.tNumber : m[4] ? styles.tKeyword : m[5] ? styles.tType : styles.tCall
    out.push(<span key={m.index} className={cls}>{m[0]}</span>)
    last = m.index + m[0].length
  }
  out.push(code.slice(last))
  return out
}

function Arrow() {
  return <i className={styles.btnIcon} aria-hidden="true">↗</i>
}

function CopyField({ value, label }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* No clipboard (insecure context): the URL is selectable text anyway. */
    }
  }
  return (
    <div className={styles.copy}>
      <code className={styles.copyValue} aria-label={label}>{value}</code>
      <button type="button" className={styles.copyBtn} onClick={copy} data-copied={copied || undefined}>
        <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
      </button>
    </div>
  )
}

function ConsoleShowcase() {
  const [shot, setShot] = useState(0)
  const c = catalystConsole
  return (
    <section className={styles.block} aria-labelledby="cat-console">
      <div className={styles.blockHead}>
        <p className={styles.kicker}>Catalyst Console {c.version} · {c.platforms}</p>
        <h2 id="cat-console" className={styles.h2}>The dashboard our drivers watch.</h2>
        <p className={styles.lede}>{c.lede}</p>
      </div>

      <div className={styles.device}>
        <div className={styles.deviceCore}>
          {c.shots.map((s, i) => (
            <img
              key={s.src}
              src={s.src}
              alt={s.alt}
              className={styles.shot}
              data-on={i === shot || undefined}
              loading="lazy"
              width="1600"
              height="1000"
            />
          ))}
        </div>
      </div>

      <div className={styles.consoleBar}>
        <div className={styles.switch} role="tablist" aria-label="Console views">
          {c.shots.map((s, i) => (
            <button
              key={s.src}
              type="button"
              role="tab"
              aria-selected={i === shot}
              className={styles.switchBtn}
              onClick={() => setShot(i)}
            >
              {i === 0 ? 'Park' : 'Drive'}
            </button>
          ))}
        </div>
        <p className={styles.shotCaption}>{c.shots[shot].caption}</p>
      </div>

      <div className={styles.consoleFoot}>
        <ul className={styles.ticks}>
          {c.features.map((f) => <li key={f}>{f}</li>)}
        </ul>
        <div className={styles.consoleCta}>
          <a className={styles.btn} href={c.url} target="_blank" rel="noreferrer noopener">
            Download Console <Arrow />
          </a>
          <p className={styles.fine}>{c.note}</p>
        </div>
      </div>
    </section>
  )
}

export default function Catalyst() {
  return (
    <div className={styles.page}>
      {/* ── the library ─────────────────────────────────────────────── */}
      <header className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.kicker}>
            <b>Open source</b> · {catalyst.license} licence
          </p>
          <h1 className={styles.h1}>{catalyst.name}</h1>
          <p className={styles.tagline}>{catalyst.tagline}</p>
          <p className={styles.lede}>{catalyst.description}</p>
          <div className={styles.row}>
            <a className={styles.btn} href={catalyst.docsUrl} target="_blank" rel="noreferrer noopener">
              Read the docs <Arrow />
            </a>
            <a className={`${styles.btn} ${styles.quiet}`} href={catalyst.repoUrl} target="_blank" rel="noreferrer noopener">
              GitHub
            </a>
          </div>
        </div>
        <figure className={styles.code}>
          <div className={styles.codeCore}>
            <div className={styles.codeTop} aria-hidden="true">
              <span /><span /><span />
              <em>Elevator.java</em>
            </div>
            <pre className={styles.pre}><code><Java code={catalystExample.code} /></code></pre>
          </div>
          <figcaption className={styles.fine}>{catalystExample.caption}</figcaption>
        </figure>
      </header>

      {/* ── the two lines ───────────────────────────────────────────── */}
      <section className={styles.block} aria-labelledby="cat-lines">
        <div className={styles.blockHead}>
          <p className={styles.kicker}>Install</p>
          <h2 id="cat-lines" className={styles.h2}>Two lines, one library.</h2>
          <p className={styles.lede}>
            Paste a URL into WPILib’s <em>Manage Vendor Libraries → Install new libraries (online)</em>.{' '}
            <a className={styles.inline} href={catalyst.versionsUrl} target="_blank" rel="noreferrer noopener">Which one?</a>
          </p>
        </div>
        <Reveal className={styles.lines} stagger={0.08} y={24}>
          {catalystLines.map((l) => (
            <article key={l.id} className={styles.card} data-line={l.id}>
              <div className={styles.cardCore}>
                <div className={styles.lineTop}>
                  <span className={styles.pill}>{l.label}</span>
                  <span className={styles.version}>{l.version}</span>
                </div>
                <h3 className={styles.h3}>{l.title}</h3>
                <ul className={styles.chips}>
                  {l.platform.map((p) => <li key={p}>{p}</li>)}
                </ul>
                <p className={styles.note}>{l.note}</p>
                <CopyField value={l.vendordep} label={`Vendordep URL for ${l.version}`} />
                <a className={styles.inline} href={l.docs} target="_blank" rel="noreferrer noopener">
                  {l.id === 'beta' ? 'Beta docs' : 'Docs'} ↗
                </a>
              </div>
            </article>
          ))}
        </Reveal>
      </section>

      {/* ── what 2.0 adds, the headline two live on the robot ───────── */}
      <AutonomyDemo />
      <StatesDemo />

      <section className={styles.block} aria-labelledby="cat-pillars">
        <div className={styles.blockHead}>
          <p className={styles.kicker}>Catalyst 2.0</p>
          <h2 id="cat-pillars" className={styles.h2}>A library for the whole robot.</h2>
          <p className={styles.lede}>
            2.0 is our second revision, built for FIRST’s new control system. It started as a box of
            mechanisms; it now runs the robot end to end.
          </p>
        </div>
        <Reveal className={styles.pillars} stagger={0.05} y={20}>
          {catalystPillars.map((p) => (
            <article key={p.title} className={styles.pillar}>
              <h3 className={styles.h3}>{p.title}</h3>
              <p className={styles.note}>{p.body}</p>
              <ul className={styles.names}>
                {p.names.map((n) => <li key={n}>{n}</li>)}
              </ul>
            </article>
          ))}
        </Reveal>
      </section>

      {/* ── the tools around it ─────────────────────────────────────── */}
      <ConsoleShowcase />

      <section className={styles.block} aria-label="More Catalyst tools">
        <Reveal className={styles.pair} stagger={0.08} y={24}>
          {[catalystApp, catalystTools].map((t) => (
            <article key={t.name} className={styles.card}>
              <div className={styles.cardCore}>
                <p className={styles.kicker}>{t.name}{t.version ? ` ${t.version}` : ''}{t.platforms ? ` · ${t.platforms}` : ''}</p>
                <p className={styles.note}>{t.lede}</p>
                <a className={`${styles.btn} ${styles.quiet}`} href={t.url} target="_blank" rel="noreferrer noopener">
                  {t.version ? 'Download' : 'Open the tools'}
                </a>
              </div>
            </article>
          ))}
        </Reveal>
      </section>
    </div>
  )
}
