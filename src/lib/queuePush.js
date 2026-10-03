// =============================================================================
// How one queued write reaches the server, and what each failure means.
//
// Split out of offlineQueue.js so it takes the Supabase client as an argument
// and imports nothing that needs a browser or Vite: the rules in here decide
// whether a scout's data is kept, retried, or dropped, and they are tested in
// plain Node by scripts/test/offline-queue.mjs. offlineQueue.js owns IndexedDB,
// scheduling and listeners; this file owns the meaning of every response.
//
// Every function returns { ok, ... } and never throws for a server answer.
// =============================================================================

// Constraint names, from migration 0005. Asserted by name in
// supabase/local-test/03_portal_tests.sql, because this file's behaviour
// depends on telling them apart.
const ENTRY_CLIENT_UUID = 'scout_entries_client_uuid_key'
const ENTRY_ONE_PER_MATCH = 'scout_entries_one_per_match'

// Errors that will fail identically on every retry. Retrying them every few
// minutes for the rest of the event drains a battery and, worse, keeps the badge
// saying "syncing" about something that never will — so they are marked
// terminal and wait for the scout to read the reason and decide.
//   42501 RLS / privilege       22P02 malformed value     23502 missing column value
//   23503 unknown event/form    23514 check (daily limit)  42703 / PGRST204 unknown column
//   P0001 a trigger's own RAISE — the scouting window and active-event rules
//         (migration 0010) reject with plain RAISE EXCEPTION, and recorded_at
//         never changes, so the answer never will either.
const TERMINAL = new Set(['42501', '22P02', '23502', '23503', '23514', '42703', 'PGRST204', 'P0001'])

export function isTerminal(error) {
  return Boolean(error?.code && TERMINAL.has(error.code))
}

/**
 * Which unique constraint a 23505 hit, as far as the queue cares.
 *
 *   'delivered'  — client_uuid. This exact entry is already on the server; the
 *                  earlier attempt landed and only its response was lost.
 *   'same-match' — one entry per scout per team per match. A DIFFERENT entry
 *                  for a match this scout already logged: a correction.
 *   'other'      — anything else. Not evidence the data is on the server.
 *
 * The distinction is the whole point. Treating every 23505 as "already there"
 * used to delete a scout's corrected entry from the phone and report it synced,
 * when the server had in fact refused it and still held the first version.
 */
export function uniqueKind(error, table) {
  if (error?.code !== '23505') return null
  const text = `${error.message ?? ''} ${error.details ?? ''}`
  if (table === 'scout_entries') {
    if (text.includes(ENTRY_ONE_PER_MATCH)) return 'same-match'
    if (text.includes(ENTRY_CLIENT_UUID) || /\(client_uuid\)/.test(text)) return 'delivered'
    return 'other'
  }
  // robot_photos has one unique column, so any collision there is client_uuid.
  return table === 'robot_photos' || /client_uuid/.test(text) ? 'delivered' : 'other'
}

function failure(error, prefix = '') {
  const message = `${prefix}${error?.message ?? error ?? 'unknown error'}`
  return isTerminal(error)
    ? { ok: false, error: `${error.code}: ${message}`, terminal: true }
    : { ok: false, error: message }
}

/**
 * Apply a re-scouted match as a correction of the scout's own earlier entry.
 *
 * Only overwrites when this copy was recorded LATER than the one on the server.
 * Two phones signed in as the same scout can sync in either order, and the one
 * the scout pressed save on last is the one they meant. When the server copy is
 * newer, this row is superseded and is dropped as delivered — it lost a race it
 * should lose.
 */
async function correctMatchEntry(client, p) {
  const { data, error } = await client
    .from('scout_entries')
    .update({
      form_id: p.form_id ?? null,
      data: p.data ?? {},
      notes: p.notes ?? null,
      recorded_at: p.recorded_at,
      comp_level: p.comp_level ?? null,
      match_number: p.match_number ?? null,
      alliance: p.alliance ?? null,
    })
    .eq('kind', 'match')
    .eq('event_key', p.event_key)
    .eq('team_number', p.team_number)
    .eq('match_key', p.match_key)
    .eq('scout_id', p.scout_id)
    .lt('recorded_at', p.recorded_at)
    .select('id')
  if (error) return failure(error, 'correction: ')
  return data?.length ? { ok: true, corrected: true } : { ok: true, superseded: true }
}

async function insertRow(client, table, record) {
  const { error } = await client.from(table).insert(record)
  if (!error) return { ok: true }

  switch (uniqueKind(error, table)) {
    case 'delivered':
      return { ok: true, deduped: true }
    case 'same-match':
      return correctMatchEntry(client, record)
    default:
      return failure(error)
  }
}

/**
 * Bytes → files row → domain row, each step safe to re-run.
 *
 * Two payload shapes reach here:
 *   { ..., _upload: { file, bucket, path, … } }  the photo never left the phone;
 *                                                upload it, index it, link it.
 *   { ..., file_id }                             the bytes and index row already
 *                                                landed (RobotCapture uploads
 *                                                online first) and only the link
 *                                                is outstanding.
 * The second shape used to be rejected as "no file attached" and retried forever,
 * so every photo whose link was queued never reached its team.
 */
async function pushStorage(client, row, table) {
  const { _upload, ...record } = row.payload

  if (!_upload?.file) {
    if (!record.file_id) {
      return { ok: false, error: 'queued photo has neither a file nor a file_id', terminal: true }
    }
    return insertRow(client, table, record)
  }

  const { bucket, path, title, kind, season, sha256 } = _upload

  // 1. bytes. upsert so a half-finished upload simply completes.
  const { error: upErr } = await client.storage
    .from(bucket)
    .upload(path, _upload.file, { cacheControl: '3600', upsert: true })
  if (upErr && !/exists/i.test(upErr.message ?? '')) return failure(upErr, 'upload: ')

  // 2. index row. unique(bucket, path): on collision, a previous attempt got
  //    this far — read its id back rather than failing.
  let fileId = record.file_id
  if (!fileId) {
    const { data: userRes } = await client.auth.getUser()
    const { data: fileRow, error: fErr } = await client
      .from('files')
      .insert({
        bucket,
        path,
        title: title ?? path.split('/').pop(),
        kind: kind ?? 'photo',
        season: season ?? null,
        byte_size: _upload.file.size ?? null,
        sha256: sha256 ?? null,
        uploaded_by: userRes?.user?.id ?? null,
      })
      .select('id')
      .single()

    if (fErr) {
      if (fErr.code !== '23505') return failure(fErr, 'files: ')
      const { data: existing } = await client
        .from('files')
        .select('id')
        .eq('bucket', bucket)
        .eq('path', path)
        .maybeSingle()
      if (!existing) return { ok: false, error: 'files row conflicted but could not be read back' }
      fileId = existing.id
    } else {
      fileId = fileRow.id
    }
  }

  // 3. domain row.
  return insertRow(client, table, { ...record, file_id: fileId })
}

/** Push one queued row through `client`, according to its handler. */
export async function pushRow(client, row, handler) {
  if (!handler) return { ok: false, error: `unknown kind ${row.kind}`, terminal: true }
  if (handler.kind === 'storage') return pushStorage(client, row, handler.table)
  return insertRow(client, handler.table, row.payload)
}
