# Team portal — setup

The portal is a private team area at `#/portal` on the same site. It is for roster, files,
graphify output, code archives, and the team knowledge base.

The public site is unchanged. Every marketing page still renders with no session, no
network call to Supabase, and no auth code downloaded — `App.jsx` lazy-loads the portal
chunk, so a sponsor reading the front page never fetches the Supabase client at all. If the
portal is not configured, it says so and the rest of the site keeps working.

## Architecture

```
  Browser
    │
    ├── HTTPS ─▶  GitHub Pages          static bundle (dist/ on gh-pages)
    │                                   no server was added — this is still the host
    │
    └── HTTPS ─▶  Supabase              Postgres + Storage + Auth
                     │                  RLS in the database is the security boundary
                     │
                     │  leg 1 — nightly.sh → mirror.mjs, service-role key, pull only
                     ▼
                  backup host           <backup-host>:/srv/backup/frc5805/<stamp>/
                     │
                     │  leg 2 — rsync + ssh over the tailnet
                     ▼
                  OptiPlex              <optiplex-host>:<path>/<stamp>/
```

Machine names and addresses are placeholders throughout these docs — this repo is public.

Nothing inbound is exposed. The backup host pulls from Supabase; the site never talks to
it, and Supabase never talks to it. Hosting, DNS, and the deploy flow are exactly as
described in `DEPLOY.md` — none of that changed.

## One-time Supabase setup

1. Create a Supabase project. Note the project ref, the project URL, and the database
   password you set — you will need the password again for the backup job.

2. Run the migrations in `supabase/migrations/` **in order**:

   ```bash
   supabase link --project-ref <your-project-ref>
   supabase db push
   ```

   | File | What it creates |
   |---|---|
   | `0001_identity.sql` | `member_role` enum, `profiles`, `auth_role()`, `is_at_least()`, `set_member_role()`, the role-escalation guards, RLS on `profiles` |
   | `0002_storage.sql` | The five buckets and every `storage.objects` policy |
   | `0003_content.sql` | `files`, `graphs`, `code_archives`, `knowledge_docs`, version history, the secret guard, RLS |
   | `0004_audit_backup.sql` | `audit_log`, `backup_runs`, the `backup_health` view, RLS |

   All four have been verified to apply cleanly, in this order, against PostgreSQL 17, and a
   full dump/restore cycle of the result has been verified end to end. See *Testing the schema
   locally* below to reproduce that, and `docs/BACKUP.md` for the restore.

3. **If `supabase db push` fails on `0002_storage.sql`, this is expected.** That file creates
   policies on `storage.objects`, which is owned by `supabase_storage_admin`, not by the role
   the CLI connects as. The error looks like `must be owner of table objects`.

   The fix is not to change the migration. Open the dashboard **SQL Editor**, paste the whole
   of `0002_storage.sql`, and run it there — the editor connects with the rights to create
   those policies. Then continue with `0003` and `0004`.

   The file is written to be safely re-runnable for the bucket rows (`on conflict (id) do
   update`), but `create policy` is not idempotent. If you have to run it twice, drop the
   policies it already created first.

4. **Turn off public signup.** Dashboard → **Authentication → Sign In / Providers → Email**
   (older UI: **Authentication → Settings**) → turn off *Allow new users to sign up*.

   This is not optional. The site is public. Accounts are created by a lead, from the
   dashboard, on request. A new signup lands in the `pending` role and can see nothing, so an
   open signup form is not an immediate breach — but it does let anyone on the internet create
   rows in `auth.users` and mail your project's rate limit, and the sign-in screen already
   tells people to ask a lead instead.

5. **Add the site origin to the allowed redirect URLs.** Dashboard → **Authentication → URL
   Configuration**. Magic-link sign-in redirects to
   `${window.location.origin}${window.location.pathname}#/portal`, so the allow-list needs to
   cover wherever the site is actually served from:

   | Setting | Value |
   |---|---|
   | Site URL | `https://tomas-1226.github.io/smblyrequired/` |
   | Redirect URLs | `https://tomas-1226.github.io/smblyrequired/**` |
   | Redirect URLs | `http://localhost:5173/**` (local dev) |

   Add the custom domain too if and when `frc5805.com` goes live (see `DEPLOY.md`).

Auth uses the PKCE flow, not the implicit flow — set in `src/lib/supabase.js`. The implicit
flow returns the session in the URL *hash*, and this site is hash-routed, so the two would
fight over `#/portal`. Do not switch it back.

## Testing the schema locally

```bash
npm run test:db
```

That recreates a throwaway local database (`frc5805_test`, or whatever `TEST_DB` is set to),
applies `supabase/local-test/00_stub.sql`, then all four migrations in order, then runs
`supabase/local-test/01_rls_tests.sql`. It prints a line per assertion, finishes with
`20 assertion(s) passed`, and stops at the first error.

**Run it after any change to `supabase/migrations/`.** It is the check that the schema still
applies and — more to the point — that the access rules still do what the *Roles* section below
claims they do.
It needs a local **PostgreSQL 15+** and it **never touches a Supabase project**. Override the
connection with `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD`; on Windows the runner also looks
for `psql.exe` under `C:\Program Files\PostgreSQL` when it is not on `PATH`.

`00_stub.sql` is what makes any of this possible. The migrations are written against a real
Supabase project, which supplies the `auth` and `storage` schemas and the `anon` /
`authenticated` / `service_role` roles. A bare Postgres has none of that, so the migrations
cannot be applied — and therefore cannot be tested — without it. The stub also reproduces
Supabase's default of granting `all` on public tables to `anon` and `authenticated`, which
matters more than it looks: `0001_identity.sql` REVOKEs `UPDATE` on `profiles.role`, and if the
grant had never been there the revoke would be a no-op and the test would prove nothing.

> `00_stub.sql` is local-only. **Never run it against a Supabase database** — it would try to
> redefine objects the platform owns.

Each test switches to the `authenticated` role and sets a `request.jwt.claims` setting, which
is exactly how PostgREST executes a browser request. These exercise the same code path
production does, not an approximation of it.

| Area | What is asserted |
|---|---|
| Signup | Every new `auth.users` row lands at `pending`, even when the signup metadata says `"role":"admin"` |
| `anon` | The public internet reads zero rows from `profiles`, `knowledge_docs`, `files`, and `backup_runs` |
| `pending` | Reads no content at all and cannot enumerate the roster — only its own `profiles` row |
| Privilege escalation | A member cannot raise their own role by direct `UPDATE`, and cannot call `set_member_role()`; a **lead** cannot either, because granting is admin-only |
| Admin limits | An admin can grant a role but cannot change their own |
| Last-admin guards | The last admin cannot be demoted, cannot be deleted, and cannot be removed via the `auth.users` cascade — zero admins is unrecoverable, since `set_member_role()` needs one |
| Read floors | `viewer` sees team media only; `member` additionally reads the knowledge base, all file records, and backup health, but not the audit log |
| Storage | A member cannot reassign an object's `owner` to another user |
| Secret guard | Six secret patterns are rejected on write, and ordinary prose containing dotted numbers is still accepted — a guard that cries wolf gets removed |
| Version history | Editing a doc snapshots its previous body, and the history cannot be deleted through the API even by an admin |
| Audit log | Every role change is written to `audit_log` |
| `backup_health` | A viewer reads zero rows through the view, proving `security_invoker` keeps `backup_runs`' RLS in force rather than bypassing it |

## Environment variables

Two variables, both public, both required for the portal to do anything:

| Variable | Where it comes from |
|---|---|
| `VITE_SUPABASE_URL` | Dashboard → Project Settings → API → Project URL |
| `VITE_SUPABASE_ANON_KEY` | Dashboard → Project Settings → API → `anon` / publishable key |

The anon key belongs in the browser. It is a public identifier — what it can actually read is
decided by the RLS policies, not by hiding the key. The **service-role** key is the opposite;
it never goes in any of these files. See `docs/BACKUP.md`.

**Local dev:**

```bash
cp .env.example .env.local
# fill in the two VITE_ values
npm run dev
```

`.env.local` is gitignored — `.gitignore` excludes every `.env*` variant except `.env.example`,
because Vite also reads `.env.production` and friends and any of them can hold a live key.

**For the deployed site:** Vite inlines every `VITE_`-prefixed variable into the bundle at
**build** time. They are not read at runtime. If they are absent when `vite build` runs, the
deployed portal renders its "not set up yet" state no matter what you configure afterwards.

Today `npm run deploy` builds *locally* and pushes `dist/` to `gh-pages` — there is no GitHub
Actions workflow in this repo. So the build environment is whichever machine runs the deploy,
and `.env.local` on that machine is what gets inlined. Anyone who deploys needs those two
values.

If you later move the deploy into a workflow, put both values in **repo secrets** and have the
workflow export them before `vite build`. Either way they do not get committed — not because
they are secret, but because a key checked into a public repo is a key you can never rotate
quietly.

## Roles

Six roles, defined as an enum in `0001_identity.sql`. **Declaration order is privilege order** —
Postgres compares enums by ordinal, which is what makes `is_at_least('member')` work. Never
reorder them; add new ones with `ALTER TYPE ... BEFORE/AFTER`.

| Role | Who it is for | What it can do |
|---|---|---|
| `pending` | Anyone who just signed up | Nothing. Reads its own `profiles` row and no other data at all. |
| `viewer` | Alumni, parents | Read the roster, the `media` bucket, and file records for `media` / `public-media`. |
| `member` | Current students on the team | Everything `viewer` has, plus the `graphs` / `code` / `knowledge` buckets, the knowledge base and its history, backup health, and uploading. Can edit, replace, and delete **their own** uploads. |
| `lead` | Subteam leads | Everything `member` has, plus delete or replace **anyone's** files, delete knowledge docs, publish to `public-media`, and read the audit log. |
| `mentor` | Adult mentors | Identical to `lead`. It sits above `lead` in the enum and no policy names it specifically, so every `is_at_least('lead')` check passes. The distinction is descriptive, not functional. |
| `admin` | Keep this set very small | Everything, plus the only role that can call `set_member_role()` to grant roles. |

Capability by role, read off the policies:

| Action | Floor |
|---|---|
| Read own profile row | any signed-in user, including `pending` |
| See the roster | `viewer` |
| Read the `media` bucket + `media`/`public-media` file records | `viewer` |
| Read `graphs` / `code` / `knowledge` buckets and their file records | `member` |
| Read knowledge docs and version history | `member` |
| Read backup health (`backup_runs`, `backup_health`) | `member` |
| Upload to `graphs` / `code` / `knowledge` / `media` | `member` |
| Replace or delete **your own** upload | `member` |
| Create or edit a knowledge doc | `member` |
| Create graph / code-archive records | `member` |
| Replace or delete **anyone's** file | `lead` |
| Delete a knowledge doc | `lead` |
| Upload, replace, or delete in `public-media` | `lead` |
| Read the audit log | `lead` |
| Change someone's role | `admin` |

Portal tabs mirror these floors: Overview and Files at `viewer`, Graphs / Code / Knowledge at
`member`, Team at `lead`. That gate is convenience only — it just avoids showing people doors
that will not open. **RLS in the database is the actual boundary**, and it applies the same
whether the request comes from the portal, `curl`, or anything else holding an anon key.

### A new signup is `pending` and sees nothing

The `role` column defaults to `pending`, and the `handle_new_user()` trigger hard-forces
`pending` on insert regardless of what the signup payload said. A `pending` user signing in
gets the "you're signed in — but not on the roster yet" screen. That is the expected state,
not an error.

`role` is deliberately not user-writable. `authenticated` has no `UPDATE` grant on that
column at all, and a trigger re-checks on top of that, so "user can edit own profile" can
never become "user can make themselves admin". Role changes go through exactly one code path:
`set_member_role()`.

Two guards worth knowing about before you get surprised by them:

- You cannot change your own role, even as an admin.
- The last remaining admin cannot be demoted.

## Bootstrapping the first admin

There is no admin when the migrations finish, and `set_member_role()` refuses to run for
anyone who is not already an admin. That is a deliberate chicken-and-egg: **the first admin
must be promoted by hand.**

This works because `guard_role_change()` lets a role change through when `auth.uid()` is null,
which is the case for SQL run in the dashboard editor and for the service-role key. It is not
a loophole — it is the only bootstrap path, and it requires dashboard access to the project.

1. Have the person sign in once (or create their user in **Authentication → Users**). The
   `on_auth_user_created` trigger writes their `profiles` row automatically.

2. Dashboard → **SQL Editor**, then:

   ```sql
   update public.profiles p
      set role = 'admin'
     from auth.users u
    where u.id = p.id
      and u.email = 'first-admin@example.org';
   ```

   Or by id, if you would rather look it up first:

   ```sql
   select u.id, u.email, p.role
     from auth.users u
     join public.profiles p on p.id = u.id
    order by u.created_at desc;

   update public.profiles
      set role = 'admin'
    where id = '00000000-0000-0000-0000-000000000000';
   ```

3. That admin promotes everyone else from the portal's **Team** tab. Every role change is
   written to `audit_log` automatically.

Do this once. After the first admin exists, there is no reason to touch roles in SQL again.

## Buckets

Five buckets, created in `0002_storage.sql`. Size and MIME limits are enforced server-side by
Supabase — a limit that only exists in the upload form is not a limit.

| Bucket | Visibility | Size limit | Allowed types | What goes in it |
|---|---|---|---|---|
| `graphs` | private | 100 MB | `application/json`, `text/html`, `image/svg+xml`, `application/gzip`, `application/x-tar`, `application/zip` | graphify output — JSON payloads and rendered HTML |
| `code` | private | 500 MB | `application/zip`, `application/gzip`, `application/x-tar`, `application/octet-stream`, `text/plain`, `application/json` | season code snapshots, CAD exports, build artifacts. CAD is what drives the ceiling |
| `knowledge` | private | 50 MB | `application/pdf`, `image/png`, `image/jpeg`, `image/webp`, `text/markdown`, `text/plain` | attachments for knowledge-base docs. The doc bodies live in Postgres, not here |
| `media` | private | 500 MB | `image/png`, `image/jpeg`, `image/webp`, `image/avif`, `video/mp4`, `video/quicktime`, `application/pdf`, `text/markdown` | internal team media — outreach records, meeting notes, award submissions, unreleased photos |
| `public-media` | **PUBLIC** | 25 MB | `image/png`, `image/jpeg`, `image/webp`, `image/avif`, `image/svg+xml` | sponsor logos and cleared photography only |

The four private buckets have no durable URL. The portal mints a signed URL per request with a
300-second expiry, because long-lived signed links get pasted into group chats and outlive
their welcome.

> **`public-media` is world-readable, permanently.**
> There is no signed URL and no session check. Anything you put there can be fetched by anyone
> who guesses or is given the path, and should be assumed to be indexed and cached by third
> parties within days. Deleting the object later does not un-publish what has already been
> copied.
>
> Write access is restricted to `lead` and above for exactly that reason, and the Files upload
> form in the portal does not target it at all — uploads route to `graphs`, `code`,
> `knowledge`, or `media` based on the kind you pick. Putting something in `public-media` is a
> deliberate act.
>
> `media` contains material about minors. It is private, with no exceptions. Do not move
> anything from `media` to `public-media` without checking the photo release first.

## What not to store

The knowledge base is meant to hold operational notes, which makes it exactly the kind of
document that accumulates a secret by accident. Do not write any of the following into
`knowledge_docs`, a file description, a commit message, or this repo:

- IP addresses — private, public, or tailnet
- Hostnames, ports, or anything describing the network layout
- SSH keys, private keys, or certificates
- API tokens, service-role keys, or database passwords
- Router, firewall, or VPN configuration

None of it belongs in a public repo, and the portal's contents get mirrored to two more
machines nightly. Reference secrets by name — "the backup env file on the backup server" — and keep
the values in a password manager.

`knowledge_docs` has a database-side guard (`reject_obvious_secrets()` in `0003_content.sql`)
that raises on write if the body matches a known pattern: private and CGNAT/tailnet IPv4
ranges, `-----BEGIN ... PRIVATE KEY-----` blocks, GitHub tokens, `sk-` / `sk_live_` API keys,
AWS access key ids, and assignments to `service_role`. Because it runs in the database it
applies to the portal, a script, a migration, and anything else that ever writes there.

**It is a backstop for the obvious accident, not a guarantee.** It only catches patterns it
already knows. It will not catch a public IP, a password, an unusual token format, a secret
split across two lines, or a hostname. A write that passes the guard is not evidence that the
document is safe to publish — it only means the guard had nothing to match. Read what you are
about to save.
