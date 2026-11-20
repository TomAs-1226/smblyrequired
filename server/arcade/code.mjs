// Print the arcade's code for this week and next, for a mentor to share.
//
//   on the server:  sudo bash /opt/arcade/code.sh
//   locally:        ARCADE_CODE_SECRET=... node server/arcade/code.mjs
import { weekId, weeklyCode, TIMEZONE } from './access.mjs'

const secret = process.env.ARCADE_CODE_SECRET
if (!secret) {
  console.error('ARCADE_CODE_SECRET is not set: the arcade has no code (it is open).')
  process.exit(1)
}
const now = new Date()
const thisWeek = weekId(now)
const nextWeek = weekId(new Date(now.getTime() + 7 * 86400000))
console.log(`This week (${thisWeek}): ${weeklyCode(secret, thisWeek)}`)
console.log(`Next week (${nextWeek}): ${weeklyCode(secret, nextWeek)}`)
console.log(`Codes change at midnight on Monday, ${TIMEZONE} time.`)
