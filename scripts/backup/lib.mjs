/**
 * What the backup scripts share: the connection, the snapshot's file formats,
 * and the walk over Firestore. mirror.mjs writes a snapshot with these and
 * restore.mjs reads one back, so the two cannot drift apart on what a line means.
 */

import { initializeApp, deleteApp, cert } from 'firebase-admin/app'
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore'
import { getAuth } from 'firebase-admin/auth'
import { getStorage } from 'firebase-admin/storage'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, readFileSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createGzip, createGunzip } from 'node:zlib'
import { createInterface } from 'node:readline'
import { once, EventEmitter } from 'node:events'
import { finished } from 'node:stream/promises'
import path from 'node:path'

import { encodeDocument } from './encoding.mjs'

export { Timestamp, FieldValue }

// The Storage client's HTTP layer hangs eleven listeners on one stream for any
// download of more than a few megabytes, one past Node's warning threshold. The
// count is fixed, not growing; without this every large object prints a
// "possible memory leak" warning into the journal, every night.
EventEmitter.defaultMaxListeners = 20

/** The five folders of the one bucket (the old five buckets). */
export const FOLDERS = ['graphs', 'code', 'knowledge', 'media', 'public-media']

export const LEG_MIRROR = 'firebase->server'
export const LEG_OFFSITE = 'server->optiplex'

/**
 * Subcollections the walk always looks for, whether or not any living document
 * has one. Discovery (below) finds the rest, but it works from documents that
 * exist: a knowledge doc that was deleted leaves its `versions` behind with no
 * parent to discover them from.
 */
export const KNOWN_SUBCOLLECTIONS = ['versions', 'entries', 'observations']

const EMULATOR_VARS = ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST']

export function die(message) {
  console.error(message)
  process.exit(1)
}

export function need(name) {
  const v = process.env[name]
  if (!v) die(`missing required env var: ${name}`)
  return v
}

/**
 * The service-account key, checked before it is used.
 *
 * The Supabase version of this job had one near-invisible way to fail: paste the
 * anon key where the service-role key belongs and it backed up nothing, without
 * error, and reported success. Firebase has no key that quietly reads nothing —
 * a credential without the role gets PERMISSION_DENIED — but the same family of
 * mistake is still on offer: the wrong file, the web app's config, a personal
 * `gcloud` login, or a key for a different project. Each is refused here by
 * name, and mirror.mjs additionally refuses a project in which it can read no
 * profiles at all.
 */
function readServiceAccount(projectId) {
  const file = need('GOOGLE_APPLICATION_CREDENTIALS')
  let stats
  let key
  try {
    stats = statSync(file)
    key = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    die(`GOOGLE_APPLICATION_CREDENTIALS: cannot read ${file} as JSON (${err.code ?? err.message}).`)
  }
  if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
    die(
      `GOOGLE_APPLICATION_CREDENTIALS: ${file} is readable by other users (mode ${(stats.mode & 0o777).toString(8)}).\n` +
        'That file can read and write everything in the project. chmod 600 it.'
    )
  }
  if (key.type !== 'service_account' || !key.private_key || !key.client_email) {
    die(
      `GOOGLE_APPLICATION_CREDENTIALS: ${file} is not a service-account key` +
        (key.type ? ` (it is a "${key.type}" credential).` : '.') +
        '\nThe web app config and a personal gcloud login are both the wrong thing here.\n' +
        'Create a key for the backup service account: see docs/BACKUP.md.'
    )
  }
  if (key.project_id !== projectId) {
    die(
      `GOOGLE_APPLICATION_CREDENTIALS is a key for project "${key.project_id}", but FIREBASE_PROJECT_ID is "${projectId}".\n` +
        'Refusing to guess which one is meant.'
    )
  }
  return key
}

/**
 * Open the project named by the environment. Returns the Admin SDK handles plus
 * whether this is the local emulators.
 *
 * Emulators are all-or-nothing: with only some of the three variables set, the
 * rest of the run would go to the live project.
 *
 * `exact: true` is for the scripts that copy documents (mirror, restore): it
 * makes integers arrive as BigInt and doubles as number, so 2 and 2.0 stay
 * distinguishable (encoding.mjs). The scripts that only read a few fields leave
 * it off and get ordinary numbers.
 */
export function connect({ exact = false } = {}) {
  const set = EMULATOR_VARS.filter((n) => process.env[n])
  if (set.length && set.length < EMULATOR_VARS.length) {
    die(
      `only ${set.join(', ')} set. All three of ${EMULATOR_VARS.join(', ')} must be set\n` +
        'together, or none: a half-emulated run would read or write the live project for the rest.'
    )
  }
  const emulated = set.length > 0
  // The client libraries each read their own variable (STORAGE_EMULATOR_HOST,
  // for one). Any of them left set would send that one service to an emulator
  // while the rest of the run went to the live project.
  const stray = Object.keys(process.env).filter((n) => n.endsWith('_EMULATOR_HOST') && process.env[n])
  if (!emulated && stray.length) {
    die(`${stray.join(', ')} is set, but this is not an emulator run. Unset it, or set all of ${EMULATOR_VARS.join(', ')}.`)
  }
  const projectId = need('FIREBASE_PROJECT_ID')
  const bucketName = need('FIREBASE_STORAGE_BUCKET')

  let app
  if (emulated) {
    // No credential, and none left lying in the environment for a client library
    // to pick up and exchange with Google on its own initiative.
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS
    app = initializeApp({ projectId, storageBucket: bucketName })
    console.log(`EMULATORS — project ${projectId}; nothing here touches a live project`)
  } else {
    const key = readServiceAccount(projectId)
    app = initializeApp({ credential: cert(key), projectId, storageBucket: bucketName })
  }

  const db = getFirestore(app)
  if (exact) db.settings({ useBigInt: true })

  return { app, db, auth: getAuth(app), bucket: getStorage(app).bucket(bucketName), projectId, bucketName, emulated }
}

/**
 * End the run with `code`, by closing the clients and letting Node stop on its
 * own rather than by calling process.exit() over open connections. On Windows
 * that call can die inside libuv (an assertion in async.c) after the work is
 * done and turn a clean run into a crash exit code; and on any platform it can
 * cut off a write that was still on its way out.
 *
 * The timer is the bound on "on its own": it does not keep the process alive,
 * it only ends one that something else is keeping alive.
 */
export async function finish(ctx, code) {
  process.exitCode = code
  await deleteApp(ctx.app).catch(() => {})
  setTimeout(() => process.exit(code), 10_000).unref()
}

/** Where the Firestore REST API is for this connection, and how to authenticate. */
export async function firestoreRest(ctx) {
  const root = `projects/${ctx.projectId}/databases/(default)/documents`
  if (ctx.emulated) {
    return { url: `http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/${root}`, root, headers: { Authorization: 'Bearer owner' } }
  }
  const token = await ctx.app.options.credential.getAccessToken()
  return {
    url: `https://firestore.googleapis.com/v1/${root}`,
    root,
    headers: { Authorization: `Bearer ${token.access_token}` },
  }
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** UTC, and colon-free so the path is valid on every filesystem it is copied to. */
export const makeStamp = (date = new Date()) => date.toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z'

export async function sha256File(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/** A gzipped JSON Lines file, written one line at a time. */
export class JsonlWriter {
  constructor(file) {
    this.file = file
    this.lines = 0
    this.gzip = createGzip({ level: 9 })
    this.out = createWriteStream(file)
    this.done = finished(this.gzip.pipe(this.out))
    // Claimed now, so an error before close() is reported by close() rather
    // than as an unhandled rejection.
    this.done.catch(() => {})
    this.gzip.on('error', (err) => this.out.destroy(err))
  }

  /** `line` is already-serialised JSON. */
  async write(line) {
    this.lines += 1
    if (!this.gzip.write(line + '\n')) await once(this.gzip, 'drain')
  }

  async close() {
    this.gzip.end()
    await this.done
    return statSync(this.file).size
  }
}

/** Every line of a gzipped JSON Lines file, as text. */
export async function* readLines(file) {
  const rl = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity })
  for await (const line of rl) if (line) yield line
}

export async function* readJsonl(file) {
  for await (const line of readLines(file)) yield JSON.parse(line)
}

// ---------------------------------------------------------------------------
// Firestore
// ---------------------------------------------------------------------------

/** `picklists/abc/entries/5805` -> `picklists/{id}/entries`: which collection a document is in. */
export function collectionPattern(docPath) {
  return docPath
    .split('/')
    .filter((_, i) => i % 2 === 0)
    .join('/{id}/')
}

/** The file a collection is written to. Cosmetic: every line carries its own full path. */
export function collectionFile(pattern) {
  const safe = pattern
    .split('/{id}/')
    .map((id) => id.replace(/[^A-Za-z0-9_-]/g, (c) => '%' + c.codePointAt(0).toString(16)))
    .join('__')
  return `firestore/${safe}.jsonl.gz`
}

async function inBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn))
}

/**
 * Every document in the database, written under `dir/firestore/`, one gzipped
 * JSON Lines file per collection and one line per document.
 *
 * Top-level collections come from listCollections(), so a collection added next
 * year is backed up without anyone editing this file. Subcollections are found
 * the same way: every document read is asked which collections hang off it, and
 * each name found is then read as a collection group, which also returns the
 * ones whose parent document no longer exists.
 *
 * What that cannot find: a subcollection whose name is on no living document
 * anywhere and is not in KNOWN_SUBCOLLECTIONS.
 *
 * The walk is not one transaction. A write that lands mid-run can be in one
 * collection's file and not in another's; the job runs at night for that reason.
 *
 * `onDocument(path, data)` sees each document as it is written.
 */
export async function dumpFirestore(db, dir, onDocument = () => {}) {
  await mkdir(path.join(dir, 'firestore'), { recursive: true })

  const writers = new Map() // file -> JsonlWriter
  const counts = new Map() // pattern -> documents
  const pending = new Set(KNOWN_SUBCOLLECTIONS)
  const walked = new Set()

  const discover = (refs) =>
    inBatches(refs, 24, async (ref) => {
      for (const sub of await ref.listCollections()) if (!walked.has(sub.id)) pending.add(sub.id)
    })

  async function walk(query, subcollectionsOnly) {
    let refs = []
    for await (const snap of query.stream()) {
      // A collection group also matches a top-level collection of the same
      // name, which the first pass has already written.
      if (subcollectionsOnly && snap.ref.parent.parent === null) continue

      const pattern = collectionPattern(snap.ref.path)
      const file = collectionFile(pattern)
      if (!writers.has(file)) writers.set(file, new JsonlWriter(path.join(dir, file)))
      const data = snap.data()
      await writers.get(file).write(encodeDocument(snap.ref.path, data))
      counts.set(pattern, (counts.get(pattern) ?? 0) + 1)
      onDocument(snap.ref.path, data)

      refs.push(snap.ref)
      if (refs.length >= 240) {
        await discover(refs)
        refs = []
      }
    }
    await discover(refs)
  }

  try {
    const top = await db.listCollections()
    for (const collection of top.sort((a, b) => (a.id < b.id ? -1 : 1))) await walk(collection, false)

    while (pending.size) {
      const id = [...pending].sort()[0]
      pending.delete(id)
      walked.add(id)
      await walk(db.collectionGroup(id), true)
    }
  } catch (err) {
    for (const w of writers.values()) w.gzip.destroy()
    throw err
  }

  let bytes = 0
  const files = []
  for (const [file, writer] of [...writers].sort()) {
    bytes += await writer.close()
    files.push(file)
  }
  const collections = Object.fromEntries([...counts].sort())
  const documents = [...counts.values()].reduce((a, b) => a + b, 0)
  return { files, collections, documents, bytes }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Every account, sorted by uid. */
export async function listAllUsers(auth) {
  const users = []
  let pageToken
  do {
    const page = await auth.listUsers(1000, pageToken)
    for (const user of page.users) users.push(user.toJSON())
    pageToken = page.pageToken
  } while (pageToken)
  return users.sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0))
}

export const hasPasswordProvider = (user) => (user.providerData ?? []).some((p) => p.providerId === 'password')

// ---------------------------------------------------------------------------
// backup_runs
// ---------------------------------------------------------------------------

/**
 * One row. Every field is always present, null when it has no value: the
 * portal orders by `started_at`, and a document without the field is simply
 * absent from that query rather than sorted last.
 */
export function runRow(fields) {
  return {
    leg: null,
    status: 'running',
    started_at: Timestamp.now(),
    finished_at: null,
    object_count: null,
    byte_total: null,
    db_dump_bytes: null,
    manifest_sha: null,
    restore_tested_at: null,
    error: null,
    created_at: FieldValue.serverTimestamp(),
    ...fields,
  }
}
