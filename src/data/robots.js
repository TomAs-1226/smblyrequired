// Robot lineage. Team 5805 has built a robot every competition season since 2016; since
// 2025 each one is named for a Book of the Bible — a nod to our Santa Margarita
// roots. (Earlier robots had other names: TBA lists Joan of Arc for 2016–17 and
// Phocas for 2018 and 2020.)
// status: 'season' (in-season) | 'champion' (won/podium) | 'build' (in progress)
// record: every event the robot played, in order (The Blue Alliance / Statbotics, checked 2026-10-02).
// retired: when a robot was retired, what became of it, and the slug of its farewell post (blog.js).
// model: the robot's CAD on a turntable (public/models, baked by tools/display-cad.mjs). A robot
//   with a model and a photo shows the model first and offers the photo; with neither, a plate.

const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
/** 'YYYY-MM' → 'Sep 2026'; a bare year stays a year. */
export const shortDate = (d) => (d.length > 4 ? `${MONTH[Number(d.slice(5, 7)) - 1].slice(0, 3)} ${d.slice(0, 4)}` : d)
/** 'YYYY-MM' → 'September 2026'. */
export const monthYear = (ym) => `${MONTH[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`

export const lineageNote =
  'A new machine every competition season since 2016 — and since 2025, each one named for a Book of the Bible, a nod to our Santa Margarita roots.'

export const robots = [
  {
    name: 'Genesis',
    book: 'Book I',
    season: '2025 Season',
    year: 2025,
    game: 'REEFSCAPE',
    status: 'champion',
    result: 'Ventura County Regional — Winner',
    subtitle: 'Elevator side-loaded cycler',
    specs: [
      { label: 'Mechanism', value: 'Elevator — side-loaded cycler' },
      { label: 'Endgame', value: 'Deep climb capable' },
      { label: 'Game', value: 'REEFSCAPE (2025)' },
    ],
    blurb: 'Our 2025 REEFSCAPE machine — an elevator-based, side-loaded cycler that climbed deep. Ventura County Regional champions.',
    image: null,
    model: { file: 'genesis.glb' },
    retired: { date: '2026-09', note: 'Decommissioned and disassembled.', post: 'farewell-genesis' },
    record: [
      { date: '2025-03', event: 'Orange County Regional', result: 'Ranked 15th of 47 · playoffs' },
      { date: '2025-03', event: 'Ventura County Regional', result: 'Regional Winner — 5–0 in the playoffs, from the 49th seed', banner: true },
    ],
  },
  {
    name: 'Exodus',
    book: 'Book II',
    season: '2025 Offseason',
    year: 2025,
    game: 'REEFSCAPE',
    status: 'champion',
    result: 'Beach Blitz Winner · SoCal Showdown Finalist',
    subtitle: 'Back-loaded cycler',
    specs: [
      { label: 'Mechanism', value: 'Back-loaded cycler' },
      { label: 'Endgame', value: 'Deep climb capable' },
      { label: 'Game', value: 'REEFSCAPE (2025)' },
    ],
    blurb: 'The offseason breakout — a back-loaded cycler with a deep climb. Beach Blitz champions and a SoCal Showdown finalist banner.',
    image: 'photos/exodus.jpg',
    model: { file: 'exodus.glb' },
    retired: { date: '2026-09', note: 'Disassembled, its parts reflowed into new robots.', post: 'farewell-exodus' },
    record: [
      { date: '2025', event: 'SoCal Showdown', result: 'Finalist' },
      { date: '2025', event: 'Beach Blitz', result: 'Event Winner', banner: true },
    ],
  },
  {
    name: 'Leviticus',
    book: 'Book III',
    season: '2026 Season',
    year: 2026,
    game: 'REBUILT',
    status: 'season',
    result: 'Port Hueneme Finalist · OC Leadership Award Semi-Finalist',
    subtitle: 'Big dumper · 3.5-ball-wide shooter',
    specs: [
      { label: 'Scoring', value: 'Big dumper — 3.5-ball-wide shooter' },
      { label: 'Flywheels', value: '4× Kraken X60' },
      { label: 'Intake', value: 'Slapdown with extendable hopper' },
    ],
    blurb: 'Our 2026 REBUILT robot: a big-dumper, 3.5-ball-wide shooter spun by four Kraken X60s, fed by a slapdown intake with an extendable hopper. A district finalist with leadership-award recognition.',
    image: 'photos/hero.jpg',
    retired: { date: '2026-09', note: 'Disassembled, its parts reflowed into new robots.', post: 'farewell-leviticus' },
    record: [
      { date: '2026-03', event: 'Port Hueneme District', result: 'Event Finalist — 3–3 in the playoffs' },
      { date: '2026-04', event: 'Orange County District', result: 'Playoffs, Alliance 3 — 3–2' },
      { date: '2026-04', event: 'FIRST California Southern State Championship', result: 'Ranked 45th of 60' },
    ],
  },
  {
    name: 'Numbers',
    book: 'Book IV',
    season: '2026 Offseason',
    year: 2026,
    game: 'REBUILT',
    status: 'build',
    result: 'Debuts at SoCal Showdown · Oct 9–11, 2026',
    subtitle: 'Our build of Team 581’s 2026 design',
    // From the robot's CAD (public/models/robot.json) and its code.
    specs: [
      { label: 'Shooter', value: '4 in stainless flywheel, four Kraken X60s, hood 13–45°' },
      { label: 'Hopper', value: 'Extends 300 mm with the intake on its front; holds about 60 FUEL' },
      { label: 'Code', value: 'Catalyst 2.0 on Systemcore' },
    ],
    blurb: 'Our 2026 offseason robot: a build of Team 581’s REBUILT design, brought up by all three subteams and built on Catalyst 2.0 for FIRST’s new Systemcore controller. It debuts at SoCal Showdown.',
    image: null,
    // Catalyst Console's bake of the same CAD: about a third of the landing page's model, plenty
    // for a turntable.
    model: { file: 'robot-preview.glb' },
    current: true,
  },
]

// Not a competition robot, so not a Book: the drivebase every Catalyst release is driven on first.
// Its numbers are the ones it publishes to Catalyst Console (Robot/Chassis/*, Drivetrain/*).
export const testbeds = [
  {
    name: 'Catalyst X1',
    kicker: 'On the bench',
    subtitle: 'Our swerve test drivebase',
    specs: [
      { label: 'Frame', value: '28 × 26 in, four swerve modules' },
      { label: 'Drive', value: 'Falcon 500s on Phoenix 6' },
      { label: 'Brain', value: 'Systemcore · Catalyst 2.0' },
      { label: 'Vision', value: 'One Limelight 4, front centre' },
    ],
    blurb:
      'X1 is where Catalyst 2.0 drives first. Every feature the library gives a drivebase — swerve, pose estimation, vision, aiming on the move — runs here before it goes on a competition robot, and reports live to Catalyst Console. No mechanisms, on purpose: nothing it shows is pretended.',
    link: { href: '#/catalyst', label: 'About Catalyst' },
    model: { kind: 'drivebase' },
  },
]
