import Section from './Section'
import Eyebrow from './Eyebrow'
import SplitHeading from './SplitHeading'
import Reveal from './Reveal'
import Icon from './Icon'
import { currentSponsors, titleSponsors, tierNote } from '../data/sponsors'
import styles from './SponsorWall.module.css'

// The wall ranks by level, top to bottom. There are no logo files, so each
// partner is set in type — the hierarchy is carried by scale and position, not
// by faked artwork. Add a sponsor in src/data/sponsors.js and it lands in the
// right tier automatically.
const TIERS = [
  { level: 'title', label: 'Title sponsor' },
  { level: 'major', label: 'Major sponsors' },
  { level: 'family', label: 'Family supporters' },
]

const byLevel = (level) => currentSponsors.filter((s) => s.level === level)

// PARTNER WALL — who puts tools in students' hands. Title sponsor above major
// above family supporters, then one quiet door to the sponsor page.
export default function SponsorWall() {
  const title = byLevel('title')
  const major = byLevel('major')
  const family = byLevel('family')

  return (
    <Section id="partners" rule={false}>
      <div className={styles.head}>
        <div className={styles.headLede}>
          <Eyebrow>Our partners</Eyebrow>
          <SplitHeading as="h2" className={styles.heading}>
            Built with people who back students.
          </SplitHeading>
        </div>
        <Reveal className={styles.headNote} y={24}>
          <p className="lead">
            Our partners put tools in students&rsquo; hands. These are the companies and families
            behind Team 5805 today &mdash; thank you.
          </p>
        </Reveal>
      </div>

      <div className={styles.wall}>
        {/* ---- Title sponsor: the largest thing on the wall ---- */}
        {title.length > 0 && (
          <Reveal className={styles.title} y={32}>
            <span className={styles.titleField} aria-hidden="true" />
            <h3 className={styles.tierLabel}>
              <span className={styles.tierRule} aria-hidden="true" />
              {TIERS[0].label}
            </h3>
            <ul className={styles.titleList}>
              {title.map((s) => (
                <li className={styles.titleItem} key={s.name}>
                  {titleSponsors.includes(s.name) && (
                    <span className={`data-tag data-tag--gold ${styles.presented}`}>
                      Presented by
                    </span>
                  )}
                  <span className={styles.titleName}>{s.name}</span>
                </li>
              ))}
            </ul>
          </Reveal>
        )}

        {/* ---- Major sponsors ---- */}
        {major.length > 0 && (
          <div className={styles.tier}>
            <h3 className={styles.tierLabel}>
              <span className={styles.tierRule} aria-hidden="true" />
              {TIERS[1].label}
            </h3>
            <Reveal as="ul" className={styles.majorList} stagger={0.08} y={24}>
              {major.map((s) => (
                <li className={styles.majorItem} key={s.name}>
                  <span className={styles.majorName}>{s.name}</span>
                  <span className={`tag ${styles.kind}`}>
                    {s.type === 'company' ? 'Company' : 'Family'}
                  </span>
                </li>
              ))}
            </Reveal>
          </div>
        )}

        {/* ---- Family supporters: quiet, set small ---- */}
        {family.length > 0 && (
          <div className={styles.tier}>
            <h3 className={styles.tierLabel}>
              <span className={styles.tierRule} aria-hidden="true" />
              {TIERS[2].label}
            </h3>
            <Reveal as="ul" className={styles.familyList} stagger={0.06} y={18}>
              {family.map((s) => (
                <li className={styles.familyItem} key={s.name}>
                  {s.name}
                </li>
              ))}
            </Reveal>
          </div>
        )}
      </div>

      {/* ---- Closing: a note and one quiet door ---- */}
      <div className={styles.close}>
        <p className={styles.closeNote}>{tierNote}</p>
        <a className={styles.closeLink} href="#/sponsor">
          Become a partner
          <Icon name="arrowRight" size={18} className={styles.closeArrow} />
        </a>
      </div>
    </Section>
  )
}
