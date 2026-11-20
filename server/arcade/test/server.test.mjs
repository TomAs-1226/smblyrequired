// The leaderboard API end to end, on a throwaway database and a random port.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'arcade-'))
process.env.ARCADE_DB = join(dir, 'test.db')
process.env.ARCADE_MIN_MATCH_SECONDS = '0'
process.env.ARCADE_TRUST_PROXY = '1'
const { server, closeDb } = await import('../server.mjs')

let base
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => {
  server.close()
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

let ipN = 0
const call = (path, body, { origin = 'https://frc5805.com', ip } = {}) =>
  fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      Origin: origin,
      'X-Forwarded-For': ip || `10.0.0.${++ipN}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
const newRun = async (difficulty = 'regional') => (await (await call('/api/runs', { difficulty })).json()).run
const entry = (run, extra = {}) => ({ run, name: 'Ada', difficulty: 'regional', blue: 120, red: 90, made: 20, fired: 30, ...extra })

test('a registered run posts once and ranks', async () => {
  const run = await newRun()
  const res = await call('/api/scores', entry(run))
  assert.equal(res.status, 201)
  assert.equal((await res.json()).rank, 1)
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://frc5805.com')
  const again = await call('/api/scores', entry(run))
  assert.equal(again.status, 409)
})

test('the board is sorted by blue score, then margin', async () => {
  await call('/api/scores', entry(await newRun(), { name: 'Low', blue: 50, red: 10, made: 5 }))
  await call('/api/scores', entry(await newRun(), { name: 'High', blue: 200, red: 10 }))
  await call('/api/scores', entry(await newRun(), { name: 'Tie wide', blue: 120, red: 20 }))
  const { scores } = await (await call('/api/scores?difficulty=regional')).json()
  assert.deepEqual(scores.map((s) => s.name), ['High', 'Tie wide', 'Ada', 'Low'])
})

test('scores need a real run of the same difficulty', async () => {
  assert.equal((await call('/api/scores', entry('f'.repeat(32)))).status, 400)
  assert.equal((await call('/api/scores', entry(undefined))).status, 400)
  const einstein = await newRun('einstein')
  assert.equal((await call('/api/scores', entry(einstein))).status, 400)
})

test('out-of-range and impossible numbers are refused', async () => {
  for (const bad of [{ blue: 9999 }, { blue: -1 }, { blue: 1.5 }, { made: 40, fired: 30 }, { made: 200, blue: 100, fired: 300 }]) {
    const res = await call('/api/scores', entry(await newRun(), bad))
    assert.equal(res.status, 400, JSON.stringify(bad))
  }
})

test('names are checked', async () => {
  for (const name of ['', ' ', 'x'.repeat(17), '<script>', 'f u c k']) {
    const res = await call('/api/scores', entry(await newRun(), { name }))
    assert.equal(res.status, 400, name)
  }
})

test('other origins cannot post', async () => {
  const res = await call('/api/runs', { difficulty: 'regional' }, { origin: 'https://evil.example' })
  assert.equal(res.status, 403)
})

test('posting is rate limited per address', async () => {
  let last
  for (let i = 0; i < 14; i++) last = await call('/api/scores', { bad: true }, { ip: '10.9.9.9' })
  assert.equal(last.status, 429)
})

test('a score posted before a match could have ended is refused', async () => {
  // A second server with the real two-minute minimum, in its own process.
  const { spawn } = await import('node:child_process')
  const port = 20000 + Math.floor(Math.random() * 20000)
  const child = spawn(process.execPath, ['main.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, ARCADE_PORT: String(port), ARCADE_DB: join(dir, 'strict.db'), ARCADE_MIN_MATCH_SECONDS: '118' },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  try {
    await new Promise((r) => child.stdout.once('data', r))
    const url = `http://127.0.0.1:${port}`
    const post = (path, body) => fetch(url + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://frc5805.com' }, body: JSON.stringify(body),
    })
    const { run } = await (await post('/api/runs', { difficulty: 'regional' })).json()
    const res = await post('/api/scores', entry(run))
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /faster than a match/)
  } finally {
    child.kill()
    await new Promise((r) => child.once('exit', r))
  }
})

// ---------------------------------------------------------------- the weekly code
const { weekId, weeklyCode, codeMatches, issuePass, passValid } = await import('../access.mjs')
const SECRET = 'test-secret-'.padEnd(64, 'x')

test('the week rolls over at midnight Monday in the team timezone, not UTC', () => {
  // Sunday 23:30 in Los Angeles is already Monday in UTC.
  const sundayNight = new Date('2026-11-23T07:30:00Z') // Sun 22 Nov 2026, 23:30 PST
  const mondayMorning = new Date('2026-11-23T08:30:00Z') // Mon 23 Nov 2026, 00:30 PST
  assert.notEqual(weekId(sundayNight), weekId(mondayMorning))
  assert.equal(weekId(new Date('2026-11-24T20:00:00Z')), weekId(new Date('2026-11-29T20:00:00Z')), 'Tuesday and Sunday share a week')
  assert.equal(weekId(new Date('2027-01-01T20:00:00Z')), '2026-W53', 'ISO weeks cross the new year')
})

test('each week has its own code, and the code is easy to read out', () => {
  const codes = new Set()
  for (let w = 1; w <= 52; w++) codes.add(weeklyCode(SECRET, `2027-W${String(w).padStart(2, '0')}`))
  assert.ok(codes.size >= 51, 'codes do not repeat week to week')
  for (const c of codes) assert.match(c, /^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/)
  assert.notEqual(weeklyCode(SECRET, '2027-W01'), weeklyCode(`${SECRET}y`, '2027-W01'), 'another secret, another code')
})

test('a code matches with any case, spaces or dashes; last week’s does not', () => {
  const wk = weekId()
  const code = weeklyCode(SECRET, wk)
  assert.ok(codeMatches(SECRET, code))
  assert.ok(codeMatches(SECRET, ` ${code.toLowerCase().replace('-', ' ')} `))
  assert.ok(!codeMatches(SECRET, 'AAA-AAA'))
  assert.ok(!codeMatches(SECRET, ''))
  const lastWeek = weekId(new Date(Date.now() - 7 * 86400000))
  assert.ok(!codeMatches(SECRET, weeklyCode(SECRET, lastWeek)))
})

test('a pass is good for its week only, and cannot be forged', () => {
  const pass = issuePass(SECRET, '2027-W10')
  assert.ok(passValid(SECRET, pass, '2027-W10'))
  assert.ok(!passValid(SECRET, pass, '2027-W11'), 'expires at the rollover')
  const [payload, mac] = pass.split('.')
  const forged = Buffer.from(JSON.stringify({ wk: '2027-W11', n: 'x' })).toString('base64url')
  assert.ok(!passValid(SECRET, `${forged}.${mac}`, '2027-W11'), 'a changed week breaks the signature')
  assert.ok(!passValid(`${SECRET}y`, pass, '2027-W10'), 'another secret does not accept it')
  assert.ok(!passValid(SECRET, `${payload}.`, '2027-W10'))
  assert.ok(!passValid(SECRET, null))
})

test('with a secret set, the server asks for the code and guards the leaderboard', async () => {
  const { spawn } = await import('node:child_process')
  const port = 20000 + Math.floor(Math.random() * 20000)
  const child = spawn(process.execPath, ['main.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, ARCADE_PORT: String(port), ARCADE_DB: join(dir, 'locked.db'), ARCADE_CODE_SECRET: SECRET, ARCADE_MIN_MATCH_SECONDS: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  try {
    await new Promise((r) => child.stdout.once('data', r))
    const url = `http://127.0.0.1:${port}`
    const post = (path, body, headers = {}) => fetch(url + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://frc5805.com', 'X-Forwarded-For': '10.7.7.7', ...headers },
      body: JSON.stringify(body),
    })
    assert.deepEqual(await (await fetch(`${url}/api/access`)).json(), { required: true })
    // No pass: no runs, no scores.
    assert.equal((await post('/api/runs', { difficulty: 'regional' })).status, 401)
    // The wrong code is refused; the right one earns a pass.
    assert.equal((await post('/api/unlock', { code: 'AAA-AAA' })).status, 401)
    const ok = await post('/api/unlock', { code: weeklyCode(SECRET, weekId()) })
    assert.equal(ok.status, 200)
    const { pass } = await ok.json()
    assert.equal((await (await post('/api/check', { pass })).json()).ok, true)
    assert.equal((await (await post('/api/check', { pass: 'nope.nope' })).json()).ok, false)
    // The pass opens the leaderboard.
    const auth = { Authorization: `Bearer ${pass}` }
    const runRes = await post('/api/runs', { difficulty: 'regional' }, auth)
    assert.equal(runRes.status, 201)
    const { run } = await runRes.json()
    const scored = await post('/api/scores', { run, name: 'Ada', difficulty: 'regional', blue: 100, red: 50, made: 10, fired: 12 }, auth)
    assert.equal(scored.status, 201)
    // Guessing is rate limited.
    let last
    for (let i = 0; i < 9; i++) last = await post('/api/unlock', { code: 'BBB-BBB' }, { 'X-Forwarded-For': '10.8.8.8' })
    assert.equal(last.status, 429)
  } finally {
    child.kill()
    await new Promise((r) => child.once('exit', r))
  }
})

test('without a secret the arcade is open', async () => {
  const res = await call('/api/access')
  assert.deepEqual(await res.json(), { required: false })
  const run = await call('/api/runs', { difficulty: 'regional' })
  assert.equal(run.status, 201)
})
