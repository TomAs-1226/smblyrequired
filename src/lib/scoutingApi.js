import {
  collection,
  doc,
  query,
  where,
  orderBy,
  limit as take,
  getDocFromServer,
  getDocsFromServer,
  runTransaction,
  getCountFromServer,
  increment,
} from 'firebase/firestore'
import { db } from './firebase'
import {
  isConfigured,
  NOT_CONNECTED,
  currentUid,
  now,
  row,
  rows,
  wrap,
  isTransportError,
  call,
  memberNames,
} from './db'
import {
  activeFormId,
  teamStatId,
  entryId,
  recordedDay,
  minutesOf,
  utcOffsetMinutes,
  PASSES_PER_DAY,
} from './ids'
import { enqueue } from './offlineQueue'
import { windowHolds } from './queuePush'

// -----------------------------------------------------------------------------
// Scouting data access.
//
// Reads go straight to Firestore; ENTRIES GO THROUGH THE OFFLINE QUEUE, always,
// even when the connection looks fine. A scout should never encounter two
// different save behaviours depending on signal strength — and "looks fine" at
// a competition venue is frequently a captive portal that will swallow the
// request. One path, one set of failure modes, one place to get it right.
//
// Two habits of the Firestore SDK shape everything below, because both turn "no
// connection" into something that looks like an answer:
//
//   * A plain read with no connection resolves from the SDK's cache — for a query
//     nobody has run yet, an EMPTY list. "No teams at this event" and "could not
//     ask" must not look the same, so every read here asks the server and fails
//     when it cannot.
//   * A plain write with no connection does not fail either: it is held in memory
//     and sent whenever the network returns, minutes later, with its promise
//     pending the whole time. Every direct write here goes through `commit`,
//     which is sent now or fails now.
// -----------------------------------------------------------------------------

const col = (name) => collection(db, name)
const codeOf = (error) => String(error?.code ?? '')

/** Run a read or write and answer the way every function here answers. */
async function answer(empty, work) {
  if (!isConfigured) return { data: empty, error: NOT_CONNECTED }
  try {
    return { data: (await work()) ?? empty, error: null }
  } catch (error) {
    return { data: empty, error: wrap(error) }
  }
}

/**
 * Writes that land now, together, or fail now. `write` gets set / update / delete.
 *
 * A transaction rather than setDoc or a batch for one reason: those wait for a
 * connection, and a pick-list drag replayed twenty minutes late, over whatever
 * was decided in between, is worse than a drag that failed.
 */
const commit = (write) =>
  runTransaction(db, async (tx) => {
    write(tx)
  })

// A sentence of ours, thrown out of a transaction: shown as it is, not wrapped.
class Refusal extends Error {}

/**
 * The stored document after a write, as a row. The write has already landed by
 * the time this runs, so a read-back lost on the way falls back to what was sent
 * rather than reporting a failure that did not happen.
 */
async function stored(ref, sent) {
  try {
    return row(await getDocFromServer(ref)) ?? sent
  } catch {
    return sent
  }
}

const isoNow = () => new Date().toISOString()
const round1 = (n) => Math.round(n * 10) / 10

// --- last-known copies for a phone with no signal ----------------------------
//
// The write path is offline-first, but the screen a scout writes FROM was not:
// reloading the Scout tab in an arena with no signal lost the active form, the
// event list and the team list, and the page said "No active match form" — so
// nothing could be recorded even though the queue was ready to hold it. The
// reads below keep their last good answer on the device and fall back to it
// only when the request never reached the server. A refusal from the server
// (the security rules, a bad query) is never papered over.
const CACHE_PREFIX = 'frc5805.cache.'

function remember(key, data) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ at: Date.now(), data }))
  } catch {
    // Storage full or blocked: the live answer is still returned, just not kept.
  }
}

function recall(key) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

// Wraps a read that resolves its data or throws a Firebase error.
async function withLastKnown(key, read, empty) {
  const kept = () => {
    const copy = recall(key)
    return copy ? { data: copy.data, error: null, offline: true, savedAt: copy.at } : null
  }
  // With no network interface at all there is nothing to wait for. The SDK takes
  // around ten seconds to give up on a dead connection, and a scout reloading the
  // Scout tab between matches should not stare at a spinner for that long.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    const copy = kept()
    if (copy) return copy
  }
  try {
    const data = (await read()) ?? empty
    remember(key, data)
    return { data, error: null }
  } catch (error) {
    return (isTransportError(error) && kept()) || { data: empty, error: wrap(error) }
  }
}

// --- events & teams (TBA-backed cache) ---------------------------------------

// SQL's `order by … asc`: nulls after everything else.
const nullsLast = (a, b) => (a == null ? (b == null ? 0 : 1) : b == null ? -1 : a < b ? -1 : a > b ? 1 : 0)

export async function listEvents(year) {
  if (!isConfigured) return { data: [], error: NOT_CONNECTED }
  return withLastKnown(
    `events.${year}`,
    async () => {
      const snap = await getDocsFromServer(query(col('events'), where('year', '==', year)))
      return rows(snap).sort((a, b) => nullsLast(a.start_date, b.start_date) || nullsLast(a.key, b.key))
    },
    []
  )
}

export async function listEventTeams(eventKey) {
  if (!isConfigured) return { data: [], error: NOT_CONNECTED }
  return withLastKnown(
    `event_teams.${eventKey}`,
    async () => {
      const snap = await getDocsFromServer(query(col('event_teams'), where('event_key', '==', eventKey)))
      return rows(snap).sort((a, b) => a.team_number - b.team_number)
    },
    []
  )
}

/**
 * Refresh the cache from The Blue Alliance via the `tbaProxy` function.
 *
 * The TBA key is server-side only, so this cannot be called directly from the
 * browser — which is also why the collections above exist rather than querying
 * TBA live from every scout's phone on a saturated network. The function writes
 * the cache itself, so an ordinary member can refresh it; a refusal comes back
 * as the function's own sentence ("TBA_KEY is not configured on the server.").
 */
export async function syncFromTba(action, params = {}) {
  return call('tbaProxy', { action, ...params })
}

// --- forms --------------------------------------------------------------------

const pointerRef = (season, kind) => doc(db, 'scout_form_active', activeFormId(season, kind))

/**
 * The one active form for a season and kind.
 *
 * Firestore has no partial unique index, so "at most one active" is carried by a
 * pointer document, scout_form_active/{season}_{kind}, that names the form. The
 * pointer is the authority: a form that still says is_active but is not the one
 * named is not live, and a named form that says it is not active is ignored.
 */
export async function activeForm(season, kind) {
  if (!isConfigured) return { data: null, error: NOT_CONNECTED }
  return withLastKnown(
    `form.${season}.${kind}`,
    async () => {
      const pointer = await getDocFromServer(pointerRef(season, kind))
      if (!pointer.exists()) return null
      const form = row(await getDocFromServer(doc(db, 'scout_forms', pointer.data().form_id)))
      return form?.is_active ? form : null
    },
    null
  )
}

export async function listForms(season) {
  return answer([], async () => {
    const snap = await getDocsFromServer(
      season ? query(col('scout_forms'), where('season', '==', season)) : col('scout_forms')
    )
    return rows(snap).sort(
      (a, b) => b.season - a.season || nullsLast(a.kind, b.kind) || nullsLast(a.name, b.name)
    )
  })
}

const FIELD_TYPES = [
  'counter', 'number', 'text', 'textarea', 'select',
  'multiselect', 'boolean', 'rating', 'timer', 'heading',
]

/**
 * What is wrong with a form's field list, as a sentence, or null when it is sound.
 *
 * This was a database trigger. The security rules can check that `fields` is a
 * list but cannot walk it, so the walk happens here, before any form is written —
 * leads are the only people the rules let write a form at all, so this is a guard
 * against a mistake, not against an attacker. The wording is the trigger's,
 * because the form builder shows it verbatim.
 *
 * A field `key` is the join between a definition and every answer ever stored
 * under it, which is why the rules about keys come first.
 */
export function validateFields(fields) {
  if (!Array.isArray(fields)) return 'fields must be a JSON array'
  const seen = new Set()
  for (const f of fields) {
    const field = f && typeof f === 'object' ? f : {}
    const key = typeof field.key === 'string' ? field.key : null
    const type = typeof field.type === 'string' ? field.type : null

    if (key == null || !/^[a-z][a-z0-9_]*$/.test(key)) {
      return `field key ${key ?? '(null)'} must be lower_snake_case`
    }
    if (seen.has(key)) return `duplicate field key: ${key}`
    seen.add(key)

    if (type == null || !FIELD_TYPES.includes(type)) {
      return `field ${key}: type ${type ?? '(null)'} is not one of {${FIELD_TYPES.join(',')}}`
    }
    if (field.label == null && type !== 'heading') return `field ${key} has no label`
    if (
      (type === 'select' || type === 'multiselect') &&
      !(Array.isArray(field.options) && field.options.length > 0)
    ) {
      return `field ${key} is a ${type}, so it needs a non-empty options array`
    }
  }
  return null
}

const TWO_ACTIVE =
  'Another form is already active for this season and type. Deactivate it first — ' +
  'two active forms would split the season across incompatible schemas.'

// What the rules check about a form besides its fields. A refused write says only
// "permission denied", so the cases a lead can actually hit are named here first.
function formProblem(form) {
  const fields = validateFields(form.fields)
  if (fields) return fields
  if (!String(form.name ?? '').trim()) return 'A form needs a name.'
  if (form.fields.length > 200) return 'A form can hold at most 200 fields.'
  if (!Number.isInteger(form.season) || form.season < 2000 || form.season > 2100) {
    return 'A form needs a season between 2000 and 2100.'
  }
  return null
}

/**
 * Save a form and keep the active pointer true to it, in one transaction.
 *
 *   - active, and the pointer names another live form: with `takeOver` that form
 *     is retired in the same write; without it the save is refused, because two
 *     active forms would split the season across incompatible schemas;
 *   - active: the pointer is set to this form;
 *   - was active and no longer is (or moved to another season or kind): the
 *     pointer it held is removed, so nothing is left naming a retired form.
 *
 * Everything is read inside the transaction, so two leads publishing in the same
 * second cannot both come away believing theirs is the live form.
 */
async function writeForm(form, { takeOver }) {
  if (!isConfigured) return { data: null, error: NOT_CONNECTED }
  const problem = formProblem(form)
  if (problem) return { data: null, error: problem }

  const ref = form.id ? doc(db, 'scout_forms', form.id) : doc(col('scout_forms'))
  const active = form.is_active ?? false
  const content = {
    season: form.season,
    kind: form.kind,
    name: form.name,
    description: form.description || null,
    fields: form.fields,
    is_active: active,
  }

  try {
    await runTransaction(db, async (tx) => {
      const before = form.id ? await tx.get(ref) : null
      if (before && !before.exists()) throw new Refusal('That form no longer exists. Reload the list.')
      const was = before?.data() ?? null

      const target = pointerRef(content.season, content.kind)
      const named = active ? await tx.get(target) : null
      const namedId = named?.exists() ? named.data().form_id : null
      let incumbent = null
      if (namedId && namedId !== ref.id) {
        const other = await tx.get(doc(db, 'scout_forms', namedId))
        if (other.exists() && other.data().is_active) incumbent = other
      }
      if (incumbent && !takeOver) throw new Refusal(TWO_ACTIVE)

      const left = was?.is_active && (!active || was.season !== content.season || was.kind !== content.kind)
      const held = left ? await tx.get(pointerRef(was.season, was.kind)) : null

      if (incumbent) tx.update(incumbent.ref, { is_active: false, updated_at: now() })
      // An existing form is updated, never set: created_at has to stay exactly
      // the server's own stamp, and a round trip through this page would not be.
      if (was) tx.update(ref, { ...content, updated_at: now() })
      else tx.set(ref, { ...content, created_by: currentUid(), created_at: now(), updated_at: now() })
      if (active) tx.set(target, { form_id: ref.id, season: content.season, kind: content.kind })
      if (held?.exists() && held.data().form_id === ref.id) tx.delete(held.ref)
    })
  } catch (error) {
    return { data: null, error: error instanceof Refusal ? error.message : wrap(error) }
  }
  return { data: await stored(ref, { id: ref.id, ...content }), error: null }
}

/**
 * Save a form as it is given. A form saved as active while another is live for
 * the same season and kind is refused with a sentence; publishing over the
 * incumbent is `activateForm`'s job, and it is a different decision.
 */
export async function saveForm(form) {
  return writeForm(form, { takeOver: false })
}

/**
 * How many entries have been recorded against a form.
 *
 * The most consequential read in the whole authoring flow, because this number
 * is what decides whether a field `key` may still be edited. A key is the join
 * between a definition and every answer ever stored under it — `scout_entries`
 * `.data` is keyed by `scout_forms.fields[].key`, nothing else. Rename one on a
 * form people have already scouted with and the existing entries keep the OLD
 * key, every aggregate reading the new one returns null, and nothing anywhere
 * reports a problem: the entries are still structurally valid, they have simply
 * become invisible. A silent wrong answer is worse than a loud failure, so the
 * builder locks the field rather than trusting anyone to remember.
 *
 * A count aggregation, so this costs a count and not the entries themselves — it
 * runs on the same venue network as everything else.
 */
export async function formEntryCount(formId) {
  if (!isConfigured) return { data: 0, error: NOT_CONNECTED }
  // A form that has never been saved cannot have entries, and there is nothing
  // to filter on.
  if (!formId) return { data: 0, error: null }
  return answer(0, async () => {
    const snap = await getCountFromServer(query(col('scout_entries'), where('form_id', '==', formId)))
    return snap.data().count
  })
}

/**
 * Publish a form, retiring whatever it replaces.
 *
 * The old form goes off, the new one goes on and the pointer moves, in one
 * transaction: there is no moment at which the season has two active forms, and
 * none at which it has no form at all. A scout either reads the old form or the
 * new one.
 */
export async function activateForm(form) {
  return writeForm({ ...form, is_active: true }, { takeOver: true })
}

/**
 * Delete a form definition.
 *
 * This never deletes anything a student recorded — the entries survive, still
 * carrying the id of the form that produced them, with nothing left to say what
 * its questions were. That is exactly why the builder makes someone type the
 * form's name first when entries exist: the data is safe, but its meaning is not.
 *
 * If the form is the live one, its pointer goes in the same transaction; the
 * rules refuse to leave a pointer naming a form that is gone.
 */
export async function deleteForm(id) {
  if (!isConfigured) return { error: NOT_CONNECTED }
  const ref = doc(db, 'scout_forms', id)
  try {
    await runTransaction(db, async (tx) => {
      const form = await tx.get(ref)
      if (!form.exists()) return
      const named = await tx.get(pointerRef(form.data().season, form.data().kind))
      if (named.exists() && named.data().form_id === id) tx.delete(named.ref)
      tx.delete(ref)
    })
    return { error: null }
  } catch (error) {
    return { error: wrap(error) }
  }
}

// --- scouting control (active event + time window) ----------------------------

// What the settings read as before anyone has saved them: no active event, no
// window, the built-in detector. The security rules treat a missing settings
// document as "no restrictions", and these say the same thing.
const SETTINGS_DEFAULTS = {
  active_event_key: null,
  lock_enabled: false,
  window_start: '08:00',
  window_end: '18:00',
  timezone: 'America/Los_Angeles',
  vision_model_url: null,
  vision_model_name: null,
  vision_model_labels: [],
  vision_model_size: 640,
}
const SETTINGS_FIELDS = Object.keys(SETTINGS_DEFAULTS)
const settingsRef = () => doc(db, 'scout_settings', 'main')

async function readSettings() {
  const snap = await getDocFromServer(settingsRef())
  return { ...SETTINGS_DEFAULTS, ...(snap.exists() ? row(snap) : {}) }
}

// The wall-clock time in a zone, as minutes after midnight and as 'HH:MM:SS'.
function localClock(settings, at) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: settings.timezone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(at)
    const v = Object.fromEntries(parts.map((p) => [p.type, p.value]))
    return { minutes: Number(v.hour) * 60 + Number(v.minute), text: `${v.hour}:${v.minute}:${v.second}` }
  } catch {
    // A zone this browser does not know: fall back to the offset saved beside it.
    const shifted = new Date(at.getTime() + (settings.utc_offset_min ?? 0) * 60_000)
    return {
      minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
      text: shifted.toISOString().slice(11, 19),
    }
  }
}

/**
 * Whether scouting is open right now, from the settings. Pure.
 *
 * This is for display: it reads the clock in the settings' time zone, on the
 * minute, as the rules do. The rules themselves judge an entry on its own
 * recorded_at, with the zone's offset as it was when the window was saved — so
 * across a daylight-saving change the two can disagree by an hour until a lead
 * saves the window again.
 */
export function controlStatus(settings, at = new Date()) {
  const clock = localClock(settings, at)
  return {
    active_event_key: settings.active_event_key ?? null,
    lock_enabled: Boolean(settings.lock_enabled),
    window_start: settings.window_start,
    window_end: settings.window_end,
    timezone: settings.timezone,
    local_now: clock.text,
    open_now:
      !settings.lock_enabled ||
      windowHolds(clock.minutes, minutesOf(settings.window_start), minutesOf(settings.window_end)),
  }
}

// The live control state: the active event, the window, and whether scouting is
// open this minute. Everyone reads it; only leadership writes the settings behind
// it. A scout's own clock decides nothing that matters — the rules judge each
// entry when it arrives.
export async function scoutControl() {
  return answer(null, async () => controlStatus(await readSettings()))
}

// What the rules check about the settings. A refusal says only "permission
// denied", so anything a lead could get wrong is named here, and a refusal that
// still comes back can only be about who is asking.
function settingsProblem(s) {
  const time = /^([01]\d|2[0-3]):[0-5]\d$/
  if (!time.test(s.window_start) || !time.test(s.window_end)) {
    return 'The scouting window needs an opening and a closing time, as HH:MM.'
  }
  try {
    utcOffsetMinutes(s.timezone)
  } catch {
    return `"${s.timezone}" is not a time zone this browser knows.`
  }
  if (!Number.isInteger(s.vision_model_size) || s.vision_model_size < 64 || s.vision_model_size > 2048) {
    return 'The model input size must be a whole number from 64 to 2048.'
  }
  if (!Array.isArray(s.vision_model_labels) || s.vision_model_labels.length > 1000) {
    return 'A model can list at most 1000 labels.'
  }
  if ((s.vision_model_url ?? '').length > 2000) return 'The model URL is too long (2000 characters at most).'
  if ((s.vision_model_name ?? '').length > 200) return 'The model name is too long (200 characters at most).'
  return null
}

export async function saveScoutSettings(patch) {
  if (!isConfigured) return { data: null, error: NOT_CONNECTED }
  try {
    // Always the one document, and always the whole of it: the rules read every
    // field, so the patch is laid over what is stored (or over the defaults, the
    // first time anyone saves).
    const snap = await getDocFromServer(settingsRef())
    const kept = snap.exists() ? snap.data() : {}
    const next = {}
    for (const key of SETTINGS_FIELDS) {
      next[key] = patch?.[key] !== undefined ? patch[key] : (kept[key] ?? SETTINGS_DEFAULTS[key])
    }
    next.window_start = String(next.window_start).slice(0, 5)
    next.window_end = String(next.window_end).slice(0, 5)

    const problem = settingsProblem(next)
    if (problem) return { data: null, error: problem }

    // The rules have no time-zone database and compare minutes, so the window is
    // also stored as minutes, beside the zone's offset from UTC as of this save.
    next.window_start_min = minutesOf(next.window_start)
    next.window_end_min = minutesOf(next.window_end)
    next.utc_offset_min = utcOffsetMinutes(next.timezone)
    next.updated_by = currentUid()

    await commit((tx) => tx.set(settingsRef(), { ...next, updated_at: now() }))
    return { data: { id: 'main', ...next, updated_at: isoNow() }, error: null }
  } catch (error) {
    // The rules let only lead+ write this document; a member's write is refused
    // by the rules, not by hiding the control. Everything else the rules check
    // was checked above, so a refusal here is about the role.
    if (codeOf(error).includes('permission-denied')) {
      return { data: null, error: 'Only a lead, mentor or admin can change scouting settings.' }
    }
    return { data: null, error: wrap(error) }
  }
}

// --- entries ------------------------------------------------------------------

/**
 * Record a scouting entry. Resolves once it is durably on the device.
 *
 * Returns the client_uuid, which is the entry's identity everywhere — including
 * on the server after it syncs. Callers should treat a resolved promise as
 * "saved", not as "uploaded"; SyncBadge is what communicates the difference.
 */
export async function recordEntry({
  form,
  kind,
  eventKey,
  teamNumber,
  matchKey,
  matchNumber,
  compLevel,
  alliance,
  data,
  notes,
  scoutId,
}) {
  // Stamped on the device: this is when the match was actually watched, which
  // is the only ordering a human cares about. created_at (server-side) can be
  // hours later if the phone was offline all afternoon.
  const recordedAt = new Date()
  return enqueue('scout_entry', {
    form_id: form?.id ?? null,
    kind,
    event_key: eventKey ?? null,
    team_number: teamNumber,
    match_key: matchKey ?? null,
    match_number: matchNumber ?? null,
    comp_level: compLevel ?? null,
    alliance: alliance ?? null,
    data: data ?? {},
    notes: notes || null,
    scout_id: scoutId ?? currentUid(),
    recorded_at: recordedAt.toISOString(),
    // The UTC day the daily allowance is counted in, and the rules check it
    // against recorded_at.
    recorded_day: recordedDay(recordedAt),
    // Match entries have no slot. A pit or strategy pass is given 1 or 2 when it
    // is delivered, by whichever of the day's two documents is still free.
    slot: null,
  })
}

/**
 * Entries, newest first, with the scout's name on each.
 *
 * One query, whatever the limit: the CSV export asks for 5000 and Analytics for
 * 4000, and both get what they asked for. `scout_name` comes from the roster (one
 * small read, kept for the session), so a CSV export and the entry lists read
 * "Alex Rivera", not an id; it is null when the scout's profile is gone — the
 * entry survives, its author is just unknown.
 *
 * The filters used together need the composite indexes in
 * firebase/firestore.indexes.json (event; event + kind; event + team; event +
 * team + kind; team).
 */
export async function listEntries({ eventKey, teamNumber, kind, limit = 200 } = {}) {
  return answer([], async () => {
    const filters = []
    if (eventKey) filters.push(where('event_key', '==', eventKey))
    if (teamNumber) filters.push(where('team_number', '==', Number(teamNumber)))
    if (kind) filters.push(where('kind', '==', kind))
    const [snap, names] = await Promise.all([
      getDocsFromServer(query(col('scout_entries'), ...filters, orderBy('recorded_at', 'desc'), take(limit))),
      memberNames(),
    ])
    return rows(snap).map((r) => ({ ...r, scout_name: names.get(r.scout_id)?.full_name ?? null }))
  })
}

// How many pit/strategy passes this scout has left on a team today. The two
// passes a day are two documents with known ids (…:{day}:1 and …:{day}:2), so
// this reads both and counts the ones that exist. Surfaced BEFORE a scout invests
// in a thirty-field form, so "daily limit reached" is a heads-up, not a rejection
// after the work is done. Match scouting is unlimited (bounded per-match), so
// callers only ask for pit/strategy.
export async function passesRemaining(teamNumber, kind, eventKey) {
  if (!isConfigured || !teamNumber) return { data: null, error: null }
  if (kind === 'match') return { data: 99, error: null }
  const scout = currentUid()
  if (!scout) return { data: null, error: null }
  try {
    const pass = {
      kind,
      event_key: eventKey ?? null,
      team_number: Number(teamNumber),
      scout_id: scout,
      recorded_day: recordedDay(new Date()),
    }
    const slots = await Promise.all(
      Array.from({ length: PASSES_PER_DAY }, (_, i) =>
        getDocFromServer(doc(db, 'scout_entries', entryId({ ...pass, slot: i + 1 })))
      )
    )
    return { data: PASSES_PER_DAY - slots.filter((s) => s.exists()).length, error: null }
  } catch (error) {
    return { data: null, error: wrap(error) }
  }
}

/**
 * Every team's aggregate at an event, best average first.
 *
 * `team_event_stats` is a collection the Cloud Functions keep — recomputed from a
 * team's entries whenever one changes — so nothing is aggregated here. A team
 * with no observed score (seen only in the pit so far) sorts last.
 */
export async function teamStats(eventKey) {
  return answer([], async () => {
    const snap = await getDocsFromServer(query(col('team_event_stats'), where('event_key', '==', eventKey)))
    const bestFirst = (a, b) =>
      a.avg_score == null ? (b.avg_score == null ? 0 : 1) : b.avg_score == null ? -1 : b.avg_score - a.avg_score
    return rows(snap).sort((a, b) => bestFirst(a, b) || a.team_number - b.team_number)
  })
}

/**
 * One team's aggregate document from `team_event_stats`.
 *
 * `teamStats` above pulls the whole event ordered for a leaderboard; this is the
 * single-document read the team-detail screen wants instead of dragging sixty
 * rows over a venue network to keep one. A team nobody has scouted or
 * photographed yet has NO document at all. That is a first-morning state, not an
 * error, so it comes back as { data: null }.
 *
 * Every scoring number in the row is match-only and the pit estimate is kept
 * apart from it — that separation is deliberate, so a caller must surface
 * `pit_estimate` on its own and never fold it into `avg_score`.
 */
export async function teamStat(eventKey, teamNumber) {
  return answer(null, async () =>
    row(await getDocFromServer(doc(db, 'team_event_stats', teamStatId(eventKey, teamNumber))))
  )
}

/**
 * A team's collaboration notes folded into one summary. Pure.
 *
 * `workability` is null until at least two INDEPENDENT observers have weighed in:
 * a single opinion about another school's students is exactly what this exists to
 * withhold. An answer nobody gave (null) is never counted as a "no".
 */
export function collaborationSummary(notes) {
  if (!notes.length) return null
  const mean = (key) => {
    const given = notes.map((n) => n[key]).filter((v) => v != null)
    return given.length ? given.reduce((sum, v) => sum + v, 0) / given.length : null
  }
  const count = (test) => notes.filter(test).length
  const observers = new Set(notes.map((n) => n.observed_by).filter((v) => v != null)).size
  const communication = mean('communication_rating')
  const coordination = mean('coordination_rating')
  return {
    event_key: notes[0].event_key ?? null,
    team_number: notes[0].team_number,
    observations: notes.length,
    observers,
    avg_communication: communication == null ? null : round1(communication),
    avg_coordination: coordination == null ? null : round1(coordination),
    would_partner: count((n) => n.would_partner_again === true),
    would_not_partner: count((n) => n.would_partner_again === false),
    unanswered_questions: count((n) => n.answered_questions === false),
    withheld_strategy: count((n) => n.shared_strategy === false),
    // A rating nobody gave counts as the midpoint, 3.
    workability: observers >= 2 ? round1(((communication ?? 3) + (coordination ?? 3)) / 2) : null,
    last_observed: notes.map((n) => n.observed_at).filter(Boolean).sort().pop() ?? null,
  }
}

/**
 * One team's collaboration summary — the "workability" signal.
 *
 * Computed here from that team's notes at the event (one per observer, so a
 * handful of documents). A non-null row can still be reporting "not enough data":
 * the detail screen reads `observers` to decide whether to show anything at all.
 * A team with no observation has no summary, which is the common case and not an
 * error.
 */
export async function teamCollaboration(eventKey, teamNumber) {
  return answer(null, async () => {
    const snap = await getDocsFromServer(
      query(
        col('team_collaboration'),
        where('event_key', '==', eventKey),
        where('team_number', '==', Number(teamNumber))
      )
    )
    return collaborationSummary(rows(snap))
  })
}

/**
 * Robot photos for a team, newest first, each carrying the `file` its bytes live
 * at: { id, bucket, path }, embedded in the photo document because there are no
 * joins.
 *
 * The caller turns each into something an <img> can show through
 * `portalApi.signedUrl` (team media is private). RobotCapture writes a fresh
 * document per retake, so one angle can carry several — ordered newest-first here
 * so a reader can lead with the latest and still see the rest.
 */
export async function teamPhotos(eventKey, teamNumber) {
  return answer([], async () => {
    const snap = await getDocsFromServer(
      query(
        col('robot_photos'),
        where('event_key', '==', eventKey),
        where('team_number', '==', Number(teamNumber))
      )
    )
    return rows(snap).sort((a, b) => nullsLast(b.created_at, a.created_at))
  })
}

// --- repo sources -------------------------------------------------------------
//
// No screen uses these. The collection is read by members and written by admins.

export async function listRepoSources() {
  return answer([], async () =>
    rows(await getDocsFromServer(col('repo_sources'))).sort((a, b) => nullsLast(a.label, b.label))
  )
}

export async function saveRepoSource(source) {
  if (!isConfigured) return { data: null, error: NOT_CONNECTED }
  const { id, created_at: _created, updated_at: _updated, ...fields } = source
  const ref = id ? doc(db, 'repo_sources', id) : doc(col('repo_sources'))
  try {
    await commit((tx) =>
      id
        ? tx.update(ref, { ...fields, updated_at: now() })
        : tx.set(ref, { ...fields, created_by: fields.created_by ?? currentUid(), created_at: now(), updated_at: now() })
    )
    return { data: await stored(ref, { id: ref.id, ...fields }), error: null }
  } catch (error) {
    return { data: null, error: wrap(error) }
  }
}

/**
 * Pulling a repository on demand has no Cloud Function behind it: the nightly
 * archive on the backup host does that job, and no screen ever called this. Kept
 * so an old import still resolves, and answers plainly.
 */
export async function triggerRepoSync() {
  if (!isConfigured) return { data: null, error: NOT_CONNECTED }
  return { data: null, error: 'Repositories are archived by the nightly backup job; there is nothing to trigger from the portal.' }
}

// --- AI -----------------------------------------------------------------------

/**
 * Ask the `ai` function for a scouting summary or pick-list help.
 *
 * The OpenAI key lives with the function. It answers with its payload directly
 * ({ task, summary | answer, model, usage, … }) and refuses with a sentence of
 * its own — "OPENAI_API_KEY is not configured on the server." reaches the person
 * who pressed the button.
 */
export async function askAi(task, params = {}) {
  return call('ai', { task, ...params })
}

// --- pick lists ----------------------------------------------------------------
//
// These are the one set of scouting writes that do NOT go through the offline
// queue, and the exception is deliberate rather than an oversight.
//
// A queued write is a promise to apply something later. That is exactly right
// for a scouting entry — the match happened, the observation is true whenever
// it lands. It is exactly wrong for a pick list. A reorder is a claim about a
// shared, contested ordering that several people are editing at once; replaying
// one twenty minutes late would silently undo whatever was decided in between.
// Worse, the rules refuse writes to a locked list, so a queued drag would be
// accepted by the queue, held, and then bounce off the server long after the
// person who made it walked away. A pick list edit either lands now, against the
// list as it currently is, or it fails loudly and the board rolls back. There is
// no useful third option — which is also why these go through `commit`.

// Teams and their aggregates for an event, read once for callers that ask at the
// same moment: the coverage summary and the checklist are both built from them.
const reading = new Map()
function eventScouting(eventKey) {
  if (!reading.has(eventKey)) {
    reading.set(
      eventKey,
      Promise.all([
        getDocsFromServer(query(col('event_teams'), where('event_key', '==', eventKey))),
        getDocsFromServer(query(col('team_event_stats'), where('event_key', '==', eventKey))),
      ])
        .then(([teams, stats]) => ({
          teams: rows(teams).sort((a, b) => a.team_number - b.team_number),
          stats: new Map(rows(stats).map((s) => [s.team_number, s])),
        }))
        .finally(() => reading.delete(eventKey))
    )
  }
  return reading.get(eventKey)
}

/**
 * "Has everyone been scouted", as one row. Pure.
 *
 * `teams_scouted` counts teams with MATCH entries only. `min_matches` is the
 * fewest matches among teams that have any entry at all, as it always was: a team
 * nobody has touched is counted in `teams_unscouted`, not as a minimum of zero.
 */
export function coverageOf(eventKey, teams, stats) {
  if (!teams.length) return null
  const matches = teams.map((t) => stats.get(t.team_number)?.matches_scouted ?? 0)
  const seen = teams
    .map((t) => stats.get(t.team_number))
    .filter((s) => s && (s.matches_scouted ?? 0) + (s.pit_visits ?? 0) + (s.notes_logged ?? 0) > 0)
    .map((s) => s.matches_scouted ?? 0)
  const scouted = matches.filter((m) => m > 0).length
  return {
    event_key: eventKey,
    teams_at_event: teams.length,
    teams_scouted: scouted,
    teams_unscouted: teams.length - scouted,
    min_matches: seen.length ? Math.min(...seen) : 0,
    avg_matches: round1(matches.reduce((sum, m) => sum + m, 0) / teams.length),
    fully_covered: scouted === teams.length,
  }
}

/** One checklist row per team at the event, including teams nobody has touched. Pure. */
export function checklistOf(eventKey, teams, stats) {
  return teams.map((t) => {
    const s = stats.get(t.team_number) ?? {}
    const matches = s.matches_scouted ?? 0
    const pit = s.pit_visits ?? 0
    const photos = s.photos ?? 0
    return {
      event_key: eventKey,
      team_number: t.team_number,
      nickname: t.nickname ?? null,
      match_passes: matches,
      pit_passes: pit,
      note_passes: s.notes_logged ?? 0,
      scouts: s.scouts ?? 0,
      photos,
      last_scouted: s.last_seen ?? null,
      pit_done: pit > 0,
      match_done: matches > 0,
      has_photos: photos > 0,
    }
  })
}

/**
 * The "has everyone been scouted" question as one row, computed from the event's
 * team list and the per-team aggregates rather than by pulling every entry down
 * and counting here.
 *
 * An event with no teams cached yet produces no row at all, and that is a
 * legitimate state on the morning of a competition rather than an error worth
 * showing a student.
 */
export async function eventCoverage(eventKey) {
  return answer(null, async () => {
    const { teams, stats } = await eventScouting(eventKey)
    return coverageOf(eventKey, teams, stats)
  })
}

/**
 * One row per team at an event: what has been recorded about it so far.
 *
 * Ordered by team number here, which is deliberately NOT the order the screen
 * shows. The sort that matters — who is still missing — depends on which gap
 * the strategy lead is chasing and changes every time they re-aim, so it is done
 * in the browser against a list of sixty rows where it costs nothing.
 */
export async function teamChecklist(eventKey) {
  return answer([], async () => {
    const { teams, stats } = await eventScouting(eventKey)
    return checklistOf(eventKey, teams, stats)
  })
}

/** What a new pick list starts with. A list keeps its own copy, so renaming a tier is a data change. */
export const DEFAULT_PICKLIST_TIERS = [
  { key: 's', label: 'S' },
  { key: 'a', label: 'A' },
  { key: 'b', label: 'B' },
  { key: 'c', label: 'C' },
  { key: 'unranked', label: 'Unranked' },
]

const entriesOf = (picklistId) => collection(db, 'picklists', picklistId, 'entries')
// An entry's id is its team number: one entry per team per list, by construction.
const entryRef = (picklistId, id) => doc(db, 'picklists', picklistId, 'entries', String(id))

export async function listPicklists(eventKey) {
  return answer([], async () => {
    const snap = await getDocsFromServer(query(col('picklists'), where('event_key', '==', eventKey)))
    return rows(snap).sort((a, b) => nullsLast(b.updated_at, a.updated_at))
  })
}

export async function createPicklist({ eventKey, name, userId }) {
  if (!isConfigured) return { data: null, error: NOT_CONNECTED }
  const ref = doc(col('picklists'))
  const list = {
    event_key: eventKey,
    name: name || 'Pick list',
    tiers: DEFAULT_PICKLIST_TIERS,
    is_locked: false,
    locked_at: null,
    locked_by: null,
    created_by: userId ?? currentUid(),
  }
  try {
    await commit((tx) => tx.set(ref, { ...list, created_at: now(), updated_at: now() }))
    return { data: { id: ref.id, ...list, created_at: isoNow(), updated_at: isoNow() }, error: null }
  } catch (error) {
    return { data: null, error: wrap(error) }
  }
}

/** A list's entries, in position order. Each row's `id` is its team number, as a string. */
export async function picklistEntries(picklistId) {
  return answer([], async () => {
    const snap = await getDocsFromServer(entriesOf(picklistId))
    return rows(snap)
      .map((e) => ({ ...e, picklist_id: picklistId }))
      .sort((a, b) => a.position - b.position)
  })
}

// A locked list refuses entry writes in the security rules, not in the UI — it
// has to hold against a second browser tab and a stale client. So every write
// path below can fail this way even when the button was enabled, and the rules
// answer every refusal with the same "permission denied". The list itself says
// which refusal it was: if it is locked, that is the reason, and it is said in
// the words written for the person who hit it.
const LOCKED =
  'this pick list is locked. Unlock it first — it was frozen to preserve what was read on the field.'

async function lockAware(error, picklistId) {
  if (codeOf(error).includes('permission-denied')) {
    try {
      const list = await getDocFromServer(doc(db, 'picklists', picklistId))
      if (list.exists() && list.data().is_locked) return LOCKED
    } catch {
      // Could not ask; the plain refusal below is still true.
    }
  }
  if (codeOf(error).includes('not-found')) return 'That team is no longer on this pick list. Reload the board.'
  return wrap(error)
}

// Firestore commits at most 500 writes at once; an event has far fewer teams, but
// nothing here should depend on that.
const chunked = (list, size = 400) =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size))

/**
 * Put teams onto the list. An entry's id is its team number, so seeding the same
 * teams twice (two leads opening a new board in the same minute) writes the same
 * documents rather than duplicates.
 *
 * Positions are handed in already spaced, because a tier where every row shares
 * a position has no gaps to bisect — the first drag would immediately force a
 * re-space of the whole thing.
 */
export async function addPicklistTeams(picklistId, teams, userId) {
  if (!isConfigured) return { data: [], error: NOT_CONNECTED }
  if (!teams.length) return { data: [], error: null }
  const entries = teams.map((r) => ({
    team_number: Number(r.team_number),
    tier: r.tier,
    position: r.position,
    note: null,
    overrides_ai: false,
    updated_by: userId ?? currentUid(),
  }))
  try {
    for (const part of chunked(entries)) {
      await commit((tx) => {
        for (const e of part) tx.set(entryRef(picklistId, e.team_number), { ...e, updated_at: now() })
      })
    }
    return {
      data: entries.map((e) => ({ id: String(e.team_number), picklist_id: picklistId, ...e, updated_at: isoNow() })),
      error: null,
    }
  } catch (error) {
    return { data: [], error: await lockAware(error, picklistId) }
  }
}

/**
 * A drag, committed. ONE document.
 *
 * The caller has already bisected between the drop's two neighbours (see
 * position.js), so this is a single write regardless of how far the card
 * travelled or how many cards sit below it. That property is the whole reason
 * the position field is sparse, and it is what keeps a reorder to one request
 * on the worst network of the year.
 *
 * `id` is the entry's id (its team number) and `picklistId` the list it is on.
 * Only the fields that moved are sent, so a drag cannot write a stale copy of
 * someone's note back over a fresh one; `data` is therefore what was written,
 * not the whole entry.
 */
export async function movePicklistEntry({ id, picklistId, tier, position, overridesAi, userId }) {
  if (!isConfigured) return { data: null, error: NOT_CONNECTED }
  const patch = { tier, position, updated_by: userId ?? currentUid() }
  // Only written when the caller has an opinion. `undefined` means "no AI
  // proposal is on screen", which must not be allowed to quietly clear a flag
  // someone set earlier in the session.
  if (overridesAi != null) patch.overrides_ai = overridesAi
  try {
    await commit((tx) => tx.update(entryRef(picklistId, id), { ...patch, updated_at: now() }))
    return {
      data: { id: String(id), picklist_id: picklistId, team_number: Number(id), ...patch, updated_at: isoNow() },
      error: null,
    }
  } catch (error) {
    return { data: null, error: await lockAware(error, picklistId) }
  }
}

/**
 * Renumber one tier back to 10, 20, 30 … in a single commit.
 *
 * The fallback path, reached only when a gap has been bisected past the point
 * where halving it again means anything. All N entries go in one commit, so they
 * cost one request instead of N and the tier is never seen half-renumbered.
 *
 * `note` and `overrides_ai` are deliberately absent from what is sent. An update
 * changes only the fields it names, so a re-space cannot blank the field that is
 * the most valuable one on the entry.
 */
export async function respacePicklistTier({ picklistId, rows: moved, userId }) {
  if (!isConfigured) return { data: [], error: NOT_CONNECTED }
  if (!moved.length) return { data: [], error: null }
  const updatedBy = userId ?? currentUid()
  try {
    await commit((tx) => {
      for (const r of moved) {
        tx.update(entryRef(picklistId, r.id), {
          tier: r.tier,
          position: r.position,
          updated_by: updatedBy,
          updated_at: now(),
        })
      }
    })
    return {
      data: moved.map((r) => ({
        id: String(r.id),
        picklist_id: picklistId,
        team_number: r.team_number,
        tier: r.tier,
        position: r.position,
        updated_by: updatedBy,
        updated_at: isoNow(),
      })),
      error: null,
    }
  } catch (error) {
    return { data: [], error: await lockAware(error, picklistId) }
  }
}

export async function setPicklistNote({ id, picklistId, note, userId }) {
  if (!isConfigured) return { data: null, error: NOT_CONNECTED }
  const ref = entryRef(picklistId, id)
  const patch = { note: note?.trim() ? note.trim() : null, updated_by: userId ?? currentUid() }
  try {
    await commit((tx) => tx.update(ref, { ...patch, updated_at: now() }))
    const sent = { id: String(id), team_number: Number(id), ...patch, updated_at: isoNow() }
    return { data: { ...(await stored(ref, sent)), picklist_id: picklistId }, error: null }
  } catch (error) {
    return { data: null, error: await lockAware(error, picklistId) }
  }
}

/**
 * Freeze or unfreeze the list.
 *
 * `locked_at` and `locked_by` are cleared on unlock rather than left behind, so
 * "when was this frozen" never answers with a timestamp from a previous freeze
 * that has since been undone. The list document itself is never frozen — only
 * its entries are — so a lead can always unlock.
 */
export async function setPicklistLock({ id, locked, userId }) {
  if (!isConfigured) return { data: null, error: NOT_CONNECTED }
  const ref = doc(db, 'picklists', id)
  const lockedBy = locked ? (userId ?? currentUid()) : null
  try {
    await commit((tx) =>
      tx.update(ref, {
        is_locked: locked,
        locked_at: locked ? now() : null,
        locked_by: lockedBy,
        updated_at: now(),
      })
    )
    const sent = { id, is_locked: locked, locked_at: locked ? isoNow() : null, locked_by: lockedBy, updated_at: isoNow() }
    return { data: await stored(ref, sent), error: null }
  } catch (error) {
    return { data: null, error: wrap(error) }
  }
}

// --- nexus (live event status) ------------------------------------------------

/**
 * Live field/queuing status for an event from Nexus for FRC, via the
 * `nexusProxy` function.
 *
 * Nexus answers "what is about to happen on the field" — which match is queuing,
 * estimated vs scheduled times, announcements. It is deliberately NOT results:
 * scores/OPR/rankings come from `syncFromTba`. TBA is the past, Nexus is the next
 * ten minutes. The NEXUS_KEY is server-side only, so — like TBA — this routes
 * through a function rather than the browser.
 *
 * Returns `{ event_key, nexus (Nexus's raw payload), summary (best-effort pill
 * fields) }`. The raw payload is always present, so the UI reads it defensively
 * and a field the proxy guessed wrong about is a UI fix, not a redeploy.
 */
export async function nexusStatus(eventKey, { force = false } = {}) {
  if (!isConfigured) return { data: null, error: NOT_CONNECTED }
  if (!eventKey) return { data: null, error: null }
  return call('nexusProxy', { action: 'event_status', eventKey, force })
}

// --- vision pipeline (on-device detection) ------------------------------------
//
// The "master device" streams detections, not video — a phone runs an object
// detector locally and only the counts and boxes leave it. These writes are
// BEST-EFFORT and deliberately NOT on the offline queue: they are high-frequency,
// and a dropped batch of frames is acceptable where a dropped scouting entry
// never is. The capture UI holds unsent batches and retries; a failure here comes
// back as { error }, it does not throw.

// The highest count each session has seen, as far as this page knows. Firestore
// can add to a stored number without reading it but cannot take a maximum, and
// the device capturing a session is the only one writing its frames.
const peaks = new Map()

/**
 * Open a capture session. `model` is required and names WHAT produced the
 * numbers — today a generic detector, later a trained model — so every
 * observation stays honestly attributable. `userId` must be the caller's own id:
 * the rules refuse a session opened in someone else's name. The operator's name
 * is copied onto the session now, so the session list never has to look it up.
 */
export async function startVisionSession({
  eventKey,
  matchKey,
  deviceLabel,
  model,
  modelNote,
  userId,
}) {
  if (!isConfigured) return { data: null, error: NOT_CONNECTED }
  const startedBy = userId ?? currentUid()
  const ref = doc(col('vision_sessions'))
  try {
    const names = await memberNames()
    const session = {
      event_key: eventKey ?? null,
      match_key: matchKey ?? null,
      device_label: deviceLabel ?? null,
      model,
      model_note: modelNote ?? null,
      started_by: startedBy,
      operator: names.get(startedBy)?.full_name ?? null,
      ended_at: null,
      frame_count: 0,
      // Kept up by pushVisionObservations in the same commit as the frames, so
      // the session list shows totals without reading a single frame.
      observations: 0,
      peak_count: null,
      count_sum: 0,
    }
    await commit((tx) => tx.set(ref, { ...session, started_at: now(), created_at: now() }))
    peaks.set(ref.id, null)
    return { data: { id: ref.id, ...session, started_at: isoNow(), created_at: isoNow() }, error: null }
  } catch (error) {
    return { data: null, error: wrap(error) }
  }
}

export async function endVisionSession(id, frameCount) {
  if (!isConfigured) return { data: null, error: NOT_CONNECTED }
  const patch = {}
  if (Number.isFinite(frameCount)) patch.frame_count = Math.max(0, Math.round(frameCount))
  try {
    await commit((tx) => tx.update(doc(db, 'vision_sessions', id), { ...patch, ended_at: now() }))
    peaks.delete(id)
    return { data: { id, ...patch, ended_at: isoNow() }, error: null }
  } catch (error) {
    return { data: null, error: wrap(error) }
  }
}

/**
 * Push a batch of observations for a session. Rows are `{ offsetMs, objectCount,
 * detections, teamNumber? }`. The rules let a member write only into a session
 * they started, so the caller must pass the id returned by startVisionSession.
 *
 * The frames and the session's counters go in ONE commit, so the totals the
 * session list shows can never disagree with the frames underneath them.
 */
export async function pushVisionObservations(sessionId, frames) {
  if (!isConfigured) return { error: NOT_CONNECTED }
  if (!sessionId || !frames?.length) return { error: null }
  const session = doc(db, 'vision_sessions', sessionId)
  try {
    if (!peaks.has(sessionId)) {
      // A session this page did not open (a reload mid-capture): ask once.
      const snap = await getDocFromServer(session)
      peaks.set(sessionId, snap.exists() ? (snap.data().peak_count ?? null) : null)
    }
    for (const part of chunked(frames)) {
      const docs = part.map((r) => ({
        offset_ms: Math.round(r.offsetMs ?? 0),
        object_count: Math.max(0, Math.round(r.objectCount ?? 0)),
        // The rules cap a frame at 300 boxes; a detector reports a few dozen.
        detections: (r.detections ?? []).slice(0, 300),
        team_number: r.teamNumber == null ? null : Number(r.teamNumber),
      }))
      const sum = docs.reduce((total, d) => total + d.object_count, 0)
      const peak = Math.max(peaks.get(sessionId) ?? 0, ...docs.map((d) => d.object_count))
      await commit((tx) => {
        for (const d of docs) {
          tx.set(doc(collection(session, 'observations')), { ...d, recorded_at: now(), created_at: now() })
        }
        tx.update(session, { observations: increment(docs.length), count_sum: increment(sum), peak_count: peak })
      })
      peaks.set(sessionId, peak)
    }
    return { error: null }
  } catch (error) {
    return { error: wrap(error) }
  }
}

/**
 * Capture sessions, newest first, each with its totals: `observations`,
 * `peak_count` and `avg_count` (null for a session that recorded no frames).
 * The totals are counters on the session document, so no frame is read here.
 */
export async function listVisionSessions(eventKey, limit = 50) {
  return answer([], async () => {
    const filters = eventKey ? [where('event_key', '==', eventKey)] : []
    const snap = await getDocsFromServer(
      query(col('vision_sessions'), ...filters, orderBy('started_at', 'desc'), take(limit))
    )
    return rows(snap).map((s) => ({
      ...s,
      avg_count: s.observations > 0 ? round1(s.count_sum / s.observations) : null,
    }))
  })
}

export async function visionFrames(sessionId, limit = 3000) {
  return answer([], async () =>
    rows(
      await getDocsFromServer(
        query(collection(db, 'vision_sessions', sessionId, 'observations'), orderBy('offset_ms'), take(limit))
      )
    )
  )
}

/**
 * The detection model configured for the vision pipeline, read off the scouting
 * settings. A null `vision_model_url` means the built-in generic detector.
 * member+ may read it (an operator's phone has to load the model to capture);
 * lead+ changes it through `saveScoutSettings`, so there is no separate writer
 * here.
 */
export async function visionModelConfig() {
  return answer(null, async () => {
    const s = await readSettings()
    return {
      vision_model_url: s.vision_model_url,
      vision_model_name: s.vision_model_name,
      vision_model_labels: s.vision_model_labels,
      vision_model_size: s.vision_model_size,
    }
  })
}
