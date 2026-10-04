// =============================================================================
// How one queued write reaches the server, and what each failure means.
//
// Split out of offlineQueue.js so it takes its backend as an argument and imports
// nothing that needs a browser, Vite or the Firebase SDK: the rules in here decide
// whether a scout's data is kept, retried, or dropped, and they are tested in
// plain Node by scripts/test/offline-queue.mjs (npm run test:portal).
// offlineQueue.js owns IndexedDB, scheduling and listeners, and hands this file a
// `store`; this file owns the meaning of every answer.
//
// The store is the small part of Firestore and Storage a push needs:
//
//   uid()                              the signed-in scout's id, or null
//   serverTime()                       the value that means "the server's clock"
//   get(collection, id)                a document as a plain row, or null
//   create(collection, id, data)       one write (the rules refuse it if the
//                                      document already exists)
//   transaction(fn)                    fn({ get, create, update }), all or nothing
//   upload(bucket, path, file, meta)   bytes into Storage
//
// Failures are thrown as Firebase errors (a `code`, a `message`).
//
// Every function here returns { ok, ... } and never throws for a server answer.
// =============================================================================

import { entryId, fileId, recordedDay, minutesOf, PASSES_PER_DAY } from './ids.js'
import { uploadType } from './uploadTypes.js'

const DENIED = 'You do not have access to that.'
const SIGNED_OUT = 'Your session expired. Sign in again.'
const UNREACHABLE = 'Could not reach the server. Check your connection.'

// --- reading an error -----------------------------------------------------------

/** A Firebase error code without its product prefix: 'storage/unauthorized' -> 'unauthorized'. */
export function errorCode(error) {
  return String(error?.code ?? '').replace(/^[a-z]+\//, '')
}

/** True when the request never got an answer, so the same request may yet succeed. */
export function isTransport(error) {
  const code = errorCode(error)
  if (/unavailable|deadline-exceeded|network|cancell?ed|retry-limit-exceeded/.test(code)) return true
  return !code && /offline|network|fetch/i.test(String(error?.message ?? error ?? ''))
}

// Answers that will be the same on every retry. Retrying them every few minutes
// for the rest of the event drains a battery and, worse, keeps the badge saying
// "syncing" about something that never will, so they are marked terminal and wait
// for the scout to read the reason and decide.
//   permission-denied    the security rules refused the write (Storage calls the
//                        same thing `unauthorized`). recorded_at never changes,
//                        so the window, the event and the shape will not either.
//   invalid-argument     a value Firestore cannot store
//   failed-precondition  the write cannot apply to the data as it stands
//   not-found            the document a correction was aimed at is gone
// Everything else — no answer, a timeout, an expired session, a busy server — is
// retried with backoff.
const TERMINAL = new Set(['permission-denied', 'unauthorized', 'invalid-argument', 'failed-precondition', 'not-found'])

export function isTerminal(error) {
  return TERMINAL.has(errorCode(error))
}

const isDenied = (error) => ['permission-denied', 'unauthorized'].includes(errorCode(error))

function sentence(error) {
  const code = errorCode(error)
  if (code === 'unauthenticated') return SIGNED_OUT
  if (isDenied(error)) return DENIED
  if (isTransport(error)) return UNREACHABLE
  return String(error?.message ?? error ?? 'unknown error')
    .replace(/^Firebase(Error)?: /, '')
    .replace(/ \((firestore|storage|functions|auth)\/[a-z-]+\)\.?$/, '')
}

const terminal = (error) => ({ ok: false, error, terminal: true })

function failure(error, prefix = '') {
  const message = `${prefix}${sentence(error)}`
  return isTerminal(error) ? terminal(message) : { ok: false, error: message }
}

// --- the scouting window --------------------------------------------------------

/** Whether minute-of-day `m` falls in [start, end], a window that may run past midnight. */
export function windowHolds(m, start, end) {
  return start <= end ? m >= start && m <= end : m >= start || m <= end
}

/**
 * Whether a time falls inside the scouting window, judged exactly as the security
 * rules judge it: on the minute, and with the offset from UTC that was stored
 * beside the window when a lead saved it (the rules have no time-zone database).
 */
export function insideWindow(at, settings) {
  const d = at instanceof Date ? at : new Date(at)
  const offset = Number.isFinite(settings.utc_offset_min) ? settings.utc_offset_min : 0
  const start = settings.window_start_min ?? minutesOf(settings.window_start)
  const end = settings.window_end_min ?? minutesOf(settings.window_end)
  const minute = (d.getUTCHours() * 60 + d.getUTCMinutes() + offset + 2880) % 1440
  return windowHolds(minute, start, end)
}

const LEADS = new Set(['lead', 'mentor', 'admin'])

/**
 * Why the rules refused to create an entry.
 *
 * Every refusal arrives as the same `permission-denied`, with no reason attached,
 * and "you do not have access" is the wrong thing to tell a scout whose entry was
 * recorded ten minutes after the window closed. The settings the rules consulted
 * are readable, so the two refusals a scout can act on are worked out here, in
 * the order the scout should hear about them.
 */
async function explainRefusal(store, entry, uid) {
  let settings
  try {
    settings = await store.get('scout_settings', 'main')
  } catch (error) {
    // Could not find out why. A dropped connection is not a verdict on the entry:
    // leave it retryable, and the next attempt gets to ask again.
    return isTerminal(error) ? terminal(DENIED) : { ok: false, error: sentence(error) }
  }
  if (!settings) return terminal(DENIED)

  if (settings.lock_enabled && !insideWindow(entry.recorded_at, settings)) {
    return terminal(
      `scouting is closed right now (open ${settings.window_start} to ${settings.window_end}, ${settings.timezone} time). ` +
        'Entries can only be recorded inside the scouting window a lead has set.'
    )
  }

  if (settings.active_event_key != null && entry.event_key !== settings.active_event_key) {
    // Leads may scout any event, so for them this was not the rule that refused.
    const profile = await store.get('profiles', uid).catch(() => null)
    if (!LEADS.has(profile?.role)) {
      return terminal(
        `scouting is set to event ${settings.active_event_key}, not ${entry.event_key ?? '(none)'}. ` +
          'A lead controls which event is being scouted. Switch to it, or ask them to change it.'
      )
    }
  }
  return terminal(DENIED)
}

// --- scouting entries -------------------------------------------------------------

// Values as Firestore stores them: no `undefined` (a cleared answer), no NaN.
const storable = (value) => JSON.parse(JSON.stringify(value ?? {}))

/**
 * The queued payload as the document the rules expect: every field present, null
 * when unset. Built here rather than trusted from the queue, so a row saved by an
 * older build of the portal still goes out whole.
 */
export function entryDoc(p, uid) {
  const recordedAt = new Date(p.recorded_at)
  return {
    client_uuid: p.client_uuid,
    form_id: p.form_id ?? null,
    kind: p.kind,
    event_key: p.event_key ?? null,
    team_number: Number(p.team_number),
    match_key: p.match_key ?? null,
    match_number: p.match_number ?? null,
    comp_level: p.comp_level ?? null,
    alliance: p.alliance ?? null,
    data: storable(p.data),
    notes: p.notes ?? null,
    scout_id: p.scout_id ?? uid,
    recorded_at: recordedAt,
    recorded_day: recordedDay(recordedAt),
    slot: null,
  }
}

/**
 * A match entry that names its match. Its id is scout + team + match, so a second
 * entry for the same match lands on the same document, and what is already there
 * decides what this one is:
 *
 *   nothing                 -> created
 *   this same entry         -> an earlier attempt landed and only its answer was
 *                              lost: delivered, nothing rewritten
 *   an older entry          -> a correction: overwritten with this one
 *   an entry as new, newer  -> superseded: dropped as delivered
 *
 * Two phones signed in as the same scout can sync in either order, and the one
 * the scout pressed save on last is the one they meant. A copy that loses that
 * race should lose it. Read and write are one transaction, so two phones cannot
 * both decide they are the newer one.
 */
async function pushMatch(store, entry, uid) {
  const id = entryId(entry)
  let wrote = null
  try {
    return await store.transaction(async (tx) => {
      wrote = null
      const there = await tx.get('scout_entries', id)
      if (!there) {
        wrote = 'create'
        tx.create('scout_entries', id, { ...entry, created_at: store.serverTime() })
        return { ok: true }
      }
      if (there.client_uuid === entry.client_uuid) return { ok: true, deduped: true }
      if (new Date(there.recorded_at).getTime() < entry.recorded_at.getTime()) {
        wrote = 'update'
        tx.update('scout_entries', id, {
          client_uuid: entry.client_uuid,
          form_id: entry.form_id,
          data: entry.data,
          notes: entry.notes,
          recorded_at: entry.recorded_at,
          recorded_day: entry.recorded_day,
          comp_level: entry.comp_level,
          match_number: entry.match_number,
          alliance: entry.alliance,
        })
        return { ok: true, corrected: true }
      }
      return { ok: true, superseded: true }
    })
  } catch (error) {
    // The window and the active event are rules about creating an entry. A
    // refused correction was refused for something else.
    if (isDenied(error) && wrote === 'create') return explainRefusal(store, entry, uid)
    return failure(error, wrote === 'update' ? 'correction: ' : '')
  }
}

/**
 * A pit or strategy pass. A scout gets two per team per day, and the two are the
 * two documents `…:{day}:1` and `…:{day}:2`: the first free one is taken, and when
 * neither is free the allowance is spent. Both are read before anything is
 * written, in one transaction, so a retry finds its own earlier attempt in either
 * slot and two phones cannot both take the last one.
 */
async function pushPass(store, entry, uid) {
  const slots = Array.from({ length: PASSES_PER_DAY }, (_, i) => i + 1)
  let wrote = false
  try {
    return await store.transaction(async (tx) => {
      wrote = false
      const taken = []
      for (const slot of slots) taken.push(await tx.get('scout_entries', entryId({ ...entry, slot })))
      if (taken.some((there) => there?.client_uuid === entry.client_uuid)) return { ok: true, deduped: true }

      const free = slots.find((_, i) => !taken[i])
      if (!free) {
        return terminal(
          `daily limit reached: ${PASSES_PER_DAY} passes on team ${entry.team_number} today. ` +
            'You get two per team per day. The allowance resets tomorrow — edit one of ' +
            "today's entries instead if you need to correct it."
        )
      }
      wrote = true
      const pass = { ...entry, slot: free }
      tx.create('scout_entries', entryId(pass), { ...pass, created_at: store.serverTime() })
      return { ok: true, slot: free }
    })
  } catch (error) {
    if (isDenied(error) && wrote) return explainRefusal(store, entry, uid)
    return failure(error)
  }
}

/**
 * A match entry with no match key (no event was chosen). Nothing else can collide
 * with it, so its id is its client_uuid and it is one plain write. Writing it a
 * second time is refused like any other forbidden write, so a refusal is checked
 * against what is actually there before it is believed: this same entry on the
 * server means the earlier attempt landed.
 */
async function pushUnkeyed(store, entry, uid) {
  const id = entryId(entry)
  try {
    await store.create('scout_entries', id, { ...entry, created_at: store.serverTime() })
    return { ok: true }
  } catch (error) {
    if (!isDenied(error)) return failure(error)
    let there
    try {
      there = await store.get('scout_entries', id)
    } catch (readError) {
      // Not known either way; ask again later rather than strand a delivered row.
      if (!isTerminal(readError)) return { ok: false, error: sentence(readError) }
    }
    if (there?.client_uuid === entry.client_uuid) return { ok: true, deduped: true }
    return explainRefusal(store, entry, uid)
  }
}

function pushEntry(store, row, uid) {
  const entry = entryDoc(row.payload, uid)
  if (entry.kind !== 'match') return pushPass(store, entry, uid)
  // entryId falls back to the client_uuid form when there is no match key.
  return entry.match_key == null ? pushUnkeyed(store, entry, uid) : pushMatch(store, entry, uid)
}

// --- robot photos -------------------------------------------------------------------

/**
 * The bytes and their `files` document, each step safe to re-run.
 *
 * The files document is written only after the bytes have landed, so finding it
 * means an earlier attempt got that far and the photo is not sent again — on a
 * venue network the upload is the expensive step.
 */
async function indexUpload(store, upload, uid) {
  const { bucket, path, file } = upload
  const id = fileId(bucket, path)
  const ref = { id, bucket, path }

  try {
    if (await store.get('files', id)) return { ok: true, file: ref }
  } catch (error) {
    return failure(error, 'files: ')
  }

  const name = file.name ?? path.split('/').pop()
  const { type, ok } = uploadType(bucket, name, file.type)
  if (!ok) return terminal(`${name} cannot go in ${bucket}.`)

  // 1. bytes. The uploader owns the object, so re-sending a half-finished upload
  //    replaces it rather than being refused.
  try {
    await store.upload(bucket, path, file, { contentType: type, owner: uid })
  } catch (error) {
    return failure(error, 'upload: ')
  }

  // 2. index document, one per stored object (its id is the bucket and path).
  try {
    await store.create('files', id, {
      bucket,
      path,
      title: upload.title ?? path.split('/').pop(),
      description: null,
      kind: upload.kind ?? 'photo',
      season: upload.season ?? null,
      tags: [],
      byte_size: Number.isInteger(file.size) ? file.size : null,
      sha256: upload.sha256 ?? null,
      uploaded_by: uid,
      created_at: store.serverTime(),
      updated_at: store.serverTime(),
    })
  } catch (error) {
    // Another tab draining the same queue can get here first; then it is there.
    if (isDenied(error) && (await store.get('files', id).catch(() => null))) return { ok: true, file: ref }
    return failure(error, 'files: ')
  }
  return { ok: true, file: ref }
}

/**
 * Bytes -> files document -> robot_photos document.
 *
 * Two payload shapes reach here:
 *   { ..., _upload: { file, bucket, path, … } }  the photo never left the phone;
 *                                                upload it, index it, link it.
 *   { ..., file: { id, bucket, path } }          the bytes and their files document
 *                                                already landed (RobotCapture
 *                                                uploads online first) and only
 *                                                the link is outstanding.
 * The second shape was once rejected as "no file attached" and retried forever,
 * so every photo whose link was queued never reached its team.
 */
async function pushPhoto(store, row, uid) {
  const { _upload, file: linked, ...p } = row.payload
  let file = linked?.id && linked.bucket && linked.path
    ? { id: linked.id, bucket: linked.bucket, path: linked.path }
    : null

  if (!file) {
    if (!_upload?.file) return terminal('queued photo has neither a file nor a file reference')
    const indexed = await indexUpload(store, _upload, uid)
    if (!indexed.ok) return indexed
    file = indexed.file
  }

  // The photo's id is its client_uuid, so a retry addresses the same document:
  // finding one there means the earlier attempt landed.
  const id = row.payload.client_uuid
  try {
    return await store.transaction(async (tx) => {
      if (await tx.get('robot_photos', id)) return { ok: true, deduped: true }
      tx.create('robot_photos', id, {
        client_uuid: id,
        event_key: p.event_key ?? null,
        team_number: Number(p.team_number),
        angle: p.angle,
        file,
        quality: storable(p.quality),
        taken_by: p.taken_by ?? uid,
        created_at: store.serverTime(),
      })
      return { ok: true }
    })
  } catch (error) {
    return failure(error)
  }
}

/** Push one queued row through `store`, according to its handler. */
export async function pushRow(store, row, handler) {
  if (!handler) return terminal(`unknown kind ${row.kind}`)
  // Signed out, every write is refused as permission-denied, which would read as
  // a verdict on the data. It is not one: the row waits for the next sign-in.
  const uid = store.uid()
  if (!uid) return { ok: false, error: SIGNED_OUT }
  return handler.kind === 'photo' ? pushPhoto(store, row, uid) : pushEntry(store, row, uid)
}
