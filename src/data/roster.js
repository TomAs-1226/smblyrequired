// Team 5805 student roster.
//
// PRIVACY: the public site shows FIRST NAMES ONLY. Last names (and parenthetical
// legal/middle names) are deliberately kept out of this file entirely, so they
// never ship in the public bundle — not just hidden from the render. These are
// minors; a first name is all the marketing site needs. `id` gives a stable
// React key without reusing a name, since first names can repeat.
//
// Grades are deliberately absent. The roster is sourced from the team's
// Microsoft Teams membership, which carries a graduation year for only a
// fraction of the students — publishing a grade for some and guessing for the
// rest would put wrong information about minors on a public page. If grade
// data becomes available for everyone, add it back as a `grade` field and
// restore the grouped layout in MeetTheTeam.jsx (see git history for it).
//
// Students on sibling team 3020 (SMbld) share the Teams org and are NOT listed
// here — this is the 5805 roster.
export const roster = [
  { id: 1, name: 'Thomas' },
  { id: 2, name: 'Ruyi' },
  { id: 3, name: 'Andrew' },
  { id: 4, name: 'Jack' },
  { id: 5, name: 'Andrea' },
  { id: 6, name: 'Ivan' },
  { id: 7, name: 'Ethan' },
  { id: 8, name: 'Justus' },
  { id: 9, name: 'Ronan' },
  { id: 10, name: 'Christopher' },
  { id: 11, name: 'Alexandra' },
  { id: 12, name: 'Siyuan' },
  { id: 13, name: 'Richard' },
  { id: 14, name: 'Siqi' },
  { id: 15, name: 'Cole' },
  { id: 16, name: 'Alexander' },
  { id: 17, name: 'Mason' },
  { id: 18, name: 'Noah' },
  { id: 19, name: 'Luke' },
  { id: 20, name: 'Memphis' },
]

export const rosterCount = roster.length
