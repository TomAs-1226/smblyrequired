import Section from './Section'
import Icon from './Icon'
import Reveal from './Reveal'
import SplitHeading from './SplitHeading'
import { posts, postBySlug } from '../data/blog'
import styles from './BlogPost.module.css'

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

const TAG_ICON = {
  Competition: 'trophy',
  Engineering: 'code',
  Build: 'wrench',
  Outreach: 'megaphone',
}

export default function BlogPost({ slug }) {
  const post = postBySlug(slug)

  if (!post) {
    return (
      <Section id="blog-post">
        <div className={styles.missing}>
          <span className="data-tag">404 // No such post</span>
          <h1 className={styles.missingTitle}>Post not found</h1>
          <p className={`lead ${styles.missingNote}`}>
            That post may have moved or never existed. Head back to the build
            blog to see everything we&rsquo;ve published.
          </p>
          <a className="btn btn--cyan" href="#/blog">
            <Icon name="arrowRight" size={18} />
            All posts
          </a>
        </div>
      </Section>
    )
  }

  const { label, iso } = formatDate(post.date)

  // Posts are newest-first; prev = newer, next = older.
  const idx = posts.findIndex((p) => p.slug === post.slug)
  const newer = idx > 0 ? posts[idx - 1] : null
  const older = idx >= 0 && idx < posts.length - 1 ? posts[idx + 1] : null

  return (
    <Section id="blog-post">
      <a className={styles.back} href="#/blog">
        <Icon name="arrowRight" size={16} className={styles.backArrow} />
        All posts
      </a>

      {/* --- Article header --- */}
      <header className={styles.header}>
        <div className={styles.meta}>
          <span className={styles.chip}>
            <Icon name={TAG_ICON[post.tag] || 'spark'} size={13} />
            {post.tag}
          </span>
          <time className="data-tag" dateTime={iso}>
            {label}
          </time>
        </div>

        <SplitHeading as="h1" className={styles.title}>
          {post.title}
        </SplitHeading>

        <p className={styles.byline}>
          <Icon name="user" size={16} className={styles.bylineIcon} />
          By {post.author}
        </p>
      </header>

      {/* --- Article body --- */}
      <Reveal className={styles.article} stagger={0.06} y={20} as="article">
        {post.body.map((para, i) => (
          <p className={styles.para} key={i}>
            {para}
          </p>
        ))}
      </Reveal>

      {/* --- Prev / next nav --- */}
      {(newer || older) && (
        <nav className={styles.postNav} aria-label="More posts">
          {newer ? (
            <a className={`${styles.navCard} ${styles.navPrev}`} href={`#/blog/${newer.slug}`}>
              <span className={styles.navDir}>
                <Icon name="arrowRight" size={15} className={styles.navArrowPrev} />
                Newer post
              </span>
              <span className={styles.navTitle}>{newer.title}</span>
            </a>
          ) : (
            <span aria-hidden="true" />
          )}

          {older ? (
            <a className={`${styles.navCard} ${styles.navNext}`} href={`#/blog/${older.slug}`}>
              <span className={styles.navDir}>
                Older post
                <Icon name="arrowRight" size={15} className={styles.navArrowNext} />
              </span>
              <span className={styles.navTitle}>{older.title}</span>
            </a>
          ) : (
            <span aria-hidden="true" />
          )}
        </nav>
      )}

      <div className={styles.foot}>
        <a className="btn btn--ghost" href="#/blog">
          <Icon name="arrowRight" size={18} className={styles.backArrow} />
          Back to all posts
        </a>
      </div>
    </Section>
  )
}
