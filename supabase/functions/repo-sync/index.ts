// =============================================================================
// repo-sync — pull the repos listed in public.repo_sources into the `code`
// bucket, so a season's software survives the students who wrote it.
//
// Admin only. repo_sources is admin-managed in 0005 ("this is the table that
// means 'make sure I can define which repositories it pulls from', and it drives
// a job holding credentials"), and this is that job. It also accepts the
// service-role key as a machine caller so a scheduler can run it unattended —
// see the note in _shared/auth.ts for why that grants nothing new.
//
// THE FAILURE MODE THIS IS BUILT AROUND: a sync that has been quietly failing
// for a month. Every path below writes `last_status`, and every failure writes
// `last_error` with the actual message. An archive job you cannot tell is broken
// is worse than no archive job, because you stop checking.
//
// The second thing it is built around: not re-archiving an unchanged repo. The
// commit SHA is resolved with one cheap request before anything is downloaded,
// and a match against `last_sha` ends the work there. Without that, a nightly
// run stores a fresh copy of an identical repo every night — the bucket fills
// with duplicates and the archive list stops meaning "these are the versions
// that mattered".
// =============================================================================

import {
  fail,
  logSafe,
  ok,
  preflight,
  readJsonBody,
  requireCaller,
  scrub,
  serviceClient,
} from '../_shared/auth.ts'

const MAX_BODY_BYTES = 2_000

// Wall-clock and memory both bound this. An edge isolate is not a build server:
// the archive is buffered in memory to be hashed and uploaded, so a handful of
// medium repos per invocation is the honest ceiling. The remainder stay due and
// are picked up by the next run — nothing is lost, it just takes another cycle.
const MAX_REPOS_PER_RUN = Number(Deno.env.get('REPO_SYNC_MAX_PER_RUN') ?? '3')

// Deliberately far below the `code` bucket's 500 MB limit from 0002. The bucket
// limit is what Storage will accept; this is what an edge function can hold in
// memory without being killed, which is the smaller number and therefore the
// real one. A repo that exceeds it fails loudly with a message saying so — see
// the README for the escape hatch.
const MAX_ARCHIVE_BYTES = Number(Deno.env.get('REPO_SYNC_MAX_MB') ?? '60') * 1024 * 1024

const GITHUB_API = 'https://api.github.com'

interface RepoSource {
  id: string
  label: string
  provider: 'github' | 'url'
  owner: string | null
  repo: string | null
  git_ref: string | null
  url: string | null
  enabled: boolean
  interval_hours: number
  last_synced_at: string | null
  last_sha: string | null
}

type Db = ReturnType<typeof serviceClient>

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    // GitHub requires a User-Agent and returns 403 without one.
    'User-Agent': 'frc5805-repo-sync',
  }
  // Optional by design: public repos sync without it. With it, private repos
  // work and the rate limit goes from 60/hour per IP — shared with every other
  // function on the same egress — to 5000/hour for us alone.
  const token = Deno.env.get('GITHUB_TOKEN')
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

// A path segment, so it must not be able to escape the bucket prefix or the
// year folder. Also keeps object names readable in the dashboard.
function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'repo'
  )
}

// git refs go into a URL path. Anything with a slash, a space, or traversal in
// it is rejected rather than escaped — a ref is a short identifier, and a source
// row that needs something exotic is a row worth looking at by hand.
function safeRef(ref: string | null): string | null {
  const r = (ref ?? 'HEAD').trim()
  return /^[A-Za-z0-9._\-/]{1,120}$/.test(r) && !r.includes('..') ? r : null
}

function safeOwnerRepo(v: string | null): string | null {
  const s = (v ?? '').trim()
  return /^[A-Za-z0-9._-]{1,100}$/.test(s) && !s.includes('..') ? s : null
}

// https only. This function runs with credentials in its environment and
// fetches whatever a row tells it to; a plaintext, file:, or data: fetch from
// here is never something we want, even for a public artifact.
function parseHttpsUrl(raw: string | null): URL {
  if (!raw) throw new Error('a url source has no url')
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('url is not a valid URL')
  }
  if (parsed.protocol !== 'https:') throw new Error('url sources must be https')
  return parsed
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// Content-length is checked when present, but codeload serves tarballs chunked
// and usually omits it — so the stream is metered as it arrives and abandoned
// the moment it crosses the cap. Buffering first and checking afterwards is how
// the isolate gets killed with no error written to last_error.
async function downloadCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? '0')
  if (declared && declared > maxBytes) {
    throw new Error(
      `archive is ${Math.round(declared / 1048576)} MB, over the ${Math.round(maxBytes / 1048576)} MB limit`
    )
  }
  if (!res.body) throw new Error('upstream sent an empty body')

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error(`archive exceeds the ${Math.round(maxBytes / 1048576)} MB limit`)
    }
    chunks.push(value)
  }

  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

/** The cheap request that makes the whole "skip unchanged" optimisation work:
 *  one call, and the response body is the bare SHA rather than a commit object. */
async function resolveSha(owner: string, repo: string, ref: string): Promise<string> {
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/commits/${ref}`, {
    headers: { ...githubHeaders(), Accept: 'application/vnd.github.sha' },
  })
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(`GitHub returned 404 for ${owner}/${repo}@${ref} (private repo without GITHUB_TOKEN, or a bad ref)`)
    }
    if (res.status === 403 || res.status === 429) {
      throw new Error('GitHub rate limit reached; set GITHUB_TOKEN to raise it')
    }
    throw new Error(`GitHub returned ${res.status} resolving the commit SHA`)
  }
  const sha = (await res.text()).trim()
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('GitHub did not return a commit SHA')
  return sha
}

async function fetchTarball(owner: string, repo: string, ref: string): Promise<Uint8Array> {
  // redirect: 'manual' on purpose. The tarball endpoint 302s to a pre-signed
  // codeload URL, and following it automatically re-sends our Authorization
  // header to a different host — which GitHub rejects, and which would leak the
  // token to that host if it ever did not. The signature in the redirect URL is
  // the credential for the second hop; nothing else should travel with it.
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/tarball/${ref}`, {
    headers: githubHeaders(),
    redirect: 'manual',
  })

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location')
    if (!location) throw new Error('GitHub redirected the tarball request without a location')
    await res.body?.cancel()
    const signed = await fetch(location) // no headers — the URL carries its own auth
    if (!signed.ok) throw new Error(`Downloading the tarball returned ${signed.status}`)
    return await downloadCapped(signed, MAX_ARCHIVE_BYTES)
  }

  if (!res.ok) throw new Error(`GitHub returned ${res.status} for the tarball`)
  return await downloadCapped(res, MAX_ARCHIVE_BYTES)
}

interface SyncOutcome {
  id: string
  label: string
  status: 'ok' | 'skipped' | 'failed'
  detail: string
  sha?: string | null
  bytes?: number
  path?: string
}

async function syncOne(db: Db, src: RepoSource, actorId: string | null, force: boolean): Promise<SyncOutcome> {
  const base = { id: src.id, label: src.label }

  // Claimed before the work starts, so a run in progress is visible in the
  // portal. If the isolate dies mid-sync the row is left saying 'running' —
  // which is correct, it *was* running when we last knew anything. It is not
  // sticky: `last_synced_at` is untouched until the work finishes, so the row
  // stays due and the next invocation retries it.
  await db.from('repo_sources').update({ last_status: 'running' }).eq('id', src.id)

  try {
    // FRC seasons are named for the calendar year they compete in, and the
    // season starts in January — so the current year is the season, with no
    // fiscal-year style offset to get wrong.
    const season = new Date().getUTCFullYear()

    let bytes: Uint8Array
    let commitSha: string
    let repoName: string
    let ref: string

    if (src.provider === 'github') {
      const owner = safeOwnerRepo(src.owner)
      const repo = safeOwnerRepo(src.repo)
      ref = safeRef(src.git_ref) ?? ''
      if (!owner || !repo) throw new Error('owner/repo are missing or contain unsupported characters')
      if (!ref) throw new Error(`git_ref ${JSON.stringify(src.git_ref)} is not a usable ref`)
      repoName = `${owner}/${repo}`

      commitSha = await resolveSha(owner, repo, ref)

      // The whole point. One API call has already told us the repo is identical
      // to the copy we already hold, so nothing is downloaded, nothing is
      // stored, and the archive list keeps meaning something.
      if (!force && src.last_sha === commitSha) {
        await db
          .from('repo_sources')
          .update({
            last_synced_at: new Date().toISOString(),
            last_status: 'ok',
            last_error: null,
            last_sha: commitSha,
          })
          .eq('id', src.id)
        return { ...base, status: 'skipped', detail: `unchanged at ${commitSha.slice(0, 7)}`, sha: commitSha }
      }

      bytes = await fetchTarball(owner, repo, ref)
    } else {
      const parsed = parseHttpsUrl(src.url)
      repoName = parsed.host + parsed.pathname
      ref = src.git_ref ?? 'HEAD'
      const res = await fetch(parsed.toString(), { headers: { 'User-Agent': 'frc5805-repo-sync' } })
      if (!res.ok) throw new Error(`Fetching the URL returned ${res.status}`)
      bytes = await downloadCapped(res, MAX_ARCHIVE_BYTES)

      // A plain URL has no commit to ask about, so the identity of the artifact
      // is the hash of its content — which means the unchanged-skip still works,
      // just one download later. code_archives.commit_sha allows 7–40 hex chars,
      // so it gets the first 40 of the content digest.
      commitSha = (await sha256Hex(bytes)).slice(0, 40)
      if (!force && src.last_sha === commitSha) {
        await db
          .from('repo_sources')
          .update({
            last_synced_at: new Date().toISOString(),
            last_status: 'ok',
            last_error: null,
            last_sha: commitSha,
          })
          .eq('id', src.id)
        return { ...base, status: 'skipped', detail: 'content unchanged', sha: commitSha }
      }
    }

    if (!bytes.byteLength) throw new Error('the downloaded archive was empty')

    const sha7 = commitSha.slice(0, 7)
    const digest = await sha256Hex(bytes)
    const path = `${season}/${slug(src.label)}-${sha7}.tar.gz`

    // upsert on both the object and the index row: re-running with force must
    // overwrite cleanly rather than half-failing on a unique constraint. The
    // path already contains the SHA, so the only thing this ever overwrites is
    // a byte-identical copy of the same commit.
    const { error: upErr } = await db.storage.from('code').upload(path, new Blob([bytes], { type: 'application/gzip' }), {
      contentType: 'application/gzip',
      upsert: true,
    })
    if (upErr) throw new Error(`Storage upload failed: ${upErr.message}`)

    const { data: fileRow, error: fileErr } = await db
      .from('files')
      .upsert(
        {
          bucket: 'code',
          path,
          title: `${src.label} @ ${sha7}`,
          description: `Automatic archive of ${repoName} at ${ref}.`,
          kind: 'code',
          season,
          byte_size: bytes.byteLength,
          sha256: digest,
          uploaded_by: actorId,
        },
        { onConflict: 'bucket,path' }
      )
      .select('id')
      .single()

    // The object landed but its index row did not — the same orphan case
    // portalApi.uploadFile() guards against. An object with no `files` row is
    // invisible to the portal and to the nightly manifest, so it is removed
    // rather than left as a silent inconsistency.
    if (fileErr || !fileRow) {
      await db.storage.from('code').remove([path])
      throw new Error(`Indexing the archive failed: ${fileErr?.message ?? 'no row returned'}`)
    }

    // code_archives has no unique constraint to upsert against, and a forced
    // re-run of an unchanged repo would otherwise add a second catalogue row for
    // the same commit — the same duplication the SHA check exists to prevent,
    // arriving through the manual override instead.
    const { data: existingArchive } = await db
      .from('code_archives')
      .select('id')
      .eq('repo', repoName)
      .eq('commit_sha', commitSha)
      .eq('season', season)
      .maybeSingle()

    const archiveRow = {
      repo: repoName,
      ref,
      commit_sha: commitSha,
      season,
      notes: `Synced automatically from ${src.provider}.`,
      file_id: fileRow.id,
      created_by: actorId,
    }
    const { error: archiveErr } = existingArchive
      ? await db.from('code_archives').update(archiveRow).eq('id', existingArchive.id)
      : await db.from('code_archives').insert(archiveRow)
    // The bytes and their index row are both safely stored at this point, so a
    // failure here is a bookkeeping gap, not a lost archive. It is reported
    // rather than rolled back — deleting a good backup over a missing catalogue
    // entry would be the wrong trade.
    if (archiveErr) logSafe('[repo-sync] code_archives insert failed:', archiveErr.message)

    await db
      .from('repo_sources')
      .update({
        last_synced_at: new Date().toISOString(),
        last_status: 'ok',
        last_error: archiveErr ? `archived, but the catalogue row failed: ${archiveErr.message}` : null,
        last_sha: commitSha,
      })
      .eq('id', src.id)

    return {
      ...base,
      status: 'ok',
      detail: `archived ${repoName}@${sha7}`,
      sha: commitSha,
      bytes: bytes.byteLength,
      path,
    }
  } catch (err) {
    const message = scrub(err instanceof Error ? err.message : String(err)).slice(0, 1000)

    // last_synced_at is stamped on failure too, deliberately. Leaving it null
    // would keep the row permanently due, so a repo that 404s would be retried
    // on every single invocation forever. The cost is that a transient failure
    // waits a full interval before retrying; `{force: true, id}` is the manual
    // override for when that wait is not acceptable.
    await db
      .from('repo_sources')
      .update({
        last_synced_at: new Date().toISOString(),
        last_status: 'failed',
        last_error: message,
      })
      .eq('id', src.id)

    logSafe('[repo-sync]', src.label, 'failed:', message)
    return { ...base, status: 'failed', detail: message }
  }
}

// -----------------------------------------------------------------------------

Deno.serve(async (req) => {
  const pre = preflight(req)
  if (pre) return pre
  if (req.method !== 'POST') return fail(req, 'Use POST.', 405)

  // admin, and machine callers allowed — a nightly scheduler has no student
  // session to present.
  const auth = await requireCaller(req, 'admin', { allowServiceRole: true })
  if (!auth.ok) return auth.response

  const parsed = await readJsonBody(req, MAX_BODY_BYTES)
  if ('error' in parsed) return fail(req, parsed.error, /too large/.test(parsed.error) ? 413 : 400)

  const force = parsed.body.force === true
  const onlyId = typeof parsed.body.id === 'string' ? parsed.body.id : null

  try {
    // Inside the try: serviceClient() throws when the service-role key is not in
    // the environment, and an uncaught throw returns a bare 500 with no CORS
    // headers — which reads as a network error rather than as the
    // misconfiguration it is.
    const db = serviceClient()

    let q = db
      .from('repo_sources')
      .select('id, label, provider, owner, repo, git_ref, url, enabled, interval_hours, last_synced_at, last_sha')
      .order('last_synced_at', { ascending: true, nullsFirst: true })
    if (onlyId) q = q.eq('id', onlyId)
    else q = q.eq('enabled', true)

    const { data: sources, error } = await q
    if (error) return fail(req, error.message, 500)
    if (!sources?.length) {
      return ok(req, { ran: 0, results: [], detail: onlyId ? 'No such source.' : 'No enabled sources.' })
    }

    // Due-ness compares two columns of the same row against now(), which
    // PostgREST cannot express as a filter — so it is computed here. The table
    // holds a handful of rows by design, so pulling them all is cheaper than the
    // view or RPC it would otherwise take.
    const now = Date.now()
    const due = (sources as RepoSource[]).filter((s) => {
      if (onlyId && force) return true // explicit single-source override
      if (!s.enabled) return false
      if (!s.last_synced_at) return true
      return now - new Date(s.last_synced_at).getTime() >= s.interval_hours * 3_600_000
    })

    const batch = due.slice(0, MAX_REPOS_PER_RUN)
    const results: SyncOutcome[] = []
    // Sequential, not Promise.all: three tarballs buffered in memory at once is
    // how this gets OOM-killed, and the failure would look like a timeout rather
    // than like what it is.
    for (const src of batch) {
      results.push(await syncOne(db, src, auth.caller.userId, force))
    }

    return ok(req, {
      ran: results.length,
      due: due.length,
      deferred: Math.max(0, due.length - batch.length),
      results,
    })
  } catch (err) {
    logSafe('[repo-sync] unhandled:', err instanceof Error ? err.message : String(err))
    return fail(req, 'The repository sync failed unexpectedly.', 500)
  }
})
