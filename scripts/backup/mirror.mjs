#!/usr/bin/env node
/**
 * Leg 1 of the network backup: Supabase -> local disk on the backup server.
 *
 * Pulls every object from every bucket, dumps the database, writes a SHA256SUMS
 * manifest, verifies each downloaded object against the checksum recorded at
 * upload time, and reports the result back into `backup_runs`.
 *
 * Run with the SERVICE ROLE key. That key bypasses RLS — which is the point,
 * since the backup must see every row and object regardless of who owns it —
 * and is exactly why this script runs on the server and never in a browser.
 *
 *   SUPABASE_URL=...            https://<ref>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY=... service_role, NOT anon
 *   SUPABASE_DB_URL=...         postgres://... (for pg_dump)
 *   BACKUP_ROOT=/srv/backup/frc5805
 *
 * Exit codes: 0 ok, 1 failed, 2 partial (some objects failed, dump succeeded).
 */

import { createClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { createGzip } from 'node:zlib'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'

const URL_ = requireEnv('SUPABASE_URL')
const KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
const DB_URL = process.env.SUPABASE_DB_URL || ''
const ROOT = process.env.BACKUP_ROOT || '/srv/backup/frc5805'

const BUCKETS = ['graphs', 'code', 'knowledge', 'media', 'public-media']

function requireEnv(name) {
  const v = process.env[name]
  if (!v) {
    console.error(`missing required env var: ${name}`)
    process.exit(1)
  }
  return v
}

function requireServiceRole(key) {
  // Guards against the easy and near-invisible mistake of pasting the anon key
  // here. With anon, RLS applies, every table returns zero rows, and the job
  // cheerfully reports a successful backup of nothing — strictly worse than no
  // backup at all, because it also tells you that you have one.
  //
  // Two key formats exist. Classic keys are JWTs carrying a `role` claim.
  // Newer projects issue opaque `sb_secret_…` / `sb_publishable_…` keys, which
  // have no claims to read, so those are checked by prefix instead.
  if (/^sb_secret_/.test(key)) return
  if (/^sb_publishable_/.test(key)) {
    console.error(
      'SUPABASE_SERVICE_ROLE_KEY is a publishable key. It is subject to RLS, so this job\n' +
        'would back up an empty set and report success. Use the secret key.'
    )
    process.exit(1)
  }

  const segments = key.split('.')
  if (segments.length !== 3) {
    console.error(
      'SUPABASE_SERVICE_ROLE_KEY is neither a JWT nor an sb_secret_… key.\n' +
        'Copy the service_role / secret key from Project Settings → API.'
    )
    process.exit(1)
  }

  try {
    const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString())
    if (payload.role !== 'service_role') {
      console.error(
        `SUPABASE_SERVICE_ROLE_KEY has role "${payload.role}", expected "service_role".\n` +
          'With the anon key this job would back up an empty set and report success.'
      )
      process.exit(1)
    }
  } catch {
    console.error('SUPABASE_SERVICE_ROLE_KEY looks like a JWT but its payload will not parse.')
    process.exit(1)
  }
}
requireServiceRole(KEY)

const supabase = createClient(URL_, KEY, { auth: { persistSession: false } })

// UTC, and colon-free so the path is valid on every filesystem the mirror might
// later be copied onto.
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z'
const dest = path.join(ROOT, stamp)

let runId = null

async function openRun() {
  const { data, error } = await supabase
    .from('backup_runs')
    .insert({ leg: 'supabase->server', status: 'running' })
    .select('id')
    .single()
  if (error) {
    console.warn(`could not open backup_runs row: ${error.message}`)
    return
  }
  runId = data.id
}

async function closeRun(fields) {
  if (!runId) return
  const { error } = await supabase
    .from('backup_runs')
    .update({ finished_at: new Date().toISOString(), ...fields })
    .eq('id', runId)
  if (error) console.warn(`could not close backup_runs row: ${error.message}`)
}

/** Storage list() is paginated; without this only the first 100 objects copy. */
async function listAll(bucket, prefix = '') {
  const out = []
  const PAGE = 100
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase.storage
      .from(bucket)
      .list(prefix, { limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } })
    if (error) throw new Error(`list ${bucket}/${prefix}: ${error.message}`)
    if (!data?.length) break

    for (const entry of data) {
      const full = prefix ? `${prefix}/${entry.name}` : entry.name
      // A row with no `id` is a synthetic folder, not an object — recurse.
      if (entry.id === null) out.push(...(await listAll(bucket, full)))
      else out.push(full)
    }
    if (data.length < PAGE) break
  }
  return out
}

async function download(bucket, objectPath) {
  const { data, error } = await supabase.storage.from(bucket).download(objectPath)
  if (error) throw new Error(error.message)

  const target = path.join(dest, 'objects', bucket, objectPath)
  await mkdir(path.dirname(target), { recursive: true })

  // Streamed rather than buffered: CAD exports and season video will not fit
  // comfortably in memory, and this job runs unattended.
  const hash = createHash('sha256')
  const source = Readable.fromWeb(data.stream())
  source.on('data', (chunk) => hash.update(chunk))
  await pipeline(source, createWriteStream(target))

  const { size } = await stat(target)
  return { sha256: hash.digest('hex'), bytes: size }
}

async function dumpDatabase() {
  if (!DB_URL) {
    console.warn('SUPABASE_DB_URL unset — skipping the database dump.')
    console.warn('Object bytes alone are not a restorable backup: without the dump you lose')
    console.warn('the knowledge base, every file title, and the whole roster.')
    return 0
  }
  await mkdir(dest, { recursive: true })

  // No shell, and no credentials in argv.
  //
  // The previous version built a `bash -c` string and escaped only `"`. Inside
  // double quotes `$`, backticks and `\` are still live, so a password
  // containing `$(...)` would have been executed. It also put the full DSN —
  // password included — into a process argument, readable via `ps` by any local
  // user. Parsing the URL into PG* environment variables avoids both: pg_dump
  // is spawned directly with no shell, and the password never appears in argv.
  const dsn = new URL(DB_URL)
  const env = {
    ...process.env,
    PGHOST: dsn.hostname,
    PGPORT: dsn.port || '5432',
    PGUSER: decodeURIComponent(dsn.username),
    PGPASSWORD: decodeURIComponent(dsn.password),
    PGDATABASE: dsn.pathname.replace(/^\//, '') || 'postgres',
  }
  if (dsn.searchParams.get('sslmode')) env.PGSSLMODE = dsn.searchParams.get('sslmode')

  // Two dumps, and the split is not cosmetic — verified against a real
  // Postgres by restoring the result:
  //
  //   auth_users.sql.gz  data only, no DDL, no triggers
  //   db.sql.gz          the whole public schema
  //
  // `public.profiles.id` is a foreign key onto `auth.users`. A public-only dump
  // is therefore NOT RESTORABLE: pg_dump adds constraints after loading data,
  // and ADD CONSTRAINT runs a validation scan that `session_replication_role =
  // replica` does not suppress, so the restore dies on profiles_id_fkey. It
  // also loses the email-to-profile mapping, which is the only record of who
  // each roster row actually is.
  //
  // auth.users is dumped --data-only because its full DDL carries the
  // on_auth_user_created trigger, which references a public function that does
  // not exist yet at that point in the restore.
  const dump = (args, outfile) =>
    runDump(['--no-owner', '--no-acl', ...args], env, path.join(dest, outfile))

  const authBytes = await dump(['--data-only', '--table=auth.users'], 'auth_users.sql.gz')
  const publicBytes = await dump(['--clean', '--if-exists', '--schema=public'], 'db.sql.gz')
  return authBytes + publicBytes
}

// Spawned without a shell; stdout is gzipped straight to disk.
async function runDump(args, env, target) {
  const child = spawn('pg_dump', args, { env, stdio: ['ignore', 'pipe', 'inherit'] })

  // Settles either way — a promise that only rejects would never resolve on
  // success, and awaiting it after a clean run would hang the job forever.
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`pg_dump exited ${code}`))
    )
  })
  // Claimed now so that a pipeline failure racing ahead of the exit event does
  // not surface as an unhandled rejection.
  exited.catch(() => {})

  await pipeline(child.stdout, createGzip({ level: 9 }), createWriteStream(target))
  // The pipeline finishing only means the stream closed. pg_dump can emit a
  // partial dump and then exit non-zero, so the exit code is what decides
  // whether this file is trustworthy.
  await exited

  const { size } = await stat(target)
  return size
}

async function main() {
  await mkdir(dest, { recursive: true })
  await openRun()

  const manifest = []
  let bytes = 0
  let failures = 0

  // The checksums recorded by the browser at upload time. Comparing against
  // these proves the bytes on disk are the bytes the uploader actually chose —
  // a manifest generated purely from the downloaded copy would only ever be
  // self-consistent, and would happily certify corrupted data.
  const expected = new Map()
  let checksumsAvailable = true
  {
    const { data, error } = await supabase.from('files').select('bucket, path, sha256')
    if (error) {
      // Previously this only warned. That was the worst bug in this script: with
      // `expected` empty, every `expected.get()` returns undefined, the mismatch
      // branch never fires, `failures` stays 0, and the run records 'ok'. A
      // transient error silently downgraded the backup from "verified against
      // upload-time checksums" to "a manifest of whatever happened to arrive" —
      // exactly the self-consistent artifact this design exists to avoid.
      console.error(`! could not read expected checksums: ${error.message}`)
      checksumsAvailable = false
    }
    for (const f of data ?? []) if (f.sha256) expected.set(`${f.bucket}/${f.path}`, f.sha256)
  }
  let unverified = 0

  for (const bucket of BUCKETS) {
    let objects = []
    try {
      objects = await listAll(bucket)
    } catch (err) {
      console.error(`! ${bucket}: ${err.message}`)
      failures += 1
      continue
    }
    console.log(`${bucket}: ${objects.length} objects`)

    for (const objectPath of objects) {
      const key = `${bucket}/${objectPath}`
      try {
        const { sha256, bytes: n } = await download(bucket, objectPath)
        const want = expected.get(key)
        if (want && want !== sha256) {
          console.error(`! CHECKSUM MISMATCH ${key}\n    expected ${want}\n    got      ${sha256}`)
          failures += 1
          continue
        }
        // Copied, but nothing to compare it against. Counted so the run can
        // report how much of it is actually verified rather than implying all.
        if (!want) unverified += 1
        manifest.push(`${sha256}  objects/${bucket}/${objectPath}`)
        bytes += n
      } catch (err) {
        console.error(`! ${key}: ${err.message}`)
        failures += 1
      }
    }
  }

  let dbBytes = 0
  try {
    dbBytes = await dumpDatabase()
    if (dbBytes) {
      // Both dump files go in the manifest. Omitting auth_users.sql.gz would
      // leave the half of the backup that makes the other half restorable
      // unverified — and silently absent from `sha256sum -c`.
      for (const name of ['auth_users.sql.gz', 'db.sql.gz']) {
        const digest = createHash('sha256').update(await readFile(path.join(dest, name)))
        manifest.push(`${digest.digest('hex')}  ${name}`)
      }
    }
  } catch (err) {
    console.error(`! database dump failed: ${err.message}`)
    await closeRun({ status: 'failed', error: `pg_dump: ${err.message}` })
    process.exit(1)
  }

  // LF endings, always: this file is verified with `sha256sum -c`, and CRLF
  // makes every single line fail to resolve.
  manifest.sort()
  const manifestText = manifest.join('\n') + '\n'
  await writeFile(path.join(dest, 'SHA256SUMS'), manifestText, 'utf8')

  const manifestSha = createHash('sha256').update(manifestText).digest('hex')
  await writeFile(path.join(dest, 'MANIFEST.sha256'), manifestSha + '\n', 'utf8')

  // A stable path the second leg and the restore test can rely on.
  await writeFile(path.join(ROOT, 'LATEST'), stamp + '\n', 'utf8')

  // 'ok' is a claim that this snapshot is complete AND verified. Deriving it
  // from `failures` alone let three different empty-but-successful outcomes
  // report green. Every condition that would make a restore fail, or make the
  // verification meaningless, has to be able to withhold it.
  const problems = []
  if (failures) problems.push(`${failures} object(s) failed`)
  if (!checksumsAvailable) problems.push('checksum table unreadable — objects copied but unverified')
  if (!dbBytes) problems.push('NO DATABASE DUMP — objects only, not restorable')
  if (manifest.length === 0) problems.push('zero objects copied')
  if (unverified) problems.push(`${unverified} object(s) had no recorded checksum`)

  // A missing dump or unverifiable objects is a degraded backup, not a crashed
  // job: the bytes that did arrive are still worth keeping and propagating.
  // 'failed' is reserved for producing nothing usable.
  const usable = manifest.length > 0 || dbBytes > 0
  const status = problems.length === 0 ? 'ok' : usable ? 'partial' : 'failed'

  await closeRun({
    status,
    object_count: manifest.length,
    byte_total: bytes,
    db_dump_bytes: dbBytes,
    manifest_sha: manifestSha,
    error: problems.length ? problems.join('; ') : null,
  })

  console.log(
    `\n${status.toUpperCase()} — ${manifest.length} objects, ${(bytes / 1e6).toFixed(1)} MB` +
      `, db ${(dbBytes / 1e6).toFixed(1)} MB\n${dest}\nmanifest ${manifestSha.slice(0, 16)}…`
  )
  for (const p of problems) console.log(`  ! ${p}`)

  process.exit(status === 'ok' ? 0 : status === 'partial' ? 2 : 1)
}

main().catch(async (err) => {
  console.error(err)
  await closeRun({ status: 'failed', error: String(err.message ?? err) })
  process.exit(1)
})
