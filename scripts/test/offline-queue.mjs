#!/usr/bin/env node
/**
 * What the offline queue does with each server answer.
 *
 *   npm run test:queue
 *
 * These are the rules that decide whether a scout's entry is kept, retried, or
 * dropped from the phone — and dropping is irreversible. Two of them were wrong
 * and are pinned here:
 *
 *   - every 23505 was treated as "already delivered", so a re-scouted match
 *     (which collides on scout_entries_one_per_match, not client_uuid) was
 *     deleted from the phone and reported synced while the server kept the old
 *     version;
 *   - a photo row carrying a file_id but no bytes was rejected as "no file
 *     attached" and retried forever, so it never reached its team.
 *
 * Runs against a fake Supabase client: no network, no browser.
 */

import { pushRow, uniqueKind, isTerminal } from '../../src/lib/queuePush.js'

// --- a fake client that answers from a script --------------------------------
// Each table call consumes the next scripted answer for that (table, op), and
// every call is recorded so a test can assert what was — and was not — sent.
function fakeClient(script = {}) {
  const calls = []
  const answer = (key) => {
    const queue = script[key] ?? []
    return queue.length ? queue.shift() : { data: null, error: null }
  }
  function builder(table) {
    let op = 'select'
    const rec = { table, op, filters: [], payload: null }
    const chain = {
      insert(p) { op = rec.op = 'insert'; rec.payload = p; return chain },
      update(p) { op = rec.op = 'update'; rec.payload = p; return chain },
      select() { return chain },
      eq(c, v) { rec.filters.push(['eq', c, v]); return chain },
      lt(c, v) { rec.filters.push(['lt', c, v]); return chain },
      single() { return chain },
      maybeSingle() { return chain },
      then(resolve, reject) {
        calls.push(rec)
        return Promise.resolve(answer(`${table}.${op}`)).then(resolve, reject)
      },
    }
    return chain
  }
  return {
    calls,
    from: builder,
    auth: { getUser: async () => ({ data: { user: { id: 'u-1' } } }) },
    storage: {
      from: (bucket) => ({
        upload: async (path) => {
          calls.push({ table: `storage:${bucket}`, op: 'upload', payload: path })
          return answer(`storage.upload`)
        },
      }),
    },
  }
}

const entryHandler = { kind: 'table', table: 'scout_entries' }
const photoHandler = { kind: 'storage', table: 'robot_photos' }

const entry = (over = {}) => ({
  client_uuid: 'c-1',
  kind: 'scout_entry',
  payload: {
    client_uuid: 'c-1', kind: 'match', event_key: '2026test', team_number: 5805,
    match_key: '2026test_qm2', match_number: 2, comp_level: 'qm', alliance: 'blue',
    data: { total_score: 11 }, notes: null, scout_id: 'u-1',
    recorded_at: '2026-03-06T20:00:00.000Z', ...over,
  },
})

const dup = (constraint) => ({
  error: {
    code: '23505',
    message: `duplicate key value violates unique constraint "${constraint}"`,
    details: 'Key (...) already exists.',
  },
})

let passed = 0
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok    ${name}`)
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`)
    process.exitCode = 1
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

// --- scouting entries ------------------------------------------------------------

await check('a clean insert is delivered', async () => {
  const c = fakeClient()
  const r = await pushRow(c, entry(), entryHandler)
  assert(r.ok && !r.deduped, JSON.stringify(r))
})

await check('client_uuid collision = an earlier attempt landed (success)', async () => {
  const c = fakeClient({ 'scout_entries.insert': [dup('scout_entries_client_uuid_key')] })
  const r = await pushRow(c, entry(), entryHandler)
  assert(r.ok && r.deduped, JSON.stringify(r))
  assert(!c.calls.some((x) => x.op === 'update'), 'must not rewrite a delivered row')
})

await check('re-scouted match becomes a correction of the scout’s own row', async () => {
  const c = fakeClient({
    'scout_entries.insert': [dup('scout_entries_one_per_match')],
    'scout_entries.update': [{ data: [{ id: 'e-1' }], error: null }],
  })
  const r = await pushRow(c, entry(), entryHandler)
  assert(r.ok && r.corrected, JSON.stringify(r))
  const upd = c.calls.find((x) => x.op === 'update')
  assert(upd, 'no correction was sent')
  assert(upd.payload.data.total_score === 11, 'correction did not carry the new answers')
  const f = Object.fromEntries(upd.filters.map(([k, col, v]) => [`${k}:${col}`, v]))
  assert(f['eq:scout_id'] === 'u-1' && f['eq:match_key'] === '2026test_qm2', 'correction not scoped to own match')
  assert(f['lt:recorded_at'] === '2026-03-06T20:00:00.000Z', 'correction must only overwrite an OLDER entry')
})

await check('a correction older than the server copy is superseded, not forced', async () => {
  const c = fakeClient({
    'scout_entries.insert': [dup('scout_entries_one_per_match')],
    'scout_entries.update': [{ data: [], error: null }],
  })
  const r = await pushRow(c, entry(), entryHandler)
  assert(r.ok && r.superseded, JSON.stringify(r))
})

await check('an unrecognised unique violation is NOT treated as delivered', async () => {
  const c = fakeClient({ 'scout_entries.insert': [dup('some_future_index')] })
  const r = await pushRow(c, entry(), entryHandler)
  assert(!r.ok, 'a collision on an unknown constraint was reported as synced')
})

await check('scouting window / active event refusals are terminal', async () => {
  const c = fakeClient({
    'scout_entries.insert': [
      { error: { code: 'P0001', message: 'scouting is closed right now (open 08:00:00 to 18:00:00, UTC time)' } },
    ],
  })
  const r = await pushRow(c, entry({ kind: 'pit', match_key: null }), entryHandler)
  assert(!r.ok && r.terminal && /scouting is closed/.test(r.error), JSON.stringify(r))
})

await check('daily limit (23514) and RLS (42501) are terminal', async () => {
  assert(isTerminal({ code: '23514' }) && isTerminal({ code: '42501' }), 'not terminal')
})

await check('a transport failure is retryable, never terminal', async () => {
  const c = fakeClient({ 'scout_entries.insert': [{ error: { message: 'Failed to fetch' } }] })
  const r = await pushRow(c, entry(), entryHandler)
  assert(!r.ok && !r.terminal, JSON.stringify(r))
})

await check('uniqueKind reads the constraint from message or details', async () => {
  assert(uniqueKind(dup('scout_entries_one_per_match').error, 'scout_entries') === 'same-match', 'match')
  assert(uniqueKind(dup('scout_entries_client_uuid_key').error, 'scout_entries') === 'delivered', 'uuid')
  assert(uniqueKind({ code: '23505', message: 'x', details: 'Key (client_uuid)=(c) exists' }, 'scout_entries') === 'delivered', 'details')
  assert(uniqueKind({ code: '42501' }, 'scout_entries') === null, 'non-23505')
})

// --- robot photos ------------------------------------------------------------------

const photo = (payload) => ({ client_uuid: 'p-1', kind: 'robot_photo', payload: { client_uuid: 'p-1', ...payload } })

await check('a link-only photo row (bytes already uploaded) is inserted, not rejected', async () => {
  const c = fakeClient()
  const r = await pushRow(c, photo({ team_number: 4414, angle: 'front', file_id: 'f-9', taken_by: 'u-1' }), photoHandler)
  assert(r.ok, JSON.stringify(r))
  assert(!c.calls.some((x) => x.op === 'upload'), 'should not re-upload')
  const ins = c.calls.find((x) => x.table === 'robot_photos' && x.op === 'insert')
  assert(ins?.payload.file_id === 'f-9', 'link not inserted with its file_id')
})

await check('a photo row with neither bytes nor file_id is terminal', async () => {
  const r = await pushRow(fakeClient(), photo({ team_number: 4414, angle: 'front' }), photoHandler)
  assert(!r.ok && r.terminal, JSON.stringify(r))
})

await check('a banked photo uploads, indexes, then links with the new file id', async () => {
  const c = fakeClient({ 'files.insert': [{ data: { id: 'f-new' }, error: null }] })
  const file = { size: 3, type: 'image/jpeg' }
  const r = await pushRow(
    c,
    photo({ team_number: 4414, angle: 'side', taken_by: 'u-1', _upload: { file, bucket: 'media', path: 'pit/x/4414/side.jpg', sha256: 'a'.repeat(64) } }),
    photoHandler
  )
  assert(r.ok, JSON.stringify(r))
  const order = c.calls.map((x) => `${x.table}.${x.op}`)
  assert(order.join(',') === 'storage:media.upload,files.insert,robot_photos.insert', order.join(','))
  const link = c.calls.find((x) => x.table === 'robot_photos')
  assert(link.payload.file_id === 'f-new' && !('_upload' in link.payload), 'link carried the wrong id or the bytes')
})

await check('a re-run after the files row landed reads its id back', async () => {
  const c = fakeClient({
    'files.insert': [{ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "files_bucket_path_key"' } }],
    'files.select': [{ data: { id: 'f-old' }, error: null }],
  })
  const r = await pushRow(
    c,
    photo({ team_number: 4414, angle: 'rear', _upload: { file: { size: 1 }, bucket: 'media', path: 'p.jpg' } }),
    photoHandler
  )
  assert(r.ok, JSON.stringify(r))
  assert(c.calls.find((x) => x.table === 'robot_photos').payload.file_id === 'f-old', 'did not reuse the existing id')
})

console.log(`\n${passed} queue case(s) passed`)
if (process.exitCode) console.error('QUEUE TESTS FAILED')
