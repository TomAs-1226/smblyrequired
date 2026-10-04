# The portal's backend on Firebase — data model and contract

The portal runs on Firebase: **Auth** for sign-in, **Firestore** for data,
**Cloud Storage** for files, and **Cloud Functions** for the few things a browser
must not do (change a role, hold an API key, keep aggregates). The browser talks
to Firestore and Storage directly; `firebase/firestore.rules` and
`firebase/storage.rules` are the access boundary, and `npm run test:rules` proves
them against the emulator.

This file is the contract between the rules, the functions and the client. Change
one and you change all three, and the tests.

## Conventions

- **Collections and fields keep the names the SQL schema had** (`scout_entries`,
  `team_number`, `recorded_at`), so the panels did not have to change.
- **Every field a validator names is always present**, `null` when it has no
  value. The rules read fields directly; a missing field is a refused write.
- **Times are Firestore Timestamps** in the database. `src/lib/db.js` turns them
  into ISO strings on the way out (`row`, `rows`, `plain`) and back on the way in
  (`ts`). `created_at` / `updated_at` are `serverTimestamp()`; the rules require
  it (`== request.time`).
- **Attribution is sent by the client and checked by the rules**: `uploaded_by`,
  `created_by`, `scout_id`, `taken_by`, `started_by`, `observed_by`, `updated_by`
  must equal the caller's uid unless the caller is a lead.
- **Every API function returns `{ data, error }`**, `error` already a sentence
  (`wrap` in `src/lib/db.js`).
- **Uniqueness lives in document ids** (`src/lib/ids.js`); the rules recompute
  each id from the document's fields.

## Roles

`profiles/{uid}.role`, in privilege order: `pending < viewer < member < lead <
mentor < admin`. `mentor` has exactly a lead's rights. A signed-in user with no
profile is `pending`. A user creates their own profile at first sign-in and it can
only say `pending`. `role` is written only by the `setMemberRole` function.

| Role | May |
|---|---|
| pending | read their own profile; nothing else |
| viewer | read the roster; read `media` and `public-media` files |
| member | read everything; record their own scouting, photos, vision sessions, notes; upload files; write knowledge docs |
| lead / mentor | manage everything a member records; author forms; scouting settings; pick lists; delete knowledge docs; read the audit log |
| admin | change roles; edit other members' profiles; manage repo sources |

## Collections

Fields are listed with their type; `?` means nullable.

### `profiles/{uid}`
`full_name? string`, `grad_year? int 2000–2100`, `subteam? string`, `role string`,
`created_at`, `updated_at`. No email (it lives in Auth). Client-writable fields:
`full_name`, `grad_year`, `subteam` (own row, or any row for an admin).

### `files/{fileId}` — the index over Storage objects
id = `fileId(bucket, path)` = `{bucket}~{path with "/" replaced by "~"}`.
`bucket` (`graphs|code|knowledge|media|public-media`), `path` (`[A-Za-z0-9_./-]+`),
`title`, `description?`, `kind?` (`graph|code|cad|doc|photo|video|other`),
`season? int`, `tags string[]`, `byte_size? int`, `sha256? hex64`, `uploaded_by`,
`created_at`, `updated_at`. The object lives at `{bucket}/{path}` in Storage.
Upload order: object first, then this document; on failure remove the object.
Deleting a file document: `onFileDeleted` removes the stored object, deletes any
`robot_photos` pointing at it, and clears `file` / `html_file` on graphs and
code archives.

### `graphs/{slug}`
id = slug (`^[a-z0-9][a-z0-9-]*$`), so slugs are unique. `slug`, `title`,
`summary?`, `source?`, `node_count? int`, `edge_count? int`, `community_count?
int`, `god_nodes string[]`, `generated_at? timestamp`, `file? {id,bucket,path}`
(graph.json), `html_file? {id,bucket,path}` (graphify's graph.html), `created_by`,
`created_at`, `updated_at`. A file is referenced by an embedded
`{id, bucket, path}` map, not an id alone: there are no joins.

### `code_archives/{autoId}`
`repo`, `ref?`, `commit_sha? hex 7–40`, `season? int`, `notes?`,
`file? {id,bucket,path,byte_size}`, `created_by`, `created_at`, `updated_at`.

### `knowledge_docs/{autoId}` and `kb_slugs/{slug}`
`slug`, `title`, `body_md`, `category?`, `is_pinned bool`, `created_by`,
`updated_by`, `created_at`, `updated_at`. `kb_slugs/{slug} = { doc_id }` makes
slugs unique: a doc and its slug index are written in one batch, and the rules
check each against the other (`getAfter`). Renaming = update doc + create new
index + delete old index, one batch. Deleting (lead) = delete doc + delete index.
`knowledge_docs/{id}/versions/{autoId}` = `{ title, body_md, edited_by,
created_at }`, the previous title and body, written by `onKnowledgeDocUpdated`
whenever either changes; nobody can edit or delete history.
Search is done in the browser over the member-readable docs (every term must
appear in title, category or body).
A body matching a secret pattern is refused by the rules; `src/lib/secretPatterns.js`
has the same patterns and names which one matched, for the error message.

### `audit_log/{autoId}` (functions only)
`actor? uid`, `action`, `entity`, `entity_id`, `detail map`, `created_at`.
Leads read.

### `backup_runs/{autoId}` (backup host only, Admin SDK)
`leg`, `status` (`running|ok|failed|partial`), `started_at`, `finished_at?`,
`object_count?`, `byte_total?`, `db_dump_bytes?`, `manifest_sha?`,
`restore_tested_at?`, `error?`, `created_at`. "Health" (latest run per leg, ok and
under 36 hours old) is computed in the browser.

### `events/{eventKey}` and `event_teams/{eventKey}_{teamNumber}` — TBA cache
events: `key`, `year int`, `name`, `short_name?`, `event_type?`, `city?`,
`state_prov?`, `country?`, `start_date? 'YYYY-MM-DD'`, `end_date?`, `week? int`,
`synced_at`. event_teams: `event_key`, `team_number int`, `nickname?`, `name?`,
`city?`, `state_prov?`, `country?`, `rookie_year? int`, `synced_at`.
Written by the `tbaProxy` function (and by leads).

### `scout_forms/{autoId}` and `scout_form_active/{season}_{kind}`
`season int`, `kind` (`match|pit|strategy`), `name`, `description?`,
`fields array`, `is_active bool`, `created_by?`, `created_at`, `updated_at`.
Field shape: `{key, label, type, section, required, min, max, options[], help}`;
`validateFields` in `src/lib/scoutingApi.js` enforces it (lower_snake_case unique
keys, known types, labels, options) before any write — leads are the only writers.
`scout_form_active/{season}_{kind} = { form_id, season, kind }` names the one
active form. Activating is one batch: old form `is_active:false`, new form
`is_active:true`, pointer moved. A reader takes the pointer, then the form, and
ignores a form that says it is not active.

### `scout_settings/main` (singleton)
`active_event_key?`, `lock_enabled bool`, `window_start 'HH:MM'`,
`window_end 'HH:MM'`, `window_start_min int`, `window_end_min int`, `timezone`
(IANA), `utc_offset_min int` (the zone's offset when the window was saved, east
positive; the rules have no time-zone database), `vision_model_url?`,
`vision_model_name?`, `vision_model_labels array`, `vision_model_size int 64–2048`,
`updated_by`, `updated_at`. Absent = no restrictions. "Open now" is computed in
the browser.

### `scout_entries/{entryId}`
id = `entryId(entry)` (`src/lib/ids.js`):
- match with a match key: `m:{event|none}:{team}:{match_key}:{scout_id}` — one
  entry per scout per match; a second submission is a **correction** (an update).
- match without a match key: `u:{client_uuid}`.
- pit / strategy: `p:{event|none}:{team}:{kind}:{scout_id}:{recorded_day}:{slot}`,
  `slot` 1 or 2 — **two passes per scout per team per UTC day**, by construction.

`client_uuid`, `form_id?`, `kind`, `event_key?`, `team_number int`, `match_key?`,
`match_number? int`, `comp_level?` (`qm|ef|qf|sf|f`), `alliance?` (`red|blue`),
`data map` (answers by field key; `total_score`, `broke`, `no_show` are read by
name), `notes?`, `scout_id`, `recorded_at` (device time at save),
`recorded_day int` (UTC `YYYYMMDD` of `recorded_at`), `slot` (`null` for match,
else 1 or 2), `created_at` (server).
On create the rules also require: inside the scouting window when
`lock_enabled` (everyone, judged on `recorded_at`); for the active event when one
is set (members; leads are exempt). Members cannot delete.

### `team_event_stats/{eventKey}_{teamNumber}` (functions only)
Kept by `onScoutEntryWritten` and `onRobotPhotoWritten`, recomputed from that
team's entries at that event on every change. Fields:
`event_key`, `team_number`, `matches_scouted`, `pit_visits`, `notes_logged`,
`scouts_contributing` (distinct scouts, match entries), `scouts` (distinct, all
kinds), `last_seen?`, `scored_matches`, `avg_score?`, `score_stddev?` (sample SD,
null at n<2), `min_score?`, `max_score?`, `pit_estimate?`, `breakdowns`,
`no_shows`, `photos`, `updated_at`. Scoring stats are match-only and skip a
`total_score` that is not a number or a numeric string; `broke` / `no_show` count
`true`, `'true'`, `'yes'` (any case). The document is deleted when a team has no
entries and no photos left. Coverage and the checklist are computed in the browser
from these plus `event_teams`.

### `robot_photos/{client_uuid}`
`client_uuid`, `event_key?`, `team_number int`, `angle`
(`front|side|rear|drivetrain|intake|scoring|other`), `file {id,bucket,path}`,
`quality map`, `taken_by`, `created_at`. A retake adds a document; readers take
the newest per angle.

### `picklists/{autoId}` and `picklists/{id}/entries/{teamNumber}`
picklists: `event_key`, `name`, `tiers array`, `is_locked bool`, `locked_at?`,
`locked_by?`, `created_by?`, `created_at`, `updated_at`.
entries (id = team number, so one per team): `team_number int`, `tier`,
`position number`, `note?`, `overrides_ai bool`, `updated_by?`, `updated_at`.
While the list is locked nobody can create, change or delete an entry.

### `team_collaboration/{event|none}:{team}:{observer}`
`event_key?`, `team_number`, `answered_questions? bool`, `shared_strategy?`,
`showed_up_prepared?`, `responsive_in_queue?`, `communication_rating? 1–5`,
`coordination_rating? 1–5`, `would_partner_again?`, `note?`, `observed_by`,
`observed_at`, `created_at`. The summary (workability needs two observers) is
computed in the browser.

### `vision_sessions/{autoId}` and `…/observations/{autoId}`
sessions: `event_key?`, `match_key?`, `device_label?`, `model`, `model_note?`,
`started_by`, `operator?` (the starter's name, copied at start), `started_at`,
`ended_at?`, `frame_count int`, `observations int`, `peak_count? int`,
`count_sum int` (so `avg = count_sum / observations`), `created_at`. The client
bumps the three counters in the same batch as the frames it writes.
observations: `offset_ms int`, `recorded_at`, `object_count int`,
`detections array`, `team_number? int`, `created_at`.

### `repo_sources/{autoId}`
As the SQL table; admins write. No UI uses it.

## Storage

One bucket, five top-level folders (the old buckets): `graphs/`, `code/`,
`knowledge/`, `media/` (private) and `public-media/` (world-readable). Limits per
folder are in `firebase/storage.rules` (same sizes and types as before;
`src/lib/uploadTypes.js` normalises the content type first). Every upload sets
`customMetadata.owner = uid`. Reading a private file: `fileUrl()` in
`src/lib/portalApi.js` fetches the bytes with the user's credentials and hands
back an object URL — no long-lived public link is created for team media.

## Cloud Functions (`functions/`, region `us-west1`)

Callable (the client uses `call(name, payload)` from `src/lib/db.js`; each checks
the caller's role in `profiles`, never a token claim, and answers with its data
or an `HttpsError` whose message is already written for the reader):

| Function | Floor | Does |
|---|---|---|
| `setMemberRole({ targetId, role })` | admin | the only way a role changes: not your own, never the last admin; writes `audit_log` (`role.change`) |
| `deleteMember({ targetId })` | admin | removes a member's profile and their sign-in: not yourself, never the last admin; writes `audit_log` (`member.delete`) |
| `tbaProxy({ action, … })` | member | The Blue Alliance, with `events` / `event_teams` cached in Firestore |
| `nexusProxy({ action:'event_status', eventKey, force })` | member | frc.nexus live queuing |
| `statboticsProxy({ action, … })` | member | Statbotics EPA |
| `ai({ task, … })` | member | scouting summaries and pick-list help (OpenAI) |

Triggers: `onScoutEntryWritten`, `onRobotPhotoWritten` (stats),
`onKnowledgeDocUpdated` (history), `onKnowledgeDocDeleted` (history goes with its
doc), `onFileDeleted` (cascade).

`rate_limits/{uid}_ai` holds the AI function's per-member rate limit. The rules
name no such collection, so no client can read or write it.

Secrets (set with `firebase functions:secrets:set NAME`, never in the repo):
`TBA_KEY`, `NEXUS_KEY`, `OPENAI_API_KEY`.

## What used to be a SQL view

| View | Now |
|---|---|
| `team_event_stats` | the `team_event_stats` collection, kept by functions |
| `event_scout_coverage`, `team_scout_checklist` | computed in the browser from `event_teams` + `team_event_stats` |
| `team_collaboration_summary` | computed in the browser from that team's notes |
| `scout_control_status` | computed in the browser from `scout_settings/main` |
| `vision_session_summary` | counters on the session document |
| `backup_health` | computed in the browser from the latest run per leg |
