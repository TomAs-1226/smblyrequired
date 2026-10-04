#!/usr/bin/env node
/**
 * Put a snapshot back, and prove it arrived.
 *
 *   restore.mjs <snapshot-dir> --target=emulator --wipe      the restore test
 *   restore.mjs <snapshot-dir> --target=live --confirm=<project-id>
 *
 * The target is whatever the environment names (see lib.mjs `connect`), and the
 * flag has to agree with it. `--target=emulator` refuses to run unless all three
 * emulator variables are set and the project id starts with `demo-`, which is
 * the prefix Firebase guarantees can never reach a real project.
 * `--target=live` refuses without `--confirm` repeating the project id, and
 * refuses a project that already has data unless `--allow-non-empty` is given.
 *
 * Order: accounts, then documents, then objects. Then everything is read back
 * out of the target and compared with the snapshot:
 *
 *   - the number of documents in each collection,
 *   - every document, re-encoded and compared with its line in the snapshot,
 *   - every account,
 *   - every restored object's bytes and metadata,
 *   - every checksum in the restored `files` index against the object it names.
 *
 * Options
 *   --objects=all|none|<n>   restore every object (default), none, or a random
 *                            sample of n. The index cross-check always covers
 *                            every object, from the bytes on disk.
 *   --verify-only            restore nothing; compare the target as it stands
 *   --no-verify              restore and do not read back
 *   --report=<file>          write the comparison as JSON
 *
 * Exit codes: 0 restored and identical, 1 failed, 2 restored but not identical
 * (the differences are listed).
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  connect, finish, dumpFirestore, listAllUsers, hasPasswordProvider, readLines, readJsonl, sha256File,
  firestoreRest,
} from './lib.mjs'
import { decode, toRestFields, ENCODING_VERSION } from './encoding.mjs'

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const SNAPSHOT = path.resolve(args.find((a) => !a.startsWith('--')) ?? process.env.SNAPSHOT_DIR ?? '')
const TARGET = option('target')
const OBJECTS = option('objects') ?? 'all'
const VERIFY_ONLY = flag('verify-only')
const NO_VERIFY = flag('no-verify')

// Before there is a connection, a refusal just ends the process. After, it is
// thrown, so the run ends through finish() with its connections closed.
class Refusal extends Error {}
let ctx = null
const fail = (message) => {
  if (ctx) throw new Refusal(message)
  console.error(`\n  FAILED: ${message}`)
  process.exit(1)
}

if (!args.some((a) => !a.startsWith('--')) && !process.env.SNAPSHOT_DIR) fail('usage: restore.mjs <snapshot-dir> --target=emulator|live …')
if (TARGET !== 'emulator' && TARGET !== 'live') fail('say where to: --target=emulator or --target=live')
if (!/^(all|none|\d+)$/.test(OBJECTS)) fail('--objects takes all, none or a number')
if (VERIFY_ONLY && NO_VERIFY) fail('--verify-only and --no-verify together leave nothing to do')

const opened = connect({ exact: true })
const { db, auth, bucket } = opened

// Nothing has been sent anywhere yet: these stop the run before it can be.
if (TARGET === 'emulator') {
  if (!opened.emulated) fail('--target=emulator, but the emulator variables are not set. Nothing was written.')
  if (!opened.projectId.startsWith('demo-')) {
    fail(`--target=emulator needs a project id starting with "demo-" (got "${opened.projectId}").`)
  }
} else {
  if (opened.emulated) fail('--target=live, but the emulator variables are set. Unset them, or use --target=emulator.')
  if (flag('wipe')) fail('--wipe is for the emulators. This script never empties a live project.')
  if (option('confirm') !== opened.projectId) {
    fail(`restoring into the live project "${opened.projectId}" needs --confirm=${opened.projectId}`)
  }
}
ctx = opened

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a)
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const inSnapshot = (rel) => path.join(SNAPSHOT, ...rel.split('/'))

// ---------------------------------------------------------------------------
// 1. The snapshot itself
// ---------------------------------------------------------------------------

/** Verify SHA256SUMS in full and return path -> sha256. */
async function checkSnapshot() {
  if (!existsSync(SNAPSHOT)) fail(`no snapshot at ${SNAPSHOT}`)
  const sumsFile = inSnapshot('SHA256SUMS')
  if (!existsSync(sumsFile)) fail('SHA256SUMS is missing')
  const text = readFileSync(sumsFile, 'utf8')
  if (!text.trim()) fail('SHA256SUMS is empty')
  if (text.includes('\r')) fail('SHA256SUMS has CRLF line endings; it was rewritten on the way here')

  const recorded = existsSync(inSnapshot('MANIFEST.sha256')) ? readFileSync(inSnapshot('MANIFEST.sha256'), 'utf8').trim() : ''
  if (recorded !== sha256(text)) fail('MANIFEST.sha256 does not match SHA256SUMS')

  const sums = new Map()
  for (const line of text.split('\n')) {
    if (!line) continue
    const m = /^([a-f0-9]{64}) {2}(.+)$/.exec(line)
    if (!m) fail(`SHA256SUMS has a line that is not a checksum: ${line.slice(0, 80)}`)
    sums.set(m[2], m[1])
  }
  let bad = 0
  for (const [rel, want] of sums) {
    let got
    try {
      got = await sha256File(inSnapshot(rel))
    } catch {
      got = null
    }
    if (got !== want) {
      console.error(`  ${got ? 'MISMATCH' : 'MISSING'}: ${rel}`)
      bad += 1
    }
  }
  if (bad) fail(`${bad} file(s) in the snapshot do not match SHA256SUMS`)

  for (const name of ['snapshot.json', 'auth_users.jsonl.gz', 'objects.jsonl.gz']) {
    if (!sums.has(name)) fail(`${name} is not in this snapshot — it is not restorable`)
  }
  const meta = JSON.parse(readFileSync(inSnapshot('snapshot.json'), 'utf8'))
  if (meta.format !== 1 || meta.encoding > ENCODING_VERSION) {
    fail(`this snapshot is format ${meta.format}, encoding ${meta.encoding}; this script reads format 1, encoding ${ENCODING_VERSION}`)
  }
  if (!meta.firestore?.collections?.profiles) fail('this snapshot has no profiles in it')
  for (const file of meta.firestore.files) {
    if (!sums.has(file)) fail(`${file} is named by snapshot.json but is not in SHA256SUMS`)
  }
  return { sums, meta, manifestSha: recorded }
}

// ---------------------------------------------------------------------------
// 2. The target
// ---------------------------------------------------------------------------

async function wipeEmulators() {
  const urls = [
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${ctx.projectId}/databases/(default)/documents`,
    `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/emulator/v1/projects/${ctx.projectId}/accounts`,
  ]
  for (const url of urls) {
    const res = await fetch(url, { method: 'DELETE', headers: { Authorization: 'Bearer owner' } })
    if (!res.ok) fail(`could not empty the emulator: ${res.status} ${url}`)
  }
  await bucket.deleteFiles({ force: true })
}

async function targetIsEmpty() {
  const [collections, users, [objects]] = await Promise.all([
    db.listCollections(),
    auth.listUsers(1),
    bucket.getFiles({ autoPaginate: false, maxResults: 1 }),
  ])
  return collections.length === 0 && users.users.length === 0 && objects.length === 0
}

// ---------------------------------------------------------------------------
// 3. Restore
// ---------------------------------------------------------------------------

/**
 * Password hashes are only useful with the parameters they were made with.
 * Those are not in the snapshot: they are the project's, they include a signing
 * key, and they are read off the console once and kept in the password manager
 * (docs/BACKUP.md). Without them the accounts still come back; the passwords do
 * not.
 */
function hashOptions() {
  if (ctx.emulated) {
    // The emulator stores whatever it is given and checks nothing.
    return { hash: { algorithm: 'SCRYPT', key: Buffer.from('emulator'), saltSeparator: Buffer.alloc(0), rounds: 8, memoryCost: 14 } }
  }
  const { AUTH_HASH_KEY, AUTH_HASH_SALT_SEPARATOR, AUTH_HASH_ROUNDS, AUTH_HASH_MEMORY_COST } = process.env
  if (!AUTH_HASH_KEY || !AUTH_HASH_ROUNDS || !AUTH_HASH_MEMORY_COST) return null
  return {
    hash: {
      algorithm: 'SCRYPT',
      key: Buffer.from(AUTH_HASH_KEY, 'base64'),
      saltSeparator: Buffer.from(AUTH_HASH_SALT_SEPARATOR ?? '', 'base64'),
      rounds: Number(AUTH_HASH_ROUNDS),
      memoryCost: Number(AUTH_HASH_MEMORY_COST),
    },
  }
}

// What the live service returns is base64. The emulator's "hash" is a plain
// string it made up, so it is carried as the text it is.
const hashBytes = (text) => Buffer.from(text, ctx.emulated ? 'utf8' : 'base64')

const defined = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null))

async function restoreUsers() {
  const users = []
  for await (const user of readJsonl(inSnapshot('auth_users.jsonl.gz'))) users.push(user)

  const options = hashOptions()
  const withHash = users.filter((u) => u.passwordHash).length
  const withPasswords = Boolean(options) && withHash > 0
  if (withHash && !options) {
    log(`    ${withHash} account(s) have a password hash but AUTH_HASH_* is not set:`)
    log('    they are restored WITHOUT a password and must reset it by email.')
  }
  const secondFactors = users.filter((u) => u.multiFactor?.enrolledFactors?.length).length
  if (secondFactors) {
    log(`    ${secondFactors} account(s) had a second factor enrolled. That is not restored; they enrol again.`)
  }

  let restored = 0
  const errors = []
  for (let i = 0; i < users.length; i += 1000) {
    const batch = users.slice(i, i + 1000).map((u) =>
      defined({
        uid: u.uid,
        email: u.email,
        emailVerified: u.emailVerified,
        displayName: u.displayName,
        photoURL: u.photoURL,
        phoneNumber: u.phoneNumber,
        disabled: u.disabled,
        customClaims: u.customClaims,
        metadata: defined({ creationTime: u.metadata?.creationTime, lastSignInTime: u.metadata?.lastSignInTime }),
        // Federated identities only. The password and phone "providers" are the
        // email and phone number above; the import refuses them listed again.
        providerData: (u.providerData ?? [])
          .filter((p) => p.providerId !== 'password' && p.providerId !== 'phone')
          .map((p) => defined({ uid: p.uid, providerId: p.providerId, email: p.email, displayName: p.displayName, photoURL: p.photoURL })),
        passwordHash: withPasswords && u.passwordHash ? hashBytes(u.passwordHash) : undefined,
        passwordSalt: withPasswords && u.passwordHash && u.passwordSalt ? hashBytes(u.passwordSalt) : undefined,
      })
    )
    const result = await auth.importUsers(batch, withPasswords ? options : undefined)
    restored += result.successCount
    for (const e of result.errors) errors.push(`${batch[e.index].uid}: ${e.error.message}`)
  }
  for (const e of errors) console.error(`  ! account ${e}`)
  if (errors.length) fail(`${errors.length} account(s) could not be restored`)
  return { users, restored, withPasswords }
}

async function restoreDocuments(meta) {
  const writer = db.bulkWriter()
  writer.onWriteError((err) => err.failedAttempts < 5)

  const errors = []
  const viaRest = [] // documents holding a whole-number double: see encoding.mjs
  let written = 0

  for (const file of meta.firestore.files) {
    for await (const { path: docPath, data } of readJsonl(inSnapshot(file))) {
      const notes = { wholeDoubles: 0 }
      const decoded = decode(data, db, notes)
      if (notes.wholeDoubles) {
        viaRest.push({ docPath, data })
        continue
      }
      writer.set(db.doc(docPath), decoded).catch((err) => errors.push(`${docPath}: ${err.message}`))
      written += 1
      // Bounded: without this a large collection is queued in memory whole.
      if (written % 2000 === 0) await writer.flush()
    }
  }
  await writer.close()

  if (viaRest.length) {
    const rest = await firestoreRest(ctx)
    for (const { docPath, data } of viaRest) {
      const url = `${rest.url}/${docPath.split('/').map(encodeURIComponent).join('/')}`
      const fields = toRestFields(data.$map ?? data, rest.root)
      const res = await fetch(url, {
        method: 'PATCH',
        headers: { ...rest.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields }),
      })
      if (res.ok) written += 1
      else errors.push(`${docPath}: REST ${res.status} ${(await res.text()).slice(0, 200)}`)
    }
  }

  for (const e of errors) console.error(`  ! document ${e}`)
  if (errors.length) fail(`${errors.length} document(s) could not be written`)
  return { written, viaRest: viaRest.length }
}

async function readObjectList() {
  const all = []
  for await (const record of readJsonl(inSnapshot('objects.jsonl.gz'))) all.push(record)
  return all
}

/** Which objects to restore: all, none, or a random sample of n (placeholders always). */
function chooseObjects(all) {
  if (OBJECTS === 'none') return []
  if (OBJECTS === 'all') return all
  const real = all.filter((r) => !r.placeholder)
  const n = Math.min(Number(OBJECTS), real.length)
  for (let i = 0; i < n; i += 1) {
    const j = i + Math.floor(Math.random() * (real.length - i))
    ;[real[i], real[j]] = [real[j], real[i]]
  }
  return real.slice(0, n)
}

const objectMetadata = (r) =>
  defined({
    contentType: r.contentType,
    contentEncoding: r.contentEncoding,
    contentDisposition: r.contentDisposition,
    contentLanguage: r.contentLanguage,
    cacheControl: r.cacheControl,
    // Custom metadata, including `owner`: the Storage rules decide who may
    // replace or delete an object from it.
    metadata: r.metadata ?? undefined,
  })

// An upload is the same name and the same bytes every time, so trying again is
// always safe. Without this, one dropped connection at object 400 of 2000 fails
// the whole restore.
async function patiently(what, fn, attempts = 4) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn()
    } catch (err) {
      if (attempt >= attempts) throw err
      log(`    retrying ${what}: ${err.message}`)
      await new Promise((resolve) => setTimeout(resolve, 1000 * 3 ** (attempt - 1)))
    }
  }
}

// Above this an upload is resumable, so a large file that is interrupted
// continues instead of starting again. Below it, one request is the whole job.
const RESUMABLE_FROM = 8 * 1024 * 1024

async function restoreObjects(chosen) {
  const errors = []
  let restored = 0
  for (const r of chosen) {
    try {
      if (r.placeholder) {
        await patiently(r.name, () => bucket.file(r.name).save('', { resumable: false, metadata: objectMetadata(r) }))
      } else {
        // gzip:false — the bytes on disk are the stored bytes; nothing is to
        // compress or transcode them on the way back up.
        await patiently(r.name, () =>
          bucket.upload(inSnapshot(`objects/${r.name}`), {
            destination: r.name,
            gzip: false,
            resumable: r.size > RESUMABLE_FROM,
            metadata: objectMetadata(r),
          })
        )
      }
      restored += 1
    } catch (err) {
      errors.push(`${r.name}: ${err.message}`)
    }
  }
  for (const e of errors) console.error(`  ! object ${e}`)
  if (errors.length) fail(`${errors.length} object(s) could not be uploaded`)
  return restored
}

// ---------------------------------------------------------------------------
// 4. Read it back
// ---------------------------------------------------------------------------

const LISTED = 20
const some = (list) => (list.length > LISTED ? [...list.slice(0, LISTED), `… and ${list.length - LISTED} more`] : list)

async function compareDocuments(meta) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'frc5805-verify-'))
  try {
    const now = await dumpFirestore(db, scratch)

    // path -> sha256 of its line in the snapshot. Hashes rather than lines, so a
    // knowledge base of long documents is not held in memory twice.
    const want = new Map()
    for (const file of meta.firestore.files) {
      for await (const line of readLines(inSnapshot(file))) want.set(JSON.parse(line).path, sha256(line))
    }

    const differing = []
    const extra = []
    for (const file of now.files) {
      for await (const line of readLines(path.join(scratch, ...file.split('/')))) {
        const docPath = JSON.parse(line).path
        if (!want.has(docPath)) extra.push(docPath)
        else if (want.get(docPath) !== sha256(line)) differing.push(docPath)
        want.delete(docPath)
      }
    }
    const missing = [...want.keys()]

    const counts = {}
    for (const pattern of new Set([...Object.keys(meta.firestore.collections), ...Object.keys(now.collections)])) {
      counts[pattern] = { snapshot: meta.firestore.collections[pattern] ?? 0, target: now.collections[pattern] ?? 0 }
    }
    const countsEqual = Object.values(counts).every((c) => c.snapshot === c.target)
    return {
      documents: meta.firestore.documents,
      found: now.documents,
      counts,
      countsEqual,
      differing: differing.sort(),
      missing: missing.sort(),
      extra: extra.sort(),
      identical: countsEqual && !differing.length && !missing.length && !extra.length,
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function compareUsers(snapshotUsers, withPasswords) {
  const now = new Map((await listAllUsers(auth)).map((u) => [u.uid, u]))
  const differing = []
  const missing = []
  const view = (u) =>
    JSON.stringify({
      email: u.email ?? null,
      emailVerified: Boolean(u.emailVerified),
      displayName: u.displayName ?? null,
      photoURL: u.photoURL ?? null,
      phoneNumber: u.phoneNumber ?? null,
      disabled: Boolean(u.disabled),
      customClaims: u.customClaims && Object.keys(u.customClaims).length ? u.customClaims : null,
      created: u.metadata?.creationTime ? new Date(u.metadata.creationTime).getTime() : null,
      federated: (u.providerData ?? []).map((p) => p.providerId).filter((p) => p !== 'password' && p !== 'phone').sort(),
    })
  let passwords = 0
  for (const want of snapshotUsers) {
    const got = now.get(want.uid)
    now.delete(want.uid)
    if (!got) {
      missing.push(want.uid)
      continue
    }
    let same = view(want) === view(got)
    if (same && withPasswords && want.passwordHash) {
      // Compared as bytes: the two sides may spell the same base64 differently.
      same = Boolean(got.passwordHash) && hashBytes(want.passwordHash).equals(Buffer.from(got.passwordHash, 'base64'))
      if (same) passwords += 1
    }
    if (!same) differing.push(want.uid)
  }
  const extra = [...now.keys()]
  return {
    users: snapshotUsers.length,
    passwords_restored: passwords,
    passwords_not_restored: snapshotUsers.filter((u) => hasPasswordProvider(u) || u.passwordHash).length - passwords,
    differing,
    missing,
    extra,
    identical: !differing.length && !missing.length && !extra.length,
  }
}

async function hashObject(file) {
  const hash = createHash('sha256')
  for await (const chunk of file.createReadStream({ decompress: false })) hash.update(chunk)
  return hash.digest('hex')
}

async function compareObjects(all, chosen) {
  const differing = []
  const missing = []
  for (const r of chosen) {
    const file = bucket.file(r.name)
    const [exists] = await file.exists()
    if (!exists) {
      missing.push(r.name)
      continue
    }
    const [meta] = await file.getMetadata()
    const custom = meta.metadata ?? {}
    // Every key the snapshot recorded must be back with the same value. The
    // target may add its own (the emulator mints a download token on upload).
    const metadataSame =
      (meta.contentType ?? null) === (r.contentType ?? null) &&
      (meta.contentEncoding ?? null) === (r.contentEncoding ?? null) &&
      (meta.cacheControl ?? null) === (r.cacheControl ?? null) &&
      Object.entries(r.metadata ?? {}).every(([k, v]) => custom[k] === v)
    const bytesSame = r.placeholder ? Number(meta.size) === 0 : (await hashObject(file)) === r.sha256
    if (!metadataSame || !bytesSame) differing.push(r.name)
  }

  let extra = []
  if (OBJECTS === 'all') {
    const want = new Set(all.map((r) => r.name))
    let pageToken
    do {
      const [page, next] = await bucket.getFiles({ autoPaginate: false, maxResults: 1000, pageToken })
      for (const f of page) if (!want.has(f.name)) extra.push(f.name)
      pageToken = next?.pageToken
    } while (pageToken)
  }
  return {
    objects: all.length,
    compared: chosen.length,
    differing,
    missing,
    extra,
    identical: !differing.length && !missing.length && !extra.length,
  }
}

/**
 * Object bytes against the checksums in the RESTORED database.
 *
 * This is the cross-check the manifest cannot provide. SHA256SUMS only proves
 * the snapshot agrees with itself; comparing against sha256 values read back
 * out of the restored `files` collection proves the bytes match what the
 * uploader originally chose. The bytes were hashed in step 1, so this covers
 * every object, not a sample.
 */
async function crossCheckIndex(sums) {
  const mismatched = []
  const missing = []
  let files = 0
  let checked = 0
  for await (const snap of db.collection('files').stream()) {
    files += 1
    const { bucket: folder, path: objectPath, sha256: want } = snap.data()
    const got = sums.get(`objects/${folder}/${objectPath}`)
    if (!got) missing.push(`${folder}/${objectPath}`)
    else if (want) {
      checked += 1
      if (want !== got) mismatched.push(`${folder}/${objectPath}`)
    }
  }
  return { files, checked, mismatched: mismatched.sort(), missing: missing.sort(), clean: !mismatched.length && !missing.length }
}

// ---------------------------------------------------------------------------

async function main() {
  log(`snapshot ${path.basename(SNAPSHOT)} -> ${TARGET} (${ctx.projectId})`)

  log('1/5 verifying the snapshot against its manifest')
  const { sums, meta, manifestSha } = await checkSnapshot()

  const all = await readObjectList()
  const chosen = chooseObjects(all)
  const report = { snapshot: meta.stamp, manifest_sha: manifestSha, target: TARGET, project: ctx.projectId }
  let snapshotUsers = []
  let withPasswords = !ctx.emulated ? Boolean(hashOptions()) : true

  if (VERIFY_ONLY) {
    log('2/5 and 3/5 skipped: --verify-only')
    for await (const user of readJsonl(inSnapshot('auth_users.jsonl.gz'))) snapshotUsers.push(user)
  } else {
    log('2/5 preparing the target')
    if (flag('wipe')) await wipeEmulators()
    else if (!flag('allow-non-empty') && !(await targetIsEmpty())) {
      fail(
        `"${ctx.projectId}" already has data in it. A restore overwrites documents and objects with the same\n` +
          '          name and leaves the rest, so the result is a mixture. If that is what you want, add --allow-non-empty.'
      )
    }

    log('3/5 restoring accounts, documents, objects')
    const accounts = await restoreUsers()
    snapshotUsers = accounts.users
    withPasswords = accounts.withPasswords
    log(`    ${accounts.restored} account(s)`)
    const docs = await restoreDocuments(meta)
    log(`    ${docs.written} document(s)` + (docs.viaRest ? ` (${docs.viaRest} through REST, to keep a whole-number double a double)` : ''))
    const uploaded = await restoreObjects(chosen)
    log(`    ${uploaded} of ${all.length} object(s)` + (OBJECTS === 'all' ? '' : ` (--objects=${OBJECTS})`))
    report.restored = { accounts: accounts.restored, documents: docs.written, documents_via_rest: docs.viaRest, objects: uploaded }
  }

  if (NO_VERIFY) {
    log('4/5 and 5/5 skipped: --no-verify')
    console.log(`\n  RESTORED — ${meta.stamp}, not read back`)
    return 0
  }

  // A dump of an empty database restores perfectly. Structural success is not
  // evidence of a usable backup, so every comparison is asserted, not printed.
  log('4/5 reading the target back and comparing')
  report.firestore = await compareDocuments(meta)
  report.auth = await compareUsers(snapshotUsers, withPasswords)
  report.storage = await compareObjects(all, chosen)
  const c = report.firestore.counts
  log(
    `    files=${c.files?.target ?? 0} docs=${c.knowledge_docs?.target ?? 0} profiles=${c.profiles?.target ?? 0}` +
      ` — ${report.firestore.found} of ${report.firestore.documents} documents, ${report.auth.users} accounts,` +
      ` ${report.storage.compared} of ${report.storage.objects} objects compared`
  )
  if (!c.profiles?.target) fail('profiles is empty — restored, but with no roster in it')
  // Warned rather than fatal: a brand-new team legitimately has neither yet.
  if (!c.files?.target) log('    WARNING: the file index is empty')
  if (!c.knowledge_docs?.target) log('    WARNING: the knowledge base is empty')

  log('5/5 verifying object bytes against checksums in the restored database')
  report.index = await crossCheckIndex(sums)
  log(`    cross-checked ${report.index.checked} object(s)`)
  if (meta.storage.orphans.length) log(`    note: ${meta.storage.orphans.length} object(s) in the snapshot have no files document`)

  const findings = []
  const say = (label, list) => {
    if (list.length) findings.push(`${list.length} ${label}: ${some(list).join(', ')}`)
  }
  if (!report.firestore.countsEqual) {
    const off = Object.entries(c).filter(([, v]) => v.snapshot !== v.target)
    findings.push('document counts differ: ' + off.map(([k, v]) => `${k} ${v.target} (snapshot ${v.snapshot})`).join(', '))
  }
  say('document(s) differ from the snapshot', report.firestore.differing)
  say('document(s) are missing from the target', report.firestore.missing)
  say('document(s) are in the target but not the snapshot', report.firestore.extra)
  say('account(s) differ', report.auth.differing)
  say('account(s) are missing from the target', report.auth.missing)
  say('account(s) are in the target but not the snapshot', report.auth.extra)
  say('object(s) differ', report.storage.differing)
  say('object(s) are missing from the target', report.storage.missing)
  say('object(s) are in the target but not the snapshot', report.storage.extra)
  say('object(s) do not match the checksum in the files index', report.index.mismatched)
  say('object(s) named by the files index are absent from the backup', report.index.missing)

  report.passed = findings.length === 0
  report.findings = findings
  if (option('report')) await writeFile(option('report'), JSON.stringify(report, null, 2) + '\n', 'utf8')

  if (report.auth.passwords_not_restored) {
    log(`    note: ${report.auth.passwords_not_restored} account(s) came back without their password`)
  }
  if (findings.length) {
    console.error(`\n  NOT IDENTICAL — ${meta.stamp}`)
    for (const f of findings) console.error(`    ! ${f}`)
    return 2
  }
  console.log(
    `\n  PASSED — ${meta.stamp} is restorable (${c.files?.target ?? 0} files, ${c.knowledge_docs?.target ?? 0} docs, ${c.profiles.target} profiles)`
  )
  return 0
}

main()
  .catch((err) => {
    if (err instanceof Refusal) console.error(`\n  FAILED: ${err.message}`)
    else console.error(err)
    return 1
  })
  .then((code) => finish(ctx, code))
