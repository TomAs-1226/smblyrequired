// Cycle Rush's server client: the weekly code and the leaderboard.
//
// The server is a small API on its own host (server/arcade/). Its base URL comes
// from VITE_ARCADE_API at build time. Without it there is no code to ask for and
// no leaderboard: the game is open and keeps only a personal best in this browser.

const BASE = (import.meta.env.VITE_ARCADE_API || '').replace(/\/+$/, '')
export const leaderboardEnabled = Boolean(BASE)
export const serverConfigured = Boolean(BASE)

// ---- the weekly code
// A correct code earns a pass for the rest of the week; it is kept in this browser.
const PASS_KEY = 'frc5805.arcade.pass'
let memoryPass = '' // for browsers that block storage
export function storedPass() {
  try {
    return localStorage.getItem(PASS_KEY) || memoryPass
  } catch {
    return memoryPass
  }
}
function keepPass(pass) {
  memoryPass = pass || ''
  try {
    if (pass) localStorage.setItem(PASS_KEY, pass)
    else localStorage.removeItem(PASS_KEY)
  } catch {
    // kept in memory for this visit only
  }
}
const authHeaders = () => (storedPass() ? { Authorization: `Bearer ${storedPass()}` } : {})

/**
 * Whether this visitor may play: 'open' (no code asked for), 'unlocked' (a pass
 * for this week), 'locked' (needs this week's code) or 'offline' (the server
 * that checks codes cannot be reached).
 */
export async function accessState() {
  if (!BASE) return 'open'
  try {
    const { required } = await request('/api/access')
    if (!required) return 'open'
    const pass = storedPass()
    if (!pass) return 'locked'
    const { ok } = await request('/api/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pass }),
    })
    if (ok) return 'unlocked'
    keepPass('') // last week's pass
    return 'locked'
  } catch {
    return 'offline'
  }
}

/** Trade this week's code for a pass. Throws the server's message if it is wrong. */
export async function unlock(code) {
  const { pass } = await request('/api/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  if (pass) keepPass(pass)
}

const BEST_KEY = (d) => `frc5805.arcade.best.${d}`

export function localBest(difficulty) {
  try {
    return Number(localStorage.getItem(BEST_KEY(difficulty))) || 0
  } catch {
    return 0
  }
}

export function saveLocalBest(difficulty, score) {
  try {
    if (score > localBest(difficulty)) localStorage.setItem(BEST_KEY(difficulty), String(score))
  } catch {
    // private window or blocked storage: the best simply is not remembered
  }
}

async function request(path, init) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 6000)
  try {
    const res = await fetch(BASE + path, { ...init, signal: ctrl.signal })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || `The arcade server answered ${res.status}.`)
    return body
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchTop(difficulty) {
  if (!BASE) return []
  const body = await request(`/api/scores?difficulty=${encodeURIComponent(difficulty)}`)
  return Array.isArray(body.scores) ? body.scores : []
}

/**
 * Tell the server a match is starting. It hands back a run id and refuses a
 * score for that run until a whole match could have been played. A best-effort
 * call: if it fails, the match still plays, it just cannot be posted.
 */
export async function startRun(difficulty) {
  if (!BASE) return null
  try {
    const body = await request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ difficulty }),
    })
    return body.run || null
  } catch {
    return null
  }
}

/** @returns {Promise<{rank:number}>} */
export function submitScore(entry) {
  return request('/api/scores', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(entry),
  })
}
