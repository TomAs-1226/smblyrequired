// Official competition record — sourced from The Blue Alliance (frc5805), checked 2026-10-02.
// kind drives styling: 'winner' & 'rookie' => gold; 'finalist' & 'award' => cyan.
// flagship marks the headline results.
export const achievements = [
  {
    year: 2026,
    event: 'Orange County District',
    award: 'FIRST Leadership Award — Semi-Finalist',
    kind: 'award',
    person: 'Andrea', // TBA lists "Andrea F"; first names only, as on the roster
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
    event: 'FIRST Championship — Turing Division',
    award: 'World Championship qualifier',
    kind: 'award',
  },
  {
    year: 2019,
    event: 'Orange County Regional',
    award: 'Finalist · Wildcard',
    kind: 'finalist',
  },
  {
    year: 2018,
    event: 'FIRST Championship — Carver Division',
    award: 'Quarterfinalist · Alliance 5',
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
    event: 'FIRST Championship — Hopper Division',
    award: 'World Championship qualifier · rookie year',
    kind: 'award',
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
  { to: 10, label: 'Seasons competing' }, // matches played 2016–20, 2022–26 (no 2021 events)
  { to: 3, label: 'Event wins' },
  { to: 2016, label: 'Winning since (rookie year)' },
]

export const recordNote =
  'Winning hardware since our rookie year — Rookie All-Star in 2016, three trips to the World Championship (2016, 2018, 2019), Orange County Regional champions in 2018, and Ventura County Regional and Beach Blitz champions in 2025. Record sourced from The Blue Alliance.'
