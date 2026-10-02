// Central route map — used by the Nav and the Home landing teasers.

import { rosterCount } from './roster'
import { subteams } from './subteams'

// Primary nav links (Sponsor is a separate gold CTA; Home is the brand/logo).
export const navLinks = [
  { path: '/team', label: 'Team' },
  { path: '/join', label: 'Join' },
  { path: '/mentors', label: 'Mentors' },
  { path: '/robots', label: 'Robots' },
  { path: '/season', label: 'Season' },
  { path: '/blog', label: 'Blog' },
  { path: '/catalyst', label: 'Catalyst' },
  { path: '/gallery', label: 'Gallery' },
  { path: '/contact', label: 'Contact' },
]

// Teaser cards for the landing page (richer blurbs + icons).
export const pageTeasers = [
  { path: '/team', label: 'The Team', icon: 'user', blurb: `Who we are, our ${subteams.length} subteams, and the ${rosterCount} students behind 5805.` },
  { path: '/join', label: 'Join the Team', icon: 'users', blurb: `Open to every experience level — ${subteams.length} subteams, student-run, and we will teach you.` },
  { path: '/robots', label: 'The Robots', icon: 'cog', blurb: 'Genesis to Numbers — our championship lineage, plus how swerve drive works.' },
  { path: '/season', label: 'Season & Record', icon: 'trophy', blurb: 'Every banner since rookie year and the latest from the shop.' },
  { path: '/sponsor', label: 'Sponsor Us', icon: 'heart', blurb: 'Why partner with us, the tiers, and the 2026 sponsorship packet.' },
  { path: '/catalyst', label: 'FRC Catalyst', icon: 'code', blurb: 'Our open-source Java library, built for the whole FRC community.' },
  { path: '/gallery', label: 'Gallery', icon: 'star', blurb: 'The pit, the field, and everything in between.' },
  { path: '/blog', label: 'Build Blog', icon: 'calendar', blurb: 'Recaps from the shop and the field, all season long.' },
  { path: '/donate', label: 'Donate', icon: 'heart', blurb: 'Support the team — gifts of any size, tax-deductible.' },
]
