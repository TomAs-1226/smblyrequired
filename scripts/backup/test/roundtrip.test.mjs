// The backup, end to end, against the local emulators: seed, mirror, inspect the
// snapshot, empty the emulators, restore, and compare what came back with what
// was there.
//
//   npx firebase --config firebase.backup-test.json emulators:exec \
//     --project demo-frc5805 "node scripts/backup/test/roundtrip.test.mjs"
//
// The comparison deliberately does not use the scripts' own encoding. "Before"
// and "after" are both read through the Firestore REST API, whose values carry
// their type ({integerValue}, {doubleValue}, {timestampValue}…), so an encoder
// and a decoder that are wrong in the same way cannot agree their way to a pass.
//
// Talks only to 127.0.0.1. The steps depend on each other and run in order; the
// first failure stops the run.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync, appendFileSync, cpSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { initializeApp } from 'firebase-admin/app'
import { getFirestore, Timestamp, GeoPoint, FieldValue } from 'firebase-admin/firestore'
import { getAuth } from 'firebase-admin/auth'
import { getStorage } from 'firebase-admin/storage'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BACKUP = path.resolve(HERE, '..')
const PROJECT = 'demo-frc5805'
const BUCKET = 'demo-frc5805.appspot.com'

for (const name of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST']) {
  if (!process.env[name]) {
    console.error(`${name} is not set. Run this through emulators:exec (see the top of this file).`)
    process.exit(1)
  }
}
for (const [name, value] of Object.entries(process.env)) {
  if (name.endsWith('_EMULATOR_HOST') && !/^(http:\/\/)?(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(value)) {
    console.error(`${name}=${value} is not a local address; this test only ever talks to this machine.`)
    process.exit(1)
  }
}
delete process.env.GOOGLE_APPLICATION_CREDENTIALS

const app = initializeApp({ projectId: PROJECT, storageBucket: BUCKET })
const db = getFirestore(app)
const auth = getAuth(app)
const bucket = getStorage(app).bucket(BUCKET)

const STORE = `http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/${PROJECT}/databases/(default)/documents`
const owner = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }
const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const scratch = mkdtempSync(path.join(os.tmpdir(), 'frc5805-backup-test-'))
const ROOT = path.join(scratch, 'backup')
const ENV = { ...process.env, FIREBASE_PROJECT_ID: PROJECT, FIREBASE_STORAGE_BUCKET: BUCKET, BACKUP_ROOT: ROOT }

function run(script, args = [], env = ENV) {
  const r = spawnSync(process.execPath, [path.join(BACKUP, script), ...args], { env, encoding: 'utf8' })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  // BACKUP_TEST_VERBOSE=1 shows what each script printed, as an operator would see it.
  if (process.env.BACKUP_TEST_VERBOSE) console.log(`
--- ${script} ${args.join(' ')} -> exit ${r.status}
${out.trimEnd()}
---`)
  return { code: r.status, out }
}

let failed = false
async function step(name, fn) {
  if (failed) return
  try {
    await fn()
    console.log(`  ok    ${name}`)
  } catch (err) {
    failed = true
    console.log(`  FAIL  ${name}`)
    console.error(err)
  }
}

// ---------------------------------------------------------------------------
// Independent readers
// ---------------------------------------------------------------------------

const docUrl = (p) => `${STORE}/${p.split('/').map(encodeURIComponent).join('/')}`

/** Every document path, found by walking — including under parents that do not exist. */
async function allPaths() {
  const out = []
  async function walk(collection) {
    for (const ref of await collection.listDocuments()) {
      if ((await ref.get()).exists) out.push(ref.path)
      for (const sub of await ref.listCollections()) await walk(sub)
    }
  }
  for (const c of await db.listCollections()) await walk(c)
  return out.sort()
}

const sorted = (v) =>
  Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v

/** path -> the document's typed fields, exactly as Firestore holds them. */
async function rawDocuments() {
  const out = new Map()
  for (const p of await allPaths()) {
    const res = await fetch(docUrl(p), { headers: owner })
    assert.equal(res.status, 200, `GET ${p}`)
    out.set(p, JSON.stringify(sorted((await res.json()).fields ?? {})))
  }
  return out
}

async function rawObjects() {
  const out = new Map()
  const [files] = await bucket.getFiles()
  for (const f of files) {
    const [bytes] = await f.download()
    out.set(f.name, { sha256: sha256(bytes), contentType: f.metadata.contentType ?? null, owner: f.metadata.metadata?.owner ?? null })
  }
  return out
}

async function rawUsers() {
  const out = new Map()
  const { users } = await auth.listUsers(1000)
  for (const u of users) {
    out.set(u.uid, {
      email: u.email ?? null,
      displayName: u.displayName ?? null,
      emailVerified: u.emailVerified,
      disabled: u.disabled,
      customClaims: u.customClaims ?? null,
      created: u.metadata.creationTime,
      passwordHash: u.passwordHash ?? null,
    })
  }
  return out
}

async function wipe() {
  for (const url of [
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/accounts`,
  ]) {
    assert.ok((await fetch(url, { method: 'DELETE', headers: owner })).ok, `DELETE ${url}`)
  }
  await bucket.deleteFiles({ force: true })
}

const jsonl = (file) =>
  gunzipSync(readFileSync(file))
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))

// ---------------------------------------------------------------------------
// The dataset
// ---------------------------------------------------------------------------

const T = (iso) => Timestamp.fromDate(new Date(iso))
const people = [
  { uid: 'uid-admin', email: 'admin@example.test', name: 'Ada Admin', role: 'admin', password: 'emulator-only-1' },
  { uid: 'uid-lead', email: 'lead@example.test', name: 'Lee Lead', role: 'lead', password: 'emulator-only-2' },
  { uid: 'uid-member', email: 'member@example.test', name: 'Mel Member', role: 'member', password: null },
  { uid: 'uid-pending', email: 'pending@example.test', name: 'Pat Pending', role: 'pending', password: 'emulator-only-3' },
]

const objects = {
  robot: { name: 'media/2026/robot.jpg', bytes: randomBytes(100_000), type: 'image/jpeg' },
  notes: { name: 'knowledge/notes/readme.md', bytes: Buffer.from('# Pit checklist\n\nBatteries — charged · tagged ← twice\n'), type: 'text/markdown' },
  // Past the size at which restore.mjs switches to a resumable upload.
  big: { name: 'code/2026/robot-code-abc1234.tar.gz', bytes: randomBytes(9 * 1024 * 1024), type: 'application/gzip' },
  bad: { name: 'graphs/bad.json', bytes: Buffer.from('{"nodes":[]}'), type: 'application/json' },
  logo: { name: 'public-media/logo.svg', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), type: 'image/svg+xml' },
  orphan: { name: 'media/orphan.png', bytes: randomBytes(2048), type: 'image/png' },
}

const fileDoc = (name, extra) => {
  const [folder, ...rest] = name.split('/')
  return {
    bucket: folder, path: rest.join('/'), title: name, description: null, kind: 'other', season: 2026, tags: ['seed'],
    byte_size: null, sha256: null, uploaded_by: 'uid-member', created_at: T('2026-03-01T18:00:00Z'), updated_at: T('2026-03-01T18:00:00Z'),
    ...extra,
  }
}
const fileId = (name) => name.replace(/\//g, '~')

async function seed({ clean }) {
  for (const p of people) {
    await auth.createUser({ uid: p.uid, email: p.email, displayName: p.name, emailVerified: p.role !== 'pending', ...(p.password ? { password: p.password } : {}) })
  }
  await auth.updateUser('uid-pending', { disabled: true })
  await auth.setCustomUserClaims('uid-admin', { beta: true })

  const batch = db.batch()
  for (const p of people) {
    batch.set(db.doc(`profiles/${p.uid}`), {
      full_name: p.name, grad_year: p.role === 'member' ? 2027 : null, subteam: p.role === 'lead' ? 'Programming' : null,
      role: p.role, created_at: T('2026-01-10T20:00:00Z'), updated_at: T('2026-02-11T21:30:00.123Z'),
    })
  }
  for (const n of [1, 2, 3]) {
    batch.set(db.doc(`scout_entries/m:2026wasno:5805:2026wasno_qm${n}:uid-member`), {
      client_uuid: `00000000-0000-4000-8000-00000000000${n}`, form_id: 'form-1', kind: 'match', event_key: '2026wasno', team_number: 5805,
      match_key: `2026wasno_qm${n}`, match_number: n, comp_level: 'qm', alliance: n % 2 ? 'red' : 'blue',
      data: { total_score: 40 + n, broke: false, no_show: false, cycles: [3, 4, n], auto: { left_line: true, pieces: n } },
      notes: n === 2 ? 'Tipped in the last ten seconds — 5805 pushed them' : null, scout_id: 'uid-member',
      recorded_at: T(`2026-03-0${n}T19:00:00Z`), recorded_day: 20260300 + n, slot: null, created_at: T(`2026-03-0${n}T19:00:05Z`),
    })
  }
  batch.set(db.doc('knowledge_docs/kb-1'), {
    slug: 'pit-checklist', title: 'Pit checklist', body_md: '# Pit checklist\n\n- batteries\n- bumpers · both sets\n', category: 'Pit',
    is_pinned: true, created_by: 'uid-lead', updated_by: 'uid-member', created_at: T('2026-01-15T00:00:00Z'), updated_at: T('2026-02-01T00:00:00Z'),
  })
  batch.set(db.doc('kb_slugs/pit-checklist'), { doc_id: 'kb-1' })
  for (const v of [1, 2]) {
    batch.set(db.doc(`knowledge_docs/kb-1/versions/v${v}`), {
      title: 'Pit checklist', body_md: `draft ${v}`, edited_by: 'uid-lead', created_at: T(`2026-01-2${v}T00:00:00Z`),
    })
  }
  // The history of a doc that has since been deleted: a subcollection whose
  // parent document does not exist.
  batch.set(db.doc('knowledge_docs/deleted-doc/versions/v1'), {
    title: 'Old wiring guide', body_md: 'superseded', edited_by: 'uid-admin', created_at: T('2025-11-02T00:00:00Z'),
  })
  batch.set(db.doc('picklists/list-1'), {
    event_key: '2026wasno', name: 'Saturday', tiers: ['first', 'second', 'avoid'], is_locked: false, locked_at: null, locked_by: null,
    created_by: 'uid-lead', created_at: T('2026-03-07T02:00:00Z'), updated_at: T('2026-03-07T03:00:00Z'),
  })
  batch.set(db.doc('picklists/list-1/entries/2910'), {
    team_number: 2910, tier: 'first', position: 1, note: null, overrides_ai: false, updated_by: 'uid-lead', updated_at: T('2026-03-07T03:00:00Z'),
  })
  batch.set(db.doc('picklists/list-1/entries/1318'), {
    team_number: 1318, tier: 'first', position: 1.5, note: 'dragged between two', overrides_ai: true, updated_by: 'uid-lead', updated_at: T('2026-03-07T03:01:00Z'),
  })
  batch.set(db.doc('vision_sessions/vs-1'), {
    event_key: null, match_key: null, device_label: 'pit laptop', model: 'coco-ssd', model_note: null, started_by: 'uid-member', operator: 'Mel Member',
    started_at: T('2026-03-05T18:00:00Z'), ended_at: null, frame_count: 2, observations: 2, peak_count: 3, count_sum: 5, created_at: T('2026-03-05T18:00:00Z'),
  })
  for (const n of [1, 2]) {
    batch.set(db.doc(`vision_sessions/vs-1/observations/o${n}`), {
      offset_ms: n * 500, recorded_at: T(`2026-03-05T18:00:0${n}Z`), object_count: n + 1,
      detections: [{ label: 'robot', score: 0.9 + n / 100, box: [0.1, 0.2, 0.3, 0.4] }], team_number: null, created_at: T(`2026-03-05T18:00:0${n}Z`),
    })
  }
  batch.set(db.doc('scout_settings/main'), {
    active_event_key: '2026wasno', lock_enabled: true, window_start: '08:00', window_end: '18:30', window_start_min: 480, window_end_min: 1110,
    timezone: 'America/Los_Angeles', utc_offset_min: -480, vision_model_url: null, vision_model_name: null, vision_model_labels: [],
    vision_model_size: 640, updated_by: 'uid-lead', updated_at: T('2026-03-01T00:00:00Z'),
  })
  batch.set(db.doc('backup_runs/older-run'), {
    leg: 'server->optiplex', status: 'ok', started_at: T('2026-03-01T10:15:00Z'), finished_at: T('2026-03-01T10:20:00Z'), object_count: 3,
    byte_total: 12345, db_dump_bytes: null, manifest_sha: 'a'.repeat(64), restore_tested_at: null, error: null, created_at: T('2026-03-01T10:20:00Z'),
  })
  // One of every type Firestore has, and the awkward cases of each.
  batch.set(db.doc('type_probe/everything'), {
    a_null: null, a_true: true, a_string: 'plain — · ← 🤖', an_empty_string: '',
    an_int: 5805, a_negative_int: -7, a_big_int: 9007199254740993n, a_double: 0.1, nan: NaN, infinity: Infinity, minus_infinity: -Infinity, minus_zero: -0,
    a_time: new Timestamp(1767225600, 123456000), an_old_time: T('1969-07-20T20:17:40.500Z'),
    a_place: new GeoPoint(47.6205, -122.3493), some_bytes: Buffer.from([0, 1, 2, 253, 254, 255]),
    a_ref: db.doc('profiles/uid-admin'), a_deep_ref: db.doc('picklists/list-1/entries/2910'),
    an_empty_map: {}, an_empty_array: [], a_vector: FieldValue.vector([0.5, 1, -2.25]),
    nested: { list: [1, 'two', null, { three: T('2026-01-01T00:00:00Z') }, [].length], $dollar: 'a key that looks like a tag', deeper: { $ts: 'not a timestamp' } },
    looks_like_a_tag: { $ts: 'still just a string' },
  })
  await batch.commit()

  // A double with no fraction (2.0). A JavaScript client cannot write one — it
  // sends every whole number as an integer — so it goes in through REST, as a
  // Python or Go writer, or the console, could have put it.
  const put = await fetch(docUrl('picklists/list-1/entries/254'), {
    method: 'PATCH',
    headers: owner,
    body: JSON.stringify({
      fields: {
        team_number: { integerValue: '254' }, tier: { stringValue: 'second' }, position: { doubleValue: 2 }, note: { nullValue: null },
        overrides_ai: { booleanValue: false }, updated_by: { stringValue: 'uid-lead' }, updated_at: { timestampValue: '2026-03-07T03:02:00Z' },
      },
    }),
  })
  assert.ok(put.ok, 'seed the whole-number double')

  const upload = (o, ownerUid = 'uid-member') =>
    bucket.file(o.name).save(o.bytes, { resumable: false, metadata: { contentType: o.type, metadata: { owner: ownerUid } } })
  const indexed = (o, extra = {}) =>
    db.doc(`files/${fileId(o.name)}`).set(fileDoc(o.name, { byte_size: o.bytes.length, sha256: sha256(o.bytes), ...extra }))

  await upload(objects.robot)
  await indexed(objects.robot, { kind: 'photo' })
  await upload(objects.notes, 'uid-lead')
  await indexed(objects.notes, { kind: 'doc' })
  await upload(objects.big, 'uid-admin')
  await indexed(objects.big, { kind: 'code' })
  await upload(objects.logo)
  await upload(objects.bad)

  if (clean) {
    await indexed(objects.logo)
    await indexed(objects.bad)
    return
  }
  // The four ways the index and the bucket can disagree:
  await indexed(objects.logo, { sha256: null }) //            no checksum was ever recorded
  await indexed(objects.bad, { sha256: 'f'.repeat(64) }) //   the bytes are not the bytes that were uploaded
  await upload(objects.orphan) //                             an object nothing points at
  await db.doc('files/public-media~ghost.png').set(fileDoc('public-media/ghost.png', { sha256: 'e'.repeat(64) })) // a document pointing at nothing
}

// ---------------------------------------------------------------------------

console.log('backup round trip\n')

let before
let snapshot
let meta
let manifestSha

await step('the emulators start empty', async () => {
  await wipe()
  assert.deepEqual(await allPaths(), [])
})

await step('mirror refuses an empty project, and writes nothing', async () => {
  const r = run('mirror.mjs')
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /has no profiles at all/)
  assert.ok(!existsSync(path.join(ROOT, 'LATEST')), 'no LATEST')
  assert.deepEqual(await allPaths(), [], 'not even a backup_runs row')
})

await step('mirror refuses a half-set emulator environment', async () => {
  const env = { ...ENV }
  delete env.FIREBASE_AUTH_EMULATOR_HOST
  const r = run('mirror.mjs', [], env)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /must be set\s+together, or none/)
})

await step('mirror refuses a credential that is not a service-account key', async () => {
  // No emulator variables here, so these runs are headed for a live project —
  // and must stop at the key file, before any client exists to make a request.
  const env = { ...ENV, FIREBASE_PROJECT_ID: 'not-a-real-project' }
  for (const n of Object.keys(env)) if (n.endsWith('_EMULATOR_HOST')) delete env[n]

  let r = run('mirror.mjs', [], env)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /missing required env var: GOOGLE_APPLICATION_CREDENTIALS/)

  const key = path.join(scratch, 'key.json')
  writeFileSync(key, JSON.stringify({ type: 'authorized_user', client_id: 'x', refresh_token: 'x' }), { mode: 0o600 })
  r = run('mirror.mjs', [], { ...env, GOOGLE_APPLICATION_CREDENTIALS: key })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /is not a service-account key \(it is a "authorized_user" credential\)/)

  writeFileSync(key, JSON.stringify({ type: 'service_account', project_id: 'some-other-project', private_key: 'x', client_email: 'x@example.test' }), { mode: 0o600 })
  r = run('mirror.mjs', [], { ...env, GOOGLE_APPLICATION_CREDENTIALS: key })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /is a key for project "some-other-project", but FIREBASE_PROJECT_ID is "not-a-real-project"/)
})

await step('seed: accounts, documents, objects, and four disagreements between index and bucket', async () => {
  await seed({ clean: false })
  before = { documents: await rawDocuments(), objects: await rawObjects(), users: await rawUsers() }
  assert.equal(before.users.size, 4)
  assert.equal(before.objects.size, 6)
  assert.match(before.documents.get('picklists/list-1/entries/254'), /"position":\{"doubleValue":2\}/, 'the seed really holds a double')
})

await step('mirror exits 2 (partial) and says why', async () => {
  const r = run('mirror.mjs')
  assert.equal(r.code, 2, r.out)
  assert.match(r.out, /CHECKSUM MISMATCH graphs\/bad\.json/)
  assert.match(r.out, /PARTIAL — 6 objects, 9\.5 MB, 29 documents, 4 accounts/)
  const stamp = readFileSync(path.join(ROOT, 'LATEST'), 'utf8')
  assert.match(stamp, /^20\d\d-\d\d-\d\dT\d\d-\d\d-\d\dZ\n$/)
  snapshot = path.join(ROOT, stamp.trim())
  meta = JSON.parse(readFileSync(path.join(snapshot, 'snapshot.json'), 'utf8'))
})

await step('SHA256SUMS: LF only, covers every file in the snapshot, and every line is true', async () => {
  const text = readFileSync(path.join(snapshot, 'SHA256SUMS'), 'utf8')
  assert.ok(!text.includes('\r'), 'no CR')
  assert.ok(text.endsWith('\n'))
  manifestSha = readFileSync(path.join(snapshot, 'MANIFEST.sha256'), 'utf8')
  assert.equal(manifestSha, sha256(text) + '\n')
  manifestSha = manifestSha.trim()

  const listed = new Map(text.trim().split('\n').map((l) => [l.slice(66), l.slice(0, 64)]))
  for (const [rel, sum] of listed) assert.equal(sha256(readFileSync(path.join(snapshot, rel))), sum, rel)

  const onDisk = []
  const walk = (dir, prefix) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name), `${prefix}${e.name}/`)
      else onDisk.push(prefix + e.name)
    }
  }
  walk(snapshot, '')
  assert.deepEqual(onDisk.filter((f) => f !== 'SHA256SUMS' && f !== 'MANIFEST.sha256').sort(), [...listed.keys()].sort())

  // And the tool nightly.sh actually runs agrees, where it is installed.
  const gnu = spawnSync('sha256sum', ['-c', '--quiet', 'SHA256SUMS'], { cwd: snapshot, encoding: 'utf8' })
  if (gnu.error) console.log('        (no sha256sum on this machine; the GNU check was skipped)')
  else assert.equal(gnu.status, 0, gnu.stdout + gnu.stderr)
})

await step('snapshot.json: every collection and subcollection counted, every disagreement named', async () => {
  assert.equal(meta.status, 'partial')
  assert.deepEqual(meta.firestore.collections, {
    backup_runs: 2, // the seeded one, and this run's own row
    files: 6,
    kb_slugs: 1,
    knowledge_docs: 1,
    'knowledge_docs/{id}/versions': 3, // two under kb-1, one under a parent that no longer exists
    picklists: 1,
    'picklists/{id}/entries': 3,
    profiles: 4,
    scout_entries: 3,
    scout_settings: 1,
    type_probe: 1,
    vision_sessions: 1,
    'vision_sessions/{id}/observations': 2,
  })
  assert.equal(meta.firestore.documents, 29)
  assert.deepEqual(meta.auth, { users: 4, password_users: 3, password_hashes: 3 })
  assert.equal(meta.storage.objects, 6)
  assert.equal(meta.storage.verified, 3)
  assert.deepEqual(meta.storage.mismatched, ['graphs/bad.json'])
  assert.deepEqual(meta.storage.unrecorded, ['public-media/logo.svg'])
  assert.deepEqual(meta.storage.orphans, ['media/orphan.png'])
  assert.deepEqual(meta.storage.missing, [{ id: 'public-media~ghost.png', name: 'public-media/ghost.png' }])
  assert.deepEqual(meta.storage.failed, [])
  assert.deepEqual(meta.problems, [
    '1 object(s) do not match their recorded checksum',
    '1 object(s) had no recorded checksum',
    '1 object(s) have no files document',
    '1 files document(s) have no object in Storage',
  ])
})

await step('the encoding is exactly what encoding.mjs documents', async () => {
  const [probe] = jsonl(path.join(snapshot, 'firestore', 'type_probe.jsonl.gz'))
  assert.deepEqual(probe, {
    path: 'type_probe/everything',
    data: {
      a_big_int: { $int: '9007199254740993' },
      a_deep_ref: { $ref: 'picklists/list-1/entries/2910' },
      a_double: 0.1,
      a_negative_int: -7,
      a_null: null,
      a_place: { $geo: [47.6205, -122.3493] },
      a_ref: { $ref: 'profiles/uid-admin' },
      a_string: 'plain — · ← 🤖',
      a_time: { $ts: '2026-01-01T00:00:00.123456000Z' },
      a_true: true,
      a_vector: { $vector: [0.5, 1, -2.25] },
      an_empty_array: [],
      an_empty_map: {},
      an_empty_string: '',
      an_int: 5805,
      an_old_time: { $ts: '1969-07-20T20:17:40.500000000Z' },
      infinity: { $double: 'Infinity' },
      looks_like_a_tag: { $map: { $ts: 'still just a string' } },
      minus_infinity: { $double: '-Infinity' },
      minus_zero: { $double: '-0' },
      nan: { $double: 'NaN' },
      nested: { $map: { $dollar: 'a key that looks like a tag', deeper: { $map: { $ts: 'not a timestamp' } }, list: [1, 'two', null, { three: { $ts: '2026-01-01T00:00:00.000000000Z' } }, 0] } },
      some_bytes: { $bytes: 'AAEC/f7/' },
      // keys are sorted, so this is compared as an object, not as text
    },
  })
  const raw = gunzipSync(readFileSync(path.join(snapshot, 'firestore', 'type_probe.jsonl.gz'))).toString('utf8')
  assert.ok(raw.startsWith('{"path":"type_probe/everything","data":{"a_big_int":'), 'one line, path first, keys sorted')

  const entries = jsonl(path.join(snapshot, 'firestore', 'picklists__entries.jsonl.gz'))
  assert.deepEqual(entries.map((e) => [e.path, e.data.position]), [
    ['picklists/list-1/entries/1318', 1.5],
    ['picklists/list-1/entries/254', { $double: '2' }],
    ['picklists/list-1/entries/2910', 1],
  ])
  const versions = jsonl(path.join(snapshot, 'firestore', 'knowledge_docs__versions.jsonl.gz')).map((v) => v.path)
  assert.deepEqual(versions, ['knowledge_docs/deleted-doc/versions/v1', 'knowledge_docs/kb-1/versions/v1', 'knowledge_docs/kb-1/versions/v2'])
})

await step('accounts and objects are in the snapshot, byte for byte', async () => {
  const users = jsonl(path.join(snapshot, 'auth_users.jsonl.gz'))
  assert.deepEqual(users.map((u) => u.uid), ['uid-admin', 'uid-lead', 'uid-member', 'uid-pending'])
  assert.equal(users[0].email, 'admin@example.test')
  assert.deepEqual(users[0].customClaims, { beta: true })
  assert.ok(users[0].passwordHash, 'a password account carries its hash')
  assert.ok(!users[2].passwordHash, 'an email-link account has none')
  assert.equal(users[3].disabled, true)

  const listed = jsonl(path.join(snapshot, 'objects.jsonl.gz'))
  assert.deepEqual(
    listed.map((o) => [o.name, o.check]),
    [
      ['code/2026/robot-code-abc1234.tar.gz', 'ok'],
      ['graphs/bad.json', 'mismatch'],
      ['knowledge/notes/readme.md', 'ok'],
      ['media/2026/robot.jpg', 'ok'],
      ['media/orphan.png', 'orphan'],
      ['public-media/logo.svg', 'unrecorded'],
    ]
  )
  for (const o of Object.values(objects)) {
    assert.ok(readFileSync(path.join(snapshot, 'objects', ...o.name.split('/'))).equals(o.bytes), o.name)
    const record = listed.find((l) => l.name === o.name)
    assert.equal(record.sha256, sha256(o.bytes))
    assert.equal(record.contentType, o.type)
    assert.equal(record.size, o.bytes.length)
  }
  assert.equal(listed.find((l) => l.name === objects.notes.name).metadata.owner, 'uid-lead')
  assert.equal(listed.find((l) => l.name === objects.robot.name).index, 'media~2026~robot.jpg')
})

await step('the run is recorded in backup_runs, running -> partial', async () => {
  const found = await db.collection('backup_runs').where('leg', '==', 'firebase->server').get()
  assert.equal(found.size, 1)
  const row = found.docs[0].data()
  assert.equal(row.status, 'partial')
  assert.equal(row.object_count, 6)
  assert.equal(row.byte_total, Object.values(objects).reduce((n, o) => n + o.bytes.length, 0))
  assert.ok(row.db_dump_bytes > 0)
  assert.equal(row.manifest_sha, manifestSha)
  assert.equal(row.error, meta.problems.join('; '))
  assert.equal(row.restore_tested_at, null)
  assert.ok(row.started_at instanceof Timestamp && row.finished_at instanceof Timestamp && row.created_at instanceof Timestamp)
  assert.deepEqual(Object.keys(row).sort(), [
    'byte_total', 'created_at', 'db_dump_bytes', 'error', 'finished_at', 'leg', 'manifest_sha', 'object_count', 'restore_tested_at', 'started_at', 'status',
  ])
  // What the snapshot holds is the row as it was mid-run.
  const inSnapshot = jsonl(path.join(snapshot, 'firestore', 'backup_runs.jsonl.gz')).find((l) => l.path === found.docs[0].ref.path)
  assert.equal(inSnapshot.data.status, 'running')
})

await step('report.mjs: leg 2 is its own row; restore-tested stamps only the leg-1 run with that manifest', async () => {
  let r = run('report.mjs', ['leg2', '--status=failed', '--started=2026-03-08T10:15:00Z', '--objects=14', '--bytes=987654', `--manifest=${manifestSha}`, '--error=rsync failed'])
  assert.equal(r.code, 0, r.out)
  const legs = await db.collection('backup_runs').where('manifest_sha', '==', manifestSha).get()
  assert.equal(legs.size, 2)
  const leg2 = legs.docs.find((d) => d.get('leg') === 'server->optiplex').data()
  assert.equal(leg2.status, 'failed')
  assert.equal(leg2.error, 'rsync failed')
  assert.equal(leg2.object_count, 14)
  assert.equal(leg2.byte_total, 987654)
  assert.equal(leg2.started_at.toDate().toISOString(), '2026-03-08T10:15:00.000Z')
  assert.equal(leg2.db_dump_bytes, null)

  r = run('report.mjs', ['restore-tested', `--manifest=${'0'.repeat(64)}`])
  assert.equal(r.code, 3, r.out)

  r = run('report.mjs', ['restore-tested', `--manifest=${manifestSha}`])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /marked 1 run\(s\) restore-tested/)
  const after = await db.collection('backup_runs').where('manifest_sha', '==', manifestSha).get()
  for (const d of after.docs) {
    if (d.get('leg') === 'firebase->server') assert.ok(d.get('restore_tested_at') instanceof Timestamp)
    else assert.equal(d.get('restore_tested_at'), null, 'the copy the test never touched stays unverified')
  }

  r = run('report.mjs', ['leg2', '--status=ok', '--started=yesterday', '--objects=1', '--bytes=1', `--manifest=${manifestSha}`])
  assert.equal(r.code, 1, 'a malformed report is refused, not written')
})

await step('restore refuses the wrong target', async () => {
  let r = run('restore.mjs', [snapshot, '--target=live', `--confirm=${PROJECT}`])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /--target=live, but the emulator variables are set/)

  r = run('restore.mjs', [snapshot, '--target=emulator'], { ...ENV, FIREBASE_PROJECT_ID: 'frc5805-prod' })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /needs a project id starting with "demo-"/)

  r = run('restore.mjs', [snapshot, '--target=emulator'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /already has data in it/)
})

await step('restore refuses a snapshot that does not match its manifest', async () => {
  const copy = path.join(scratch, 'tampered')
  cpSync(snapshot, copy, { recursive: true })
  appendFileSync(path.join(copy, 'objects', 'knowledge', 'notes', 'readme.md'), 'x')
  let r = run('restore.mjs', [copy, '--target=emulator', '--verify-only'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /MISMATCH: objects\/knowledge\/notes\/readme\.md/)

  cpSync(snapshot, copy, { recursive: true, force: true })
  writeFileSync(path.join(copy, 'SHA256SUMS'), readFileSync(path.join(snapshot, 'SHA256SUMS'), 'utf8').replace(/\n/g, '\r\n'))
  r = run('restore.mjs', [copy, '--target=emulator', '--verify-only'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /CRLF/)
})

await step('wipe, restore: everything is back, and the two index disagreements are still reported', async () => {
  await wipe()
  assert.deepEqual(await allPaths(), [])
  assert.equal((await auth.listUsers(10)).users.length, 0)

  const reportFile = path.join(scratch, 'report.json')
  const r = run('restore.mjs', [snapshot, '--target=emulator', `--report=${reportFile}`])
  assert.equal(r.code, 2, r.out)
  const report = JSON.parse(readFileSync(reportFile, 'utf8'))
  assert.deepEqual(report.restored, { accounts: 4, documents: 29, documents_via_rest: 1, objects: 6 })
  assert.equal(report.firestore.identical, true, JSON.stringify(report.firestore))
  assert.equal(report.auth.identical, true, JSON.stringify(report.auth))
  assert.equal(report.auth.passwords_restored, 3)
  assert.equal(report.storage.identical, true, JSON.stringify(report.storage))
  assert.equal(report.storage.compared, 6)
  assert.deepEqual(report.index, { files: 6, checked: 4, mismatched: ['graphs/bad.json'], missing: ['public-media/ghost.png'], clean: false })
  assert.equal(report.passed, false)
})

await step('the restored data is identical to what was there, value for value and type for type', async () => {
  const after = { documents: await rawDocuments(), objects: await rawObjects(), users: await rawUsers() }

  for (const [p, fields] of before.documents) assert.equal(after.documents.get(p), fields, p)
  const added = [...after.documents.keys()].filter((p) => !before.documents.has(p))
  assert.equal(added.length, 1, `only the mirror's own run row is new: ${added}`)
  assert.match(added[0], /^backup_runs\//)
  assert.match(after.documents.get(added[0]), /"leg":\{"stringValue":"firebase->server"\}/)
  assert.match(after.documents.get(added[0]), /"status":\{"stringValue":"running"\}/)
  assert.match(after.documents.get('picklists/list-1/entries/254'), /"position":\{"doubleValue":2\}/, '2.0 is still a double')
  assert.match(after.documents.get('picklists/list-1/entries/2910'), /"position":\{"integerValue":"1"\}/, '1 is still an integer')

  assert.deepEqual([...after.objects.keys()].sort(), [...before.objects.keys()].sort())
  for (const [name, o] of before.objects) assert.deepEqual(after.objects.get(name), o, name)

  assert.deepEqual([...after.users.keys()].sort(), [...before.users.keys()].sort())
  for (const [uid, u] of before.users) {
    const got = after.users.get(uid)
    // The emulator's "hash" is a string it made up, and it stores an imported
    // hash as the base64 it was sent. Same bytes, spelled differently.
    const hash = got.passwordHash ? Buffer.from(got.passwordHash, 'base64').toString('utf8') : null
    assert.deepEqual({ ...got, passwordHash: hash, created: new Date(got.created).getTime() }, { ...u, created: new Date(u.created).getTime() }, uid)
  }
})

await step('a clean project: mirror exits 0, the restore passes, and the run can be marked restore-tested', async () => {
  await wipe()
  await seed({ clean: true })
  const clean = { documents: await rawDocuments(), objects: await rawObjects() }

  let r = run('mirror.mjs')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /\nOK — 5 objects/)
  const dir = path.join(ROOT, readFileSync(path.join(ROOT, 'LATEST'), 'utf8').trim())
  assert.notEqual(dir, snapshot)
  const sha = readFileSync(path.join(dir, 'MANIFEST.sha256'), 'utf8').trim()
  const row = (await db.collection('backup_runs').where('manifest_sha', '==', sha).get()).docs[0]
  assert.equal(row.get('status'), 'ok')
  assert.equal(row.get('error'), null)

  // --objects=2: the restore test's mode. Two objects go up and come back; the
  // checksum cross-check still covers all five.
  const reportFile = path.join(scratch, 'report-clean.json')
  r = run('restore.mjs', [dir, '--target=emulator', '--wipe', '--objects=2', `--report=${reportFile}`])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /PASSED — .* is restorable \(5 files, 1 docs, 4 profiles\)/)
  const report = JSON.parse(readFileSync(reportFile, 'utf8'))
  assert.equal(report.passed, true)
  assert.equal(report.storage.compared, 2)
  assert.deepEqual(report.index, { files: 5, checked: 5, mismatched: [], missing: [], clean: true })

  r = run('restore.mjs', [dir, '--target=emulator', '--wipe'])
  assert.equal(r.code, 0, r.out)
  const after = { documents: await rawDocuments(), objects: await rawObjects() }
  for (const [p, fields] of clean.documents) assert.equal(after.documents.get(p), fields, p)
  assert.equal(after.documents.size, clean.documents.size + 1)
  assert.deepEqual(after.objects, clean.objects)

  // After a wipe-and-restore the row is the one from the snapshot (still
  // `running`, no manifest yet), so nothing matches — and the helper says so
  // rather than claiming a badge it did not change.
  r = run('report.mjs', ['restore-tested', `--manifest=${sha}`])
  assert.equal(r.code, 3, r.out)
})

rmSync(scratch, { recursive: true, force: true })
console.log(failed ? '\nFAILED' : '\nall passed')
process.exit(failed ? 1 : 0)
