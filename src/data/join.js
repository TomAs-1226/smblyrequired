// "Join the team" page — content for prospective students and their parents.
//
// Nothing here is new information. The subteams come from subteams.js, the
// contact details from team.js, the competition calendar from schedule.js, the
// offseason robots from robots.js, and the time-commitment wording from the
// 'Join' entries in faq.js. Where this file writes a sentence of its own, the
// source it restates is named beside it.
//
// What the site does NOT publish — and so the page does not either: an
// application form, a deadline, a fee, meeting days or times, and any
// eligibility rule beyond what the FAQ says. The page tells visitors to ask
// rather than guessing. If those facts become public, add them here.

import { team, contact, pillars } from './team'
import { schedule, season } from './schedule'
import { robots } from './robots'
import { faqs } from './faq'

// Time-commitment answer, verbatim from the FAQ so the two cannot disagree.
const timeFaq = faqs.find((f) => f.tag === 'Join' && /time commitment/i.test(f.q))
// Who can join, verbatim from the FAQ.
const joinFaq = faqs.find((f) => f.tag === 'Join' && /how do students join/i.test(f.q))

export const joinEligibility = joinFaq ? joinFaq.a : ''
export const timeCommitment = timeFaq ? timeFaq.a : ''

// What the hero's fact panel shows — all from team.js.
export const joinFacts = [
  { label: 'School', value: team.school },
  { label: 'Location', value: team.location },
  { label: 'Program', value: team.program },
  { label: 'Founded', value: `${team.founded} — ${team.foundedNote}` },
]

// The season, as three phases. The wording restates mission (team.js), the
// Mechanical subteam copy ("six-week deadline") and the FAQ above; the event
// and robot lists are the real records.
const competitionPillar = pillars.find((p) => p.title === 'Competition')

export const seasonRhythm = [
  {
    key: 'build',
    label: 'Build season',
    icon: 'wrench',
    tag: 'Busiest: January–April',
    body: 'Every season we design, machine, wire, and program a 120-pound competition robot from scratch, against a six-week deadline. Expect several days a week.',
  },
  {
    key: 'compete',
    label: 'Competition',
    icon: 'trophy',
    tag: `${season} season`,
    body: competitionPillar ? competitionPillar.body : '',
    // Straight from schedule.js. `result` is null for events not yet played.
    events: schedule.map((s) => ({
      month: s.month,
      name: s.event,
      dates: s.dates,
      result: s.result,
    })),
  },
  {
    key: 'offseason',
    label: 'Offseason',
    icon: 'cog',
    tag: 'Lighter',
    body: 'Training, outreach, and our offseason robot. Students lead the schedule.',
    // Straight from robots.js: every robot whose season is an offseason.
    robots: robots
      .filter((r) => /offseason/i.test(r.season))
      .map((r) => ({ name: r.name, season: r.season, subtitle: r.subtitle })),
  },
]

// How to get in touch — only what team.js `contact` holds. New-member interest
// goes to the general address (the same routing the Contact page states).
export const joinEmailSubject = `Joining FRC Team ${team.number}`

export const joinChannels = [
  {
    key: 'email',
    icon: 'mail',
    label: 'Email the team',
    text: contact.generalEmail,
    href: `mailto:${contact.generalEmail}?subject=${encodeURIComponent(joinEmailSubject)}`,
  },
  {
    key: 'phone',
    icon: 'user',
    label: 'Program office',
    text: contact.phone,
    href: `tel:${contact.phone.replace(/[^\d+]/g, '')}`,
  },
  {
    key: 'address',
    icon: 'pin',
    label: 'Where to find us',
    text: contact.address,
  },
]
