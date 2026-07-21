# Backup — install and operation

Nightly mirror of the Supabase project down to local hardware. Runs on the backup host as a
systemd timer.

> Machine names, addresses, and ports are deliberately absent from this file — it lives in a
> public repo. `<backup-host>` and `<optiplex-host>` are placeholders; fill in your own.

## The two legs

```
  leg 1   Supabase       ──▶  backup host    mirror.mjs — pull objects + pg_dump, verify, manifest
  leg 2   backup host    ──▶  OptiPlex       rsync over the tailnet, re-verified on arrival
```

Both legs report into `backup_runs` as **separate rows**, tagged `supabase->server` and
`server->optiplex`. That is the whole point of the table.

A single combined status hides the failure that actually bites: leg 1 succeeding every night
for months while leg 2 has been quietly failing the entire time. From the outside that looks
green. In reality it means the team has exactly one copy of everything, on one machine, and
nobody knows. Two rows make the second leg's silence visible.

Leg 2 is skipped, loudly, if `OPTIPLEX_HOST` is unset — the log says `single copy only!`.

## What you need on the backup server

| Requirement | Why |
|---|---|
| Node 18+ | `mirror.mjs` uses `Readable.fromWeb` and `base64url` |
| `pg_dump`, `psql`, `gzip` | database dump and the restore test |
| `rsync`, `ssh`, `curl` | leg 2 and the status reports |
| `sha256sum`, `du`, `find` | manifest verification, spot-checks, retention |

## Install

### 1. Scripts

Put the repo's `scripts/backup/` at `/opt/frc5805/scripts/backup/` — that exact path is
hard-coded in the systemd unit's `ExecStart`.

```bash
sudo mkdir -p /opt/frc5805
sudo git clone https://github.com/TomAs-1226/smblyrequired /opt/frc5805
```

`mirror.mjs` imports `@supabase/supabase-js`, so install it somewhere Node will resolve from
`/opt/frc5805/scripts/backup/` — the repo root works:

```bash
cd /opt/frc5805 && sudo npm install --omit=dev
```

Check the scripts are executable and have LF endings (`.gitattributes` enforces this, but a
CRLF shebang fails with a "bad interpreter" error that names a path which plainly exists):

```bash
sudo chmod +x /opt/frc5805/scripts/backup/*.sh
head -1 /opt/frc5805/scripts/backup/nightly.sh | cat -A | tail -c 20   # expect no ^M
```

### 2. The `backup` user

The unit runs as `User=backup`. **Give it a home outside `/home`** — the unit sets
`ProtectHome=true`, which makes `/home`, `/root`, and `/run/user` invisible to the service. If
the backup user's home is `/home/backup`, its `~/.ssh` key will not exist as far as the service
is concerned and leg 2 fails with `Permission denied (publickey)` while the key sits right
there when you check by hand.

```bash
sudo useradd --system --home-dir /var/lib/frc5805 --create-home --shell /bin/bash backup
sudo mkdir -p /srv/backup/frc5805
sudo chown -R backup:backup /srv/backup/frc5805 /var/lib/frc5805
```

### 3. `/etc/frc5805-backup.env`

```bash
sudo install -o backup -g backup -m 0600 /dev/null /etc/frc5805-backup.env
sudo -e /etc/frc5805-backup.env
```

Mode **0600**, owned by `backup`. It holds the service-role key. It is deliberately not in the
repo and not in the unit file — `systemctl show` prints `Environment=` values to any user who
can read the unit.

Every variable the three scripts read:

| Variable | Required | Default | Read by | What it is |
|---|---|---|---|---|
| `SUPABASE_URL` | **yes** | — | `mirror.mjs`, `nightly.sh`, `restore-test.sh` | `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | **yes** | — | all three | service-role key, classic JWT or `sb_secret_…`. Bypasses RLS — see the warning below |
| `SUPABASE_DB_URL` | strongly recommended | — | `mirror.mjs` | Postgres URI for `pg_dump`. **Unset means no database dump at all** — neither `db.sql.gz` nor `auth_users.sql.gz` |
| `BACKUP_ROOT` | no | `/srv/backup/frc5805` | all three | where snapshots are written |
| `OPTIPLEX_HOST` | leg 2 only | *(empty)* | `nightly.sh` | ssh target, e.g. `backup@<optiplex-host>`. Empty = leg 2 skipped |
| `OPTIPLEX_PATH` | no | `/srv/backup/frc5805` | `nightly.sh` | destination directory on the OptiPlex |
| `RETAIN_DAYS` | no | `30` | `nightly.sh` | local snapshot retention |
| `SCRATCH_DB` | no | `postgres://postgres@localhost/frc5805_restore_test` | `restore-test.sh` | throwaway database. **It gets dropped** |

One more, set in the environment rather than in the file: `BACKUP_ENV` overrides the path to
the config file itself (default `/etc/frc5805-backup.env`). Useful for testing against a second
config; not needed in normal operation.

A minimal working file:

```bash
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
SUPABASE_DB_URL=postgresql://postgres:<db-password>@<supabase-db-host>:5432/postgres
BACKUP_ROOT=/srv/backup/frc5805
OPTIPLEX_HOST=backup@<optiplex-host>
OPTIPLEX_PATH=/srv/backup/frc5805
RETAIN_DAYS=30
```

Fill in every `<placeholder>` from your own project and your own network. Nothing in this repo
records what they are, on purpose.

> **Without `SUPABASE_DB_URL` you do not have a restorable backup.** `mirror.mjs` warns and
> continues with objects only. Object bytes alone lose the entire knowledge base, every file
> title, tag, and checksum, and the whole roster — all of that lives in Postgres, not in
> Storage.

### 4. The service-role key

> ### The service-role key bypasses RLS entirely
>
> It is not "an admin account". It is a key that ignores every row-level security policy in the
> project — every row of every table, every object in every bucket, regardless of who owns it.
> That is exactly why the backup needs it, and exactly why it is dangerous.
>
> - It lives **only** in `/etc/frc5805-backup.env`, mode 0600, on the backup host.
> - It **never** gets a `VITE_` prefix. Vite inlines every `VITE_`-prefixed variable into the
>   public JavaScript bundle, which is then published to a public branch of a public repo.
> - It **never** goes in `.env`, `.env.local`, a knowledge-base doc, a commit, a screenshot, or
>   a chat message.
> - It **never** appears in a command line. `nightly.sh` and `restore-test.sh` write the `apikey`
>   and `Authorization` headers into a mode-600 temp file and pass `curl -H @"$file"`, removing
>   it on exit. As a `-H` argument it would be visible in `ps` to every local user on the box.
>   `mirror.mjs` does the equivalent for the database password: it parses `SUPABASE_DB_URL` into
>   `PG*` environment variables and spawns `pg_dump` with no shell, so neither the DSN nor the
>   password reaches `argv`.
> - If it is ever exposed, rotate it in the dashboard immediately and update this one file.
>   Treat exposure as a full compromise of the project's data — because it is.
>
> `mirror.mjs` validates the key before doing anything. That is there to catch pasting the
> **anon** key in by mistake: with the anon key the job would back up an empty set and
> cheerfully report success, which is worse than having no backup at all.
>
> Both key formats are accepted. A classic key is a JWT, so it is decoded and its `role` claim
> must be `service_role`. Newer projects issue opaque keys instead, which carry no claims to
> read, so those are checked by prefix: `sb_secret_…` passes, `sb_publishable_…` is rejected
> outright. Anything that is neither a three-segment JWT nor an `sb_secret_…` key is rejected
> as well.

### 5. Where to find the keys in the dashboard

| What | Where |
|---|---|
| Service-role key | Project Settings → **API** → *Project API keys* → `service_role` (revealed behind a click, marked secret) |
| Project URL | Project Settings → **API** → *Project URL* |
| Database connection string | Project Settings → **Database** → *Connection string* → **URI** |

For `SUPABASE_DB_URL`, take the **direct connection** (or session pooler) string, not the
transaction pooler — `pg_dump` needs session-level features the transaction pooler does not
provide. The password is the database password you set when the project was created; you can
reset it on that same page if you no longer have it.

### 6. SSH to the OptiPlex, for leg 2

Key-based only. No passwords — the job runs unattended at 03:15.

**Confirm the OptiPlex's hostname and destination path yourself.** They are not written down
anywhere in this repo and this document will not guess at them. Everything below uses
`<optiplex-host>` as a placeholder; substitute the real tailnet name.

```bash
# as the backup user
sudo -u backup ssh-keygen -t ed25519 -N '' -f /var/lib/frc5805/.ssh/id_ed25519

# install the public key on the OptiPlex (run from the backup server)
sudo -u backup ssh-copy-id -i /var/lib/frc5805/.ssh/id_ed25519.pub backup@<optiplex-host>

# connect once by hand — this both proves it works AND writes known_hosts
sudo -u backup ssh backup@<optiplex-host> 'mkdir -p /srv/backup/frc5805 && echo ok'
```

That last step is not optional. The unit runs with `ProtectSystem=strict`, so the service can
only write inside `ReadWritePaths` — it cannot create or append to `known_hosts` at 03:15. If
the host key has not already been accepted, leg 2 fails on an interactive prompt that nobody is
there to answer. Do the manual connection first.

### 7. systemd

```bash
sudo cp /opt/frc5805/scripts/backup/systemd/frc5805-backup.service /etc/systemd/system/
sudo cp /opt/frc5805/scripts/backup/systemd/frc5805-backup.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now frc5805-backup.timer
systemctl list-timers frc5805-backup.timer
```

The timer fires at **03:15** daily with up to 20 minutes of randomized delay, and
`Persistent=true` — so if the machine was off or asleep at 03:15 it runs on the next boot
rather than silently skipping the night. Enable the **timer**, not the service; the service is
`Type=oneshot` and is what the timer triggers.

If you change `BACKUP_ROOT` away from `/srv/backup/frc5805`, you must also change
`ReadWritePaths=` in the unit. `ProtectSystem=strict` makes everything else read-only, and the
job will fail on its first write with a permission error that looks like a filesystem problem.

## Verify it works

Run it by hand once, as the service user, before trusting the timer:

```bash
sudo -u backup env BACKUP_ENV=/etc/frc5805-backup.env \
  /opt/frc5805/scripts/backup/nightly.sh; echo "exit=$?"
```

Expect leg 1 to print a per-bucket object count, then `manifest ok`, then leg 2, then
`leg 2 verified`, then `done`.

Then check the unit itself:

```bash
sudo systemctl start frc5805-backup.service
systemctl status frc5805-backup.service
journalctl -u frc5805-backup.service -n 100 --no-pager
```

`Active: inactive (dead)` with `status=0/SUCCESS` is a clean run — `oneshot` units are not
supposed to stay active. Anything else shows as `failed` with the exit code.

### Exit codes

`mirror.mjs` (leg 1):

| Code | Meaning |
|---|---|
| `0` | ok — see the five conditions below, all of which must hold |
| `1` | failed — nothing usable was produced, or the `pg_dump` step raised |
| `2` | partial — something usable exists, but at least one condition was not met |

`ok` is a claim that the snapshot is both complete **and** verified, so it is withheld unless
every one of these is true:

- no object failed to download or mismatched its checksum,
- the `files` checksum table was readable,
- a database dump exists (`SUPABASE_DB_URL` was set and `pg_dump` succeeded),
- at least one object was copied,
- every copied object had a recorded checksum to compare against.

Deriving the status from download failures alone let several empty-but-successful outcomes
report green. Anything that would make a restore fail, or make the verification meaningless,
can withhold `ok` on its own. The run is `partial` when a usable artifact was still produced —
any object copied, or a dump written — and `failed` only when nothing usable came out.

The specific reason is written to `backup_runs.error` (multiple reasons are joined with `; `)
and surfaced on the portal's Overview tab next to the leg, so "why is this amber" is
answerable without reading the journal.

`nightly.sh` treats `2` as "keep going": a partial snapshot is still worth propagating, so leg 2
runs. Any other non-zero exit from leg 1 aborts before leg 2 and exits with that same code.

`nightly.sh` overall exits `0` on a clean run, `1` if leg 2 failed or the manifest did not
verify, and passes leg 1's code through when leg 1 aborted or when `OPTIPLEX_HOST` is unset. A
**partial leg 1 followed by a successful leg 2 exits `2`**, not `0` — returning `0` there would
make `systemctl status` report a clean run while objects were actually missing from the
snapshot, which is the exact class of silent failure these scripts exist to expose.

### Where snapshots land

```
/srv/backup/frc5805/
├── LATEST                          # one line: the newest stamp
├── 2026-07-19T03-17-04Z/
└── 2026-07-20T03-15-42Z/
    ├── objects/<bucket>/<path>     # every object from all five buckets
    ├── auth_users.sql.gz           # pg_dump --no-owner --no-acl --data-only --table=auth.users
    ├── db.sql.gz                   # pg_dump --no-owner --no-acl --clean --if-exists --schema=public
    ├── SHA256SUMS                  # one line per file, LF endings, sorted — BOTH dumps included
    └── MANIFEST.sha256             # sha256 of SHA256SUMS itself
```

Both dumps are gzipped at level 9 and both are listed in `SHA256SUMS`. Omitting
`auth_users.sql.gz` from the manifest would leave the half of the backup that makes the other
half restorable unverified, and silently absent from `sha256sum -c`.

Stamps are UTC and colon-free so the path stays valid on any filesystem the mirror is later
copied onto. `MANIFEST.sha256` is a single value that changes if any file in the set changed —
comparing two runs is one string comparison, which is what gets recorded in
`backup_runs.manifest_sha`.

Object checksums are compared against the `sha256` recorded by the browser at upload time, not
merely regenerated from the downloaded copy. A manifest built only from what was downloaded is
self-consistent by construction and would happily certify corrupted data.

### Why the database is two files

This split is not cosmetic. It was established by restoring the result against a real
PostgreSQL 17, and a single public-only dump does not work:

`public.profiles.id` is a foreign key onto `auth.users`. A public-only dump is therefore **not
restorable**. `pg_dump` adds constraints *after* loading data, and `ADD CONSTRAINT` performs a
validation scan that `session_replication_role = replica` does **not** suppress — so the
restore dies on `profiles_id_fkey`. A public-only dump also loses the email-to-profile mapping,
which is the only record of which actual person each roster row belongs to.

`auth.users` is dumped `--data-only` for its own reason: its full DDL carries the
`on_auth_user_created` trigger, which references a function in `public` that does not exist yet
at that point in a restore.

## The restore test

The portal shows every backup as **"Unverified"** until `restore-test.sh` has run against it.
Nothing else flips that badge — not a green run, not a matching manifest. A backup nobody has
restored is a hypothesis.

```bash
sudo -u backup /opt/frc5805/scripts/backup/restore-test.sh             # newest snapshot
sudo -u backup /opt/frc5805/scripts/backup/restore-test.sh 2026-07-20T03-15-42Z
```

What it proves, in five steps:

1. The manifest verifies — every file is byte-for-byte what was recorded.
2. Both dumps actually **restore** into a live Postgres database without erroring. It fails
   immediately if either `db.sql.gz` or `auth_users.sql.gz` is missing or empty, in the same
   order documented under *Restoring for real* below.
3. The restored database **contains rows** — it reports `files`, `knowledge_docs`, and
   `profiles` counts and fails outright if `profiles` is empty. A dump of an empty database
   restores perfectly; structural success is not evidence of a usable backup. Empty `files` or
   `knowledge_docs` only warn: a brand-new team legitimately has neither yet.
4. Up to 25 randomly chosen objects are checked against the `sha256` values read back out of
   the **restored database** — not out of the manifest. Step 1 only proves the snapshot agrees
   with itself; this proves the bytes still match what the uploader originally chose. It fails
   if the database lists files but the snapshot contains no objects, or if any referenced
   object is absent or mismatched.
5. It PATCHes `restore_tested_at` on `backup_runs` rows matching that `manifest_sha` **and**
   `leg=supabase->server`.

That leg filter matters. Filtering on `manifest_sha` alone also marked the `server->optiplex`
rows verified — copies this script never touched — and, because `manifest_sha` is stable while
nothing changes, every earlier night carrying the same manifest along with them.

If the PATCH fails the restore itself still passed, so the script warns rather than erroring —
but the portal will keep showing that backup as **Unverified**. The same applies when
`SUPABASE_URL` or the service-role key is unset.

> **It destroys `$SCRATCH_DB`.** The script runs `DROP DATABASE IF EXISTS` / `CREATE DATABASE`
> before restoring, and drops it again at the end. Point `SCRATCH_DB` at a throwaway database
> on a local Postgres instance. **Never point it at the production database or at anything you
> would miss.** The default is `postgres://postgres@localhost/frc5805_restore_test`.

### Schedule it monthly

Run it at least monthly. An untested backup slowly turns into a folder of files you hope are
useful. No unit ships for this one — create both:

```bash
sudo tee /etc/systemd/system/frc5805-restore-test.service >/dev/null <<'EOF'
[Unit]
Description=FRC 5805 monthly restore test
After=network-online.target

[Service]
Type=oneshot
User=backup
Group=backup
EnvironmentFile=/etc/frc5805-backup.env
ExecStart=/opt/frc5805/scripts/backup/restore-test.sh
TimeoutStartSec=2h
EOF

sudo tee /etc/systemd/system/frc5805-restore-test.timer >/dev/null <<'EOF'
[Unit]
Description=Run the FRC 5805 restore test monthly

[Timer]
OnCalendar=*-*-01 05:00:00
RandomizedDelaySec=30m
Persistent=true

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now frc5805-restore-test.timer
```

The restore test needs to write to Postgres and read `$BACKUP_ROOT`, so it is intentionally
not given the hardened sandbox the nightly unit has. If you add `ProtectSystem=strict` here,
add the socket and data paths `psql` needs.

## Restoring for real

1. **Pick a snapshot.**

   ```bash
   ls -1 /srv/backup/frc5805
   cat /srv/backup/frc5805/LATEST
   SNAP=/srv/backup/frc5805/$(cat /srv/backup/frc5805/LATEST)
   ```

2. **Verify it before you rely on it.**

   ```bash
   cd "$SNAP" && sha256sum -c SHA256SUMS
   sha256sum SHA256SUMS && cat MANIFEST.sha256    # these two must agree
   ```

   If this fails, try an older snapshot rather than restoring known-bad data.

3. **Restore the database, in this order.** The order below was established by running it
   against a real PostgreSQL 17, not by reasoning about it. Deviating from it fails.

   **3a. Stub `auth` and create the three API roles.** Skip this step only if the target is a
   real Supabase project, where both already exist. The roles are cluster-global, so on a box
   that has ever run this they are usually present already — but on a fresh cluster every
   `CREATE POLICY ... TO authenticated` in the dump fails without them.

   ```bash
   psql "<target-database-url>" -v ON_ERROR_STOP=1 <<'SQL'
   do $stub$
   begin
     if not exists (select 1 from pg_roles where rolname = 'anon') then
       create role anon nologin noinherit;
     end if;
     if not exists (select 1 from pg_roles where rolname = 'authenticated') then
       create role authenticated nologin noinherit;
     end if;
     if not exists (select 1 from pg_roles where rolname = 'service_role') then
       create role service_role nologin noinherit bypassrls;
     end if;
   end
   $stub$;

   create schema if not exists auth;
   create table if not exists auth.users (
     id uuid primary key,
     email text unique,
     raw_user_meta_data jsonb,
     created_at timestamptz default now()
   );
   create or replace function auth.uid() returns uuid language sql stable
     as $fn$ select null::uuid $fn$;
   grant usage on schema auth to anon, authenticated, service_role;
   SQL
   ```

   **3b. Load `auth.users` data first**, so the `profiles` foreign key has something to point
   at:

   ```bash
   gunzip -c "$SNAP/auth_users.sql.gz" | psql "<target-database-url>" -v ON_ERROR_STOP=1
   ```

   **3c. Load the public schema last.** It was taken with `--clean --if-exists --no-owner
   --no-acl --schema=public`, so it drops and recreates what it owns and does not care that
   role names differ in the target.

   ```bash
   gunzip -c "$SNAP/db.sql.gz" | psql "<target-database-url>" -v ON_ERROR_STOP=1
   ```

   Restore into a scratch database first and look at it before you point this at a live
   project — `restore-test.sh` does exactly this sequence and is the safe way to rehearse it.
   The dump covers `public` only; `storage.objects` rows are not in it, which is why step 4
   re-uploads the objects rather than restoring them.

4. **Re-upload the objects.** No upload script ships with the repo; the storage REST API does
   the job with the service-role key:

   ```bash
   cd "$SNAP/objects"
   for bucket in graphs code knowledge media public-media; do
     [ -d "$bucket" ] || continue
     find "$bucket" -type f | while read -r f; do
       rel="${f#"$bucket"/}"
       curl -fsS -X POST "$SUPABASE_URL/storage/v1/object/$bucket/$rel" \
         -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
         -H "x-upsert: true" \
         -H "Content-Type: application/octet-stream" \
         --data-binary @"$f" >/dev/null && echo "ok   $bucket/$rel" || echo "FAIL $bucket/$rel"
     done
   done
   ```

   The buckets have to exist first — re-run `0002_storage.sql` if you are restoring into a new
   project. Keep the paths exactly as they are on disk; the `files` rows you just restored
   reference them by `(bucket, path)`.

5. **Confirm.** Run `mirror.mjs` against the restored project. It re-derives every checksum and
   compares against the `sha256` values in `files`, so a clean run is proof the objects and the
   database agree.

## Retention

- **Local: 30 days**, via `RETAIN_DAYS`. At the end of each run `nightly.sh` deletes snapshot
  directories under `BACKUP_ROOT` older than that. Only directories whose name matches
  `20*-*-*T*Z` are eligible, so nothing else living under `BACKUP_ROOT` can be caught by the
  sweep. `LATEST` is a file, not a directory, so it is never touched either.
- **Retention is skipped entirely when leg 2 did not succeed.** On those nights the local
  snapshots are the only copies that exist, and pruning them is the one action guaranteed to
  turn a bad situation into an unrecoverable one. The log says so when it happens.
- **Snapshots are hard-linked.** Leg 2's `rsync` passes `--link-dest` pointing at the previous
  snapshot, so unchanged files cost an inode rather than a copy — thirty dated snapshots are
  roughly one full copy plus the deltas. `rsync` resolves `--link-dest` **on the receiving
  side**, so `nightly.sh` builds that path from `OPTIPLEX_PATH`, not from the local
  `BACKUP_ROOT`. Passing the local path would silently match nothing whenever the two differ —
  no error, no warning, just a full copy every night and a disk that fills up a month early.
- **Remote pruning is deliberately not automated.** The OptiPlex keeps its own copies and
  `nightly.sh` never deletes anything on the far side. Pruning both ends from one script means
  a single bad variable expansion can wipe both copies in the same second — which is precisely
  the event the second copy exists to survive. Prune the OptiPlex by hand, after checking what
  you are about to remove.

### The config is validated before anything reaches `rm -rf`

`BACKUP_ROOT` and `RETAIN_DAYS` both arrive from a sourced env file and both end up in the
retention sweep, so `nightly.sh` refuses to start until they are sane. It exits with `FATAL`
and touches nothing if:

| Check | Rejected |
|---|---|
| `BACKUP_ROOT` is a system directory | `/`, `/root`, `/home`, `/etc`, `/var`, `/usr`, `/srv`, `/tmp`, or empty |
| `BACKUP_ROOT` is not absolute | anything not starting with `/` |
| `BACKUP_ROOT` contains `..` | any path traversal |
| `BACKUP_ROOT` does not exist | a typo that would otherwise be created silently |
| `RETAIN_DAYS` is not a whole number | `7d`, `-1`, `1.5`, empty |
| `RETAIN_DAYS` is below `1` | `0` would prune tonight's own snapshot |

Note that `/srv` itself is rejected while the default `/srv/backup/frc5805` is fine — the guard
is against a truncated or half-substituted value, not against the directory tree.
