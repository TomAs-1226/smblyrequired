import Section from './Section'
import Eyebrow from './Eyebrow'
import SplitHeading from './SplitHeading'
import Reveal from './Reveal'
import Icon from './Icon'
import { posts } from '../data/blog'
import styles from './BlogIndex.module.css'

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

// Map a post tag to a telemetry icon. Falls back to a neutral spark.
const TAG_ICON = {
  Competition: 'trophy',
  Engineering: 'code',
  Build: 'wrench',
  Outreach: 'megaphone',
}

export default function BlogIndex() {
  const [featured, ...rest] = posts

  return (
    <Section id="blog">
      <Eyebrow>The build blog</Eyebrow>

      <div className={styles.head}>
        <SplitHeading as="h2" className={styles.heading}>
          From the shop and the field.
        </SplitHeading>
        <p className={`lead ${styles.note}`}>
          Notes from the pit, the programming bench, and the competition floor —
          what we built, what broke, and what we learned fixing it.
        </p>
      </div>

      {/* Featured (newest) post — oversized lede card */}
      {featured && (
        <Reveal className={styles.featuredWrap} y={28}>
          <FeaturedCard post={featured} />
        </Reveal>
      )}

      {/* Remaining posts — clean two-up editorial grid */}
      {rest.length > 0 && (
        <Reveal className={styles.grid} stagger={0.08} y={28}>
          {rest.map((post) => (
            <PostCard key={post.slug} post={post} />
          ))}
        </Reveal>
      )}
    </Section>
  )
}

function FeaturedCard({ post }) {
  const { label, iso } = formatDate(post.date)
  return (
    <a className={`${styles.feature} hud-frame`} href={`#/blog/${post.slug}`}>
      <header className={styles.featureMeta}>
        <time className="data-tag data-tag--gold" dateTime={iso}>
          {label}
        </time>
        <span className={styles.chip}>
          <Icon name={TAG_ICON[post.tag] || 'spark'} size={14} />
          {post.tag}
        </span>
        <span className={styles.latestFlag}>Latest</span>
      </header>

      <h3 className={styles.featureTitle}>{post.title}</h3>
      <p className={styles.featureExcerpt}>{post.excerpt}</p>

      <span className={styles.featureRead}>
        Read
        <Icon name="arrowRight" size={18} className={styles.readArrow} />
      </span>
    </a>
  )
}

function PostCard({ post }) {
  const { label, iso } = formatDate(post.date)
  return (
    <a className={styles.card} href={`#/blog/${post.slug}`}>
      <header className={styles.cardMeta}>
        <time className={`data-tag ${styles.cardDate}`} dateTime={iso}>
          {label}
        </time>
        <span className={styles.chip}>
          <Icon name={TAG_ICON[post.tag] || 'spark'} size={13} />
          {post.tag}
        </span>
      </header>

      <h3 className={styles.cardTitle}>{post.title}</h3>
      <p className={styles.cardExcerpt}>{post.excerpt}</p>

      <span className={styles.cardRead}>
        Read
        <Icon name="arrowRight" size={16} className={styles.readArrow} />
      </span>
    </a>
  )
}
