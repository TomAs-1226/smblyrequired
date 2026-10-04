#!/usr/bin/env node
/**
 * What the offline queue does with each server answer.
 *
 *   npm run test:portal   (or: node scripts/test/offline-queue.mjs)
 *
 * These are the rules that decide whether a scout's entry is kept, retried, or
 * dropped from the phone — and dropping is irreversible. Three of them have been
 * wrong before and are pinned here:
 *
 *   - a second entry for a match the scout already logged was treated as
 *     "already delivered", so the correction was deleted from the phone and
 *     reported synced while the server kept the old version;
 *   - a photo carrying a file reference but no bytes was rejected as "no file
 *     attached" and retried forever, so it never reached its team;
 *   - every refusal by the security rules arrives as the same permission-denied,
 *     and a scout told only "you do not have access" cannot tell a closed
 *     scouting window from a real problem.
 *
 * Runs against a fake store standing in for Firestore and Storage: no network,
 * no browser, no SDK. firebase/test/rules.test.mjs is what proves the rules
 * themselves refuse what this file assumes they refuse.
 */

import { pushRow, isTerminal, isTransport, insideWindow, entryDoc } from '../../src/lib/queuePush.js'
import { entryId, fileId } from '../../src/lib/ids.js'

// --- a fake store -----------------------------------------------------------------
// Documents live in a Map keyed 'collection/id'. `fail` scripts errors: each key
// ('transaction', 'commit', 'create scout_entries', 'get files', 'upload') holds a
// queue, and each call takes the next item — an error to throw, or null to let
// that call through. Every call is recorded so a test can assert what was — and
// was not — sent.
const SERVER_TIME = { serverTime: true }
const err = (code, message = code) => Object.assign(new Error(message), { code })
const denied = () => err('permission-denied', 'Missing or insufficient permissions.')

// Stored documents read back as rows do in the app: times as ISO strings.
const asStored = (doc) =>
  Object.fromEntries(Object.entries(doc).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]))

function fakeStore({ uid = 'u-1', docs = {}, fail = {} } = {}) {
  const data = new Map(Object.entries(docs))
  const calls = []
  const maybeFail = (key) => {
    const next = fail[key]?.shift()
    if (next) throw next
  }
  const read = (collection, id) => data.get(`${collection}/${id}`) ?? null
  return {
    calls,
    data,
    doc: read,
    uid: () => uid,
    serverTime: () => SERVER_TIME,
    async get(collection, id) {
      calls.push({ op: 'get', collection, id })
      maybeFail(`get ${collection}`)
      return read(collection, id)
    },
    // As the rules do: a document that exists cannot be created again.
    async create(collection, id, doc) {
      calls.push({ op: 'create', collection, id, doc })
      maybeFail(`create ${collection}`)
      if (data.has(`${collection}/${id}`)) throw denied()
      data.set(`${collection}/${id}`, asStored(doc))
    },
    async transaction(fn) {
      maybeFail('transaction')
      const writes = []
      const result = await fn({
        get: async (collection, id) => read(collection, id),
        create: (collection, id, doc) => writes.push({ op: 'create', collection, id, doc }),
        update: (collection, id, doc) => writes.push({ op: 'update', collection, id, doc }),
      })
      if (writes.length) maybeFail('commit')
      for (const w of writes) {
        const key = `${w.collection}/${w.id}`
        data.set(key, asStored(w.op === 'update' ? { ...data.get(key), ...w.doc } : w.doc))
        calls.push(w)
      }
      return result
    },
    async upload(bucket, path, file, meta) {
      calls.push({ op: 'upload', bucket, path, meta })
      maybeFail('upload')
    },
  }
}

const entryHandler = { kind: 'entry' }
const photoHandler = { kind: 'photo' }

const entry = (over = {}) => ({
  client_uuid: over.client_uuid ?? 'c-1',
  kind: 'scout_entry',
  payload: {
    client_uuid: 'c-1', form_id: 'f-1', kind: 'match', event_key: '2026test', team_number: 5805,
    match_key: '2026test_qm2', match_number: 2, comp_level: 'qm', alliance: 'blue',
    data: { total_score: 11 }, notes: null, scout_id: 'u-1',
    recorded_at: '2026-03-06T20:00:00.000Z', ...over,
  },
})
const pit = (over = {}) =>
  entry({ kind: 'pit', match_key: null, match_number: null, comp_level: null, alliance: null, ...over })

const MATCH_ID = 'm:2026test:5805:2026test_qm2:u-1'
const PIT_ID = (slot) => `p:2026test:5805:pit:u-1:20260306:${slot}`
const writesOf = (store) => store.calls.filter((c) => c.op === 'create' || c.op === 'update')

// A window of 08:00–18:00 Pacific, saved while the zone was at UTC-8.
const settings = (over = {}) => ({
  active_event_key: null, lock_enabled: false, window_start: '08:00', window_end: '18:00',
  window_start_min: 480, window_end_min: 1080, timezone: 'America/Los_Angeles', utc_offset_min: -480,
  ...over,
})

let passed = 0
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok    ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}\n      ${error.message}`)
    process.exitCode = 1
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

// --- match entries ------------------------------------------------------------------

await check('a new match entry is created under the id its fields derive, whole', async () => {
  const s = fakeStore()
  const r = await pushRow(s, entry(), entryHandler)
  assert(r.ok && !r.deduped && !r.corrected, JSON.stringify(r))
  const [w] = writesOf(s)
  assert(w?.op === 'create' && w.id === MATCH_ID, `wrote ${w?.op} ${w?.id}`)
  assert(w.id === entryId(w.doc), 'the id does not match the document it holds')
  assert(w.doc.recorded_at instanceof Date && w.doc.recorded_day === 20260306, 'recorded_at / recorded_day')
  assert(w.doc.slot === null && w.doc.created_at === SERVER_TIME, 'slot must be null and created_at the server time')
  const fields = ['client_uuid', 'form_id', 'kind', 'event_key', 'team_number', 'match_key', 'match_number',
    'comp_level', 'alliance', 'data', 'notes', 'scout_id', 'recorded_at', 'recorded_day', 'slot', 'created_at']
  assert(fields.every((k) => k in w.doc) && Object.keys(w.doc).length === fields.length,
    `fields sent: ${Object.keys(w.doc).join(',')}`)
})

await check('the same client_uuid already there = an earlier attempt landed (success, nothing rewritten)', async () => {
  const s = fakeStore({ docs: { [`scout_entries/${MATCH_ID}`]: { client_uuid: 'c-1', recorded_at: '2026-03-06T20:00:00.000Z' } } })
  const r = await pushRow(s, entry(), entryHandler)
  assert(r.ok && r.deduped, JSON.stringify(r))
  assert(writesOf(s).length === 0, 'must not rewrite a delivered entry')
})

await check('a re-scouted match becomes a correction of the scout’s own older entry', async () => {
  const s = fakeStore({
    docs: { [`scout_entries/${MATCH_ID}`]: { client_uuid: 'c-0', scout_id: 'u-1', data: { total_score: 4 }, recorded_at: '2026-03-06T19:00:00.000Z', created_at: 'kept' } },
  })
  const r = await pushRow(s, entry(), entryHandler)
  assert(r.ok && r.corrected, JSON.stringify(r))
  const [w] = writesOf(s)
  assert(w?.op === 'update' && w.id === MATCH_ID, 'no correction was sent to the entry for that match')
  assert(w.doc.data.total_score === 11 && w.doc.client_uuid === 'c-1', 'correction did not carry the new answers')
  assert(w.doc.recorded_day === 20260306, 'a correction must move recorded_day with recorded_at')
  assert(!('created_at' in w.doc) && !('scout_id' in w.doc), 'a correction must not touch created_at or the scout')
  assert(s.doc('scout_entries', MATCH_ID).created_at === 'kept', 'created_at was overwritten')
})

await check('a correction older than the server copy is superseded, not forced', async () => {
  const s = fakeStore({ docs: { [`scout_entries/${MATCH_ID}`]: { client_uuid: 'c-9', recorded_at: '2026-03-06T21:00:00.000Z' } } })
  const r = await pushRow(s, entry(), entryHandler)
  assert(r.ok && r.superseded, JSON.stringify(r))
  assert(writesOf(s).length === 0, 'an older copy overwrote a newer one')
})

await check('an entry exactly as new as the server copy is superseded too', async () => {
  const s = fakeStore({ docs: { [`scout_entries/${MATCH_ID}`]: { client_uuid: 'c-9', recorded_at: '2026-03-06T20:00:00.000Z' } } })
  const r = await pushRow(s, entry(), entryHandler)
  assert(r.ok && r.superseded && writesOf(s).length === 0, JSON.stringify(r))
})

await check('a match entry with no match key is one write to u:{client_uuid}', async () => {
  const s = fakeStore()
  const r = await pushRow(s, entry({ event_key: null, match_key: null }), entryHandler)
  assert(r.ok, JSON.stringify(r))
  const [w] = writesOf(s)
  assert(w?.op === 'create' && w.id === 'u:c-1' && w.doc.slot === null, `wrote ${w?.op} ${w?.id}`)
})

await check('a refused u: write whose document holds this client_uuid was already delivered', async () => {
  const s = fakeStore({ docs: { 'scout_entries/u:c-1': { client_uuid: 'c-1' } } })
  const r = await pushRow(s, entry({ event_key: null, match_key: null }), entryHandler)
  assert(r.ok && r.deduped, JSON.stringify(r))
})

await check('a refused u: write that could not be checked stays retryable', async () => {
  const s = fakeStore({ fail: { 'create scout_entries': [denied()], 'get scout_entries': [err('unavailable')] } })
  const r = await pushRow(s, entry({ event_key: null, match_key: null }), entryHandler)
  assert(!r.ok && !r.terminal, JSON.stringify(r))
})

// --- pit and strategy passes -----------------------------------------------------------

await check('the first pit pass of the day takes slot 1, the second slot 2', async () => {
  const s = fakeStore()
  const first = await pushRow(s, pit(), entryHandler)
  const second = await pushRow(s, pit({ client_uuid: 'c-2' }), entryHandler)
  assert(first.ok && second.ok, JSON.stringify([first, second]))
  const ids = writesOf(s).map((w) => w.id)
  assert(ids.join() === [PIT_ID(1), PIT_ID(2)].join(), ids.join())
  assert(writesOf(s).every((w) => w.id === entryId(w.doc)), 'a pass was written under an id its fields do not derive')
  assert(s.doc('scout_entries', PIT_ID(2)).slot === 2, 'slot not recorded on the document')
})

await check('a retried pass finds itself in either slot and is not written twice', async () => {
  const s = fakeStore({
    docs: { [`scout_entries/${PIT_ID(1)}`]: { client_uuid: 'c-0' }, [`scout_entries/${PIT_ID(2)}`]: { client_uuid: 'c-1' } },
  })
  const r = await pushRow(s, pit(), entryHandler)
  assert(r.ok && r.deduped && writesOf(s).length === 0, JSON.stringify(r))
})

await check('a pass already delivered to slot 1 does not take slot 2 as well', async () => {
  const s = fakeStore({ docs: { [`scout_entries/${PIT_ID(1)}`]: { client_uuid: 'c-1' } } })
  const r = await pushRow(s, pit(), entryHandler)
  assert(r.ok && r.deduped && writesOf(s).length === 0, 'a delivered pass took the second slot as well')
})

await check('the third pass in a day is terminal, with the reason a scout can act on', async () => {
  const s = fakeStore({
    docs: { [`scout_entries/${PIT_ID(1)}`]: { client_uuid: 'c-7' }, [`scout_entries/${PIT_ID(2)}`]: { client_uuid: 'c-8' } },
  })
  const r = await pushRow(s, pit(), entryHandler)
  assert(!r.ok && r.terminal, JSON.stringify(r))
  assert(
    r.error ===
      "daily limit reached: 2 passes on team 5805 today. You get two per team per day. The allowance resets tomorrow — edit one of today's entries instead if you need to correct it.",
    r.error
  )
  assert(writesOf(s).length === 0, 'a third pass was written')
})

await check('the allowance is per kind and per UTC day of recorded_at', async () => {
  const s = fakeStore({
    docs: { [`scout_entries/${PIT_ID(1)}`]: { client_uuid: 'c-7' }, [`scout_entries/${PIT_ID(2)}`]: { client_uuid: 'c-8' } },
  })
  const strategy = await pushRow(s, pit({ kind: 'strategy' }), entryHandler)
  const nextDay = await pushRow(s, pit({ client_uuid: 'c-3', recorded_at: '2026-03-07T00:00:01.000Z' }), entryHandler)
  assert(strategy.ok && nextDay.ok, JSON.stringify([strategy, nextDay]))
  const ids = writesOf(s).map((w) => w.id)
  assert(ids[0] === 'p:2026test:5805:strategy:u-1:20260306:1' && ids[1] === 'p:2026test:5805:pit:u-1:20260307:1', ids.join())
})

// --- refusals ----------------------------------------------------------------------------

const CLOSED =
  'scouting is closed right now (open 08:00 to 18:00, America/Los_Angeles time). Entries can only be recorded inside the scouting window a lead has set.'

await check('a refusal outside the scouting window is terminal and says so', async () => {
  // 20:00 UTC is noon Pacific: open. 04:00 UTC is 20:00 Pacific: closed.
  const s = fakeStore({ docs: { 'scout_settings/main': settings({ lock_enabled: true }) }, fail: { commit: [denied()] } })
  const r = await pushRow(s, pit({ recorded_at: '2026-03-07T04:00:00.000Z' }), entryHandler)
  assert(!r.ok && r.terminal && r.error === CLOSED, JSON.stringify(r))
})

await check('the window is named before the event when both would refuse', async () => {
  const s = fakeStore({
    docs: { 'scout_settings/main': settings({ lock_enabled: true, active_event_key: '2026other' }) },
    fail: { commit: [denied()] },
  })
  const r = await pushRow(s, entry({ recorded_at: '2026-03-07T04:00:00.000Z' }), entryHandler)
  assert(r.terminal && r.error === CLOSED, JSON.stringify(r))
})

await check('a refusal for the wrong event is terminal and names both events', async () => {
  const s = fakeStore({
    docs: { 'scout_settings/main': settings({ active_event_key: '2026other' }), 'profiles/u-1': { role: 'member' } },
    fail: { commit: [denied()] },
  })
  const r = await pushRow(s, entry(), entryHandler)
  assert(!r.ok && r.terminal, JSON.stringify(r))
  assert(
    r.error ===
      'scouting is set to event 2026other, not 2026test. A lead controls which event is being scouted. Switch to it, or ask them to change it.',
    r.error
  )
  const none = fakeStore({
    docs: { 'scout_settings/main': settings({ active_event_key: '2026other' }), 'profiles/u-1': { role: 'member' } },
    fail: { 'create scout_entries': [denied()] },
  })
  const r2 = await pushRow(none, entry({ event_key: null, match_key: null }), entryHandler)
  assert(r2.terminal && /not \(none\)\./.test(r2.error), r2.error)
})

await check('a lead is exempt from the active event, so that is not the reason given', async () => {
  const s = fakeStore({
    docs: { 'scout_settings/main': settings({ active_event_key: '2026other' }), 'profiles/u-1': { role: 'lead' } },
    fail: { commit: [denied()] },
  })
  const r = await pushRow(s, entry(), entryHandler)
  assert(r.terminal && r.error === 'You do not have access to that.', JSON.stringify(r))
})

await check('any other refusal is terminal: "You do not have access to that."', async () => {
  const open = fakeStore({ docs: { 'scout_settings/main': settings({ lock_enabled: true }) }, fail: { commit: [denied()] } })
  const r = await pushRow(open, entry(), entryHandler)
  assert(!r.ok && r.terminal && r.error === 'You do not have access to that.', JSON.stringify(r))
  const unset = fakeStore({ fail: { commit: [denied()] } })
  const r2 = await pushRow(unset, entry(), entryHandler)
  assert(r2.terminal && r2.error === 'You do not have access to that.', JSON.stringify(r2))
})

await check('a refused correction is not blamed on the window (the window is a rule about creating)', async () => {
  const s = fakeStore({
    docs: {
      'scout_settings/main': settings({ lock_enabled: true }),
      [`scout_entries/${MATCH_ID}`]: { client_uuid: 'c-0', recorded_at: '2026-03-06T19:00:00.000Z' },
    },
    fail: { commit: [denied()] },
  })
  const r = await pushRow(s, entry({ recorded_at: '2026-03-07T04:00:00.000Z' }), entryHandler)
  assert(r.terminal && r.error === 'correction: You do not have access to that.', JSON.stringify(r))
})

await check('a refusal that cannot be explained for lack of signal stays retryable', async () => {
  const s = fakeStore({ fail: { commit: [denied()], 'get scout_settings': [err('unavailable')] } })
  const r = await pushRow(s, entry(), entryHandler)
  assert(!r.ok && !r.terminal, JSON.stringify(r))
})

await check('invalid-argument, failed-precondition and not-found are terminal', async () => {
  for (const code of ['invalid-argument', 'failed-precondition', 'not-found']) {
    const r = await pushRow(fakeStore({ fail: { transaction: [err(code, `the ${code} message`)] } }), entry(), entryHandler)
    assert(!r.ok && r.terminal && r.error === `the ${code} message`, `${code}: ${JSON.stringify(r)}`)
  }
  assert(isTerminal(err('permission-denied')) && isTerminal(err('storage/unauthorized')), 'refusals are terminal')
})

await check('no answer, a timeout and an expired session are retryable, never terminal', async () => {
  const failures = [err('unavailable'), err('deadline-exceeded'), err('unauthenticated'), err('aborted'), new Error('Failed to fetch')]
  for (const failure of failures) {
    const r = await pushRow(fakeStore({ fail: { transaction: [failure] } }), entry(), entryHandler)
    assert(!r.ok && !r.terminal, `${failure.code ?? failure.message}: ${JSON.stringify(r)}`)
  }
  assert(isTransport(err('unavailable')) && isTransport(new Error('Failed to fetch')), 'transport')
  assert(!isTransport(denied()) && !isTerminal(err('unavailable')), 'a refusal is not a transport failure')
})

await check('signed out, nothing is sent and nothing is marked refused', async () => {
  const s = fakeStore({ uid: null })
  const r = await pushRow(s, entry(), entryHandler)
  assert(!r.ok && !r.terminal && /sign in/i.test(r.error), JSON.stringify(r))
  assert(s.calls.length === 0, 'a signed-out push reached the server')
})

await check('the window is judged as the rules judge it: on the minute, with the stored offset', async () => {
  const day = settings({ lock_enabled: true })
  assert(insideWindow('2026-03-06T16:00:00.000Z', day), '08:00 local is the first open minute')
  assert(insideWindow('2026-03-07T02:00:59.000Z', day), '18:00:59 local is still the last open minute')
  assert(!insideWindow('2026-03-07T02:01:00.000Z', day), '18:01 local is closed')
  assert(!insideWindow('2026-03-06T15:59:59.000Z', day), '07:59 local is closed')
  const night = settings({ window_start: '22:00', window_end: '02:00', window_start_min: 1320, window_end_min: 120, utc_offset_min: 0 })
  assert(insideWindow('2026-03-06T23:30:00.000Z', night) && insideWindow('2026-03-06T01:00:00.000Z', night), 'overnight window')
  assert(!insideWindow('2026-03-06T12:00:00.000Z', night), 'noon is outside an overnight window')
})

await check('a row queued by an older build still goes out whole', async () => {
  const old = entryDoc({ client_uuid: 'c-1', kind: 'pit', team_number: '5805', data: { a: undefined, b: 2 }, recorded_at: '2026-03-06T23:59:59.000Z' }, 'u-1')
  assert(old.scout_id === 'u-1' && old.team_number === 5805 && old.recorded_day === 20260306, JSON.stringify(old))
  assert(old.event_key === null && old.form_id === null && old.notes === null && old.slot === null, 'unset fields must be null, not missing')
  assert(!('a' in old.data) && old.data.b === 2, 'undefined answers cannot be stored')
})

// --- robot photos ------------------------------------------------------------------

const photo = (payload) => ({ client_uuid: 'p-1', kind: 'robot_photo', payload: { client_uuid: 'p-1', ...payload } })
const FILE = { id: 'media~pit~x~4414~front.jpg', bucket: 'media', path: 'pit/x/4414/front.jpg' }

await check('a link-only photo (bytes already uploaded) is linked, not rejected', async () => {
  const s = fakeStore()
  const r = await pushRow(s, photo({ team_number: 4414, angle: 'front', file: FILE, quality: { sharpness: 80 }, taken_by: 'u-1' }), photoHandler)
  assert(r.ok, JSON.stringify(r))
  assert(!s.calls.some((c) => c.op === 'upload'), 'should not re-upload')
  const [w] = writesOf(s)
  assert(w?.collection === 'robot_photos' && w.id === 'p-1', 'the photo id must be its client_uuid')
  assert(w.doc.file.id === FILE.id && w.doc.file.path === FILE.path, 'link not written with its file')
  const fields = ['client_uuid', 'event_key', 'team_number', 'angle', 'file', 'quality', 'taken_by', 'created_at']
  assert(fields.every((k) => k in w.doc) && Object.keys(w.doc).length === fields.length, Object.keys(w.doc).join(','))
  assert(w.doc.event_key === null, 'an unset event must be null, not missing')
})

await check('a photo with neither bytes nor a file reference is terminal', async () => {
  const r = await pushRow(fakeStore(), photo({ team_number: 4414, angle: 'front' }), photoHandler)
  assert(!r.ok && r.terminal, JSON.stringify(r))
})

await check('a banked photo uploads, indexes, then links — in that order, owned by the scout', async () => {
  const s = fakeStore()
  const path = 'pit/x/4414/side.jpg'
  const r = await pushRow(
    s,
    photo({ team_number: 4414, angle: 'side', taken_by: 'u-1', _upload: { file: { size: 3, type: 'image/jpg' }, bucket: 'media', path, title: 'Team 4414 — Side', season: 2026, sha256: 'a'.repeat(64) } }),
    photoHandler
  )
  assert(r.ok, JSON.stringify(r))
  const order = s.calls.filter((c) => c.op !== 'get').map((c) => `${c.op} ${c.collection ?? c.bucket}`)
  assert(order.join(', ') === 'upload media, create files, create robot_photos', order.join(', '))
  const up = s.calls.find((c) => c.op === 'upload')
  assert(up.path === path && up.meta.owner === 'u-1' && up.meta.contentType === 'image/jpeg', JSON.stringify(up))
  const index = s.calls.find((c) => c.collection === 'files' && c.op === 'create')
  assert(index.id === fileId('media', path) && index.doc.uploaded_by === 'u-1' && index.doc.byte_size === 3, JSON.stringify(index))
  assert(index.doc.created_at === SERVER_TIME && index.doc.updated_at === SERVER_TIME && Array.isArray(index.doc.tags), 'files document incomplete')
  const link = s.calls.find((c) => c.collection === 'robot_photos')
  assert(link.doc.file.id === index.id && link.doc.file.bucket === 'media' && !('_upload' in link.doc), 'link carried the wrong file or the bytes')
})

await check('a re-run after the files document landed reuses it and does not upload again', async () => {
  const path = 'pit/x/4414/rear.jpg'
  const s = fakeStore({ docs: { [`files/${fileId('media', path)}`]: { bucket: 'media', path } } })
  const r = await pushRow(s, photo({ team_number: 4414, angle: 'rear', _upload: { file: { size: 1 }, bucket: 'media', path } }), photoHandler)
  assert(r.ok, JSON.stringify(r))
  assert(!s.calls.some((c) => c.op === 'upload'), 'the photo was sent a second time')
  assert(!s.calls.some((c) => c.collection === 'files' && c.op === 'create'), 'a second files document was written')
  assert(s.doc('robot_photos', 'p-1').file.id === fileId('media', path), 'did not reuse the existing file')
})

await check('a photo document already there = delivered, nothing rewritten', async () => {
  const s = fakeStore({ docs: { 'robot_photos/p-1': { client_uuid: 'p-1' } } })
  const r = await pushRow(s, photo({ team_number: 4414, angle: 'front', file: FILE }), photoHandler)
  assert(r.ok && r.deduped && writesOf(s).length === 0, JSON.stringify(r))
})

await check('an upload that got no answer is retried; one the rules refused is terminal', async () => {
  const banked = () => photo({ team_number: 4414, angle: 'side', _upload: { file: { size: 3, type: 'image/jpeg' }, bucket: 'media', path: 'p.jpg' } })
  const dropped = await pushRow(fakeStore({ fail: { upload: [err('storage/retry-limit-exceeded')] } }), banked(), photoHandler)
  assert(!dropped.ok && !dropped.terminal, JSON.stringify(dropped))
  const cancelled = await pushRow(fakeStore({ fail: { upload: [err('storage/canceled')] } }), banked(), photoHandler)
  assert(!cancelled.ok && !cancelled.terminal, JSON.stringify(cancelled))
  const refused = await pushRow(fakeStore({ fail: { upload: [err('storage/unauthorized')] } }), banked(), photoHandler)
  assert(!refused.ok && refused.terminal && /^upload: /.test(refused.error), JSON.stringify(refused))
})

await check('a refused photo link is terminal; a dropped one is retried', async () => {
  const link = () => photo({ team_number: 4414, angle: 'front', file: FILE })
  const refused = await pushRow(fakeStore({ fail: { commit: [denied()] } }), link(), photoHandler)
  assert(!refused.ok && refused.terminal && refused.error === 'You do not have access to that.', JSON.stringify(refused))
  const dropped = await pushRow(fakeStore({ fail: { transaction: [err('unavailable')] } }), link(), photoHandler)
  assert(!dropped.ok && !dropped.terminal, JSON.stringify(dropped))
})

await check('an unknown kind is terminal', async () => {
  const r = await pushRow(fakeStore(), { client_uuid: 'x', kind: 'mystery', payload: {} }, undefined)
  assert(!r.ok && r.terminal, JSON.stringify(r))
})

console.log(`\n${passed} queue case(s) passed`)
if (process.exitCode) console.error('QUEUE TESTS FAILED')
