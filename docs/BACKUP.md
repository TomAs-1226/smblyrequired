# Backup — install and operation

Nightly mirror of the Firebase project down to local hardware. Runs on the backup host as a
systemd timer.

> Machine names, addresses, and ports are deliberately absent from this file — it lives in a
> public repo. `<backup-host>` and `<optiplex-host>` are placeholders; fill in your own.

## The two legs

```
  leg 1   Firebase       ──▶  backup host    mirror.mjs — documents, accounts, objects; verify; manifest
  leg 2   backup host    ──▶  OptiPlex       rsync over the tailnet, re-verified on arrival
```

Both legs report into `backup_runs` as **separate rows**, tagged `firebase->server` and
`server->optiplex`. That is the whole point of the collection.

A single combined status hides the failure that actually bites: leg 1 succeeding every night
for months while leg 2 has been quietly failing the entire time. From the outside that looks
green. In reality it means the team has exactly one copy of everything, on one machine, and
nobody knows. Two rows make the second leg's silence visible.

Leg 2 is skipped, loudly, if `OPTIPLEX_HOST` is unset — the log says `single copy only!`.

## What you need on the backup server

| Requirement | Why |
|---|---|
| Node 22+ | the Firebase Admin SDK the scripts are built on requires it |
| `rsync`, `ssh` | leg 2 |
| `sha256sum`, `du`, `find` | manifest verification, the leg 2 report, retention |
| `firebase-tools` and Java 21+ | the restore test only: it restores into the local emulators |

There is no `pg_dump`, `psql` or `curl` any more. Everything that talks to Firebase is Node.

## Install

### 1. Scripts

Put the repo at `/opt/frc5805` — the systemd units' `ExecStart` lines hard-code
`/opt/frc5805/scripts/backup/`.

```bash
sudo mkdir -p /opt/frc5805
sudo git clone https://github.com/TomAs-1226/smblyrequired /opt/frc5805
```

The backup has its own `package.json`, with one dependency (`firebase-admin`), so the host
never installs the website's:

```bash
cd /opt/frc5805/scripts/backup && sudo npm ci
```

Clone the whole repo rather than copying the directory: `repo-archive.mjs` imports the file-id
function from `src/lib/ids.js`, and the restore test reads `firebase.backup-test.json` and the
rules files from the repo root.

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

Mode **0600**, owned by `backup`. It says which project to back up and where the key file is.
It is deliberately not in the repo and not in the unit file — `systemctl show` prints
`Environment=` values to any user who can read the unit.

Every variable the scripts read:

| Variable | Required | Default | Read by | What it is |
|---|---|---|---|---|
| `GOOGLE_APPLICATION_CREDENTIALS` | **yes** | — | every `.mjs` | path of the service-account key file (step 4). The file is the secret, not this path |
| `FIREBASE_PROJECT_ID` | **yes** | — | every `.mjs` | the project id, e.g. `<project-id>` |
| `FIREBASE_STORAGE_BUCKET` | **yes** | — | every `.mjs` | the bucket name, without `gs://` |
| `BACKUP_ROOT` | no | `/srv/backup/frc5805` | `mirror.mjs`, both shell scripts | where snapshots are written |
| `OPTIPLEX_HOST` | leg 2 only | *(empty)* | `nightly.sh` | ssh target, e.g. `backup@<optiplex-host>`. Empty = leg 2 skipped |
| `OPTIPLEX_PATH` | no | `/srv/backup/frc5805` | `nightly.sh` | destination directory on the OptiPlex |
| `RETAIN_DAYS` | no | `30` | `nightly.sh` | local snapshot retention |
| `RESTORE_TEST_OBJECTS` | no | `25` | `restore-test.sh` | how many objects the restore test uploads into the emulator: a number, `all` or `none` |
| `GITHUB_TOKEN` | private repos only | — | `repo-archive.mjs` | lets the archiver read private repositories |
| `ARCHIVE_TMP` | no | the system temp dir | `repo-archive.mjs` | scratch directory for tarballs; the unit sets it |

One more, set in the environment rather than in the file: `BACKUP_ENV` overrides the path to
the config file itself (default `/etc/frc5805-backup.env`). Useful for testing against a second
config; not needed in normal operation.

A minimal working file:

```bash
GOOGLE_APPLICATION_CREDENTIALS=/etc/frc5805-backup-key.json
FIREBASE_PROJECT_ID=<project-id>
FIREBASE_STORAGE_BUCKET=<bucket-name>
BACKUP_ROOT=/srv/backup/frc5805
OPTIPLEX_HOST=backup@<optiplex-host>
OPTIPLEX_PATH=/srv/backup/frc5805
RETAIN_DAYS=30
```

Fill in every `<placeholder>` from your own project and your own network. Nothing in this repo
records what they are, on purpose.

The variables changed with the move to Firebase. `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`SUPABASE_DB_URL` and `SCRATCH_DB` are no longer read by anything; delete them from the file
rather than leaving a live key lying in it.

### 4. The service-account key

> ### The key bypasses the security rules entirely
>
> The backup talks to Firebase through the Admin SDK, signed in as a service account. The Admin
> SDK does not go through `firestore.rules` or `storage.rules` at all — every document, every
> object, every account, regardless of who owns it. That is exactly why the backup needs it,
> and exactly why it is dangerous.
>
> - It lives **only** in `/etc/frc5805-backup-key.json`, mode 0600, owned by `backup`, on the
>   backup host. `mirror.mjs` refuses to start if the file is readable by anyone else.
> - It **never** goes in the repo, in `/opt/frc5805`, in `.env`, `.env.local`, a knowledge-base
>   doc, a commit, a screenshot, or a chat message. Its contents never go in a `VITE_`
>   variable: Vite inlines every one of those into the public JavaScript bundle.
> - It **never** appears on a command line or in the shell's environment. The scripts are given
>   the *path*; only Node opens the file. `nightly.sh` and `restore-test.sh` used to handle the
>   Supabase key themselves to call the REST API with `curl`; they now call `report.mjs`
>   instead and never see a credential.
> - If it is ever exposed, delete that key in the Google Cloud console immediately (step below,
>   same page) and create a new one. Treat exposure as a full compromise of the project's
>   data — because it is.

**Create a service account for the backup, with the fewest roles that work.** Do not reuse the
`firebase-adminsdk` account Firebase creates for you: it can do far more than read.

In the Google Cloud console, with the Firebase project selected:

1. **IAM & Admin → Service Accounts → Create service account.** Name it something that says
   what it is for, like `portal-backup`.
2. **Grant it these roles** (the second step of the same dialog, or later under IAM & Admin →
   IAM):

   | Role | What the backup uses it for |
   |---|---|
   | **Cloud Datastore User** | read every Firestore document; write `backup_runs`, and the archiver's `files` / `code_archives` / `repo_sources` rows |
   | **Storage Object Viewer** | list and download every object |
   | **Firebase Authentication Viewer** | list the accounts |
   | **Storage Object Admin** *(instead of Viewer, and only if you run the repo archiver)* | the archiver uploads into `code/` and replaces an archive when a commit is re-archived |

   There is no narrower stock role than Cloud Datastore User that can both read everything and
   write the run log. Where the console lets you, grant the two Storage roles on the bucket
   rather than on the whole project.
3. **Open the new account → Keys → Add key → Create new key → JSON.** The browser downloads one
   file. That file is the key; there is no way to download it a second time.
4. Move it to the backup host and lock it down, then delete every other copy — the browser's
   download, anything in a sync folder:

   ```bash
   sudo install -o backup -g backup -m 0600 <downloaded-key>.json /etc/frc5805-backup-key.json
   ```

If "Create new key" is greyed out, the project belongs to an organization whose policy
disables service-account keys. An organization admin has to allow it for this project; there
is no way round it from here.

**Password hashes need one more permission.** The portal signs people in with an email and a
password, or with an emailed link. Listing accounts works with the Viewer role; whether the
list also carries each password's *hash* depends on a single permission,
`firebaseauth.configs.getHashConfig`. Leg 1 tells you which you have — it prints, every night:

```
auth: 41 accounts, 38 of 38 password hashes exported
```

If that reads `0 of 38`, the hashes are being withheld. Either create a custom role holding
just that permission and add it to the service account, or accept the consequence, which is
spelled out under *Accounts and passwords* below: a restore still brings every account back,
and every member sets a new password.

`mirror.mjs` checks the credential before doing anything. The Supabase version of this job had
one near-invisible way to fail — the anon key pasted where the service-role key belonged, which
backed up nothing and cheerfully reported success. Firebase has no key that quietly reads
nothing, but the same family of mistake is still on offer, so each form of it is refused by
name:

- the file is missing, unreadable, or not JSON;
- it is readable by other users;
- it is not a service-account key — the web app's config and a personal `gcloud` login are
  both JSON and both wrong;
- it is a key for a different project than `FIREBASE_PROJECT_ID`;
- **the project has no `profiles` at all.** A portal nobody has ever signed in to is the wrong
  project, the wrong database or an empty one, and backing it up would record a successful
  backup of nothing. This is checked before anything is written anywhere — not even a
  `backup_runs` row goes into a project that fails it.

### 5. Where to find the values

| What | Where |
|---|---|
| Project id | Firebase console → Project settings → **General** → *Project ID* |
| Bucket name | Firebase console → **Storage** → the `gs://…` address at the top of the Files tab, without the `gs://` |
| Service-account key | Google Cloud console → **IAM & Admin** → *Service Accounts* (step 4) |
| Password hash parameters | Firebase console → **Authentication** → *Users* → the ⋮ menu above the table → *Password hash parameters* |

**Copy the password hash parameters into the password manager now**, while the project exists.
They are four values — a signer key, a salt separator, rounds and a memory cost — and a
restore needs them to make the exported password hashes usable (see *Accounts and passwords*).
They are not in any snapshot: the signer key is a secret, and keeping it beside the hashes it
protects would defeat it. If the project is ever lost, they are lost with it.

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

The repo archiver has its own pair of units, `frc5805-archive.service` and `.timer`, installed
the same way; see *The repo archiver* below.

## Verify it works

Run it by hand once, as the service user, before trusting the timer:

```bash
sudo -u backup env BACKUP_ENV=/etc/frc5805-backup.env \
  /opt/frc5805/scripts/backup/nightly.sh; echo "exit=$?"
```

Expect leg 1 to print a document count per collection, the account count, an object count per
folder, then `manifest ok`, then leg 2, then `leg 2 verified`, then `done`.

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
| `0` | ok — see the conditions below, all of which must hold |
| `1` | failed — the credential or the project was refused, or the Firestore or Auth export raised. `LATEST` is not moved |
| `2` | partial — a usable snapshot exists, but at least one condition was not met |

`ok` is a claim that the snapshot is both complete **and** verified, so it is withheld unless
every one of these is true:

- no object failed to download, and none has a name that cannot be a file path,
- no object's bytes differ from the checksum recorded for it,
- at least one object was copied,
- every copied object has a `files` document, and that document records a checksum,
- every `files` document has its object in Storage.

The last two are the two directions of the same question. An object nothing points at was
uploaded and never indexed, or its document was deleted and the object left behind; a document
pointing at nothing is a file the portal lists and cannot open. Both are named, one line each,
in the journal and in `snapshot.json`.

Deriving the status from download failures alone let several empty-but-successful outcomes
report green. Anything that would make a restore fail, or make the verification meaningless,
can withhold `ok` on its own. The run is `partial` when the documents and accounts were
exported and something about the objects is not right, and `failed` only when nothing usable
came out.

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
    ├── firestore/<collection>.jsonl.gz   # one file per collection, one line per document
    ├── auth_users.jsonl.gz               # one line per account
    ├── objects/<folder>/<path>           # every object in the bucket, as stored
    ├── objects.jsonl.gz                  # one line per object: type, metadata, sha256, verdict
    ├── snapshot.json                     # counts, status, and every problem by name
    ├── SHA256SUMS                        # one line per file above, LF endings, sorted by path
    └── MANIFEST.sha256                   # sha256 of SHA256SUMS itself
```

A subcollection gets its own file, named for where it hangs:
`firestore/knowledge_docs__versions.jsonl.gz`, `firestore/picklists__entries.jsonl.gz`,
`firestore/vision_sessions__observations.jsonl.gz`. The file name is a convenience; every line
carries the document's full path.

Nothing in the walk is a list of collection names. Top-level collections are whatever the
database says exist, and every document read is asked what hangs off it, so a collection or
subcollection added next season is backed up without anyone editing the script. Each
subcollection name found is then read across the whole database, which also returns the ones
whose parent document is gone — the edit history of a deleted knowledge doc is still there, and
still backed up. The cost is about two reads per document per night.

Everything in the snapshot is in `SHA256SUMS`, including the exports and `snapshot.json`.
Leaving the exports out would leave the half of the backup that makes the other half usable
unverified, and silently absent from `sha256sum -c`.

Stamps are UTC and colon-free so the path stays valid on any filesystem the mirror is later
copied onto. `MANIFEST.sha256` is a single value that changes if any file in the set changed —
comparing two copies of a snapshot is one string comparison, which is what gets recorded in
`backup_runs.manifest_sha`.

Object checksums are compared against the `sha256` recorded by the browser at upload time, not
merely regenerated from the downloaded copy. A manifest built only from what was downloaded is
self-consistent by construction and would happily certify corrupted data. An object that does
*not* match is still kept and still listed in `SHA256SUMS` — it is the only copy of whatever is
in Storage — and is marked `"check":"mismatch"` in `objects.jsonl.gz`; the run goes partial.

### The encoding

Firestore has types JSON does not: timestamps, integers as distinct from doubles, bytes,
references, geopoints. A plain `JSON.stringify` of a document is a lossy copy — a timestamp
becomes a string nobody can tell from a string — and a restore from it is a different database
that merely resembles the old one. The security rules check `is timestamp` and `is int`; they
would refuse half of it.

So each line is `{"path": "<full document path>", "data": {…}}`, and inside `data` everything
JSON holds exactly is left alone, and everything else is an object with one `$` key:

| Firestore value | In the snapshot |
|---|---|
| null, boolean, string, array, map | as they are (map keys sorted) |
| integer | a JSON number without a fraction: `5805` |
| double with a fraction | a JSON number with one: `1.5` |
| double with no fraction, NaN, ±Infinity, −0 | `{"$double":"2"}`, `{"$double":"NaN"}` |
| integer beyond 2^53 | `{"$int":"9007199254740993"}` |
| timestamp | `{"$ts":"2026-03-07T03:02:00.123456000Z"}` — UTC, always nine digits |
| geopoint | `{"$geo":[latitude, longitude]}` |
| bytes | `{"$bytes":"<base64>"}` |
| reference | `{"$ref":"profiles/<uid>"}` — the path from the database root |
| vector | `{"$vector":[…]}` |
| a map with a key starting with `$` | `{"$map":{…}}`, so it cannot be read as one of the above |

A reference is stored relative to the database root, so a snapshot restored into a different
project points at that project's documents. Keys are sorted and there is no whitespace, so the
same document always encodes to the same bytes — which is what lets the restore test compare
what it restored line for line. The full statement is at the top of
`scripts/backup/encoding.mjs`; `npm test` in `scripts/backup` pins it value by value.

`gunzip -c firestore/profiles.jsonl.gz | head` reads a snapshot with nothing installed.

### What a snapshot is not

- **Not one instant.** The old `pg_dump` was a single transaction. This walk is not: a write
  that lands while it runs can be in one collection's file and not in another's. It runs at
  03:15 for that reason, and it takes seconds, but a slug index and its doc written at exactly
  the wrong moment can disagree in one night's snapshot.
- **Not the project.** Rules, indexes and functions are code in this repo. Function secrets are
  in Secret Manager. Sign-in settings are in the console. See *What is not in a snapshot*.
- **Not exhaustive past what can be discovered.** A subcollection is found when some living
  document has one of that name, or when its name is listed in `KNOWN_SUBCOLLECTIONS` in
  `lib.mjs` (`versions`, `entries`, `observations`). A new subcollection name whose every
  parent has been deleted would be missed. Add new names to that list when the data model
  grows one.

## The restore test

The portal shows every backup as **"Unverified"** until `restore-test.sh` has run against it.
Nothing else flips that badge — not a green run, not a matching manifest. A backup nobody has
restored is a hypothesis.

```bash
sudo -u backup /opt/frc5805/scripts/backup/restore-test.sh             # newest snapshot
sudo -u backup /opt/frc5805/scripts/backup/restore-test.sh 2026-07-20T03-15-42Z
```

It restores into the **Firebase emulators**, which it starts for the run and which are gone
when it ends. That takes `firebase-tools` and Java 21 or newer on the backup host:

```bash
sudo npm install -g firebase-tools
java -version
```

The first run downloads the emulators into the backup user's home, so it needs the network
once. The emulators listen on this machine only, on the three ports in
`firebase.backup-test.json` at the repo root. If `firebase` is not on the service's `PATH`,
set `FIREBASE_BIN` to its full path in the env file.

What it proves, in five steps:

1. The manifest verifies — every file is byte-for-byte what was recorded, `SHA256SUMS` hashes
   to `MANIFEST.sha256`, and the file has not been rewritten with CRLF endings on the way.
2. The target is empty: the emulators are wiped, so nothing left over can pass for restored.
3. The snapshot **restores**: accounts first, then every document, then objects. It fails
   immediately if `snapshot.json`, the accounts or the object list is missing, or if the
   snapshot holds no profiles.
4. Everything is **read back out of the target and compared**. The number of documents in each
   collection must equal the snapshot's; every document is re-encoded and must equal its line
   in the snapshot, byte for byte; every account must match; every object that was uploaded
   must come back with the same bytes, content type and metadata. It fails outright if
   `profiles` is empty — an empty database restores perfectly, and structural success is not
   evidence of a usable backup. Empty `files` or `knowledge_docs` only warn: a brand-new team
   legitimately has neither yet.
5. Every object's bytes are checked against the `sha256` read back out of the **restored
   `files` collection** — not out of the manifest. Step 1 only proves the snapshot agrees with
   itself; this proves the bytes still match what the uploader originally chose. It fails if
   any object the index names is absent from the backup, or does not match.

Then it stamps `restore_tested_at`, through `report.mjs`, on the `backup_runs` row with that
`manifest_sha` **and** `leg = firebase->server`. `report.mjs` exits `3` when no row matched, and
the script then says so instead of "marked verified": a write that matches nothing is not an
error to Firestore, and used to be logged as success for a stamp that changed nothing.

That leg filter matters. Filtering on `manifest_sha` alone would also mark the
`server->optiplex` rows verified — copies this script never touched.

If the stamp cannot be written the restore itself still passed, so the script warns rather than
erroring — but the portal will keep showing that backup as **Unverified**. The same applies
when `FIREBASE_PROJECT_ID` or the key path is unset.

Step 5 covers every object, from the bytes already on disk. Step 3 uploads only
`RESTORE_TEST_OBJECTS` of them (25, chosen at random) into the emulator, enough to prove the
upload path and the metadata without copying a season of video into a scratch directory. Set
it to `all` for the full rehearsal if the disk has room for a second copy.

A `partial` snapshot whose problem is a checksum mismatch or a missing object **cannot pass**,
on purpose: step 5 finds the same disagreement leg 1 did. One whose only problem is objects
with no `files` document, or documents with no recorded checksum, can.

> **The live project is never the target.** `restore-test.sh` takes the key path out of the
> environment and swaps the project id for `demo-frc5805-restore` before it starts the
> emulators; `restore.mjs --target=emulator` refuses to run unless all three emulator
> variables are set and the project id starts with `demo-`, the prefix Firebase guarantees can
> never reach a real project. The live project is contacted once, afterwards, to write one
> timestamp.

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

The restore test starts a Java process, keeps the emulators' downloads in the backup user's
home and works in a temporary directory, so it is intentionally not given the hardened sandbox
the nightly unit has. If you add `ProtectSystem=strict` here, add those paths.

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
   cat snapshot.json                              # status, counts, and anything it was missing
   ```

   If this fails, try an older snapshot rather than restoring known-bad data.

3. **Prepare the project you are restoring into.** For a new project, in the Firebase console:
   create it; create the Firestore database in **production mode**, in the same region as
   before; turn on Storage; under Authentication → Sign-in method, enable **Email/Password**
   and **Email link**. Do not pick "test mode" for Firestore or Storage: it leaves the database
   open to the internet for thirty days, and the next step is about to fill it with the roster.

   **Leave the functions undeployed until the data is in.** Their triggers fire on every
   document written: restoring scouting entries with `onScoutEntryWritten` live recomputes
   aggregates the snapshot already contains, once per entry. When you are restoring over the
   existing project instead, they are already deployed and that is what will happen — the end
   state is the same, apart from `updated_at` on the aggregates, and any knowledge doc that
   differs from the snapshot gains a history row for the version being replaced.

4. **Make a key that can write to it.** The nightly key cannot: it is read-only where it can
   be. Create a service account in the target project as in *Install → 4*, with **Cloud
   Datastore User**, **Storage Object Admin** and **Firebase Authentication Admin**, and delete
   the key again when the restore is done.

   Put the target and, if you have them, the password hash parameters in a file — not on the
   command line, where `ps` shows them to every user on the box:

   ```bash
   sudo install -o backup -g backup -m 0600 /dev/null /etc/frc5805-restore.env
   sudo -e /etc/frc5805-restore.env
   ```

   ```bash
   GOOGLE_APPLICATION_CREDENTIALS=/etc/frc5805-restore-key.json
   FIREBASE_PROJECT_ID=<target-project-id>
   FIREBASE_STORAGE_BUCKET=<target-bucket-name>
   # From the password manager: the ORIGINAL project's password hash parameters.
   AUTH_HASH_KEY=<base64_signer_key>
   AUTH_HASH_SALT_SEPARATOR=<base64_salt_separator>
   AUTH_HASH_ROUNDS=<rounds>
   AUTH_HASH_MEMORY_COST=<mem_cost>
   ```

5. **Restore.** Accounts, then documents, then objects, then everything read back and compared.

   ```bash
   sudo -u backup bash -c 'set -a; . /etc/frc5805-restore.env; set +a
     node /opt/frc5805/scripts/backup/restore.mjs "$0" --target=live --confirm="$FIREBASE_PROJECT_ID"' "$SNAP"
   ```

   `--confirm` has to repeat the project id, and the script refuses a project that already has
   any document, account or object in it unless you add `--allow-non-empty`. Restoring over
   existing data overwrites what has the same name and leaves everything else, so the result is
   a mixture; that flag is how you say you mean it. It never deletes anything.

   It exits `0` when the target is identical to the snapshot, `2` when everything was written
   but something differs — it lists what — and `1` when it could not finish. Running it again is
   safe: every write is the same document or object under the same name.
   `--verify-only` repeats the comparison without writing.

6. **Deploy what is not data** (below), from a checkout of this repo:

   ```bash
   firebase deploy --only firestore,storage,functions --project <target-project-id>
   firebase functions:secrets:set TBA_KEY          # and NEXUS_KEY, OPENAI_API_KEY
   npm run test:rules
   ```

   For a new project, rebuild and redeploy the site with that project's `VITE_FIREBASE_*`
   values, and add the site's domain under Authentication → Settings → Authorized domains.

7. **Confirm.** Point `/etc/frc5805-backup.env` at the restored project and run `mirror.mjs`.
   It re-derives every checksum and compares against the `sha256` values in `files`, so a clean
   run is proof the objects and the database agree.

### Accounts and passwords

What a restore brings back, for every account: the **same uid** — so `profiles/{uid}` and every
`scout_id`, `uploaded_by` and `created_by` in the data still point at the right person — the
email address and whether it was verified, the display name, whether the account was disabled,
custom claims, linked sign-in providers, and when it was created.

What it brings back only if two things are true: **the password.** The snapshot must contain
the hashes (leg 1 prints how many it exported; see *Install → 4*), and the restore must be
given the original project's password hash parameters (`AUTH_HASH_*` above). With both, people
sign in with the password they had. Missing either, the accounts still come back and
`restore.mjs` says how many came back without a password; those members use "email me a
sign-in link" or the password reset, both of which the sign-in page already offers.

What it cannot bring back: sessions (everyone signs in again), a second factor if anyone had
enrolled one, and the project's own sign-in settings.

### What is not in a snapshot

A snapshot is the project's **data**. Everything else is somewhere else, and a restore that
stops at the data leaves a project that looks complete and is not:

| Not in the snapshot | Where it is | Put back with |
|---|---|---|
| Security rules and indexes | `firebase/` in this repo | `firebase deploy --only firestore,storage` |
| Cloud Functions | `functions/` in this repo | `firebase deploy --only functions` |
| Function secrets (`TBA_KEY`, `NEXUS_KEY`, `OPENAI_API_KEY`) | Secret Manager; the values are in the password manager | `firebase functions:secrets:set NAME` |
| Sign-in methods, authorized domains, email templates | the Firebase console | by hand |
| Password hash parameters | the password manager (*Install → 5*) | passed to `restore.mjs` as `AUTH_HASH_*` |
| The web app config | `VITE_FIREBASE_*` at build time | rebuild the site |
| Each document's server-side create and update times | nowhere | not restorable; `created_at` / `updated_at` are fields, and come back exactly |

### What replaced the two SQL files

`restore-stub.sql` and `post-restore.sql` are gone, and so is what they were for.

`restore-stub.sql` existed because a Supabase dump would not load into a plain PostgreSQL
without a stand-in for the `auth` schema and three roles. The rehearsal target is now the
Firebase emulators, which are the real services run locally. There is nothing to stub.

`post-restore.sql` put back two things a `public`-only, `--no-acl` dump silently dropped: the
trigger that gave each new signup a profile row, and the grant that kept `profiles.role` out
of reach. Neither exists as database state any more. A member's profile is created by the
portal at first sign-in and the rules allow it to say only `pending`; `role` is written only
by the `setMemberRole` function. Both live in `firebase/firestore.rules` and `functions/`, in
this repo, and neither is — or could be — in a snapshot.

The failure they guarded against has a new shape, and it is worse. Then: a restored project
that quietly stopped onboarding. Now: a restored project whose **rules were never deployed**.
A database created in test mode with the roster restored into it is readable by anyone until
someone notices. That is why step 3 says production mode, why step 6 is not optional, and why
it ends with `npm run test:rules`.

The other thing the old order protected was a foreign key: `profiles` could not load before
`auth.users`. Firestore has no foreign keys, so nothing fails to load in the wrong order — but
accounts still go first, so there is never a moment where a profile exists and its account
does not, and they keep their uids, so nothing has to be re-linked.

## The repo archiver

`repo-archive.mjs` is a separate nightly job on the same host: for each enabled row in
`repo_sources` it fetches the repository as a tarball, stores it at
`code/<year>/<label>-<commit>.tar.gz` in the bucket, indexes it in `files`, and records it in
`code_archives`. It runs at **01:30**, before the backup, so the same night's snapshot includes
what it just archived.

```bash
sudo cp /opt/frc5805/scripts/backup/systemd/frc5805-archive.service /etc/systemd/system/
sudo cp /opt/frc5805/scripts/backup/systemd/frc5805-archive.timer   /etc/systemd/system/
sudo mkdir -p /var/tmp/frc5805 && sudo chown backup:backup /var/tmp/frc5805
sudo systemctl daemon-reload
sudo systemctl enable --now frc5805-archive.timer
```

It reads the same env file and the same key, which then needs **Storage Object Admin** rather
than Viewer (*Install → 4*). `GITHUB_TOKEN` goes in the env file if any repo is private.

```bash
node repo-archive.mjs                 # everything that is due
node repo-archive.mjs --force         # everything enabled, changed or not
node repo-archive.mjs --repo=<name>   # one source: its repo, owner/repo, or label
```

A repository that has not moved since the last run is skipped. That now holds for a plain
`url` source too: it is identified by the hash of what it serves, where it used to be named by
the clock and stored again every interval. And an archive is one object, one `files` document
and one `code_archives` row per repository and commit, however many times it is re-run —
`--force` used to add a duplicate row each time. Exit codes: `0` done, `1` fatal, `2` some
sources failed (each failure is written to that source's `last_error`).

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

## Testing the scripts themselves

Nothing here needs a Firebase project, a key or the backup host. From a checkout with the
site's dependencies installed (`npm install` at the root, for `firebase-tools`) and the
backup's (`npm ci` in `scripts/backup`):

```bash
cd scripts/backup && npm test              # the encoding, value by value; no emulator
cd scripts/backup && npm run test:emulators
```

The second starts the Auth, Firestore and Storage emulators and runs two suites against them.
`test/roundtrip.test.mjs` seeds a small portal — accounts, profiles, scouting entries, a
knowledge doc with history, a pick list, objects, and one of each way the file index and the
bucket can disagree — mirrors it, checks the snapshot file by file, empties the emulators,
restores, and compares every document, account and object with what was there before, read
through the REST API rather than through the scripts' own encoding. `test/repo-archive.test.mjs`
runs the archiver against a stand-in for GitHub served from the test itself.
