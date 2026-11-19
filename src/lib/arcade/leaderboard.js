// Cycle Rush leaderboard client.
//
// The leaderboard is a small API on its own host (server/arcade/). Its base URL
// comes from VITE_ARCADE_API at build time; without it the game still works and
// keeps only a personal best in this browser.

const BASE = (import.meta.env.VITE_ARCADE_API || '').replace(/\/+$/, '')
export const leaderboardEnabled = Boolean(BASE)

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
    if (!res.ok) throw new Error(body.error || `Leaderboard error (${res.status})`)
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
      headers: { 'Content-Type': 'application/json' },
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  })
}
