// Sponsorship tiers, current partners, and giving info — mirrors the packet.

// Every tier includes the benefits of the tiers below it.
export const tiers = [
  {
    key: 'bronze',
    name: 'Bronze',
    amount: 250,
    perks: [
      { text: 'Logo on team jersey', strong: true },
      { text: 'Name on our website' },
      { text: 'Social media thank-you' },
      { text: 'Tax-deductible receipt' },
    ],
  },
  {
    key: 'silver',
    name: 'Silver',
    amount: 500,
    perks: [
      { text: 'Everything in Bronze', strong: true },
      { text: 'Logo on our pit banner' },
      { text: 'Logo on team website' },
    ],
  },
  {
    key: 'gold',
    name: 'Gold',
    amount: 1000,
    perks: [
      { text: 'Everything in Silver', strong: true },
      { text: 'Larger jersey logo' },
      { text: 'Dedicated social feature' },
      { text: 'Recognition in pit display' },
    ],
  },
  {
    key: 'platinum',
    name: 'Platinum',
    amount: 2500,
    perks: [
      { text: 'Everything in Gold', strong: true },
      { text: 'Your logo on the robot', strong: true },
      { text: 'Shop visit / robot demo invite' },
    ],
  },
  {
    key: 'title',
    name: 'Title',
    amount: 5000,
    featured: true,
    perks: [
      { text: 'Everything in Platinum', strong: true },
      { text: 'Largest logo on robot & banner', strong: true },
      { text: '“Presented by” recognition' },
      { text: 'Custom partnership & plaque' },
    ],
  },
]

export const tierNote =
  'Every sponsor, at every level, gets their logo on our team jerseys. Logo placement directly on the robot begins at the Platinum tier.';

// What every sponsor receives.
export const sponsorBenefits = [
  'Your logo on our team jerseys — at every level of support.',
  'Your logo on the robot at higher tiers — seen by thousands at events.',
  'Social media & website recognition to our community.',
  'A tax-deductible contribution supporting youth STEM education.',
]

// Where sponsorship dollars go (a competitive FRC season runs ~$25,000–$35,000).
export const budget = [
  { label: 'Event registration & fees', pct: 40 },
  { label: 'Robot parts & materials', pct: 28 },
  { label: 'Tools & equipment', pct: 12 },
  { label: 'Travel & logistics', pct: 12 },
  { label: 'Outreach & operations', pct: 8 },
]
export const seasonCost = '$25,000–$35,000'

// In-kind donations welcome.
export const inKind = [
  'Aluminum, polycarbonate & stock',
  'CNC / machining / 3D-print time',
  'Electronics & motors',
  'Tools & shop equipment',
  'Professional mentorship',
  'Build space & transport',
]

// Current partners. type: 'company' | 'family'; level: 'title' | 'major' | 'family'.
// fabworks & Truffles Clothing are our title sponsors (per our FIRST team record).
export const currentSponsors = [
  { name: 'fabworks', type: 'company', level: 'title' },
  { name: 'Truffles Clothing', type: 'company', level: 'title' },
  { name: 'Pacific Realway Consulting', type: 'company', level: 'major' },
  { name: 'The Yu Family', type: 'family', level: 'family' },
  { name: 'The Zhang Family', type: 'family', level: 'family' },
  { name: 'The Bullockus Family', type: 'family', level: 'family' },
]

// Title sponsors get a "Presented by" credit in the hero/footer.
export const titleSponsors = ['fabworks', 'Truffles Clothing']

// How to become a sponsor (3 steps).
export const sponsorSteps = [
  { n: 1, title: 'Reach out', body: 'Email our program overseer with the level or in-kind support you have in mind.' },
  { n: 2, title: 'We confirm', body: 'We’ll send a sponsor agreement, collect your logo, and confirm tax-deductibility.' },
  { n: 3, title: 'Go visible', body: 'Your brand goes on the jerseys, robot, and socials — onto the field at every event.' },
]

export const taxNote =
  'Team 5805 is supported through Santa Margarita Catholic High School. Contributions may be tax-deductible to the extent allowed by law. Tax ID and 501(c)(3) details are available on request.';

export const packetUrl = 'Team5805-Sponsorship-Packet.pdf'
