import Section from './Section'
import Eyebrow from './Eyebrow'
import SplitHeading from './SplitHeading'
import Reveal from './Reveal'
import Icon from './Icon'
import { news, newsNote } from '../data/news'
import styles from './News.module.css'

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

// 'YYYY-MM' -> { label: 'Apr 2026', iso: '2026-04' } for a clean mono date tag.
function formatDate(date) {
  const [year, month] = String(date).split('-')
  const idx = Number(month) - 1
  const m = MONTHS[idx] || month
  return { label: `${m} ${year}`, iso: `${year}-${month}` }
}

// Map an entry tag to a telemetry icon. Falls back to a neutral spark.
const TAG_ICON = {
  Competition: 'trophy',
  Engineering: 'code',
  Build: 'wrench',
}

export default function News() {
  const [featured, ...rest] = news

  return (
    <Section id="news">
      <Eyebrow>Latest</Eyebrow>

      <div className={styles.head}>
        <SplitHeading as="h2" className={styles.heading}>
          From the shop and the field.
        </SplitHeading>
        <p className={`lead ${styles.note}`}>{newsNote}</p>
      </div>

      {/* Featured (newest) entry — oversized lede above the timeline */}
      {featured && (
        <Reveal className={styles.featured} stagger={0.1} y={28}>
          <FeaturedItem entry={featured} />
        </Reveal>
      )}

      {/* Remaining entries — left-spined editorial timeline */}
      {rest.length > 0 && (
        <Reveal className={styles.feed} stagger={0.08} y={26} as="ol">
          {rest.map((entry, i) => (
            <FeedItem key={`${entry.date}-${i}`} entry={entry} />
          ))}
        </Reveal>
      )}
    </Section>
  )
}

function FeaturedItem({ entry }) {
  const { label, iso } = formatDate(entry.date)
  return (
    <article className={`${styles.feature} hud-frame`}>
      <header className={styles.featureMeta}>
        <time className="data-tag data-tag--gold" dateTime={iso}>
          {label}
        </time>
        <span className={styles.chip}>
          <Icon name={TAG_ICON[entry.tag] || 'spark'} size={14} />
          {entry.tag}
        </span>
        <span className={styles.latestFlag}>Latest</span>
      </header>
      <h3 className={styles.featureTitle}>{entry.title}</h3>
      <p className={styles.featureBlurb}>{entry.blurb}</p>
    </article>
  )
}

function FeedItem({ entry }) {
  const { label, iso } = formatDate(entry.date)
  return (
    <li className={styles.item}>
      <span className={styles.node} aria-hidden="true" />
      <time className={`data-tag ${styles.itemDate}`} dateTime={iso}>
        {label}
      </time>
      <div className={styles.itemBody}>
        <span className={styles.chip}>
          <Icon name={TAG_ICON[entry.tag] || 'spark'} size={14} />
          {entry.tag}
        </span>
        <h3 className={styles.itemTitle}>{entry.title}</h3>
        <p className={styles.itemBlurb}>{entry.blurb}</p>
      </div>
    </li>
  )
}
