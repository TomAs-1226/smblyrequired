// =============================================================================
// _shared/auth.ts — caller verification, CORS, and response shape for every
// Edge Function in this directory.
//
// These functions exist for one reason only: three API keys (The Blue Alliance,
// OpenAI, GitHub) must never reach the browser. The site is a public static
// bundle on a public branch — a key in the frontend is a key published to the
// world. Everything below follows from that.
//
// The rule that is easiest to get wrong: **a valid JWT is not authorization**.
// Signup puts a user in the `pending` role (0001_identity.sql), and a pending
// user is signed in, holds a perfectly valid token, and is entitled to nothing.
// If these functions checked only "is there a JWT", anyone on the internet who
// could reach the signup form could drain the OpenAI account. So every request
// resolves the caller's `profiles.role` and compares it against a floor.
//
// One implementation lives here rather than three copies in three files,
// because three copies drift and the one that drifts is the one with the hole.
// =============================================================================

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Mirrors public.member_role. Order IS privilege order — the same ordinal trick
// that makes `role >= 'member'` work in Postgres. If a role is ever added to the
// enum with ALTER TYPE ... BEFORE/AFTER, it must be inserted at the matching
// position here or this file will silently disagree with the database.
export type MemberRole = 'pending' | 'viewer' | 'member' | 'lead' | 'mentor' | 'admin'

const ROLE_ORDER: MemberRole[] = ['pending', 'viewer', 'member', 'lead', 'mentor', 'admin']

export function isAtLeast(role: MemberRole, minimum: MemberRole): boolean {
  return ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(minimum)
}

// Injected by the platform; they are not secrets you set yourself. The service
// role key bypasses RLS entirely, so it is read here and passed nowhere else.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

// -----------------------------------------------------------------------------
// Secret scrubbing.
//
// Not paranoia about our own log lines — upstream APIs do this to us. OpenAI's
// 401 body quotes back a partially masked copy of the key it was sent, and a
// GitHub error can echo a token in a URL. Forwarding an upstream error body
// verbatim to the browser, or into a log, is therefore a leak path even though
// no line in this repo ever prints a key on purpose. Everything that could have
// come from upstream goes through here first.
// -----------------------------------------------------------------------------
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g, // OpenAI, current and legacy prefixes
  /gh[pousr]_[A-Za-z0-9]{8,}/g, // GitHub personal access / OAuth / refresh tokens
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, // any JWT, incl. ours
  /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{12,}=*/g,
]

export function scrub(text: unknown): string {
  let out = typeof text === 'string' ? text : String(text ?? '')
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]')
  return out
}

// Every log line in these functions goes through this. Supabase function logs
// are readable by anyone with dashboard access, which is a wider set of people
// than "may hold the OpenAI key".
export function logSafe(...parts: unknown[]): void {
  console.log(parts.map((p) => scrub(typeof p === 'string' ? p : JSON.stringify(p))).join(' '))
}

// -----------------------------------------------------------------------------
// CORS.
//
// An allow-list, not `*`. Worth being precise about what this does and does not
// buy, because it is easy to mistake for a security boundary: CORS is enforced
// by the *browser*, so it cannot stop curl, a script, or a server. It stops one
// specific thing — some other website causing a signed-in student's browser to
// call this function with their token attached. That is worth stopping. The
// actual authorization is the role check further down; this is not it.
//
// Consequently a request with no Origin header at all (curl, a cron job, a
// server) is not blocked here. It still has to pass the role check.
// -----------------------------------------------------------------------------
function allowedOrigins(): string[] {
  return (Deno.env.get('ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean)
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin')
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    // Responses differ per Origin. Without this a shared cache can hand the
    // header it computed for one origin to a request from another.
    Vary: 'Origin',
  }

  // Echo the caller's origin only when it is on the list. Echoing an arbitrary
  // origin back is functionally `*` with extra steps.
  if (origin && allowedOrigins().includes(origin.replace(/\/$/, ''))) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  // No Access-Control-Allow-Credentials: auth here is a bearer token the caller
  // attaches explicitly, never an ambient cookie. Turning credentials on would
  // widen the attack surface for nothing.
  return headers
}

// Fails closed on an unknown origin, and says why. An empty ALLOWED_ORIGINS on
// a fresh deploy will break the portal loudly rather than quietly allowing
// everything, which is the correct direction for that mistake to fail in.
export function preflight(req: Request): Response | null {
  if (req.method !== 'OPTIONS') return null
  const headers = corsHeaders(req)
  if (req.headers.get('origin') && !headers['Access-Control-Allow-Origin']) {
    return new Response(null, { status: 403, headers })
  }
  return new Response(null, { status: 204, headers })
}

// -----------------------------------------------------------------------------
// Response shape.
//
// `{ data, error }` with `error` already reduced to a string a student can
// read — the same contract src/lib/portalApi.js uses everywhere else, so the
// portal does not need a second error-handling path for these three endpoints.
// -----------------------------------------------------------------------------
export function ok<T>(req: Request, data: T, status = 200): Response {
  return new Response(JSON.stringify({ data, error: null }), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
  })
}

export function fail(req: Request, message: string, status = 400): Response {
  return new Response(JSON.stringify({ data: null, error: scrub(message) }), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
  })
}

// -----------------------------------------------------------------------------
// Request body reading, with a hard size cap.
//
// The cap is upstream of everything: an unbounded body is a free way to make
// this function burn memory and CPU, and for the ai function it is also a free
// way to inflate somebody else's OpenAI bill. content-length is checked first
// because it is cheap, but it is client-supplied, so the decoded length is
// checked too.
// -----------------------------------------------------------------------------
export async function readJsonBody(
  req: Request,
  maxBytes: number
): Promise<{ body: Record<string, unknown> } | { error: string }> {
  const declared = Number(req.headers.get('content-length') ?? '0')
  if (declared > maxBytes) return { error: `Request too large (limit ${maxBytes} bytes).` }

  let text: string
  try {
    text = await req.text()
  } catch {
    return { error: 'Could not read the request body.' }
  }
  if (new TextEncoder().encode(text).length > maxBytes) {
    return { error: `Request too large (limit ${maxBytes} bytes).` }
  }
  if (!text.trim()) return { body: {} }

  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: 'Request body must be a JSON object.' }
    }
    return { body: parsed as Record<string, unknown> }
  } catch {
    return { error: 'Request body is not valid JSON.' }
  }
}

// -----------------------------------------------------------------------------
// Caller verification.
// -----------------------------------------------------------------------------

export interface Caller {
  userId: string | null // null for the trusted machine caller
  role: MemberRole
  /** Scoped to the caller's own JWT, so RLS applies to everything it reads. */
  client: SupabaseClient
  isMachine: boolean
}

export type CallerResult = { ok: true; caller: Caller } | { ok: false; response: Response }

function constantTimeEquals(a: string, b: string): boolean {
  // Length leaks, which is fine — key lengths are public knowledge. What must
  // not leak is *where* two same-length strings first differ, because that
  // turns guessing a key into a per-character search instead of a global one.
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Service-role client. RLS does not apply to it — use it only where a caller
 *  genuinely cannot do the write themselves, and never to read on their behalf. */
export function serviceClient(): SupabaseClient {
  if (!SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not available')
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/**
 * Resolve the caller and enforce a privilege floor.
 *
 * @param minimum          the role floor, e.g. 'member' or 'admin'
 * @param allowServiceRole whether a request bearing the service-role key itself
 *                         counts as an admin machine caller (see below)
 */
export async function requireCaller(
  req: Request,
  minimum: MemberRole,
  { allowServiceRole = false } = {}
): Promise<CallerResult> {
  const authHeader = req.headers.get('Authorization') ?? ''
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()

  if (!token) {
    return { ok: false, response: fail(req, 'Sign in to use this.', 401) }
  }

  // The machine caller. A scheduler cannot hold a student's session, so a job
  // that runs unattended has to authenticate as something. Accepting the
  // service-role key grants nothing new: anyone holding it can already read and
  // write every table directly, RLS and all. It is opt-in per function so the
  // ai and tba-proxy endpoints still require a real human.
  //
  // The key therefore belongs only in the scheduler's own secret store, next to
  // the backup job's copy — never in this repo, never with a VITE_ prefix.
  if (allowServiceRole && SERVICE_ROLE_KEY && constantTimeEquals(token, SERVICE_ROLE_KEY)) {
    return {
      ok: true,
      caller: { userId: null, role: 'admin', client: serviceClient(), isMachine: true },
    }
  }

  // Built with the caller's own JWT, not the service key. Two reasons: getUser()
  // validates the token against the auth server rather than trusting its claims,
  // and every subsequent read through this client is subject to the same RLS the
  // browser would hit — so a bug here cannot hand a caller rows they could not
  // have fetched themselves.
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: userRes, error: userErr } = await client.auth.getUser()
  if (userErr || !userRes?.user) {
    return { ok: false, response: fail(req, 'Your session expired. Sign in again.', 401) }
  }

  // Reading the caller's own row works under RLS because of the "profiles: read
  // own row" policy in 0001 — which exists precisely so a pending user can see
  // that they are pending. Absent or unreadable means pending: the default is
  // the least privilege, never the benefit of the doubt.
  const { data: profile } = await client
    .from('profiles')
    .select('role')
    .eq('id', userRes.user.id)
    .maybeSingle()

  const role = (profile?.role ?? 'pending') as MemberRole

  if (!isAtLeast(role, minimum)) {
    // Deliberately vague about what the floor is. Telling a pending account
    // exactly which role unlocks the OpenAI key is free reconnaissance, and the
    // person who legitimately hits this needs to talk to a lead either way.
    return {
      ok: false,
      response: fail(
        req,
        role === 'pending'
          ? 'Your account is still pending approval. Ask a lead to approve it.'
          : 'You do not have access to that.',
        403
      ),
    }
  }

  return { ok: true, caller: { userId: userRes.user.id, role, client, isMachine: false } }
}

// -----------------------------------------------------------------------------
// Per-user rate limiting.
//
// LIMITATION, STATED PLAINLY: this counter lives in the isolate's memory. Edge
// functions run as many isolates across regions, and an idle isolate is torn
// down, so the real allowance is "N per window per isolate" and a cold start
// resets it to zero. It is a guard against a stuck retry loop or one student
// hammering a button — it is NOT a spend cap and must not be relied on as one.
//
// The spend cap that actually holds is a hard monthly limit set in the OpenAI
// dashboard. Set one. If per-user accounting ever needs to be real, move this
// to a table keyed by (user_id, window_start) and count there instead.
// -----------------------------------------------------------------------------
const hits = new Map<string, number[]>()

export function rateLimit(key: string, max: number, windowSeconds: number): boolean {
  const now = Date.now()
  const cutoff = now - windowSeconds * 1000
  const recent = (hits.get(key) ?? []).filter((t) => t > cutoff)
  if (recent.length >= max) {
    hits.set(key, recent)
    return false
  }
  recent.push(now)
  hits.set(key, recent)

  // The map only ever grows otherwise, and an isolate can live for hours.
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (v.every((t) => t <= cutoff)) hits.delete(k)
  }
  return true
}

// -----------------------------------------------------------------------------
// A tiny TTL memo, for upstream responses that have nowhere to be cached in
// Postgres. Same isolate-scoped caveat as the rate limiter: a miss is always
// correct, a hit is a bonus. Never use it for anything where staleness is
// unsafe — TTLs at the call sites are chosen with that in mind.
// -----------------------------------------------------------------------------
const memo = new Map<string, { at: number; value: unknown }>()

export function memoGet<T>(key: string, ttlSeconds: number): T | null {
  const entry = memo.get(key)
  if (!entry) return null
  if (Date.now() - entry.at > ttlSeconds * 1000) {
    memo.delete(key)
    return null
  }
  return entry.value as T
}

export function memoSet(key: string, value: unknown): void {
  if (memo.size > 500) memo.clear() // crude, but this is a cache, not a store
  memo.set(key, { at: Date.now(), value })
}
