#!/usr/bin/env node
/**
 * Leg 1 of the network backup: Firebase -> local disk on the backup server.
 *
 * Writes every Firestore document, every Auth account and every Storage object
 * into a dated snapshot directory, verifies each object against the checksum
 * recorded at upload time, writes a SHA256SUMS manifest, and reports the result
 * into `backup_runs`.
 *
 * Runs with a service-account key through the Admin SDK. That bypasses the
 * security rules — which is the point, since the backup must see every document
 * and object regardless of who owns it — and is exactly why this script runs on
 * the server and never in a browser.
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=...  path to the service-account key file
 *   FIREBASE_PROJECT_ID=...             the project id
 *   FIREBASE_STORAGE_BUCKET=...         the bucket name, without gs://
 *   BACKUP_ROOT=/srv/backup/frc5805
 *
 * Exit codes: 0 ok, 1 failed, 2 partial (a usable snapshot exists, but not a
 * complete and verified one).
 */

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'

import {
  connect, finish, dumpFirestore, listAllUsers, hasPasswordProvider, JsonlWriter, sha256File, makeStamp,
  runRow, Timestamp, LEG_MIRROR, FOLDERS,
} from './lib.mjs'
import { ENCODING_VERSION } from './encoding.mjs'

const ROOT = process.env.BACKUP_ROOT || '/srv/backup/frc5805'
const ctx = connect({ exact: true })
const { db, auth, bucket } = ctx

const stamp = makeStamp()
const dest = path.join(ROOT, stamp)

let run = null

async function openRun() {
  try {
    run = await db.collection('backup_runs').add(runRow({ leg: LEG_MIRROR, status: 'running' }))
  } catch (err) {
    console.warn(`could not open backup_runs row: ${err.message}`)
  }
}

async function closeRun(fields) {
  if (!run) return
  try {
    await run.update({ finished_at: Timestamp.now(), ...fields })
  } catch (err) {
    console.warn(`could not close backup_runs row: ${err.message}`)
  }
}

/**
 * Refuse a project this job cannot have been meant for.
 *
 * The old script's worst failure was a key that read nothing and a job that
 * reported a successful backup of it — strictly worse than no backup, because it
 * also tells you that you have one. A portal with no profiles is not a portal:
 * it is the wrong project id, the wrong database, or a project nobody has signed
 * in to yet, and none of those should produce a green row. Checked before
 * anything is written anywhere, including backup_runs. False means stop.
 */
async function preflight() {
  let probe
  try {
    probe = await db.collection('profiles').limit(1).get()
  } catch (err) {
    console.error(`cannot read Firestore in project "${ctx.projectId}": ${err.message}`)
    console.error('The service account needs the Cloud Datastore User role: see docs/BACKUP.md.')
    return false
  }
  if (probe.empty) {
    console.error(
      `project "${ctx.projectId}" has no profiles at all.\n` +
        'That is the wrong project, the wrong database, or an empty one. Backing it up\n' +
        'would record a successful backup of nothing, so this run stops here.'
    )
    return false
  }
  return true
}

/**
 * Where an object goes on disk, or null if its name cannot be a path. Storage
 * allows names a filesystem does not: `..` segments, empty segments, control
 * characters. Such an object is counted as a failure, never written somewhere
 * surprising and never silently skipped.
 */
function localPath(name) {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\\]/.test(name)) return null
  const parts = name.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null
  return path.join(dest, 'objects', ...parts)
}

async function download(file, target) {
  await mkdir(path.dirname(target), { recursive: true })

  // Streamed rather than buffered: CAD exports and season video will not fit
  // comfortably in memory, and this job runs unattended. `decompress: false`
  // keeps the stored bytes as stored, which is what the checksum was taken of.
  const hash = createHash('sha256')
  let bytes = 0
  const source = file.createReadStream({ decompress: false })
  source.on('data', (chunk) => {
    hash.update(chunk)
    bytes += chunk.length
  })
  await pipeline(source, createWriteStream(target))
  return { sha256: hash.digest('hex'), bytes }
}

async function downloadWithRetry(file, target) {
  try {
    return await download(file, target)
  } catch (err) {
    console.warn(`  retrying ${file.name}: ${err.message}`)
    return download(file, target)
  }
}

/** Returns the exit code. */
async function main() {
  if (!(await preflight())) return 1
  await mkdir(dest, { recursive: true })
  await openRun()

  // sha256 -> path, for SHA256SUMS. Everything the snapshot holds goes in.
  const manifest = []

  // --- Firestore -------------------------------------------------------------
  // The checksums recorded by the browser at upload time come out of this pass.
  // Comparing against these proves the bytes on disk are the bytes the uploader
  // actually chose — a manifest generated purely from the downloaded copy would
  // only ever be self-consistent, and would happily certify corrupted data.
  const expected = new Map() // object name -> { id, sha256 }
  let store
  try {
    store = await dumpFirestore(db, dest, (docPath, data) => {
      const m = /^files\/([^/]+)$/.exec(docPath)
      if (m && typeof data.bucket === 'string' && typeof data.path === 'string') {
        expected.set(`${data.bucket}/${data.path}`, { id: m[1], sha256: data.sha256 ?? null })
      }
    })
  } catch (err) {
    console.error(`! Firestore export failed: ${err.message}`)
    await closeRun({ status: 'failed', error: `firestore: ${err.message}` })
    return 1
  }
  for (const [pattern, n] of Object.entries(store.collections)) console.log(`${pattern}: ${n} documents`)

  if (!store.collections.profiles) {
    console.error('! the export contains no profiles — refusing to call this a backup')
    await closeRun({ status: 'failed', error: 'export contains no profiles' })
    return 1
  }

  // --- Auth ------------------------------------------------------------------
  // Without the accounts the roster is a list of ids: the email that says who
  // each profile actually is lives in Auth, not in Firestore.
  let users
  let authBytes = 0
  try {
    users = await listAllUsers(auth)
    const writer = new JsonlWriter(path.join(dest, 'auth_users.jsonl.gz'))
    for (const user of users) await writer.write(JSON.stringify(user))
    authBytes = await writer.close()
  } catch (err) {
    console.error(`! Auth export failed: ${err.message}`)
    await closeRun({ status: 'failed', error: `auth: ${err.message}` })
    return 1
  }
  const passwordUsers = users.filter(hasPasswordProvider).length
  const passwordHashes = users.filter((u) => u.passwordHash).length
  console.log(`auth: ${users.length} accounts, ${passwordHashes} of ${passwordUsers} password hashes exported`)

  // --- Storage ---------------------------------------------------------------
  const objects = new JsonlWriter(path.join(dest, 'objects.jsonl.gz'))
  const seen = new Set()
  const failed = [] // { name, error }
  const mismatched = []
  const unrecorded = [] // has a files document, but it records no checksum
  const orphans = [] // no files document at all
  const perFolder = new Map()
  let objectBytes = 0
  let copied = 0
  let placeholders = 0

  try {
    let pageToken
    do {
      // Paged by hand. Left to itself the client collects every page into one
      // array before returning.
      const [page, next] = await bucket.getFiles({ autoPaginate: false, maxResults: 1000, pageToken })
      for (const file of page) {
        const name = file.name
        const meta = file.metadata ?? {}
        const record = {
          name,
          size: Number(meta.size ?? 0),
          contentType: meta.contentType ?? null,
          contentEncoding: meta.contentEncoding ?? null,
          contentDisposition: meta.contentDisposition ?? null,
          contentLanguage: meta.contentLanguage ?? null,
          cacheControl: meta.cacheControl ?? null,
          metadata: meta.metadata ?? null,
          timeCreated: meta.timeCreated ?? null,
          updated: meta.updated ?? null,
        }

        // The console's "create folder" makes a zero-byte object named `x/`.
        // Not a file; recorded so a restore can put it back, and not downloaded.
        if (name.endsWith('/')) {
          placeholders += 1
          await objects.write(JSON.stringify({ ...record, placeholder: true }))
          continue
        }

        const target = localPath(name)
        if (!target) {
          console.error(`! ${JSON.stringify(name)}: not a name that can be a file path`)
          failed.push({ name, error: 'name cannot be a file path' })
          continue
        }

        let got
        try {
          got = await downloadWithRetry(file, target)
          if (got.bytes !== record.size) throw new Error(`got ${got.bytes} bytes, Storage says ${record.size}`)
        } catch (err) {
          console.error(`! ${name}: ${err.message}`)
          failed.push({ name, error: String(err.message ?? err) })
          continue
        }

        seen.add(name)
        const index = expected.get(name)
        let check = 'ok'
        if (!index) {
          check = 'orphan'
          orphans.push(name)
        } else if (!index.sha256) {
          // Copied, but nothing to compare it against. Counted so the run can
          // report how much of it is actually verified rather than implying all.
          check = 'unrecorded'
          unrecorded.push(name)
        } else if (index.sha256 !== got.sha256) {
          console.error(`! CHECKSUM MISMATCH ${name}\n    expected ${index.sha256}\n    got      ${got.sha256}`)
          check = 'mismatch'
          mismatched.push(name)
        }

        await objects.write(JSON.stringify({ ...record, sha256: got.sha256, index: index?.id ?? null, check }))
        manifest.push([got.sha256, `objects/${name}`])
        objectBytes += got.bytes
        copied += 1
        const folder = name.split('/')[0]
        perFolder.set(folder, (perFolder.get(folder) ?? 0) + 1)
      }
      pageToken = next?.pageToken
    } while (pageToken)
  } catch (err) {
    // Listing failed part-way. What was copied is kept and the run goes partial.
    console.error(`! could not list the bucket: ${err.message}`)
    failed.push({ name: '(bucket listing)', error: String(err.message ?? err) })
  }
  await objects.close()

  for (const folder of new Set([...FOLDERS, ...perFolder.keys()])) {
    console.log(`${folder}: ${perFolder.get(folder) ?? 0} objects`)
  }

  // The other direction: a files document whose object is not in Storage. The
  // portal lists that file and cannot open it. Not judged when the listing
  // itself failed, since then nearly everything would look missing.
  const listingFailed = failed.some((f) => f.name === '(bucket listing)')
  const failedNames = new Set(failed.map((f) => f.name))
  const missing = []
  if (!listingFailed) {
    for (const [name, index] of expected) {
      if (!seen.has(name) && !failedNames.has(name)) missing.push({ id: index.id, name })
    }
  }
  for (const name of orphans) console.error(`! no files document for ${name}`)
  for (const m of missing) console.error(`! files/${m.id} points at ${m.name}, which is not in Storage`)

  // 'ok' is a claim that this snapshot is complete AND verified. Every
  // condition that would make a restore fail, or make the verification
  // meaningless, has to be able to withhold it.
  const problems = []
  if (failed.length) problems.push(`${failed.length} object(s) failed`)
  if (mismatched.length) problems.push(`${mismatched.length} object(s) do not match their recorded checksum`)
  if (copied === 0) problems.push('zero objects copied')
  if (unrecorded.length) problems.push(`${unrecorded.length} object(s) had no recorded checksum`)
  if (orphans.length) problems.push(`${orphans.length} object(s) have no files document`)
  if (missing.length) problems.push(`${missing.length} files document(s) have no object in Storage`)

  // The export exists by this point (its failure exits above), so what is on
  // disk is usable even when it is not complete: a degraded backup, not a
  // crashed job.
  const status = problems.length === 0 ? 'ok' : 'partial'

  await writeFile(
    path.join(dest, 'snapshot.json'),
    JSON.stringify(
      {
        format: 1,
        encoding: ENCODING_VERSION,
        stamp,
        project: ctx.projectId,
        bucket: ctx.bucketName,
        status,
        problems,
        firestore: { documents: store.documents, collections: store.collections, files: store.files },
        auth: { users: users.length, password_users: passwordUsers, password_hashes: passwordHashes },
        storage: {
          objects: copied,
          bytes: objectBytes,
          placeholders,
          verified: copied - mismatched.length - unrecorded.length - orphans.length,
          mismatched,
          unrecorded,
          orphans,
          missing,
          failed,
        },
      },
      null,
      2
    ) + '\n',
    'utf8'
  )

  for (const name of [...store.files, 'auth_users.jsonl.gz', 'objects.jsonl.gz', 'snapshot.json']) {
    manifest.push([await sha256File(path.join(dest, name)), name])
  }

  // LF endings, always: this file is verified with `sha256sum -c`, and CRLF
  // makes every single line fail to resolve.
  manifest.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  const manifestText = manifest.map(([sha, name]) => `${sha}  ${name}`).join('\n') + '\n'
  await writeFile(path.join(dest, 'SHA256SUMS'), manifestText, 'utf8')

  const manifestSha = createHash('sha256').update(manifestText).digest('hex')
  await writeFile(path.join(dest, 'MANIFEST.sha256'), manifestSha + '\n', 'utf8')

  // A stable path the second leg and the restore test can rely on.
  await writeFile(path.join(ROOT, 'LATEST'), stamp + '\n', 'utf8')

  const dumpBytes = store.bytes + authBytes
  await closeRun({
    status,
    object_count: copied,
    byte_total: objectBytes,
    db_dump_bytes: dumpBytes,
    manifest_sha: manifestSha,
    error: problems.length ? problems.join('; ') : null,
  })

  console.log(
    `\n${status.toUpperCase()} — ${copied} objects, ${(objectBytes / 1e6).toFixed(1)} MB` +
      `, ${store.documents} documents, ${users.length} accounts, export ${(dumpBytes / 1e6).toFixed(1)} MB` +
      `\n${dest}\nmanifest ${manifestSha.slice(0, 16)}…`
  )
  for (const p of problems) console.log(`  ! ${p}`)
  if (passwordUsers && !passwordHashes) {
    console.log(
      '  note: no password hashes were exported. A restore brings every account back,\n' +
        '        but each member has to set a new password. See docs/BACKUP.md.'
    )
  }

  return status === 'ok' ? 0 : 2
}

// systemd stops a job with SIGTERM. Without this the row would say `running`
// for ever — a status nothing can resolve.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await closeRun({ status: 'failed', error: `interrupted (${signal})` })
    process.exit(1)
  })
}

main()
  .catch(async (err) => {
    console.error(err)
    await closeRun({ status: 'failed', error: String(err.message ?? err) })
    return 1
  })
  .then((code) => finish(ctx, code))
