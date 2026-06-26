// Official competition record — sourced from The Blue Alliance (frc5805).
// kind drives styling: 'winner' & 'rookie' => gold; 'finalist' & 'award' => cyan.
// flagship marks the headline results.
export const achievements = [
  {
    year: 2026,
    event: 'Orange County District',
    award: 'FIRST Leadership Award — Semi-Finalist',
    kind: 'award',
    person: 'Rey Freeman',
  },
  {
    year: 2026,
    event: 'Port Hueneme District',
    award: 'Event Finalist',
    kind: 'finalist',
    robot: 'Leviticus',
  },
  {
    year: 2025,
    event: 'Ventura County Regional',
    award: 'Regional Winner',
    kind: 'winner',
    robot: 'Genesis',
    flagship: true,
  },
  {
    year: 2025,
    event: 'Beach Blitz (Gene Haas Foundation)',
    award: 'Event Winner',
    kind: 'winner',
    robot: 'Exodus',
  },
  {
    year: 2025,
    event: 'SoCal Showdown',
    award: 'Finalist',
    kind: 'finalist',
    robot: 'Exodus',
  },
  {
    year: 2019,
    event: 'Orange County Regional',
    award: 'Finalist · Wildcard',
    kind: 'finalist',
  },
  {
    year: 2018,
    event: 'Orange County Regional',
    award: 'Regional Winner',
    kind: 'winner',
  },
  {
    year: 2016,
    event: 'San Diego Regional',
    award: 'Rookie All-Star · Highest Rookie Seed',
    kind: 'rookie',
    flagship: true,
  },
  {
    year: 2016,
    event: 'Battle at the Border',
    award: 'Finalist',
    kind: 'finalist',
  },
]

// Headline record stats (derived from the real record).
export const recordStats = [
  { to: 11, label: 'Seasons competing' },
  { to: 3, label: 'Event wins' },
  { to: 2016, label: 'Winning since (rookie year)' },
]

export const recordNote =
  'Winning hardware since our rookie year — Rookie All-Star in 2016, Orange County Regional champions in 2018, and Ventura County Regional champions in 2025. Record sourced from The Blue Alliance.'
