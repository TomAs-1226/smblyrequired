// Cycle Rush leaderboard API. One file, no dependencies: node:http + node:sqlite.
//
//   GET  /api/health
//   POST /api/runs     { difficulty }                         → { run }
//   POST /api/scores   { run, name, difficulty, blue, red, made, fired } → { rank }
//   GET  /api/scores?difficulty=regional                    → { scores: [...] }
//
// It sits behind Caddy (TLS) on the Oracle VM; see docs/ARCADE.md.
//
// About cheating: the game runs in the browser, so a determined person can post
// any number. The run id makes that cost a real two-minute wait per score and
// stops replaying one run, the bounds stop absurd numbers, and the rate limits
// stop floods. It is a school leaderboard, not a bank; that is the bar.

import http from 'node:http'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const env = (k, d) => process.env[k] ?? d
const PORT = Number(env('ARCADE_PORT', 8787))
const HOST = env('ARCADE_HOST', '127.0.0.1')
const DB_PATH = env('ARCADE_DB', './data/arcade.db')
const ORIGINS = new Set(
  env('ARCADE_ORIGINS', 'https://frc5805.com,https://www.frc5805.com,http://localhost:5173')
    .split(',').map((s) => s.trim()).filter(Boolean),
)
// A match is 3 s of countdown + 120 s. Allow a little clock slack either side.
const MIN_MATCH_S = Number(env('ARCADE_MIN_MATCH_SECONDS', 118))
const MAX_RUN_S = 2 * 60 * 60
const TRUST_PROXY = env('ARCADE_TRUST_PROXY', '1') === '1'

const DIFFICULTIES = new Set(['rookie', 'regional', 'einstein'])
const MAX_SCORE = 600 // far above anything the engine produces in 120 s
const NAME_RE = /^[\p{L}\p{N} ._'-]{1,16}$/u
// Short and blunt. Anything it misses, an admin deletes by hand (docs/ARCADE.md).
const BLOCKED = /(fuck|shit|bitch|cunt|nigg|fag|rape|porn|penis|vagina|dick|cock|pussy|whore|slut|retard|nazi|hitler)/i

// ---------------------------------------------------------------- storage
mkdirSync(dirname(DB_PATH), { recursive: true })
const db = new DatabaseSync(DB_PATH)
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    difficulty TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    difficulty TEXT NOT NULL,
    blue INTEGER NOT NULL,
    red INTEGER NOT NULL,
    made INTEGER NOT NULL,
    fired INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS scores_board ON scores (difficulty, blue DESC, created_at);
`)
const q = {
  insertRun: db.prepare('INSERT INTO runs (id, difficulty, started_at) VALUES (?, ?, ?)'),
  getRun: db.prepare('SELECT * FROM runs WHERE id = ?'),
  useRun: db.prepare('UPDATE runs SET used = 1 WHERE id = ? AND used = 0'),
  pruneRuns: db.prepare('DELETE FROM runs WHERE started_at < ?'),
  insertScore: db.prepare(
    'INSERT INTO scores (name, difficulty, blue, red, made, fired, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ),
  top: db.prepare(
    `SELECT name, blue, red, made, fired, created_at FROM scores
     WHERE difficulty = ? ORDER BY blue DESC, (blue - red) DESC, created_at ASC LIMIT 10`,
  ),
  rank: db.prepare(
    `SELECT COUNT(*) + 1 AS rank FROM scores
     WHERE difficulty = ? AND (blue > ? OR (blue = ? AND blue - red > ?))`,
  ),
}
const now = () => Math.floor(Date.now() / 1000)
setInterval(() => q.pruneRuns.run(now() - MAX_RUN_S), 10 * 60 * 1000).unref()

// ---------------------------------------------------------------- rate limits
const buckets = new Map()
function limited(key, max, windowS) {
  const t = Date.now()
  const b = buckets.get(key)
  if (!b || t > b.reset) {
    buckets.set(key, { n: 1, reset: t + windowS * 1000 })
    return false
  }
  b.n++
  return b.n > max
}
setInterval(() => {
  const t = Date.now()
  for (const [k, b] of buckets) if (t > b.reset) buckets.delete(k)
}, 60 * 1000).unref()

// ---------------------------------------------------------------- http
function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = req.headers['x-forwarded-for']
    if (typeof xf === 'string' && xf) return xf.split(',')[0].trim()
  }
  return req.socket.remoteAddress || 'unknown'
}

function send(res, status, body, origin) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }
  if (origin && ORIGINS.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
    headers['Vary'] = 'Origin'
  }
  res.writeHead(status, headers)
  res.end(body === null ? '' : JSON.stringify(body))
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 2048) { reject(new Error('too large')); req.destroy() } else chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { reject(new Error('bad json')) }
    })
    req.on('error', reject)
  })
}

const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi

export function validateScore(body) {
  if (!body || typeof body !== 'object') return 'Bad request.'
  const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : ''
  if (!NAME_RE.test(name)) return 'Names are 1–16 letters, numbers, spaces, or . _ \' -'
  if (BLOCKED.test(name.replace(/[^a-z]/gi, ''))) return 'Pick a different name.'
  if (!DIFFICULTIES.has(body.difficulty)) return 'Unknown difficulty.'
  if (!int(body.blue, 0, MAX_SCORE) || !int(body.red, 0, MAX_SCORE)) return 'That score is out of range.'
  if (!int(body.fired, 0, MAX_SCORE) || !int(body.made, 0, body.fired)) return 'That score is out of range.'
  if (body.made > body.blue) return 'That score is out of range.'
  if (typeof body.run !== 'string' || !/^[a-f0-9]{32}$/.test(body.run)) return 'This match was not registered, so it cannot be posted.'
  return null
}

async function handle(req, res) {
  const origin = req.headers.origin
  const url = new URL(req.url, 'http://x')
  const ip = clientIp(req)

  if (req.method === 'OPTIONS') {
    if (!origin || !ORIGINS.has(origin)) return send(res, 403, null)
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    })
    return res.end()
  }
  if (req.method === 'POST' && origin && !ORIGINS.has(origin)) {
    return send(res, 403, { error: 'Origin not allowed.' })
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return send(res, 200, { ok: true }, origin)
  }

  if (req.method === 'GET' && url.pathname === '/api/scores') {
    if (limited(`get:${ip}`, 120, 60)) return send(res, 429, { error: 'Slow down.' }, origin)
    const d = url.searchParams.get('difficulty')
    if (!DIFFICULTIES.has(d)) return send(res, 400, { error: 'Unknown difficulty.' }, origin)
    return send(res, 200, { scores: q.top.all(d) }, origin)
  }

  if (req.method === 'POST' && url.pathname === '/api/runs') {
    if (limited(`run:${ip}`, 40, 600)) return send(res, 429, { error: 'Slow down.' }, origin)
    const body = await readJson(req).catch(() => null)
    if (!body || !DIFFICULTIES.has(body.difficulty)) return send(res, 400, { error: 'Unknown difficulty.' }, origin)
    const run = crypto.randomBytes(16).toString('hex')
    q.insertRun.run(run, body.difficulty, now())
    return send(res, 201, { run }, origin)
  }

  if (req.method === 'POST' && url.pathname === '/api/scores') {
    if (limited(`score:${ip}`, 12, 600)) return send(res, 429, { error: 'Too many scores from here. Try again in a few minutes.' }, origin)
    const body = await readJson(req).catch(() => null)
    const bad = validateScore(body)
    if (bad) return send(res, 400, { error: bad }, origin)
    const run = q.getRun.get(body.run)
    if (!run || run.difficulty !== body.difficulty) return send(res, 400, { error: 'This match was not registered, so it cannot be posted.' }, origin)
    const age = now() - run.started_at
    if (age < MIN_MATCH_S) return send(res, 400, { error: 'That match ended faster than a match can.' }, origin)
    if (age > MAX_RUN_S) return send(res, 400, { error: 'That match is too old to post.' }, origin)
    if (q.useRun.run(body.run).changes !== 1) return send(res, 409, { error: 'This match is already posted.' }, origin)
    const name = body.name.trim().replace(/\s+/g, ' ')
    q.insertScore.run(name, body.difficulty, body.blue, body.red, body.made, body.fired, now())
    const { rank } = q.rank.get(body.difficulty, body.blue, body.blue, body.blue - body.red)
    return send(res, 201, { rank }, origin)
  }

  return send(res, 404, { error: 'Not found.' }, origin)
}

export const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err)
    if (!res.headersSent) send(res, 500, { error: 'Server error.' })
  })
})

export const listen = () => server.listen(PORT, HOST, () => console.log(`arcade api on ${HOST}:${PORT}`))
export const closeDb = () => db.close()
