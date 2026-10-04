// The repo archiver against the local emulators, with a stand-in for GitHub
// served from this process.
//
//   npx firebase --config firebase.backup-test.json emulators:exec \
//     --project demo-frc5805 "node scripts/backup/test/repo-archive.test.mjs"
//
// Talks only to 127.0.0.1: the emulators, and the little HTTP server below. The
// archiver takes its GitHub address from ARCHIVE_GITHUB_API only when it is
// running against the emulators, so nothing here can reach the real one.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { initializeApp } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT = 'demo-frc5805'
const BUCKET = 'demo-frc5805.appspot.com'
const YEAR = new Date().getUTCFullYear()

for (const name of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST']) {
  if (!process.env[name]) {
    console.error(`${name} is not set. Run this through emulators:exec (see the top of this file).`)
    process.exit(1)
  }
}
delete process.env.GOOGLE_APPLICATION_CREDENTIALS

const app = initializeApp({ projectId: PROJECT, storageBucket: BUCKET })
const db = getFirestore(app)
const bucket = getStorage(app).bucket(BUCKET)
const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const scratch = mkdtempSync(path.join(os.tmpdir(), 'frc5805-archive-test-'))

// --- a stand-in for GitHub, and for a plain download URL --------------------
const upstream = {
  commit: 'a1b2c3d' + '0'.repeat(33),
  tarball: () => Buffer.from(`tarball of ${upstream.commit}`),
  cad: Buffer.from('cad export, first revision'),
  broken: false,
  hits: [],
}
const server = http.createServer((req, res) => {
  upstream.hits.push(req.url)
  if (upstream.broken) return res.writeHead(404).end('not found')
  if (req.url === '/repos/team5805/robot-code/commits/main') return res.end(upstream.commit)
  if (req.url === `/repos/team5805/robot-code/tarball/${upstream.commit}`) return res.end(upstream.tarball())
  if (req.url === '/dl/cad.tar.gz') return res.end(upstream.cad)
  res.writeHead(404).end('not found')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const ORIGIN = `http://127.0.0.1:${server.address().port}`

const ENV = {
  ...process.env,
  FIREBASE_PROJECT_ID: PROJECT,
  FIREBASE_STORAGE_BUCKET: BUCKET,
  ARCHIVE_GITHUB_API: ORIGIN,
  ARCHIVE_TMP: path.join(scratch, 'tmp'),
  GITHUB_TOKEN: '',
}
function archive(...args) {
  // spawnSync would block this process, and with it the server the child needs.
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, '..', 'repo-archive.mjs'), ...args], { env: ENV })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => {
      if (process.env.BACKUP_TEST_VERBOSE) console.log(`\n--- repo-archive.mjs ${args.join(' ')} -> exit ${code}\n${out.trimEnd()}\n---`)
      resolve({ code, out })
    })
  })
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

async function wipe() {
  const url = `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`
  assert.ok((await fetch(url, { method: 'DELETE', headers: { Authorization: 'Bearer owner' } })).ok)
  await bucket.deleteFiles({ force: true })
}
const objectNames = async () => (await bucket.getFiles())[0].map((f) => f.name).sort()
const rows = async (name) => (await db.collection(name).get()).docs.map((d) => ({ id: d.id, ...d.data() }))
const makeDue = (id) => db.doc(`repo_sources/${id}`).update({ last_synced_at: Timestamp.fromMillis(Date.now() - 48 * 3600_000) })

const source = (fields) => ({
  label: null, provider: 'github', owner: null, repo: null, git_ref: 'HEAD', url: null, enabled: true, interval_hours: 24,
  last_synced_at: null, last_status: null, last_error: null, last_sha: null, created_by: 'uid-admin',
  created_at: Timestamp.now(), updated_at: Timestamp.now(), ...fields,
})

console.log('repo archiver\n')

const codeName = () => `code/${YEAR}/robot-code-${upstream.commit.slice(0, 7)}.tar.gz`
const cadName = () => `code/${YEAR}/cad-drawings-${sha256(upstream.cad).slice(0, 7)}.tar.gz`
let firstFileCreated

await step('seed three sources: a GitHub repo, a plain URL, and a disabled one', async () => {
  await wipe()
  await db.doc('repo_sources/gh').set(source({ label: 'Robot Code', owner: 'team5805', repo: 'robot-code', git_ref: 'main' }))
  await db.doc('repo_sources/cad').set(source({ label: 'CAD drawings', provider: 'url', url: `${ORIGIN}/dl/cad.tar.gz`, interval_hours: 1, created_by: null }))
  await db.doc('repo_sources/off').set(source({ label: 'Retired', owner: 'team5805', repo: 'old', enabled: false }))
})

await step('first run archives both: object, files document by its deterministic id, code_archives row', async () => {
  const r = await archive()
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /2 enabled, 2 due/)
  assert.deepEqual(await objectNames(), [cadName(), codeName()].sort())

  const [bytes] = await bucket.file(codeName()).download()
  assert.ok(bytes.equals(upstream.tarball()))
  const [meta] = await bucket.file(codeName()).getMetadata()
  assert.equal(meta.contentType, 'application/gzip')
  assert.equal(meta.metadata.owner, 'uid-admin')

  const id = `code~${YEAR}~robot-code-a1b2c3d.tar.gz`
  const file = (await db.doc(`files/${id}`).get()).data()
  assert.ok(file, `files/${id} exists`)
  assert.deepEqual(
    { ...file, created_at: null, updated_at: null },
    {
      bucket: 'code', path: `${YEAR}/robot-code-a1b2c3d.tar.gz`, title: 'Robot Code @ a1b2c3d', description: 'Automated archive of team5805/robot-code',
      kind: 'code', season: YEAR, tags: [], byte_size: bytes.length, sha256: sha256(bytes), uploaded_by: 'uid-admin', created_at: null, updated_at: null,
    }
  )
  assert.ok(file.created_at instanceof Timestamp && file.updated_at instanceof Timestamp)
  firstFileCreated = file.created_at

  const archives = await rows('code_archives')
  assert.equal(archives.length, 2)
  const code = archives.find((a) => a.repo === 'team5805/robot-code')
  assert.deepEqual(
    { ...code, id: null, created_at: null, updated_at: null },
    {
      id: null, repo: 'team5805/robot-code', ref: 'main', commit_sha: upstream.commit, season: YEAR, notes: 'Archived automatically from github',
      file: { id, bucket: 'code', path: `${YEAR}/robot-code-a1b2c3d.tar.gz`, byte_size: bytes.length }, created_by: 'uid-admin', created_at: null, updated_at: null,
    }
  )
  const cad = archives.find((a) => a.repo === 'CAD drawings')
  assert.equal(cad.commit_sha, sha256(upstream.cad).slice(0, 40), 'a URL source is identified by its content')
  assert.equal(cad.created_by, null)

  const gh = (await db.doc('repo_sources/gh').get()).data()
  assert.equal(gh.last_status, 'ok')
  assert.equal(gh.last_sha, upstream.commit)
  assert.equal(gh.last_error, null)
  assert.ok(gh.last_synced_at instanceof Timestamp)
  assert.equal((await db.doc('repo_sources/off').get()).data().last_status, null, 'a disabled source is left alone')
  assert.ok(!existsSync(ENV.ARCHIVE_TMP) || readdirSync(ENV.ARCHIVE_TMP).length === 0, 'no tarball left in the scratch directory')
})

await step('run again at once: nothing is due', async () => {
  const r = await archive()
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /2 enabled, 0 due/)
})

await step('--force re-archives, and adds no second row for the same commit', async () => {
  const r = await archive('--force')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /done: 2 archived, 0 unchanged, 0 failed/)
  assert.equal((await rows('code_archives')).length, 2, 'still one row per repo and commit')
  assert.equal((await rows('files')).length, 2)
  assert.equal((await objectNames()).length, 2)
  const file = (await db.doc(`files/code~${YEAR}~robot-code-a1b2c3d.tar.gz`).get()).data()
  assert.ok(file.created_at.isEqual(firstFileCreated), 'the existing files document is updated, not replaced')
})

await step('a URL source that has not changed is not stored again when its interval comes round', async () => {
  await makeDue('cad')
  const r = await archive()
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /2 enabled, 1 due/)
  assert.match(r.out, /skip {2}CAD drawings — unchanged at/)
  assert.equal((await objectNames()).length, 2)
  assert.equal((await rows('code_archives')).length, 2)
  const cad = (await db.doc('repo_sources/cad').get()).data()
  assert.equal(cad.last_status, 'ok')
  assert.ok(Date.now() - cad.last_synced_at.toMillis() < 60_000, 'and it is not asked again until the next interval')
})

await step('a URL source that has changed is', async () => {
  const before = cadName()
  upstream.cad = Buffer.from('cad export, second revision')
  await makeDue('cad')
  const r = await archive()
  assert.equal(r.code, 0, r.out)
  assert.notEqual(cadName(), before)
  assert.deepEqual(await objectNames(), [before, cadName(), codeName()].sort())
  assert.equal((await rows('code_archives')).length, 3)
})

await step('a new commit is a new archive; --repo picks one source', async () => {
  const before = codeName()
  upstream.commit = 'feedbee' + '1'.repeat(33)
  await makeDue('gh')
  await makeDue('cad')
  const r = await archive('--repo=team5805/robot-code')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /1 enabled, 1 due/)
  assert.equal((await objectNames()).length, 4)
  assert.ok((await objectNames()).includes(codeName()) && (await objectNames()).includes(before))
  assert.equal((await rows('code_archives')).filter((a) => a.repo === 'team5805/robot-code').length, 2)

  // Same commit again, due again: asked, answered "unchanged", nothing downloaded.
  await makeDue('gh')
  upstream.hits.length = 0
  const again = await archive('--repo=robot-code')
  assert.match(again.out, /skip {2}Robot Code — unchanged at feedbee/)
  assert.deepEqual(upstream.hits, ['/repos/team5805/robot-code/commits/main'])
})

await step('a source that fails is recorded as failed, exits 2, and leaves the others alone', async () => {
  upstream.broken = true
  await makeDue('gh')
  const r = await archive('--repo=robot-code')
  assert.equal(r.code, 2, r.out)
  const gh = (await db.doc('repo_sources/gh').get()).data()
  assert.equal(gh.last_status, 'failed')
  assert.match(gh.last_error, /HTTP 404/)
  assert.equal(gh.last_sha, upstream.commit, 'the last good commit is still remembered')
  assert.equal((await objectNames()).length, 4)
  upstream.broken = false

  await db.doc('repo_sources/bad').set(source({ label: 'Bad row', owner: 'team5805/../..', repo: 'x' }))
  const bad = await archive('--repo=Bad row')
  assert.equal(bad.code, 2, bad.out)
  assert.match(bad.out, /owner and repo must be plain GitHub names/)
})

server.close()
await wipe()
rmSync(scratch, { recursive: true, force: true })
console.log(failed ? '\nFAILED' : '\nall passed')
process.exit(failed ? 1 : 0)
