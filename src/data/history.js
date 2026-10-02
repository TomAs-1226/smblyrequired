// Team history — BUILT, not written. Every entry below is derived from data
// that already lives elsewhere in src/data, so this file cannot drift from the
// record: change a result in achievements.js, a robot in robots.js, or the
// founding year in team.js and the timeline follows.
//
//   team.js          -> founding, rookie year, the sibling program (origin)
//   achievements.js  -> every competition result (The Blue Alliance record)
//   robots.js        -> the robot lineage, one machine at a time
//
// Nothing is hand-copied and no milestone is invented. A season with no entry
// in any of those files simply does not appear — the timeline shows what the
// record supports and nothing else.
//
// Order: OLDEST first, so the page reads as a story. (The honors list in the
// Impact section directly above it on the Season page runs newest first.)

import { team } from './team'
import { achievements } from './achievements'
import { robots } from './robots'

// kind drives the marker icon + colour in Timeline.jsx.
//   origin | founded | robot | winner | rookie | finalist | award
const ORDER = { origin: 0, founded: 1, robot: 2, rookie: 3, winner: 4, finalist: 5, award: 6 }

const slugOf = (name) => name.toLowerCase()

function build() {
  const items = []

  // --- team.js ------------------------------------------------------------
  // The program 5805 grew out of (team.origin names the sibling team).
  if (team.siblingTeam) {
    items.push({
      year: team.siblingTeam.since,
      kind: 'origin',
      title: `Team ${team.siblingTeam.number} (${team.siblingTeam.name}) begins`,
      detail: `The robotics program at ${team.schoolShort} that Team ${team.number} later grew out of.`,
    })
  }

  items.push({
    year: team.founded,
    kind: 'founded',
    title: `Team ${team.number} founded`,
    detail: team.foundedNote,
    // Founding and rookie year are the same season in team.js; say so on one
    // entry rather than repeating it. If they ever differ, rookie gets its own.
    tag: team.rookieYear === team.founded ? 'Rookie year' : undefined,
  })
  if (team.rookieYear !== team.founded) {
    items.push({
      year: team.rookieYear,
      kind: 'founded',
      title: 'Rookie season',
      detail: `${team.name} takes the field for the first time.`,
    })
  }

  // --- achievements.js ----------------------------------------------------
  for (const a of achievements) {
    items.push({
      year: a.year,
      kind: a.kind,
      title: a.event,
      detail: a.award,
      robot: a.robot,
      person: a.person,
      flagship: Boolean(a.flagship),
    })
  }

  // --- robots.js ----------------------------------------------------------
  for (const r of robots) {
    items.push({
      year: r.year,
      kind: 'robot',
      title: r.name,
      // book + season + game + what it is — all straight from the robot record
      detail: [r.subtitle, r.season, r.game].filter(Boolean).join(' · '),
      tag: r.book,
      href: `#/robots/${slugOf(r.name)}`,
      building: r.status === 'build',
    })
  }

  return items
}

// [{ year, items: [...] }], oldest year first. Within a year the order is
// fixed by ORDER above, then the order the source file lists them in.
function groupByYear(list) {
  const map = new Map()
  list.forEach((it, i) => {
    if (!map.has(it.year)) map.set(it.year, [])
    map.get(it.year).push({ ...it, _i: i })
  })
  return [...map.entries()]
    .sort(([a], [b]) => a - b)
    .map(([year, rows]) => ({
      year,
      items: rows
        .sort((x, y) => ORDER[x.kind] - ORDER[y.kind] || x._i - y._i)
        .map(({ _i, ...rest }) => rest),
    }))
}

export const history = groupByYear(build())

export const historyNote =
  'Only seasons with something in our record appear here — results from The Blue Alliance, the robots we have built, and where the team came from.'
