# Edge Functions

Three functions, and a shared module they all depend on. They exist for exactly
one reason: **three API keys must never reach the browser.**

The site is a public static bundle served from a public branch. Vite inlines
anything it can see, and `dist/` is committed to `gh-pages` — so a key used from
the frontend is a key published to the world, permanently, in git history. The
Supabase anon key is fine there (it is a public identifier and RLS decides what
it can read). The TBA, OpenAI, and GitHub keys are not.

These functions run on Deno in Supabase's edge runtime. They are the only place
those three keys exist outside a password manager.

| Function | Key it holds | Who may call it |
|---|---|---|
| `tba-proxy` | `TBA_KEY` | `member`+ |
| `ai` | `OPENAI_API_KEY` | `member`+ |
| `repo-sync` | `GITHUB_TOKEN` (optional) | `admin`+, or the service-role key |
| `_shared/auth.ts` | — | not deployed on its own |

## The thing to understand before editing any of these

**A valid JWT is not authorization.** Signing up puts a user in the `pending`
role (`supabase/migrations/0001_identity.sql`), and a pending user is signed in,
holds a perfectly valid token, and is entitled to nothing. Supabase's own gateway
JWT check — which is on by default — proves only that *somebody signed up*.

So every request goes through `requireCaller()` in `_shared/auth.ts`, which
resolves the caller's `profiles.role` and compares it against a floor. Without
that, anyone who can reach the signup form can drain the OpenAI account.

Two related rules that live in the same file:

- Reads on the caller's behalf use a client built from **their** JWT, so RLS
  applies exactly as it does in the browser. The service-role key is used only
  where a caller genuinely cannot do the write themselves — the TBA cache tables
  (member-readable, lead-writable) and everything `repo-sync` touches.
- Upstream error bodies are **never** forwarded to the client or into a log.
  OpenAI's 401 response quotes back a masked copy of the key it was sent. Every
  string that could have come from upstream goes through `scrub()` first.

---

## `tba-proxy`

The Blue Alliance API v3. The build-time equivalent for the public site is
`scripts/fetch-tba.mjs`; this is the portal's runtime version, for a scout who
needs the match schedule now rather than at the next deploy.

`POST` body is `{ action, ...params }`. The action names are a **whitelist**.
There is deliberately no path parameter to forward — a function that attaches a
credential to a caller-supplied URL is an open relay wearing our API key.

| Action | Params | Returns | Cached in |
|---|---|---|---|
| `events` | `year` | events for a season | `public.events`, 12 h |
| `event_teams` | `eventKey` | teams at an event | `public.event_teams`, 6 h |
| `event_matches` | `eventKey` | match schedule + live scores | isolate memory, 2 min |
| `team_history` | `teamNumber`, `year` | that team's events, ranks, records | isolate memory, 15 min |

Add `"force": true` to any of them to bypass the cache.

`events` and `event_teams` write through to the cache tables from migration
0005, so a pit full of scouts hits Postgres rather than each hitting TBA over a
saturated arena network. `event_matches` and `team_history` have no table to
write to, so they get a short in-memory cache only — see *Known limitations*.

## `ai`

OpenAI Chat Completions. `POST` body is `{ task, ...params }`.

| Task | Params | Model | Why that model |
|---|---|---|---|
| `scouting_summary` | `teamNumber`, `eventKey` | `gpt-4o-mini` | Grounded restatement of numbers, run once per team per event — dozens of calls an afternoon |
| `picklist_help` | `eventKey`, optional `limit`, `question` | `gpt-4o` | Genuine comparative reasoning across ~30 teams, run a few times per event, most directly moves a pick |
| `kb_answer` | `question` | `gpt-4o-mini` | Retrieval-grounded, cites doc slugs |
| `form_suggest` | `season`, `game`, optional `kind` | `gpt-4o-mini` | Structured JSON generation against a fixed schema |
| `summarise_notes` | `teamNumber`, optional `eventKey` | `gpt-4o-mini` | Short condensation of free text |

Every response includes `model` and `usage` (prompt/completion/total tokens) so
cost is visible at the call site rather than discovered on a statement.

**The honesty requirement.** Alliance selection happens on eight minutes of
notice with these summaries open, and a student will read the output aloud to a
drive team who will believe it. Every prompt forces the model to state its sample
size and refuse to extrapolate past it — "only 2 matches scouted" belongs in the
first sentence, not in a footnote. If you edit the prompts, keep that property.

Three tasks skip the model call entirely when there is no data, rather than
paying a model to phrase "there is no data" and giving it room to fill the
silence with something plausible.

`kb_answer` searches `public.knowledge_docs` through the `search` tsvector and
its GIN index, and sends **only the top matches** — never the knowledge base
wholesale. `form_suggest` returns a **draft** and writes nothing: `scout_forms`
allows one active form per `(season, kind)`, and auto-activating one could
displace the form students are mid-event submitting against.

Limits: 8 KB request body, per-task output caps, and a per-user rate limit
(default 15 requests / 5 minutes, `AI_RATE_MAX` and `AI_RATE_WINDOW_SECONDS`).
**Read the rate-limit limitation below before treating it as a spend control.**

## `repo-sync`

Pulls the repos listed in `public.repo_sources` into the `code` bucket. Admin
only.

`POST` with an empty body `{}` syncs everything enabled and due (that is,
`last_synced_at` older than the row's `interval_hours`). `{"force": true, "id":
"<uuid>"}` forces one specific source regardless of schedule.

For `provider='github'` it resolves the commit SHA for `git_ref` in one cheap
API call first, and **skips the download entirely if it matches `last_sha`**.
Re-archiving an unchanged repo every night fills the bucket with duplicates and
makes the archive list stop meaning "these are the versions that mattered".

Each successful sync uploads to `code` at `{year}/{label}-{sha7}.tar.gz`, inserts
a `public.files` row (with a SHA-256 the nightly mirror can verify against) and a
`public.code_archives` row, then updates `last_synced_at`, `last_status`, and
`last_sha`.

On failure it writes `last_error` with the actual message. **A sync that has been
failing silently for a month is the failure mode this is built around** — the
portal can show `repo_sources.last_error`, so make sure something does.

---

## Setting the secrets

Link the project first, exactly as in `docs/PORTAL.md`:

```bash
supabase link --project-ref <your-project-ref>
```

Then set the secrets. **Every value below is a placeholder.** This repo is
public — no real key, hostname, or address goes in this file or any other file
here, ever.

```bash
# The Blue Alliance read API key — thebluealliance.com/account
supabase secrets set TBA_KEY=<your-tba-read-api-key>

# OpenAI API key. Set a hard monthly spend limit on this key in the OpenAI
# dashboard; that limit is the only real cost control (see below).
supabase secrets set OPENAI_API_KEY=<your-openai-api-key>

# Optional. Without it, repo-sync works on public repos at GitHub's 60/hour
# unauthenticated rate limit. With it, private repos work and the limit is
# 5000/hour. A fine-grained token with read-only Contents access is enough.
supabase secrets set GITHUB_TOKEN=<your-github-token>

# Comma-separated, no trailing slashes, no wildcards. This is the CORS
# allow-list; anything not on it gets no Access-Control-Allow-Origin header.
supabase secrets set ALLOWED_ORIGINS=https://<your-domain>,http://localhost:5173
```

Optional tuning, all with sensible defaults:

```bash
supabase secrets set AI_RATE_MAX=15              # requests per user per window
supabase secrets set AI_RATE_WINDOW_SECONDS=300
supabase secrets set REPO_SYNC_MAX_PER_RUN=3     # repos archived per invocation
supabase secrets set REPO_SYNC_MAX_MB=60         # per-archive memory ceiling
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are injected
by the platform. Do not set them yourself — the CLI rejects secrets with a
`SUPABASE_` prefix anyway.

Check what is set (names only; values are never printed back):

```bash
supabase secrets list
```

## Deploying

```bash
supabase functions deploy tba-proxy
supabase functions deploy ai
supabase functions deploy repo-sync
```

`_shared/` is not deployed on its own — it is bundled into each function that
imports it. A change to `_shared/auth.ts` therefore requires **redeploying all
three**, which is the one real cost of having a single implementation.

Do not deploy with `--no-verify-jwt`. The platform's JWT check is a cheap first
filter that rejects unauthenticated junk before our code runs; the role check
inside is the actual authorization. Keep both. `OPTIONS` preflights are exempt
from the platform check, which is why the CORS handler works.

## Testing

Get an access token for a real account. This is a normal password sign-in
against your project's auth endpoint:

```bash
PROJECT=<your-project-ref>
ANON=<your-anon-key>

TOKEN=$(curl -s -X POST "https://$PROJECT.supabase.co/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d '{"email":"<your-email>","password":"<your-password>"}' | jq -r .access_token)
```

### tba-proxy

```bash
# events for a season
curl -s -X POST "https://$PROJECT.supabase.co/functions/v1/tba-proxy" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"events","year":2026}' | jq

# teams at an event
curl -s -X POST "https://$PROJECT.supabase.co/functions/v1/tba-proxy" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"event_teams","eventKey":"2026casd"}' | jq

# match schedule
curl -s -X POST "https://$PROJECT.supabase.co/functions/v1/tba-proxy" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"event_matches","eventKey":"2026casd"}' | jq

# one team's season so far, bypassing the cache
curl -s -X POST "https://$PROJECT.supabase.co/functions/v1/tba-proxy" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"team_history","teamNumber":5805,"year":2026,"force":true}' | jq
```

### ai

```bash
curl -s -X POST "https://$PROJECT.supabase.co/functions/v1/ai" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"task":"scouting_summary","teamNumber":5805,"eventKey":"2026casd"}' | jq

curl -s -X POST "https://$PROJECT.supabase.co/functions/v1/ai" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"task":"picklist_help","eventKey":"2026casd","limit":24}' | jq

curl -s -X POST "https://$PROJECT.supabase.co/functions/v1/ai" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"task":"kb_answer","question":"how do I restore the database backup?"}' | jq

curl -s -X POST "https://$PROJECT.supabase.co/functions/v1/ai" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"task":"form_suggest","season":2026,"kind":"match","game":"<one-paragraph description of the season game>"}' | jq

curl -s -X POST "https://$PROJECT.supabase.co/functions/v1/ai" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"task":"summarise_notes","teamNumber":5805,"eventKey":"2026casd"}' | jq
```

Check `.data.usage` on every response — that is the token cost of that call.

### repo-sync

Needs an **admin** token, or the service-role key as the bearer.

```bash
# everything enabled and due
curl -s -X POST "https://$PROJECT.supabase.co/functions/v1/repo-sync" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{}' | jq

# force one source, ignoring both its schedule and its last_sha
curl -s -X POST "https://$PROJECT.supabase.co/functions/v1/repo-sync" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"force":true,"id":"<repo-source-uuid>"}' | jq
```

Verify the unchanged-repo skip works by running it twice: the second run should
report `"status":"skipped"` with `"unchanged at <sha7>"`, and no new object
should appear in the bucket.

### The checks that matter

These are the assertions worth re-running after any change to `_shared/auth.ts`.
Reading the code is not the same as testing it.

```bash
# no token -> 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  "https://$PROJECT.supabase.co/functions/v1/ai" -d '{"task":"kb_answer","question":"x"}'

# a pending account's token -> 403, not 200
curl -s -X POST "https://$PROJECT.supabase.co/functions/v1/ai" \
  -H "Authorization: Bearer $PENDING_TOKEN" -H "Content-Type: application/json" \
  -d '{"task":"kb_answer","question":"x"}' | jq

# a member's token against repo-sync -> 403 (admin floor)
curl -s -X POST "https://$PROJECT.supabase.co/functions/v1/repo-sync" \
  -H "Authorization: Bearer $MEMBER_TOKEN" -d '{}' | jq

# an origin not on the allow-list gets no Access-Control-Allow-Origin back
curl -s -i -X OPTIONS "https://$PROJECT.supabase.co/functions/v1/ai" \
  -H "Origin: https://not-our-site.example" | grep -i access-control
```

## Scheduling repo-sync

The function is admin-gated, and a scheduler has no student session to present —
so it authenticates with the service-role key, which `requireCaller()` accepts as
a machine caller for this function only. That grants nothing new: anyone holding
that key can already read and write every table directly, RLS and all.

Consequently the key belongs only in the scheduler's own secret store, alongside
the backup job's copy. Never in this repo, never with a `VITE_` prefix, never in
the browser.

```bash
curl -s -X POST "https://$PROJECT.supabase.co/functions/v1/repo-sync" \
  -H "Authorization: Bearer <your-service-role-key>" \
  -H "Content-Type: application/json" -d '{}'
```

Run it from whatever already runs on a timer — the backup host's systemd timers
(`scripts/backup/systemd/`) are the obvious home, since that machine already
holds a service-role key and is already the thing that gets checked when a backup
looks wrong.

## Known limitations

Written down because each one is the kind of thing that gets rediscovered
expensively.

1. **The rate limiter is per-isolate and best-effort.** It lives in the
   function's memory. Edge functions scale to many isolates and an idle one is
   torn down, so the real allowance is "N per window per isolate" and a cold
   start resets it to zero. It stops a stuck retry loop or one student leaning on
   a button. **It is not a spend cap.** The control that actually holds is a hard
   monthly limit on the OpenAI key. Set one. If per-user accounting ever has to be
   real, move the counter to a table keyed by `(user_id, window_start)`.

2. **`event_matches` and `team_history` are only memo-cached**, for the same
   reason — there is no table in migration 0005 to write them to. Live scores
   should not be cached long anyway, but under load most requests will still
   reach TBA. If that becomes a problem, the fix is a `matches` cache table, not
   a longer in-memory TTL.

3. **`repo-sync` buffers each archive in memory** to hash and upload it, so it is
   capped at `REPO_SYNC_MAX_MB` (default 60) — well below the `code` bucket's
   500 MB limit, because the isolate's memory ceiling is the smaller and
   therefore real number. A repo that exceeds it fails with a message saying so.
   The right fix is not a bigger cap: it is to run that repo's archive from the
   backup host, which already holds a service-role key, already has disk, and is
   not on a wall-clock limit.

4. **`repo-sync` syncs at most `REPO_SYNC_MAX_PER_RUN` repos per invocation**,
   sequentially. Edge functions have a wall-clock limit and three tarballs in
   memory at once is how this gets OOM-killed. Anything not reached stays due and
   is picked up next run; nothing is lost, it just takes another cycle.

5. **`last_synced_at` is stamped on failure too.** Otherwise a repo that 404s
   would be retried on every invocation forever. The cost is that a transient
   failure waits a full `interval_hours` before retrying — use `{force, id}` when
   that wait is not acceptable.

6. **A row stuck at `last_status = 'running'` means an invocation died mid-sync.**
   It is not sticky: `last_synced_at` is not written until the work finishes, so
   the row stays due and the next run retries it.

7. **CORS is not authorization.** It is enforced by the browser, so it does not
   stop curl, a script, or a server — and requests with no `Origin` header are
   not blocked. It stops one specific thing: another website causing a signed-in
   student's browser to call these functions with their token attached. The role
   check is the authorization.

8. **The model can still be wrong.** The prompts push hard toward citing sample
   sizes and refusing to extrapolate, and the deterministic no-data paths mean it
   is never asked to narrate an empty dataset. Neither is a guarantee. Treat every
   AI summary as a starting point for a conversation with the scouts, not as a
   finding.
