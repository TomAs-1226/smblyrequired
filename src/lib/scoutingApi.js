import { supabase, isConfigured } from './supabase'
import { enqueue } from './offlineQueue'

// -----------------------------------------------------------------------------
// Scouting data access.
//
// Reads go straight to Supabase; WRITES GO THROUGH THE OFFLINE QUEUE, always,
// even when the connection looks fine. A scout should never encounter two
// different save behaviours depending on signal strength — and "looks fine" at
// a competition venue is frequently a captive portal that will swallow the
// request. One path, one set of failure modes, one place to get it right.
// -----------------------------------------------------------------------------

const NOT_CONFIGURED = 'The portal is not connected to a backend yet.'

function wrap(error) {
  if (!error) return null
  if (/JWT|not authenticated/i.test(error.message)) return 'Your session expired. Sign in again.'
  if (/permission denied|row-level security/i.test(error.message))
    return 'You do not have access to that.'
  return error.message
}

// --- events & teams (TBA-backed cache) ---------------------------------------

export async function listEvents(year) {
  if (!isConfigured) return { data: [], error: NOT_CONFIGURED }
  const { data, error } = await supabase
    .from('events')
    .select('key, name, short_name, city, state_prov, start_date, end_date, week')
    .eq('year', year)
    .order('start_date')
  return { data: data ?? [], error: wrap(error) }
}

export async function listEventTeams(eventKey) {
  if (!isConfigured) return { data: [], error: NOT_CONFIGURED }
  const { data, error } = await supabase
    .from('event_teams')
    .select('team_number, nickname, city, state_prov, rookie_year')
    .eq('event_key', eventKey)
    .order('team_number')
  return { data: data ?? [], error: wrap(error) }
}

/**
 * Refresh the cache from The Blue Alliance via the edge proxy.
 *
 * The TBA key is server-side only, so this cannot be called directly from the
 * browser — which is also why the tables above exist rather than querying TBA
 * live from every scout's phone on a saturated network.
 */
export async function syncFromTba(action, params = {}) {
  if (!isConfigured) return { data: null, error: NOT_CONFIGURED }
  const { data, error } = await supabase.functions.invoke('tba-proxy', {
    body: { action, ...params },
  })
  if (error) return { data: null, error: wrap(error) }
  if (data?.error) return { data: null, error: data.error }
  return { data: data?.data ?? data, error: null }
}

// --- forms --------------------------------------------------------------------

export async function activeForm(season, kind) {
  if (!isConfigured) return { data: null, error: NOT_CONFIGURED }
  const { data, error } = await supabase
    .from('scout_forms')
    .select('id, season, kind, name, description, fields')
    .eq('season', season)
    .eq('kind', kind)
    .eq('is_active', true)
    .maybeSingle()
  return { data, error: wrap(error) }
}

export async function listForms(season) {
  if (!isConfigured) return { data: [], error: NOT_CONFIGURED }
  let q = supabase
    .from('scout_forms')
    .select('id, season, kind, name, description, fields, is_active, updated_at')
    .order('season', { ascending: false })
    .order('kind')
  if (season) q = q.eq('season', season)
  const { data, error } = await q
  return { data: data ?? [], error: wrap(error) }
}

export async function saveForm(form) {
  if (!isConfigured) return { data: null, error: NOT_CONFIGURED }
  const row = {
    season: form.season,
    kind: form.kind,
    name: form.name,
    description: form.description || null,
    fields: form.fields,
    is_active: form.is_active ?? false,
  }
  const q = form.id
    ? supabase.from('scout_forms').update(row).eq('id', form.id)
    : supabase.from('scout_forms').insert(row)
  const { data, error } = await q.select().single()

  // The database validates field structure (migration 0005) and enforces one
  // active form per season+kind. Both messages are written to be read by a
  // mentor, so they are surfaced verbatim rather than flattened.
  if (error) {
    if (/field |duplicate field|fields must be/i.test(error.message))
      return { data: null, error: error.message }
    if (error.code === '23505')
      return {
        data: null,
        error:
          'Another form is already active for this season and type. Deactivate it first — ' +
          'two active forms would split the season across incompatible schemas.',
      }
  }
  return { data, error: wrap(error) }
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
 * reports a problem: the rows are still structurally valid, they have simply
 * become invisible. A silent wrong answer is worse than a loud failure, so the
 * builder locks the field rather than trusting anyone to remember.
 *
 * `head: true` so this costs a count and not the entries themselves — it runs
 * on the same venue network as everything else.
 */
export async function formEntryCount(formId) {
  if (!isConfigured) return { data: 0, error: NOT_CONFIGURED }
  // A form that has never been saved cannot have entries, and asking with a
  // null filter would happily count the entire table instead.
  if (!formId) return { data: 0, error: null }
  const { count, error } = await supabase
    .from('scout_entries')
    .select('id', { count: 'exact', head: true })
    .eq('form_id', formId)
  return { data: count ?? 0, error: wrap(error) }
}

/**
 * Publish a form, retiring whatever it replaces.
 *
 * `scout_forms_one_active` (migration 0005) is a PARTIAL unique index over
 * (season, kind) where is_active. Flipping a second form to active therefore
 * fails with a bare 23505 naming an index — accurate, and meaningless to the
 * mentor who just pressed Publish.
 *
 * Retiring the incumbent first turns the ordinary case into two plain updates
 * that cannot collide. The gap between them is the honest cost: for one round
 * trip the season has no active form at all. That is the safe direction to
 * fail — a scout who meets "no active form" goes and asks someone, whereas two
 * active forms quietly split the season across incompatible schemas and nobody
 * finds out until analysis.
 *
 * The publish itself goes back through `saveForm` rather than a bare update, so
 * a collision that survives the retirement (a second mentor, a second tab, the
 * same second) still comes back as the one sentence written for that case, and
 * so the 0005 field validation keeps reporting through a single path.
 */
export async function activateForm(form) {
  if (!isConfigured) return { data: null, error: NOT_CONFIGURED }

  let q = supabase
    .from('scout_forms')
    .update({ is_active: false })
    .eq('season', form.season)
    .eq('kind', form.kind)
    .eq('is_active', true)
  // Excluding the form being published keeps re-publishing something already
  // active from briefly un-publishing it mid-competition.
  if (form.id) q = q.neq('id', form.id)

  const { error } = await q
  if (error) return { data: null, error: wrap(error) }

  return saveForm({ ...form, is_active: true })
}

/**
 * Delete a form definition.
 *
 * `scout_entries.form_id` is ON DELETE SET NULL (migration 0005), so this never
 * deletes anything a student recorded — the entries survive, detached from the
 * questions that produced them. That is a deliberate schema choice, and it is
 * also exactly why the builder makes someone type the form's name first when
 * entries exist: the data is safe, but its meaning is not.
 */
export async function deleteForm(id) {
  if (!isConfigured) return { error: NOT_CONFIGURED }
  const { error } = await supabase.from('scout_forms').delete().eq('id', id)
  return { error: wrap(error) }
}

// --- scouting control (active event + time window) ----------------------------

// The live control state, computed server-side (timezone maths and all), so the
// browser never has to guess whether scouting is open. Everyone reads it; only
// leadership writes the underlying settings.
export async function scoutControl() {
  if (!isConfigured) return { data: null, error: NOT_CONFIGURED }
  const { data, error } = await supabase.from('scout_control_status').select('*').maybeSingle()
  return { data, error: wrap(error) }
}

export async function saveScoutSettings(patch) {
  if (!isConfigured) return { data: null, error: NOT_CONFIGURED }
  // Always the singleton row. RLS lets only lead+ through; a member's write is
  // refused by the policy, not by hiding the control.
  const { data, error } = await supabase
    .from('scout_settings')
    .update(patch)
    .eq('id', 1)
    .select()
    .single()
  return { data, error: wrap(error) }
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
    scout_id: scoutId,
    // Stamped on the device: this is when the match was actually watched, which
    // is the only ordering a human cares about. created_at (server-side) can be
    // hours later if the phone was offline all afternoon.
    recorded_at: new Date().toISOString(),
  })
}

export async function listEntries({ eventKey, teamNumber, kind, limit = 200 } = {}) {
  if (!isConfigured) return { data: [], error: NOT_CONFIGURED }
  let q = supabase
    .from('scout_entries')
    // Embeds the scout's name so a CSV export and the entry lists read "Alex
    // Rivera", not a UUID. The join is member+ under the roster read policy,
    // which every caller of this already is. `scout_name` is flattened onto the
    // row so consumers don't have to reach through the nested object.
    .select(
      'id, client_uuid, kind, event_key, team_number, match_key, match_number, comp_level, alliance, data, notes, scout_id, recorded_at, scout:profiles!scout_entries_scout_id_fkey(full_name)'
    )
    .order('recorded_at', { ascending: false })
    .limit(limit)
  if (eventKey) q = q.eq('event_key', eventKey)
  if (teamNumber) q = q.eq('team_number', teamNumber)
  if (kind) q = q.eq('kind', kind)
  const { data, error } = await q
  // Flatten the join so callers see a plain `scout_name` string (null when the
  // scout row was removed — the entry survives, its author is just unknown).
  const rows = (data ?? []).map((r) => ({ ...r, scout_name: r.scout?.full_name ?? null }))
  return { data: rows, error: wrap(error) }
}

// How many pit/strategy passes this scout has left on a team today, via the
// passes_remaining() RPC from migration 0007. Surfaced BEFORE a scout invests in
// a thirty-field form, so "daily limit reached" is a heads-up, not a rejection
// after the work is done. Match scouting is unlimited (bounded per-match), so
// callers only ask for pit/strategy.
export async function passesRemaining(teamNumber, kind, eventKey) {
  if (!isConfigured || !teamNumber) return { data: null, error: null }
  const { data, error } = await supabase.rpc('passes_remaining', {
    p_team: Number(teamNumber),
    p_kind: kind,
    p_event: eventKey ?? null,
  })
  return { data, error: wrap(error) }
}

export async function teamStats(eventKey) {
  if (!isConfigured) return { data: [], error: NOT_CONFIGURED }
  const { data, error } = await supabase
    .from('team_event_stats')
    .select('*')
    .eq('event_key', eventKey)
    .order('avg_score', { ascending: false, nullsFirst: false })
  return { data: data ?? [], error: wrap(error) }
}

/**
 * One team's aggregate row from `team_event_stats` (migration 0009).
 *
 * `teamStats` above pulls the whole event ordered for a leaderboard; this is the
 * single-row read the team-detail screen wants instead of dragging sixty rows
 * over a venue network to keep one. `maybeSingle`, not `single`: a team nobody
 * has scouted yet has NO row in the view at all — it groups `scout_entries`, and
 * a team with zero entries simply is not in the result. That is a first-morning
 * state, not an error, so it comes back as { data: null }.
 *
 * Every scoring number in the row is match-only and the pit estimate is kept
 * apart from it — that separation is the whole point of 0009, so a caller must
 * surface `pit_estimate` on its own and never fold it into `avg_score`.
 */
export async function teamStat(eventKey, teamNumber) {
  if (!isConfigured) return { data: null, error: NOT_CONFIGURED }
  const { data, error } = await supabase
    .from('team_event_stats')
    .select('*')
    .eq('event_key', eventKey)
    .eq('team_number', teamNumber)
    .maybeSingle()
  return { data, error: wrap(error) }
}

/**
 * One team's collaboration summary (migration 0008) — the "workability" signal.
 *
 * `workability` is null until at least two INDEPENDENT observers have weighed in;
 * the view enforces that floor, not this caller, so a non-null row can still be
 * reporting "not enough data". The detail screen reads `observers` to decide
 * whether to show anything at all — a single opinion about another school's
 * students is exactly what 0008 was written to withhold. `maybeSingle`: a team
 * with no observation has no row, which is the common case and not an error.
 */
export async function teamCollaboration(eventKey, teamNumber) {
  if (!isConfigured) return { data: null, error: NOT_CONFIGURED }
  const { data, error } = await supabase
    .from('team_collaboration_summary')
    .select('*')
    .eq('event_key', eventKey)
    .eq('team_number', teamNumber)
    .maybeSingle()
  return { data, error: wrap(error) }
}

/**
 * Robot photos for a team, newest first, each carrying the bucket + path its
 * bytes live at (migration 0005: `robot_photos.file_id` -> `files`).
 *
 * The embed is why this is its own query rather than a bare select: a photo row
 * records only a `file_id`, and minting a signed URL needs the bucket and path
 * that `files` holds. The caller mints those per photo through
 * `portalApi.signedUrl` (bucket 'media' is private). RobotCapture writes a fresh
 * row per retake with no unique index on (team, angle), so one angle can carry
 * several rows — ordered newest-first here so a reader can lead with the latest
 * and still see the rest. A row whose `file` came back null (the object was
 * deleted out from under it) is handed across as-is for the caller to skip.
 */
export async function teamPhotos(eventKey, teamNumber) {
  if (!isConfigured) return { data: [], error: NOT_CONFIGURED }
  const { data, error } = await supabase
    .from('robot_photos')
    .select('id, angle, created_at, quality, file:files(bucket, path)')
    .eq('event_key', eventKey)
    .eq('team_number', teamNumber)
    .order('created_at', { ascending: false })
  return { data: data ?? [], error: wrap(error) }
}

// --- repo sources -------------------------------------------------------------

export async function listRepoSources() {
  if (!isConfigured) return { data: [], error: NOT_CONFIGURED }
  const { data, error } = await supabase
    .from('repo_sources')
    .select('*')
    .order('label')
  return { data: data ?? [], error: wrap(error) }
}

export async function saveRepoSource(row) {
  if (!isConfigured) return { data: null, error: NOT_CONFIGURED }
  const q = row.id
    ? supabase.from('repo_sources').update(row).eq('id', row.id)
    : supabase.from('repo_sources').insert(row)
  const { data, error } = await q.select().single()
  return { data, error: wrap(error) }
}

export async function triggerRepoSync(id) {
  if (!isConfigured) return { data: null, error: NOT_CONFIGURED }
  const { data, error } = await supabase.functions.invoke('repo-sync', {
    body: id ? { force: true, id } : { force: true },
  })
  if (error) return { data: null, error: wrap(error) }
  return { data, error: data?.error ?? null }
}

// --- AI -----------------------------------------------------------------------

export async function askAi(task, params = {}) {
  if (!isConfigured) return { data: null, error: NOT_CONFIGURED }
  const { data, error } = await supabase.functions.invoke('ai', { body: { task, ...params } })

  if (error) {
    // supabase-js throws FunctionsHttpError on any non-2xx AND DISCARDS THE BODY,
    // so the edge function's actual message — e.g. "OPENAI_API_KEY is not
    // configured on the server." — never reaches here. All the caller gets is
    // "Edge Function returned a non-2xx status code", which is useless to the
    // person reading it. Recover the real message where the SDK exposes the
    // response, and fall back to something honest rather than pretending to
    // know a cause we cannot see.
    const body = await error?.context?.json?.().catch(() => null)
    if (body?.error) return { data: null, error: body.error }
    if (/non-2xx/i.test(String(error.message ?? ''))) {
      return {
        data: null,
        error:
          'The AI service rejected that request. It is most often an unset ' +
          'OPENAI_API_KEY, or your role not being high enough — check the ' +
          'function logs in Supabase for the actual reason.',
      }
    }
    return { data: null, error: wrap(error) }
  }

  if (data?.error) return { data: null, error: data.error }
  // The edge function wraps its payload as {data, error} (see _shared/auth.ts's
  // ok() helper), so unwrap one level — matching what syncFromTba already does.
  // Without this the payload sits at res.data.data and every caller has to know.
  return { data: data?.data ?? data, error: null }
}

// --- pick lists ----------------------------------------------------------------
//
// These are the one set of writes in this file that do NOT go through the
// offline queue, and the exception is deliberate rather than an oversight.
//
// A queued write is a promise to apply something later. That is exactly right
// for a scouting entry — the match happened, the observation is true whenever
// it lands. It is exactly wrong for a pick list. A reorder is a claim about a
// shared, contested ordering that several people are editing at once; replaying
// one twenty minutes late would silently undo whatever was decided in between.
// Worse, `picklist_entries` has a trigger that rejects writes to a locked list,
// so a queued drag would be accepted by the queue, held, and then bounce off the
// database long after the person who made it walked away. A pick list edit
// either lands now, against the list as it currently is, or it fails loudly and
// the board rolls back. There is no useful third option.

/**
 * `event_scout_coverage` (migration 0006) — the "has everyone been scouted"
 * question as one row rather than pulling every entry down and counting here.
 *
 * `maybeSingle`, not `single`: an event with no `event_teams` rows yet produces
 * no row at all, and that is a legitimate state on the morning of a competition
 * rather than an error worth showing a student.
 */
export async function eventCoverage(eventKey) {
  if (!isConfigured) return { data: null, error: NOT_CONFIGURED }
  const { data, error } = await supabase
    .from('event_scout_coverage')
    .select('*')
    .eq('event_key', eventKey)
    .maybeSingle()
  return { data, error: wrap(error) }
}

/**
 * `team_scout_checklist` (migration 0007) — one row per team at an event.
 *
 * Ordered by team number here, which is deliberately NOT the order the screen
 * shows. The sort that matters — who is still missing — depends on which gap
 * the strategy lead is chasing and changes every time they re-aim, so it is done
 * in the browser against a list of sixty rows where it costs nothing. Sorting
 * server-side would spend a round trip on the worst network of the year every
 * time somebody changed their mind.
 */
export async function teamChecklist(eventKey) {
  if (!isConfigured) return { data: [], error: NOT_CONFIGURED }
  const { data, error } = await supabase
    .from('team_scout_checklist')
    .select('*')
    .eq('event_key', eventKey)
    .order('team_number')
  return { data: data ?? [], error: wrap(error) }
}

export async function listPicklists(eventKey) {
  if (!isConfigured) return { data: [], error: NOT_CONFIGURED }
  const { data, error } = await supabase
    .from('picklists')
    .select('id, event_key, name, tiers, is_locked, locked_at, locked_by, created_at, updated_at')
    .eq('event_key', eventKey)
    .order('updated_at', { ascending: false })
  return { data: data ?? [], error: wrap(error) }
}

export async function createPicklist({ eventKey, name, userId }) {
  if (!isConfigured) return { data: null, error: NOT_CONFIGURED }
  const { data, error } = await supabase
    .from('picklists')
    // `tiers` is left to the column default so a new list starts on the schema's
    // S/A/B/C/Unranked rather than on a copy of it made here — the default lives
    // in one place and renaming a tier stays a data change, not a code change.
    .insert({ event_key: eventKey, name: name || 'Pick list', created_by: userId ?? null })
    .select('id, event_key, name, tiers, is_locked, locked_at, locked_by, created_at, updated_at')
    .single()
  return { data, error: wrap(error) }
}

export async function picklistEntries(picklistId) {
  if (!isConfigured) return { data: [], error: NOT_CONFIGURED }
  const { data, error } = await supabase
    .from('picklist_entries')
    .select('id, picklist_id, team_number, tier, position, note, overrides_ai, updated_at')
    .eq('picklist_id', picklistId)
    .order('position')
  return { data: data ?? [], error: wrap(error) }
}

// A locked list rejects writes in the database, not in the UI — that is the
// point of doing it with a trigger (migration 0006: it has to hold against a
// second browser tab and a stale client). So every write path below can fail
// this way even when the button was enabled, and "this pick list is locked" with
// the trigger's own hint is far more use than "something went wrong". Both are
// forwarded verbatim: they were written to be read by the person who hit them.
function lockAware(error) {
  if (!error) return null
  if (/pick list is locked/i.test(error.message ?? '')) {
    return error.hint ? `${error.message}. ${error.hint}` : error.message
  }
  return wrap(error)
}

/**
 * Put every team at the event onto the list.
 *
 * Positions are handed in already spaced rather than left to the column default
 * of 0, because a tier where every row shares a position has no gaps to bisect —
 * the first drag would immediately force a re-space of the whole thing.
 */
export async function addPicklistTeams(picklistId, rows, userId) {
  if (!isConfigured) return { data: [], error: NOT_CONFIGURED }
  if (!rows.length) return { data: [], error: null }
  const { data, error } = await supabase
    .from('picklist_entries')
    .insert(
      rows.map((r) => ({
        picklist_id: picklistId,
        team_number: r.team_number,
        tier: r.tier,
        position: r.position,
        updated_by: userId ?? null,
      }))
    )
    .select('id, picklist_id, team_number, tier, position, note, overrides_ai, updated_at')
  return { data: data ?? [], error: lockAware(error) }
}

/**
 * A drag, committed. ONE row.
 *
 * The caller has already bisected between the drop's two neighbours (see
 * position.js), so this is a single-row UPDATE regardless of how far the card
 * travelled or how many cards sit below it. That property is the whole reason
 * the position column is sparse, and it is what keeps a reorder to one request
 * on the worst network of the year.
 */
export async function movePicklistEntry({ id, tier, position, overridesAi, userId }) {
  if (!isConfigured) return { data: null, error: NOT_CONFIGURED }
  const patch = { tier, position, updated_by: userId ?? null }
  // Only written when the caller has an opinion. `undefined` means "no AI
  // proposal is on screen", which must not be allowed to quietly clear a flag
  // someone set earlier in the session.
  if (overridesAi != null) patch.overrides_ai = overridesAi
  const { data, error } = await supabase
    .from('picklist_entries')
    .update(patch)
    .eq('id', id)
    .select('id, picklist_id, team_number, tier, position, note, overrides_ai, updated_at')
    .single()
  return { data, error: lockAware(error) }
}

/**
 * Renumber one tier back to 10, 20, 30 … in a single round trip.
 *
 * The fallback path, reached only when a gap has been bisected past the point
 * where halving it again means anything. Sent as an upsert on the primary key so
 * N rows cost one request instead of N — a re-space that arrives as thirty
 * separate updates is the exact failure mode the sparse scheme exists to avoid,
 * just moved somewhere less obvious.
 *
 * `note` and `overrides_ai` are deliberately absent from the payload. PostgREST
 * updates only the columns it was sent, so a re-space cannot blank the field the
 * migration calls the most valuable one on the table.
 */
export async function respacePicklistTier({ picklistId, rows, userId }) {
  if (!isConfigured) return { data: [], error: NOT_CONFIGURED }
  if (!rows.length) return { data: [], error: null }
  const { data, error } = await supabase
    .from('picklist_entries')
    .upsert(
      rows.map((r) => ({
        id: r.id,
        picklist_id: picklistId,
        team_number: r.team_number,
        tier: r.tier,
        position: r.position,
        updated_by: userId ?? null,
      })),
      { onConflict: 'id' }
    )
    .select('id, picklist_id, team_number, tier, position, note, overrides_ai, updated_at')
  return { data: data ?? [], error: lockAware(error) }
}

export async function setPicklistNote({ id, note, userId }) {
  if (!isConfigured) return { data: null, error: NOT_CONFIGURED }
  const { data, error } = await supabase
    .from('picklist_entries')
    .update({ note: note?.trim() ? note.trim() : null, updated_by: userId ?? null })
    .eq('id', id)
    .select('id, picklist_id, team_number, tier, position, note, overrides_ai, updated_at')
    .single()
  return { data, error: lockAware(error) }
}

/**
 * Freeze or unfreeze the list.
 *
 * `locked_at` and `locked_by` are cleared on unlock rather than left behind, so
 * "when was this frozen" never answers with a timestamp from a previous freeze
 * that has since been undone.
 */
export async function setPicklistLock({ id, locked, userId }) {
  if (!isConfigured) return { data: null, error: NOT_CONFIGURED }
  const { data, error } = await supabase
    .from('picklists')
    .update({
      is_locked: locked,
      locked_at: locked ? new Date().toISOString() : null,
      locked_by: locked ? (userId ?? null) : null,
    })
    .eq('id', id)
    .select('id, event_key, name, tiers, is_locked, locked_at, locked_by, created_at, updated_at')
    .single()
  return { data, error: wrap(error) }
}

// --- nexus (live event status) ------------------------------------------------

/**
 * Live field/queuing status for an event from Nexus for FRC, via the edge proxy.
 *
 * Nexus answers "what is about to happen on the field" — which match is queuing,
 * estimated vs scheduled times, announcements. It is deliberately NOT results:
 * scores/OPR/rankings come from `syncFromTba`. TBA is the past, Nexus is the next
 * ten minutes. The NEXUS_KEY is server-side only, so — like TBA — this routes
 * through an edge function rather than the browser.
 *
 * Returns `{ event_key, nexus (Nexus's raw payload), summary (best-effort pill
 * fields) }`. The raw payload is always present, so the UI reads it defensively
 * and a field the proxy guessed wrong about is a UI fix, not a redeploy.
 */
export async function nexusStatus(eventKey, { force = false } = {}) {
  if (!isConfigured) return { data: null, error: NOT_CONFIGURED }
  if (!eventKey) return { data: null, error: null }
  const { data, error } = await supabase.functions.invoke('nexus-proxy', {
    body: { action: 'event_status', eventKey, force },
  })
  if (error) {
    // functions.invoke throws on non-2xx and discards the body, so the proxy's
    // real message — e.g. "NEXUS_KEY is not configured" — is recovered from the
    // response the same way askAi does, rather than surfacing a useless "non-2xx".
    const body = await error?.context?.json?.().catch(() => null)
    if (body?.error) return { data: null, error: body.error }
    return { data: null, error: wrap(error) }
  }
  if (data?.error) return { data: null, error: data.error }
  return { data: data?.data ?? data, error: null }
}

// --- vision pipeline (on-device detection) ------------------------------------
//
// The "master device" streams detections, not video — a phone runs an object
// detector locally and only the counts and boxes leave it (migration 0011).
// These writes are BEST-EFFORT and deliberately NOT on the offline queue: they
// are high-frequency, and a dropped batch of frames is acceptable where a dropped
// scouting entry never is. The capture UI holds unsent batches and retries; a
// failure here comes back as { error }, it does not throw.

/**
 * Open a capture session. `model` is required and names WHAT produced the
 * numbers — today a generic detector, later a trained model — so every
 * observation stays honestly attributable. `userId` must be the caller's own id:
 * RLS refuses a session opened in someone else's name.
 */
export async function startVisionSession({
  eventKey,
  matchKey,
  deviceLabel,
  model,
  modelNote,
  userId,
}) {
  if (!isConfigured) return { data: null, error: NOT_CONFIGURED }
  const { data, error } = await supabase
    .from('vision_sessions')
    .insert({
      event_key: eventKey ?? null,
      match_key: matchKey ?? null,
      device_label: deviceLabel ?? null,
      model,
      model_note: modelNote ?? null,
      started_by: userId ?? null,
    })
    .select()
    .single()
  return { data, error: wrap(error) }
}

export async function endVisionSession(id, frameCount) {
  if (!isConfigured) return { data: null, error: NOT_CONFIGURED }
  const patch = { ended_at: new Date().toISOString() }
  if (Number.isFinite(frameCount)) patch.frame_count = frameCount
  const { data, error } = await supabase
    .from('vision_sessions')
    .update(patch)
    .eq('id', id)
    .select()
    .single()
  return { data, error: wrap(error) }
}

/**
 * Push a batch of observations for a session. Rows are `{ offsetMs, objectCount,
 * detections, teamNumber? }`. RLS lets a member write only into a session they
 * own, so the caller must pass the id returned by startVisionSession.
 */
export async function pushVisionObservations(sessionId, rows) {
  if (!isConfigured) return { error: NOT_CONFIGURED }
  if (!sessionId || !rows?.length) return { error: null }
  const { error } = await supabase.from('vision_observations').insert(
    rows.map((r) => ({
      session_id: sessionId,
      offset_ms: Math.round(r.offsetMs ?? 0),
      object_count: r.objectCount ?? 0,
      detections: r.detections ?? [],
      team_number: r.teamNumber ?? null,
    }))
  )
  return { error: wrap(error) }
}

export async function listVisionSessions(eventKey, limit = 50) {
  if (!isConfigured) return { data: [], error: NOT_CONFIGURED }
  let q = supabase
    .from('vision_session_summary')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(limit)
  if (eventKey) q = q.eq('event_key', eventKey)
  const { data, error } = await q
  return { data: data ?? [], error: wrap(error) }
}

export async function visionFrames(sessionId, limit = 3000) {
  if (!isConfigured) return { data: [], error: NOT_CONFIGURED }
  const { data, error } = await supabase
    .from('vision_observations')
    .select('offset_ms, object_count, detections, team_number, created_at')
    .eq('session_id', sessionId)
    .order('offset_ms')
    .limit(limit)
  return { data: data ?? [], error: wrap(error) }
}

/**
 * The detection model configured for the vision pipeline (migration 0012), read
 * off the scout_settings singleton. A null `vision_model_url` means the built-in
 * generic detector. member+ may read it (an operator's phone has to load the
 * model to capture); lead+ changes it through `saveScoutSettings`, so there is no
 * separate writer here.
 */
export async function visionModelConfig() {
  if (!isConfigured) return { data: null, error: NOT_CONFIGURED }
  const { data, error } = await supabase
    .from('scout_settings')
    .select('vision_model_url, vision_model_name, vision_model_labels, vision_model_size')
    .eq('id', 1)
    .maybeSingle()
  return { data, error: wrap(error) }
}
