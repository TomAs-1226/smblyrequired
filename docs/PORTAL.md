# Team portal — setup and operations

The portal is a private team area at `#/portal` on the same site. It is for roster, files,
graphify output, code archives, the team knowledge base, and scouting.

The public site is unchanged. Every marketing page still renders with no session, no
network call to Firebase, and no auth code downloaded — `App.jsx` lazy-loads the portal
chunk, so a sponsor reading the front page never fetches the Firebase client at all. If the
portal is not configured, it says so and the rest of the site keeps working.

The data model and the contract between the rules, the functions and the client are in
`docs/FIREBASE.md`. This page is how to set it up, run it, and operate it.

## Architecture

```
  Browser
    │
    ├── HTTPS ─▶  GitHub Pages          static bundle (dist/ on gh-pages)
    │                                   no server was added — this is still the host
    │
    └── HTTPS ─▶  Firebase              Auth · Firestore · Cloud Storage · Cloud Functions
                     │                  firestore.rules and storage.rules are the
                     │                  security boundary; functions do what a browser must not
                     │
                     │  the backup host pulls from Firebase, nothing is pushed to it
                     ▼                  (see docs/BACKUP.md for both legs)
                  backup host
```

Machine names and addresses are placeholders throughout these docs — this repo is public.

Nothing inbound is exposed. The backup host pulls from Firebase; the site never talks to it,
and Firebase never talks to it. Hosting, DNS, and the deploy flow are exactly as described in
`DEPLOY.md` — none of that changed. How the backup works, and how to restore, is
`docs/BACKUP.md`.

The browser reads and writes Firestore and Storage directly. There is no server in between
checking each request, so the rules are the only thing standing between a signed-in user and
the data. Cloud Functions exist for the few things a browser must not do: change a role,
hold an API key (The Blue Alliance, frc.nexus, OpenAI), and keep aggregates.

## One-time Firebase setup

Do this once, in the Firebase console unless a step says otherwise.

1. **Create a Firebase project.** Turn Google Analytics off; nothing here uses it.

2. **Upgrade to the Blaze (pay-as-you-go) plan, and set a budget alert.** Cloud Storage and
   Cloud Functions need it. A team this size is expected to stay within the free quotas, so
   the alert is there to tell you if that stops being true, not because a bill is expected.

3. **Authentication.** Enable **Email/Password**, and within it **Email link
   (passwordless sign-in)**. Then, under **Settings → Authorized domains**, add the site's
   domain (`frc5805.com`); `localhost` is there by default.

   Optional hardening: upgrade Authentication to **Identity Platform** and untick **Enable
   create (sign-up)**, so accounts exist only when a lead adds them in the console. Without
   it, anyone can request a sign-in link and get an account. That is not a breach — a new
   account is `pending` and can read nothing until an admin approves it (see *A new account
   is `pending` and sees nothing* below) — but it does let strangers fill the user list.

4. **Firestore Database → Create database**, in **production mode**. Choose the location
   `nam5` or `us-west1`. **It cannot be changed later**, and the functions run in `us-west1`.

5. **Storage → Get started**, in **production mode**.

6. **Register the web app.** Project settings → Your apps → add a **Web** app, and copy its
   config into `.env.local` as the five `VITE_FIREBASE_*` values (see `.env.example`). They
   are public identifiers, not secrets.

7. **Connect the CLI.**

   ```bash
   npx firebase login
   npx firebase use --add      # pick the project; this records its id in .firebaserc
   ```

   The project id is an identifier, not a secret. The tests always pass
   `--project demo-frc5805` explicitly, so they never touch the real project.

8. **Install the functions' dependencies and set their three secrets.**

   ```bash
   npm --prefix functions ci
   npx firebase functions:secrets:set TBA_KEY
   npx firebase functions:secrets:set NEXUS_KEY
   npx firebase functions:secrets:set OPENAI_API_KEY
   ```

   Each prompts for the value; nothing is written to the repo. Also set a hard monthly spend
   limit in the OpenAI dashboard — the AI function is rate-limited per member, but the limit
   on the OpenAI side is the one that cannot be bypassed.

9. **Deploy the backend.**

   ```bash
   npm run deploy:backend      # Firestore rules and indexes, Storage rules, functions
   ```

   The first deploy asks to enable several Google Cloud APIs, and to let the Storage rules
   read Firestore (they look up your role there). Answer yes to both. A first deploy of the
   Firestore triggers can fail once while those permissions propagate; run it again. It
   prompts once for `OPENAI_MODEL` and `OPENAI_MODEL_REASONING`; press Enter to accept the
   defaults.

10. **Storage CORS, once**, so the browser can download files:

    ```bash
    gcloud storage buckets update gs://<bucket> --cors-file=firebase/cors.json
    ```

    `<bucket>` is the value of `VITE_FIREBASE_STORAGE_BUCKET` from step 6. If `gcloud` is not
    installed locally, Cloud Shell in the console works. `firebase/cors.json` allows `GET` and
    `HEAD` from the site's origins; add an origin there if the site is ever served from a new
    one.

11. **Make the first admin.** Sign in to the portal once — that creates your `pending`
    profile. Then, in the console, **Firestore Database → `profiles` →** your document, and
    set `role` to `admin`. There is no admin until you do this, and the rules do not let any
    client write `role`, so the console is the only way in. From then on, roles are changed in
    the portal's **Admin** tab.

12. **Publish the site** so the config is baked in:

    ```bash
    npm run deploy
    ```

## Running it locally with the emulators

The emulators run Auth, Firestore, Storage and Functions on your machine, with the real
rules and the real functions. They need no credentials and never touch the real project.

```bash
npm run emulators           # terminal 1 — needs Java 21 or newer
npm run seed:emulators      # terminal 2, once the emulators are up
npm run dev:emulators       # terminal 3 — the site, at http://localhost:5174
```

The seed script creates one account per role. Its address list and the shared password are in
`scripts/firebase/seed-emulators.mjs`; they exist only inside the emulator and vanish when it
stops.

`npm run dev` on its own, with real `VITE_FIREBASE_*` values in `.env.local`, talks to the real
project instead. Do not test destructive things there.

## Testing

```bash
npm test                    # everything below, in order
```

| Script | What it runs |
|---|---|
| `npm run test:markdown` | The knowledge-base renderer: 21 attack cases and 12 feature cases. No network |
| `npm run test:portal` | Node-only suites: offline queue, upload types, CSV export, analytics maths. No network |
| `npm run test:rules` | `firebase/test/rules.test.mjs` — 52 tests of the Firestore and Storage rules, against the emulator |
| `npm run test:functions` | `functions/test/` — 53 tests of the Cloud Functions, against the emulator |

The two emulator suites need **Java 21 or newer** on `PATH` (the emulators are Java programs)
and no credentials. They run under the placeholder project `demo-frc5805`, and
`test:functions` uses its own ports so it can run while `npm run emulators` is up.

**Run `npm run test:rules` after touching `firebase/firestore.rules` or
`firebase/storage.rules`.** The rules are the access boundary, so these tests are the actual
proof that the *Roles* section below is true — that a member cannot escalate, that a signed-out
visitor reads nothing, that a second pit pass in a day is refused, that a locked pick list
cannot be edited, that a member cannot overwrite another member's file. Reading the rules is
not the same as testing them. `test:functions` is the same for the role-change guards, the
statistics and the cascades.

## Environment variables

Five variables, all public, all required for the portal to do anything:

| Variable | Where it comes from |
|---|---|
| `VITE_FIREBASE_API_KEY` | Project settings → Your apps → the web app's config |
| `VITE_FIREBASE_AUTH_DOMAIN` | the same |
| `VITE_FIREBASE_PROJECT_ID` | the same |
| `VITE_FIREBASE_STORAGE_BUCKET` | the same |
| `VITE_FIREBASE_APP_ID` | the same |

Optional: `VITE_FIREBASE_FUNCTIONS_REGION`, which defaults to `us-west1` and must match
`REGION` in `functions/src/config.js`. `TBA_KEY` in `.env.local` is only for
`scripts/fetch-tba.mjs` at build time; the portal's own Blue Alliance calls use the
function's secret.

These belong in the browser. They identify the project; what a signed-in user can actually
read or write is decided by the rules, not by hiding the values. A **service-account key** is
the opposite: it bypasses the rules entirely, so it never goes in any of these files, never
carries a `VITE_` prefix, and lives only on the backup host. See `docs/BACKUP.md`.

**Local dev:**

```bash
cp .env.example .env.local
# fill in the five VITE_ values
npm run dev
```

`.env.local` is gitignored — `.gitignore` excludes every `.env*` variant except `.env.example`
and `.env.emulators` (which holds no secrets), because Vite also reads `.env.production` and
friends and any of them can hold a live key.

**For the deployed site:** Vite inlines every `VITE_`-prefixed variable into the bundle at
**build** time. They are not read at runtime. If they are absent when `vite build` runs, the
deployed portal renders its "not set up yet" state no matter what you configure afterwards.

`npm run deploy` builds *locally* and pushes `dist/` to `gh-pages` — there is no GitHub
Actions workflow in this repo. So the build environment is whichever machine runs the deploy,
and `.env.local` on that machine is what gets inlined. Anyone who deploys needs those values.

The Cloud Functions have their own configuration, separate from all of the above: the three
secrets from step 8 (`TBA_KEY`, `NEXUS_KEY`, `OPENAI_API_KEY`), the `OPENAI_MODEL` and
`OPENAI_MODEL_REASONING` parameters, and the AI rate limit (`AI_RATE_MAX`,
`AI_RATE_WINDOW_SECONDS`, defaults in `functions/src/config.js`).

## Roles

Six roles, stored as `profiles/{uid}.role`. **Order is privilege order**: `pending < viewer <
member < lead < mentor < admin`. The same order appears in the rules (`rank`), in
`functions/src/roles.js` and in `src/lib/auth.jsx`; keep them in step. A signed-in user with no
profile document is treated as `pending`.

| Role | Who it is for | What it can do |
|---|---|---|
| `pending` | Anyone who just signed in for the first time | Nothing. Reads its own `profiles` document and no other data at all. |
| `viewer` | Alumni, parents | Read the roster, the `media` and `public-media` files and their records. |
| `member` | Current students on the team | Everything `viewer` has, plus all other files, the knowledge base and its history, scouting data, and backup health. Records their own scouting, photos, vision sessions and notes; uploads; writes knowledge docs. Can edit, replace, and delete **their own** uploads. |
| `lead` | Subteam leads | Everything `member` has, plus delete or replace **anyone's** files, delete knowledge docs, author scouting forms, set the scouting window and active event, manage pick lists, publish to `public-media`, and read the audit log. |
| `mentor` | Adult mentors | Identical to `lead`. It sits above `lead` in the order and no rule names it specifically, so every `atLeast('lead')` check passes. The distinction is descriptive, not functional. |
| `admin` | Keep this set very small | Everything, plus the only role that can change roles, edit other members' profiles, and manage repository sources. |

Capability by role, read off `firebase/firestore.rules` and `firebase/storage.rules`:

| Action | Floor |
|---|---|
| Read own profile | any signed-in user, including `pending` |
| See the roster | `viewer` |
| Read `media` / `public-media` files and their records | `viewer` |
| Read `graphs` / `code` / `knowledge` files and their records | `member` |
| Read knowledge docs and version history | `member` |
| Read scouting data, pick lists, team statistics, backup health | `member` |
| Upload to `graphs` / `code` / `knowledge` / `media` | `member` |
| Replace or delete **your own** upload | `member` |
| Create or edit a knowledge doc | `member` |
| Create graph / code-archive records | `member` |
| Record your own scouting entries, photos, vision sessions, collaboration notes | `member` |
| Record scouting on behalf of someone else | `lead` |
| Replace or delete **anyone's** file | `lead` |
| Pin a knowledge doc; delete a knowledge doc | `lead` |
| Author scouting forms; set the active event and scouting window; edit pick lists | `lead` |
| Delete scouting entries | `lead` |
| Upload, replace, or delete in `public-media` | `lead` |
| Read the audit log | `lead` |
| Change someone's role; edit another member's profile; manage `repo_sources` | `admin` |

Portal tabs mirror these floors: Overview and Files at `viewer`; Scout, Coverage, Compare,
Analytics, Team detail, Pick list, Vision, Graphs, Code and Knowledge at `member`; Forms,
Event control and Team at `lead`; Admin at `admin`. That gate is convenience only — it just
avoids showing people doors that will not open. **The rules are the actual boundary**, and they
apply the same whether the request comes from the portal, `curl`, or anything else holding the
public web config.

### A new account is `pending` and sees nothing

At first sign-in the portal creates the user's own `profiles` document, and the rules accept
it only if it says `pending`. A `pending` user gets the "you're signed in — but not on the
roster yet" screen. That is the expected state, not an error. The portal listens to the
profile live, so when an admin approves the account the screen changes without a reload.

`role` is deliberately not client-writable. The rules refuse any write that touches it, from
anyone, including an admin; the only code path that changes a role is the `setMemberRole`
Cloud Function, which runs with the Admin SDK and checks the caller's role in `profiles` (not a
token claim). So "a user can edit their own profile" can never become "a user can make
themselves admin".

The guards in `setMemberRole` (admin only) that you will meet:

- You cannot change your own role, even as an admin.
- The last remaining admin cannot be demoted.
- Every change is written to `audit_log` (`role.change`).

`deleteMember` is the matching function for removing someone: it deletes their profile and
their sign-in, is admin only, refuses yourself and the last admin, and writes `member.delete`
to the audit log. Profiles cannot be deleted from a client at all.

## Storage folders

One Cloud Storage bucket; the five "buckets" of the data model are its top-level folders.
Size and type limits are enforced server-side in `firebase/storage.rules` — a limit that only
exists in the upload form is not a limit. Every upload carries `customMetadata.owner` set to
the uploader's uid; the rules use it to let a member replace or delete only their own files.

| Folder | Visibility | Size limit | Allowed types | What goes in it |
|---|---|---|---|---|
| `graphs/` | private (`member`) | 100 MB | `application/json`, `text/html`, `image/svg+xml`, `application/gzip`, `application/x-tar`, `application/zip` | graphify output — JSON payloads and rendered HTML |
| `code/` | private (`member`) | 500 MB | `application/zip`, `application/gzip`, `application/x-tar`, `application/octet-stream`, `text/plain`, `application/json` | season code snapshots, CAD exports, build artifacts. CAD is what drives the ceiling |
| `knowledge/` | private (`member`) | 50 MB | `application/pdf`, `image/png`, `image/jpeg`, `image/webp`, `text/markdown`, `text/plain` | attachments for knowledge-base docs. The doc bodies live in Firestore, not here |
| `media/` | private (`viewer`) | 500 MB | `image/png`, `image/jpeg`, `image/webp`, `image/avif`, `video/mp4`, `video/quicktime`, `application/pdf`, `text/markdown` | internal team media — outreach records, meeting notes, award submissions, unreleased photos |
| `public-media/` | **PUBLIC** | 25 MB | `image/png`, `image/jpeg`, `image/webp`, `image/avif`, `image/svg+xml` | sponsor logos and cleared photography only |

The rules check the allowed types against the Content-Type the browser sends, and browsers take
that from the operating system. Windows sends `.zip` as `application/x-zip-compressed`, and
`.md`, `.7z` and `.step` often arrive with no type at all. So the portal normalises the type
per folder before uploading (`src/lib/uploadTypes.js`): `code` accepts anything, sent as
`application/octet-stream`, and every other folder refuses an unsupported type up front with a
readable message rather than a bare denial from the server.

A file is two things: the object in Storage, and a document in the `files` collection that
indexes it. The upload writes the object first, then the document, and removes the object if
the document fails. Deleting the document makes a Cloud Function remove the object and clear
every reference to it.

Files have **no expiring link**. `signedUrl` in `src/lib/portalApi.js` returns a Firebase
download URL, which carries its own token and does not expire; anyone who is given that URL can
fetch the file until the token is revoked in the console. Do not paste one into a group chat.
Team photos use a different path (`blobUrl`): the portal fetches the bytes with the signed-in
user's own credentials and shows them from an object URL, so nothing shareable is created.

> **`public-media/` is world-readable, permanently.**
> There is no session check. Anything you put there can be fetched by anyone who guesses or is
> given the path, and should be assumed to be indexed and cached by third parties within days.
> Deleting the object later does not un-publish what has already been copied.
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
- API tokens, service-account keys, or database passwords
- Router, firewall, or VPN configuration

None of it belongs in a public repo, and the portal's contents get mirrored to more machines
nightly. Reference secrets by name — "the backup env file on the backup server" — and keep the
values in a password manager.

`knowledge_docs` has a guard in the Firestore rules (`looksSecret` in `firebase/firestore.rules`)
that refuses a write whose body matches a known pattern: private and CGNAT/tailnet IPv4 ranges,
`-----BEGIN ... PRIVATE KEY-----` blocks, GitHub tokens, `sk-` / `sk_live_` API keys, AWS access
key ids, and assignments to `service_role`. Because it is in the rules it applies to the portal,
a script, and anything else that ever writes there. `src/lib/secretPatterns.js` holds the same
six patterns so the portal can say which one matched; the rules can only say "denied", and
`firebase/test/rules.test.mjs` runs the same payloads through both.

**It is a backstop for the obvious accident, not a guarantee.** It only catches patterns it
already knows. It will not catch a public IP, a password, an unusual token format, a secret
split across two lines, or a hostname. A write that passes the guard is not evidence that the
document is safe to publish — it only means the guard had nothing to match. Read what you are
about to save.

## What changed from the Supabase version

The portal used to run on Supabase (Postgres, Storage, Auth). Everything a reader of the old
page might look for, and where it went:

- **Uniqueness is by deterministic document id.** Where Postgres had unique indexes, the
  document id is now derived from the fields (`src/lib/ids.js`) and the rules recompute it, so
  a duplicate cannot exist: one match entry per scout per match, one `files` document per
  stored object, one pick-list entry per team, unique knowledge slugs and graph slugs.
- **Two pit or strategy passes a day are enforced by slots.** The entry id ends in a slot of
  1 or 2, per scout, per team, per UTC day; a third has nowhere to go.
- **The scouting window uses an offset recorded when it is saved.** The rules have no
  time-zone database, so the lead's browser stores the zone's offset from UTC with the window
  (`utc_offset_min`). After a daylight-saving change, **a lead should re-save the window** in
  Event control, or it is an hour off.
- **File links do not expire.** See *Storage folders* above.
- **Knowledge-base search runs in the browser**, over the docs the member can read, not in the
  database. Every term must appear in the title, category or body.
- **Approval is realtime.** A pending user sees the change as soon as an admin makes it.
- **SQL views became stored or computed values.** Team statistics are a collection kept by
  functions; coverage, the checklist and the collaboration summary are computed in the
  browser. The table is in `docs/FIREBASE.md`.
- **Role changes and the AI and API proxies are Cloud Functions** rather than database
  functions and edge functions.

The old `supabase/` folder, the migrations and `npm run test:db` are gone; `npm run test:rules`
and `npm run test:functions` replace them.
