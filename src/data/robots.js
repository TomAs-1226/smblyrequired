// Robot lineage. Team 5805 builds a new robot every season, each named for a
// Book of the Bible — a nod to our Santa Margarita roots.
// status: 'season' (in-season) | 'champion' (won/podium) | 'build' (in progress)

export const lineageNote =
  'One team, a new machine every season — each named for a Book of the Bible, a nod to our Santa Margarita roots. And we’re just getting started.'

export const robots = [
  {
    name: 'Genesis',
    book: 'Book I',
    season: '2025 Season',
    year: 2025,
    game: 'REEFSCAPE',
    status: 'champion',
    result: 'Ventura County Regional — Winner',
    blurb: 'Our 2025 REEFSCAPE machine — Ventura County Regional champions.',
    image: null,
  },
  {
    name: 'Exodus',
    book: 'Book II',
    season: '2025 Offseason',
    year: 2025,
    game: 'REEFSCAPE',
    status: 'champion',
    result: 'Beach Blitz Winner · SoCal Showdown Finalist',
    blurb: 'The offseason breakout — Beach Blitz champions and a SoCal Showdown finalist banner.',
    image: 'photos/exodus.jpg',
  },
  {
    name: 'Leviticus',
    book: 'Book III',
    season: '2026 Season',
    year: 2026,
    game: 'REBUILT',
    status: 'champion',
    result: 'Port Hueneme Finalist · OC Leadership Award Semi-Finalist',
    blurb: 'Our current 2026 REBUILT robot — a district finalist with leadership-award recognition.',
    image: 'photos/hero.jpg',
    current: true,
  },
  {
    name: 'Numbers',
    book: 'Book IV',
    season: '2026 Offseason',
    year: 2026,
    game: 'REBUILT',
    status: 'build',
    result: 'In build for fall 2026',
    blurb: 'On the bench now — our next machine, in design and fabrication for the fall offseason.',
    image: null,
  },
]
