// The arcade's weekly code, and the pass a correct code earns.
//
// The code is derived from a secret that only the server holds and the current
// week, so it changes by itself every Monday at midnight in the team's timezone
// and nobody has to remember to change it:
//
//   code = 6 characters of HMAC-SHA256(secret, "arcade-code:" + week)
//
// It is short enough to read out at a meeting (ABC-123 style, no 0/O or 1/I).
// Someone who types it correctly gets a pass: the week it is good for, signed
// with the same secret, so the server can check it later without storing it.
// The pass stops working when the week rolls over.
//
// Shared by server.mjs and code.mjs (which prints the code for a mentor to share).
import crypto from 'node:crypto'

export const TIMEZONE = 'America/Los_Angeles'
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 32: no 0/O, no 1/I

/** The ISO week a moment falls in, in the team's timezone: "2026-W47". */
export function weekId(date = new Date(), timeZone = TIMEZONE) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(date)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)]),
  )
  // ISO 8601: weeks start on Monday; week 1 holds the year's first Thursday.
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day))
  const dow = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dow)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/** The code for a week, e.g. "K7Q-X3M". */
export function weeklyCode(secret, week) {
  const h = crypto.createHmac('sha256', secret).update(`arcade-code:${week}`).digest()
  let s = ''
  for (let i = 0; i < 6; i++) s += ALPHABET[h[i] % ALPHABET.length] // 256 / 32: no bias
  return `${s.slice(0, 3)}-${s.slice(3)}`
}

/** What someone typed, in the code's own form: case, spaces and dashes do not matter. */
export const normalise = (input) => String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '')

/** Does `input` match this week's code? Constant-time, so the comparison leaks nothing. */
export function codeMatches(secret, input, week = weekId()) {
  const want = Buffer.from(normalise(weeklyCode(secret, week)))
  const got = Buffer.from(normalise(input))
  return got.length === want.length && crypto.timingSafeEqual(got, want)
}

const b64 = (buf) => Buffer.from(buf).toString('base64url')
const sign = (secret, payload) => b64(crypto.createHmac('sha256', secret).update(`arcade-pass:${payload}`).digest())

/** A pass for the given week. */
export function issuePass(secret, week = weekId()) {
  const payload = b64(JSON.stringify({ wk: week, n: crypto.randomBytes(6).toString('hex') }))
  return `${payload}.${sign(secret, payload)}`
}

/** Is `pass` signed by us and for this week? */
export function passValid(secret, pass, week = weekId()) {
  if (typeof pass !== 'string' || pass.length > 300) return false
  const [payload, mac] = pass.split('.')
  if (!payload || !mac) return false
  const want = Buffer.from(sign(secret, payload))
  const got = Buffer.from(mac)
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return false
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).wk === week
  } catch {
    return false
  }
}
