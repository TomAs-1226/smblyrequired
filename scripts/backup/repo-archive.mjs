#!/usr/bin/env node
/**
 * Repo archiver — the host-side version.
 *
 * WHY THIS EXISTS SEPARATELY FROM supabase/functions/repo-sync
 *
 * The edge function was the wrong shape for the job and failed in production
 * exactly as predicted: it buffers each tarball in isolate memory to hash and
 * upload, the edge runtime caps that around 60 MB, and the run died with
 * HTTP 546 after seven small repos. Worse, the isolate was killed mid-write, so
 * one row was left saying `running` forever — a status nothing can resolve and
 * nothing will retry.
 *
 * This runs on a machine with a disk. It streams each tarball STRAIGHT TO A
 * FILE, hashes it as the bytes pass, and uploads from that file. Memory use is
 * a 64 KB buffer regardless of whether the repo is 400 KB or 4 GB.
 *
 * The edge function is still useful as a manual "sync this one now" button from
 * the portal for a small repo. This is what runs nightly and gets through
 * everything.
 *
 *   SUPABASE_URL=...                 https://<ref>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY=...    secret key (sb_secret_… or the legacy JWT)
 *   GITHUB_TOKEN=...                 optional; required for private repos
 *   ARCHIVE_TMP=/var/tmp/frc5805     optional scratch dir
 *
 * Exit codes: 0 all done, 1 fatal, 2 some repos failed.
 */

import { createClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import path from 'node:path'
import os from 'node:os'

const URL_ = need('SUPABASE_URL')
const KEY = need('SUPABASE_SERVICE_ROLE_KEY')
const GH_TOKEN = process.env.GITHUB_TOKEN || ''
const TMP = process.env.ARCHIVE_TMP || path.join(os.tmpdir(), 'frc5805-archive')

// Storage rejects anything over the bucket's file_size_limit (500 MB on `code`,
// migration 0002). Checked before uploading rather than after downloading a
// gigabyte, so a runaway repo costs bandwidth once and then gets skipped loudly.
const MAX_BYTES = 500 * 1024 * 1024

function need(n) {
  const v = process.env[n]
  if (!v) {
    console.error(`missing required env var: ${n}`)
    process.exit(1)
  }
  return v
}

const supabase = createClient(URL_, KEY, { auth: { persistSession: false } })

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a)

/** Resolve a ref to its commit SHA without downloading anything. */
async function resolveSha(owner, repo, ref) {
  const headers = { Accept: 'application/vnd.github.sha', 'User-Agent': 'frc5805-archiver' }
  if (GH_TOKEN) headers.Authorization = `Bearer ${GH_TOKEN}`
  const r = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref || 'HEAD')}`,
    { headers }
  )
  if (!r.ok) throw new Error(`resolve ${owner}/${repo}@${ref}: HTTP ${r.status}`)
  return (await r.text()).trim()
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

async function archiveOne(src) {
  const label = src.label
  const season = new Date().getFullYear()

  await supabase
    .from('repo_sources')
    .update({ last_status: 'running', last_error: null })
    .eq('id', src.id)

  let url
  let sha = null
  let filename

  if (src.provider === 'github') {
    sha = await resolveSha(src.owner, src.repo, src.git_ref)
    // Nothing changed since the last run — re-archiving an identical tree wastes
    // storage and makes the backup diff meaningless.
    if (src.last_sha && src.last_sha === sha) {
      await supabase
        .from('repo_sources')
        .update({ last_status: 'ok', last_synced_at: new Date().toISOString(), last_error: null })
        .eq('id', src.id)
      return { label, skipped: true, reason: `unchanged at ${sha.slice(0, 7)}` }
    }
    url = `https://api.github.com/repos/${src.owner}/${src.repo}/tarball/${sha}`
    filename = `${slug(label)}-${sha.slice(0, 7)}.tar.gz`
  } else {
    url = src.url
    filename = `${slug(label)}-${Date.now()}`
  }

  await mkdir(TMP, { recursive: true })
  const tmpFile = path.join(TMP, filename)

  const headers = { 'User-Agent': 'frc5805-archiver' }
  if (GH_TOKEN && src.provider === 'github') headers.Authorization = `Bearer ${GH_TOKEN}`

  try {
    const { sha256, bytes } = await download(url, tmpFile, headers)
    const storagePath = `${season}/${filename}`

    // upsert:true so a retry after a partial upload completes instead of
    // colliding — the same idempotency rule the offline queue uses.
    const { error: upErr } = await supabase.storage
      .from('code')
      .upload(storagePath, createReadStream(tmpFile), {
        contentType: 'application/gzip',
        upsert: true,
        duplex: 'half',
      })
    if (upErr) throw new Error(`upload: ${upErr.message}`)

    const { data: fileRow, error: fErr } = await supabase
      .from('files')
      .upsert(
        {
          bucket: 'code',
          path: storagePath,
          title: label,
          description: `Automated archive of ${src.owner}/${src.repo}`,
          kind: 'code',
          season,
          byte_size: bytes,
          sha256,
        },
        { onConflict: 'bucket,path' }
      )
      .select('id')
      .single()
    if (fErr) throw new Error(`files: ${fErr.message}`)

    const { error: aErr } = await supabase.from('code_archives').insert({
      repo: src.provider === 'github' ? `${src.owner}/${src.repo}` : label,
      ref: src.git_ref,
      commit_sha: sha,
      season,
      notes: `Archived automatically from ${src.provider}`,
      file_id: fileRow.id,
    })
    // A duplicate archive row on a forced re-run is not a failure.
    if (aErr && aErr.code !== '23505') throw new Error(`code_archives: ${aErr.message}`)

    await supabase
      .from('repo_sources')
      .update({
        last_status: 'ok',
        last_synced_at: new Date().toISOString(),
        last_sha: sha,
        last_error: null,
      })
      .eq('id', src.id)

    return { label, bytes, sha }
  } finally {
    // Always, including on failure — otherwise a few failed runs fill the disk
    // with half-downloaded tarballs nobody will ever look at.
    await rm(tmpFile, { force: true }).catch(() => {})
  }
}

const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)

async function main() {
  const force = process.argv.includes('--force')
  const only = process.argv.find((a) => a.startsWith('--repo='))?.split('=')[1]

  let q = supabase.from('repo_sources').select('*').eq('enabled', true).order('label')
  if (only) q = q.eq('repo', only)
  const { data: sources, error } = await q
  if (error) {
    console.error(`could not read repo_sources: ${error.message}`)
    process.exit(1)
  }

  const now = Date.now()
  const due = force
    ? sources
    : sources.filter((s) => {
        if (!s.last_synced_at) return true
        const age = (now - new Date(s.last_synced_at).getTime()) / 36e5
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
      const r = await archiveOne(src)
      if (r.skipped) {
        skipped++
        log(`  skip  ${r.label} — ${r.reason}`)
      } else {
        ok++
        log(`  ok    ${r.label}  ${(r.bytes / 1024 / 1024).toFixed(1)} MB`)
      }
    } catch (err) {
      const msg = String(err.message ?? err)
      failed.push({ label: src.label, msg })
      log(`  FAIL  ${src.label} — ${msg}`)
      await supabase
        .from('repo_sources')
        .update({
          last_status: 'failed',
          last_error: msg.slice(0, 500),
          last_synced_at: new Date().toISOString(),
        })
        .eq('id', src.id)
    }
  }

  await rm(TMP, { recursive: true, force: true }).catch(() => {})

  log(`\ndone: ${ok} archived, ${skipped} unchanged, ${failed.length} failed`)
  for (const f of failed) log(`  ${f.label}: ${f.msg}`)
  process.exit(failed.length ? 2 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
