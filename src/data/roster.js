// Team 5805 student roster. `captain` flags the lead.
//
// PRIVACY: the public site shows FIRST NAMES ONLY. Last names (and parenthetical
// legal/middle names) are deliberately kept out of this file entirely, so they
// never ship in the public bundle — not just hidden from the render. These are
// minors; a first name and a grade is all the marketing site needs. `id` gives a
// stable React key without reusing a name, since first names can repeat.
export const roster = [
  { id: 1, name: 'Ian', grade: 'Senior', captain: true },
  { id: 2, name: 'Michael', grade: 'Senior' },
  { id: 3, name: 'Jerry', grade: 'Senior' },
  { id: 4, name: 'Cyra', grade: 'Senior' },
  { id: 5, name: 'Rey', grade: 'Junior' },
  { id: 6, name: 'Alexander', grade: 'Junior' },
  { id: 7, name: 'Ethan', grade: 'Junior' },
  { id: 8, name: 'Jack', grade: 'Junior' },
  { id: 9, name: 'Noah', grade: 'Junior' },
  { id: 10, name: 'Benjamin', grade: 'Junior' },
  { id: 11, name: 'Justus', grade: 'Junior' },
  { id: 12, name: 'Tiger', grade: 'Junior' },
  { id: 13, name: 'Richard', grade: 'Junior' },
  { id: 14, name: 'Jeffrey', grade: 'Junior' },
  { id: 15, name: 'Louis', grade: 'Junior' },
  { id: 16, name: 'Eric', grade: 'Junior' },
  { id: 17, name: 'Thomas', grade: 'Junior' },
  { id: 18, name: 'Andrew', grade: 'Sophomore' },
  { id: 19, name: 'Ethan', grade: 'Sophomore' },
]

export const rosterCount = roster.length
