#!/usr/bin/env node
/**
 * The two things the shell scripts need to say to `backup_runs`.
 *
 *   report.mjs leg2 --status=ok|failed --started=<ISO time> --objects=<n>
 *                   --bytes=<n> --manifest=<sha256> [--error=<text>]
 *       Record one run of the second leg (backup host -> second machine).
 *
 *   report.mjs restore-tested --manifest=<sha256>
 *       Stamp `restore_tested_at` on the leg-1 run(s) that produced the snapshot
 *       with that manifest. Exit 3 when no run matched: a write that changed
 *       nothing must not be reported as "marked verified".
 *
 * The shell scripts used to do this with curl and the service-role key in a
 * header file. Firestore has no key to put in a header; the Admin SDK signs
 * each request from the key file, which is never read by the shell at all.
 *
 * Exit codes: 0 done, 1 failed, 3 nothing matched (restore-tested only).
 */

import { connect, finish, runRow, Timestamp, LEG_MIRROR, LEG_OFFSITE } from './lib.mjs'

let ctx = null
const [command, ...rest] = process.argv.slice(2)
const option = (name) => rest.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)

function bail(message) {
  console.error(message)
  process.exit(1)
}

function wholeNumber(name) {
  const text = option(name)
  if (!/^\d+$/.test(text ?? '')) bail(`--${name} must be a whole number (got '${text ?? ''}')`)
  return Number(text)
}

function manifestSha() {
  const sha = option('manifest')
  if (!/^[a-f0-9]{64}$/.test(sha ?? '')) bail('--manifest must be a sha256 (64 hex characters)')
  return sha
}

async function leg2() {
  const status = option('status')
  if (status !== 'ok' && status !== 'failed') bail("--status must be 'ok' or 'failed'")
  const started = new Date(option('started') ?? '')
  if (Number.isNaN(started.getTime())) bail('--started must be a time, e.g. 2026-07-20T03:15:42Z')
  const row = runRow({
    leg: LEG_OFFSITE,
    status,
    started_at: Timestamp.fromDate(started),
    finished_at: Timestamp.now(),
    object_count: wholeNumber('objects'),
    byte_total: wholeNumber('bytes'),
    manifest_sha: manifestSha(),
    error: option('error') || null,
  })

  ctx = connect()
  await ctx.db.collection('backup_runs').add(row)
  console.log(`recorded ${LEG_OFFSITE}: ${status}`)
  return 0
}

async function restoreTested() {
  const sha = manifestSha()
  ctx = connect()
  const { db } = ctx

  // Scoped to the leg actually tested. Filtering on manifest_sha alone would
  // also mark the server->optiplex rows verified — copies the restore test
  // never touched. The leg is checked here rather than in the query so the
  // query needs no composite index to exist in the project.
  const found = await db.collection('backup_runs').where('manifest_sha', '==', sha).get()
  const runs = found.docs.filter((d) => d.get('leg') === LEG_MIRROR)
  if (!runs.length) {
    console.log(`no ${LEG_MIRROR} run has manifest ${sha.slice(0, 16)}…`)
    return 3
  }
  const now = Timestamp.now()
  for (const run of runs) await run.ref.update({ restore_tested_at: now })
  console.log(`marked ${runs.length} run(s) restore-tested`)
  return 0
}

const commands = { leg2, 'restore-tested': restoreTested }
if (!commands[command]) bail('usage: report.mjs leg2 … | report.mjs restore-tested --manifest=<sha256>')

commands[command]()
  .catch((err) => {
    console.error(`could not write backup_runs: ${err.message}`)
    return 1
  })
  .then((code) => (ctx ? finish(ctx, code) : process.exit(code)))
