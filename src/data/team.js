// Single source of truth for team identity + copy. Edit here to update the site.

export const team = {
  number: 5805,
  name: 'SMbly Required',
  shortName: 'Team 5805',
  school: 'Santa Margarita Catholic High School',
  schoolShort: 'Santa Margarita Catholic HS',
  location: 'Rancho Santa Margarita, California',
  founded: 2016,
  foundedNote: 'Founded in the 2015–16 season',
  program: 'FIRST® Robotics Competition',
  website: 'https://smblyrequired.com/',
  currentGame: 'REBUILT',
  currentSeason: '2026',
  rookieYear: 2016,
  motto: 'Building robots. Building leaders. Inspiring the future.',
  tagline: 'Build the future with us.',
  lead:
    'A student-run FIRST® Robotics Competition team that turns aluminum, code, and ambition into champions — and into the next generation of engineers.',
  // Real program copy (Santa Margarita Catholic HS robotics).
  mission:
    'More than a club, it’s a launchpad — it’s a lifestyle. Every season our students design, machine, wire, and program a 120-pound competition robot from scratch, then drive it head-to-head against the best teams in Southern California. Beyond the workshop they lead fundraising, marketing, outreach, and program management. They don’t just learn how to compete — they learn how to lead, adapt, and succeed.',
  missionTag: 'Heart, hustle, and human ingenuity in motion.',
  origin:
    'SMbly Required (FIRST Team 5805) grew out of the robotics program at Santa Margarita Catholic High School — home of FIRST Team 3020 since 2009 — and has been building and competing since the 2015–16 season.',
  siblingTeam: { number: 3020, name: 'SMbld', since: 2009 },
}

export const contact = {
  // Sponsorship / partnerships
  overseer: 'Alexander Klatt',
  overseerRole: 'Head Coach & Program Manager',
  sponsorEmail: 'klatta@smhs.org',
  // General program inquiries
  generalEmail: 'robotics@smhs.org',
  phone: '(949) 766-6000',
  org: 'Santa Margarita Catholic HS · FRC 5805',
  address: '22062 Antonio Parkway, Rancho Santa Margarita, CA 92688',
  checkMemo: 'Robotics – Team 5805',
}

// Mentors & coaches for Team 5805.
export const mentors = [
  { name: 'Alexander Klatt', role: 'Head Coach & Program Manager' },
  { name: 'Teddy Bullockus', role: 'Lead Mentor' },
  { name: 'John Evans', role: 'Mentor' },
]

// Headline stats. `to` numeric values count up; strings render as-is.
export const stats = [
  { to: 2016, label: 'Founded' },
  { to: 19, label: 'Students on the team' },
  { to: 10, suffix: '+', label: 'Seasons competing' },
  { to: 100, suffix: '%', label: 'Student-built robot' },
]

// "What we do" pillars.
export const pillars = [
  {
    title: 'Engineering & design',
    body: 'CAD, CNC machining, 3D printing, electronics, and Java programming — students own the full build.',
    icon: 'cog',
  },
  {
    title: 'Business & outreach',
    body: 'Students run the budget, sponsor relations, branding, and community STEM outreach themselves.',
    icon: 'megaphone',
  },
  {
    title: 'Competition',
    body: 'A full FRC district season each year against 40+ teams per event across Southern California.',
    icon: 'trophy',
  },
  {
    title: 'Mentorship',
    body: 'Industry and parent mentors guide students toward college and STEM careers.',
    icon: 'compass',
  },
]

// "What is FIRST?" supporting facts.
export const firstFacts = [
  { strong: '3,000+ teams', rest: 'compete worldwide each season.' },
  { strong: '$80M+ in scholarships', rest: 'available to FIRST students from 200+ providers.' },
  { strong: 'FIRST alumni', rest: 'are far more likely to pursue science and engineering degrees.' },
  { strong: '“The varsity sport for the mind”', rest: '— hands-on STEM at competition intensity.' },
]

// FIRST legal line (required attribution).
export const firstDisclaimer =
  'FIRST® is a registered trademark of For Inspiration and Recognition of Science and Technology (FIRST), which does not sponsor, authorize, or endorse this website.'
