#!/usr/bin/env node
/**
 * Repo archiver.
 *
 * For every enabled row in `repo_sources`: fetch the repository as a tarball,
 * store it in the `code/` folder of the bucket, index it in `files`, and record
 * it in `code_archives` so it shows up in the portal's Code tab.
 *
 * WHY THIS RUNS ON THE BACKUP HOST
 *
 * The first version was a cloud function and was the wrong shape for the job: it
 * buffered each tarball in memory to hash and upload it, the runtime capped that
 * around 60 MB, and the run died after seven small repos — mid-write, leaving one
 * row saying `running` for ever. This runs on a machine with a disk. It streams
 * each tarball STRAIGHT TO A FILE, hashes it as the bytes pass, and uploads from
 * that file. Memory use is a 64 KB buffer whether the repo is 400 KB or 4 GB.
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=...  the same key file the backup uses
 *   FIREBASE_PROJECT_ID=...
 *   FIREBASE_STORAGE_BUCKET=...
 *   GITHUB_TOKEN=...                    optional; required for private repos
 *   ARCHIVE_TMP=/var/tmp/frc5805        optional scratch dir
 *
 *   repo-archive.mjs                    everything that is due
 *   repo-archive.mjs --force            everything enabled, changed or not
 *   repo-archive.mjs --repo=<name>      one source: its repo, owner/repo or label
 *
 * Exit codes: 0 all done, 1 fatal, 2 some repos failed.
 */

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import path from 'node:path'
import os from 'node:os'

import { connect, finish, Timestamp, FieldValue } from './lib.mjs'
// The id the rules and the portal compute for a files document. Imported from
// the site's own source so the two cannot disagree.
import { fileId } from '../../src/lib/ids.js'

const ctx = connect()
const { db, bucket } = ctx

const GH_TOKEN = process.env.GITHUB_TOKEN || ''
const TMP = process.env.ARCHIVE_TMP || path.join(os.tmpdir(), 'frc5805-archive')

// For the test suite, and honoured only against the emulators: a live run always
// talks to GitHub itself and only ever fetches https.
const GITHUB_API = (ctx.emulated && process.env.ARCHIVE_GITHUB_API) || 'https://api.github.com'

// The Storage rules cap `code/` at 500 MB. The Admin SDK is not bound by the
// rules, so the cap is applied here — and during the download, so a runaway repo
// costs bandwidth once and then gets skipped loudly.
const MAX_BYTES = 500 * 1024 * 1024
const RESUMABLE_FROM = 8 * 1024 * 1024

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a)

const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)

/** Resolve a ref to its commit SHA without downloading anything. */
async function resolveSha(owner, repo, ref) {
  const headers = { Accept: 'application/vnd.github.sha', 'User-Agent': 'frc5805-archiver' }
  if (GH_TOKEN) headers.Authorization = `Bearer ${GH_TOKEN}`
  const r = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref || 'HEAD')}`, { headers })
  if (!r.ok) throw new Error(`resolve ${owner}/${repo}@${ref}: HTTP ${r.status}`)
  const sha = (await r.text()).trim()
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error(`resolve ${owner}/${repo}@${ref}: not a commit sha`)
  return sha
}

/**
 * Stream a URL to disk, hashing as it goes.
 *
 * The hash is computed from the same bytes that land on disk, in one pass —
 * not by re-reading the file afterwards, which would be a second full read and
 * would not actually prove the written bytes match what arrived.
 */
async function download(url, dest, headers = {}) {
  const r = await fetch(url, { headers, redirect: 'follow' })
  if (!r.ok) throw new Error(`download: HTTP ${r.status}`)
  if (!r.body) throw new Error('download: empty body')

  const hash = createHash('sha256')
  let bytes = 0
  const source = Readable.fromWeb(r.body)
  source.on('data', (chunk) => {
    bytes += chunk.length
    hash.update(chunk)
    if (bytes > MAX_BYTES) source.destroy(new Error(`exceeds ${MAX_BYTES / 1024 / 1024} MB cap`))
  })
  await pipeline(source, createWriteStream(dest))
  return { sha256: hash.digest('hex'), bytes }
}

/** What a `url` source is stored as. A tarball unless the URL plainly says otherwise. */
function urlKind(url) {
  const p = new URL(url).pathname.toLowerCase()
  if (p.endsWith('.zip')) return { ext: 'zip', contentType: 'application/zip' }
  if (p.endsWith('.tar')) return { ext: 'tar', contentType: 'application/x-tar' }
  return { ext: 'tar.gz', contentType: 'application/gzip' }
}

async function archiveOne(src, force) {
  const label = src.label
  const season = new Date().getUTCFullYear()
  const source = db.doc(`repo_sources/${src.id}`)
  const unchanged = async (sha) => {
    await source.update({ last_status: 'ok', last_synced_at: Timestamp.now(), last_error: null, updated_at: FieldValue.serverTimestamp() })
    return { label, skipped: true, reason: `unchanged at ${sha.slice(0, 7)}` }
  }

  await source.update({ last_status: 'running', last_error: null, updated_at: FieldValue.serverTimestamp() })
  await mkdir(TMP, { recursive: true })
  const tmpFile = path.join(TMP, `${slug(label) || 'source'}-${src.id}.part`)

  try {
    let sha
    let got
    let repoName
    let kind = { ext: 'tar.gz', contentType: 'application/gzip' }

    if (src.provider === 'github') {
      // These go into a URL path. Checked rather than escaped: a name GitHub
      // would never issue is a mistake in the row, not something to encode.
      if (!/^[A-Za-z0-9._-]{1,100}$/.test(src.owner ?? '') || !/^[A-Za-z0-9._-]{1,100}$/.test(src.repo ?? '')) {
        throw new Error('owner and repo must be plain GitHub names')
      }
      if (src.git_ref && (!/^[A-Za-z0-9._\-/]{1,120}$/.test(src.git_ref) || src.git_ref.includes('..'))) {
        throw new Error('git_ref is not a branch, tag or commit name')
      }
      repoName = `${src.owner}/${src.repo}`
      sha = await resolveSha(src.owner, src.repo, src.git_ref)
      // Nothing changed since the last run — re-archiving an identical tree
      // wastes storage and makes the backup diff meaningless.
      if (!force && src.last_sha === sha) return await unchanged(sha)

      const headers = { 'User-Agent': 'frc5805-archiver' }
      if (GH_TOKEN) headers.Authorization = `Bearer ${GH_TOKEN}`
      got = await download(`${GITHUB_API}/repos/${src.owner}/${src.repo}/tarball/${sha}`, tmpFile, headers)
    } else {
      const url = new URL(src.url)
      const local = ctx.emulated && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
      if (url.protocol !== 'https:' && !local) throw new Error('url sources must be https')
      repoName = label
      kind = urlKind(src.url)
      got = await download(src.url, tmpFile, { 'User-Agent': 'frc5805-archiver' })
      // A URL has no commit to ask about, so its identity is its content. This
      // used to be named by the clock instead, with nothing to compare — so
      // every interval stored another copy of the same bytes.
      sha = got.sha256.slice(0, 40)
      if (!force && src.last_sha === sha) return await unchanged(sha)
    }

    const sha7 = sha.slice(0, 7)
    const storagePath = `${season}/${slug(label)}-${sha7}.${kind.ext}`
    const objectName = `code/${storagePath}`
    const owner = typeof src.created_by === 'string' ? src.created_by : null

    // The same name for the same commit, so a retry after a partial upload — or a
    // forced re-run — replaces the object instead of piling up beside it.
    await bucket.upload(tmpFile, {
      destination: objectName,
      gzip: false,
      resumable: got.bytes > RESUMABLE_FROM,
      metadata: { contentType: kind.contentType, ...(owner ? { metadata: { owner } } : {}) },
    })

    // Object first, then its index document; if the document cannot be written
    // the object is taken back out, so nothing is stored that the portal cannot
    // list (the same order the portal's own uploads use).
    const id = fileId('code', storagePath)
    const fileRef = db.doc(`files/${id}`)
    const described = {
      bucket: 'code',
      path: storagePath,
      title: `${label} @ ${sha7}`,
      description: `Automated archive of ${repoName}`,
      kind: 'code',
      season,
      byte_size: got.bytes,
      sha256: got.sha256,
      updated_at: FieldValue.serverTimestamp(),
    }
    try {
      if ((await fileRef.get()).exists) await fileRef.update(described)
      else await fileRef.set({ ...described, tags: [], uploaded_by: owner, created_at: FieldValue.serverTimestamp() })
    } catch (err) {
      await bucket.file(objectName).delete({ ignoreNotFound: true }).catch(() => {})
      throw new Error(`files: ${err.message}`)
    }

    // One row per repo, commit and season. Firestore has no unique constraint to
    // lean on — the SQL table had none either, which is why --force used to add
    // a duplicate row every time — so the existing row is looked for and updated.
    // Only `commit_sha` is in the query; the rest is matched here, so no
    // composite index has to exist.
    const file = { id, bucket: 'code', path: storagePath, byte_size: got.bytes }
    const row = {
      ref: src.git_ref ?? null,
      notes: `Archived automatically from ${src.provider}`,
      file,
      updated_at: FieldValue.serverTimestamp(),
    }
    const found = await db.collection('code_archives').where('commit_sha', '==', sha).get()
    const existing = found.docs.find((d) => d.get('repo') === repoName && d.get('season') === season)
    if (existing) await existing.ref.update(row)
    else {
      await db.collection('code_archives').add({
        repo: repoName, commit_sha: sha, season, ...row, created_by: owner, created_at: FieldValue.serverTimestamp(),
      })
    }

    await source.update({
      last_status: 'ok',
      last_synced_at: Timestamp.now(),
      last_sha: sha,
      last_error: null,
      updated_at: FieldValue.serverTimestamp(),
    })
    return { label, bytes: got.bytes, sha, path: objectName }
  } finally {
    // Always, including on failure — otherwise a few failed runs fill the disk
    // with half-downloaded tarballs nobody will ever look at.
    await rm(tmpFile, { force: true }).catch(() => {})
  }
}

/** Returns the exit code. */
async function main() {
  const force = process.argv.includes('--force')
  const only = process.argv.find((a) => a.startsWith('--repo='))?.slice('--repo='.length)

  let sources
  try {
    const found = await db.collection('repo_sources').where('enabled', '==', true).get()
    sources = found.docs.map((d) => ({ id: d.id, ...d.data() }))
  } catch (err) {
    console.error(`could not read repo_sources: ${err.message}`)
    return 1
  }
  sources.sort((a, b) => String(a.label).localeCompare(String(b.label)))
  if (only) sources = sources.filter((s) => only === s.repo || only === `${s.owner}/${s.repo}` || only === s.label)

  const now = Date.now()
  const due = force
    ? sources
    : sources.filter((s) => {
        if (!s.last_synced_at) return true
        const age = (now - s.last_synced_at.toMillis()) / 36e5
        return age >= (s.interval_hours ?? 24)
      })

  log(`${sources.length} enabled, ${due.length} due`)

  let ok = 0
  let skipped = 0
  const failed = []

  // Sequential on purpose. Parallel downloads would be faster but this shares a
  // home connection with everything else in the house, and the job has all night.
  for (const src of due) {
    try {
      const r = await archiveOne(src, force)
      if (r.skipped) {
        skipped++
        log(`  skip  ${r.label} — ${r.reason}`)
      } else {
        ok++
        log(`  ok    ${r.label}  ${(r.bytes / 1024 / 1024).toFixed(1)} MB  ${r.path}`)
      }
    } catch (err) {
      const msg = String(err.message ?? err)
      failed.push({ label: src.label, msg })
      log(`  FAIL  ${src.label} — ${msg}`)
      await db
        .doc(`repo_sources/${src.id}`)
        .update({ last_status: 'failed', last_error: msg.slice(0, 500), last_synced_at: Timestamp.now(), updated_at: FieldValue.serverTimestamp() })
        .catch((e) => log(`  could not record the failure: ${e.message}`))
    }
  }

  await rm(TMP, { recursive: true, force: true }).catch(() => {})

  log(`done: ${ok} archived, ${skipped} unchanged, ${failed.length} failed`)
  for (const f of failed) log(`  ${f.label}: ${f.msg}`)
  return failed.length ? 2 : 0
}

main()
  .catch((err) => {
    console.error(err)
    return 1
  })
  .then((code) => finish(ctx, code))
