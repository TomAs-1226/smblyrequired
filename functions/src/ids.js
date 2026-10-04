// Document ids the functions write.
//
// The same two functions as src/lib/ids.js. A deployed function carries only the
// functions/ directory, so it cannot import the site's copy; test/stats.test.mjs
// holds the two to the same answers.

/** event_teams/{id} */
export const eventTeamId = (eventKey, teamNumber) => `${eventKey}_${teamNumber}`

/** team_event_stats/{id} */
export const teamStatId = (eventKey, teamNumber) => `${eventKey}_${teamNumber}`
