// Build-time fetch of live competition data from The Blue Alliance.
// Writes src/data/live.json (data only — the API key never ships to the client).
// Run: node --env-file=.env scripts/fetch-tba.mjs   (key in .env as TBA_KEY=...)
// Gracefully no-ops if TBA_KEY is missing, keeping any existing live.json.
import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Load .env (if present) so `node scripts/fetch-tba.mjs` works without --env-file.
try {
  const env = readFileSync(fileURLToPath(new URL('../.env', import.meta.url)), 'utf8')
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch {
  /* no .env — fine, we'll just no-op below */
}

const KEY = process.env.TBA_KEY
const OUT = fileURLToPath(new URL('../src/data/live.json', import.meta.url))
const TEAM = 'frc5805'
const SEASON = 2026

if (!KEY) {
  console.log('[tba] No TBA_KEY set — skipping fetch (keeping existing live.json).')
  process.exit(0)
}

const BASE = 'https://www.thebluealliance.com/api/v3'
const headers = { 'X-TBA-Auth-Key': KEY }
const get = async (p) => {
  const r = await fetch(BASE + p, { headers })
  if (!r.ok) throw new Error(`${p} -> ${r.status}`)
  return r.json()
}
const strip = (html) => (html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

try {
  const events = (await get(`/team/${TEAM}/events/${SEASON}/simple`)).sort((a, b) =>
    (a.start_date || '').localeCompare(b.start_date || '')
  )
  const statuses = await get(`/team/${TEAM}/events/${SEASON}/statuses`).catch(() => ({}))

  const eventRows = events.map((e) => {
    const s = statuses[e.key] || {}
    const rank = s.qual && s.qual.ranking ? s.qual.ranking.rank : null
    const total = s.qual && s.qual.num_teams ? s.qual.num_teams : null
    const rec = s.qual && s.qual.ranking ? s.qual.ranking.record : null
    return {
      key: e.key,
      name: e.name,
      dates: e.start_date,
      rank,
      total,
      record: rec ? `${rec.wins}-${rec.losses}-${rec.ties}` : null,
      result: strip(s.overall_status_str) || null,
    }
  })

  // Most-recent event (last by date) → pull recent matches for a "from the field" feed.
  const last = events[events.length - 1]
  let recentMatches = []
  let lastEvent = null
  if (last) {
    const s = statuses[last.key] || {}
    lastEvent = {
      key: last.key,
      name: last.name,
      dates: last.start_date,
      rank: s.qual && s.qual.ranking ? s.qual.ranking.rank : null,
      total: s.qual ? s.qual.num_teams : null,
      result: strip(s.overall_status_str) || null,
    }
    const matches = await get(`/team/${TEAM}/event/${last.key}/matches/simple`).catch(() => [])
    const order = { qm: 0, ef: 1, qf: 2, sf: 3, f: 4 }
    matches.sort(
      (a, b) =>
        (order[a.comp_level] ?? 9) - (order[b.comp_level] ?? 9) ||
        (a.match_number || 0) - (b.match_number || 0)
    )
    recentMatches = matches
      .filter((m) => m.alliances && m.winning_alliance !== undefined)
      .map((m) => {
        const onRed = (m.alliances.red.team_keys || []).includes(TEAM)
        const us = onRed ? 'red' : 'blue'
        const them = onRed ? 'blue' : 'red'
        const usScore = m.alliances[us].score
        const themScore = m.alliances[them].score
        const label =
          (m.comp_level === 'qm' ? 'Qual ' : m.comp_level.toUpperCase() + ' ') + m.match_number
        let outcome = 'T'
        if (m.winning_alliance === us) outcome = 'W'
        else if (m.winning_alliance === them) outcome = 'L'
        return { label, usScore, themScore, outcome }
      })
      .slice(-8)
  }

  const data = {
    updated: new Date().toISOString(),
    season: SEASON,
    events: eventRows,
    lastEvent,
    recentMatches,
    source: `https://www.thebluealliance.com/team/5805/${SEASON}`,
  }
  writeFileSync(OUT, JSON.stringify(data, null, 2))
  console.log(`[tba] wrote ${OUT} — ${eventRows.length} events, ${recentMatches.length} matches`)
} catch (err) {
  console.error('[tba] fetch failed:', err.message)
  if (!existsSync(OUT)) {
    writeFileSync(OUT, JSON.stringify({ updated: null, season: SEASON, events: [], recentMatches: [] }, null, 2))
    console.log('[tba] wrote empty live.json fallback')
  }
  process.exit(0)
}
