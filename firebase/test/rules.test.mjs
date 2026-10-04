// The portal's access model, proven against the emulator.
//
//   npm run test:rules
//
// Reading firebase/firestore.rules is not the same as testing it. Each test here
// signs in as a role and tries the thing: a member raising their own role, the
// public internet reading the roster, a third pit pass in one day, an edit to a
// locked pick list. It needs no credentials and never touches a real project
// (`demo-` projects exist only in the emulator).
import { readFileSync } from 'node:fs'
import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  initializeTestEnvironment, assertFails, assertSucceeds,
} from '@firebase/rules-unit-testing'
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where, writeBatch,
  serverTimestamp, Timestamp,
} from 'firebase/firestore'
import { ref, uploadBytes, getBytes, deleteObject } from 'firebase/storage'
import { fileId, entryId, recordedDay, activeFormId, collabId, minutesOf } from '../../src/lib/ids.js'
import { findSecret } from '../../src/lib/secretPatterns.js'

const PROJECT = 'demo-frc5805'
const ROLES = ['pending', 'viewer', 'member', 'lead', 'mentor', 'admin']

let env
const dbOf = (who) => (who ? env.authenticatedContext(who).firestore() : env.unauthenticatedContext().firestore())
const storeOf = (who) => (who ? env.authenticatedContext(who).storage() : env.unauthenticatedContext().storage())
const admin = (fn) => env.withSecurityRulesDisabled((ctx) => fn(ctx.firestore()))
const now = () => serverTimestamp()

before(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') },
    storage: { rules: readFileSync(new URL('../storage.rules', import.meta.url), 'utf8') },
  })
})
after(async () => { await env?.cleanup() })

beforeEach(async () => {
  await env.clearFirestore()
  await admin(async (db) => {
    // One user per role (uid = role name), a second member, and a second admin-free world.
    for (const r of ROLES) {
      await setDoc(doc(db, 'profiles', r), {
        full_name: `${r} user`, grad_year: null, subteam: null, role: r,
        created_at: Timestamp.now(), updated_at: Timestamp.now(),
      })
    }
    await setDoc(doc(db, 'profiles', 'member2'), {
      full_name: 'second member', grad_year: null, subteam: null, role: 'member',
      created_at: Timestamp.now(), updated_at: Timestamp.now(),
    })
  })
})

// ---- builders: full, valid documents the tests then bend ----------------------

const fileDoc = (bucket, path, by, over = {}) => ({
  bucket, path, title: 'A file', description: null, kind: 'doc', season: 2026, tags: [],
  byte_size: 10, sha256: null, uploaded_by: by, created_at: now(), updated_at: now(), ...over,
})
const entry = (over = {}) => {
  const recorded = over.recorded_at ?? new Date('2026-10-10T18:00:00Z')
  const e = {
    client_uuid: 'c-1', form_id: null, kind: 'match', event_key: '2026test', team_number: 5805,
    match_key: '2026test_qm1', match_number: 1, comp_level: 'qm', alliance: 'red',
    data: { total_score: 40 }, notes: null, scout_id: 'member',
    slot: null, ...over,
  }
  e.recorded_at = Timestamp.fromDate(recorded)
  e.recorded_day = over.recorded_day ?? recordedDay(recorded)
  e.created_at = now()
  return e
}
const pit = (over = {}) => entry({ kind: 'pit', match_key: null, match_number: null, comp_level: null, alliance: null, slot: 1, ...over })
const putEntry = (who, e, id = entryId(e)) => setDoc(doc(dbOf(who), 'scout_entries', id), e)

const settingsDoc = (by, over = {}) => {
  const s = {
    active_event_key: null, lock_enabled: false, window_start: '08:00', window_end: '18:00',
    timezone: 'America/Los_Angeles', utc_offset_min: -420, vision_model_url: null, vision_model_name: null,
    vision_model_labels: [], vision_model_size: 640, updated_by: by, updated_at: now(), ...over,
  }
  s.window_start_min = minutesOf(s.window_start)
  s.window_end_min = minutesOf(s.window_end)
  return s
}
const formDoc = (over = {}) => ({
  season: 2026, kind: 'match', name: 'Match form', description: null,
  fields: [{ key: 'total_score', label: 'Score', type: 'number' }], is_active: false,
  created_by: 'lead', created_at: now(), updated_at: now(), ...over,
})
const kbDoc = (by, over = {}) => ({
  slug: 'wiring', title: 'Wiring', body_md: 'Crimp, then tug-test.', category: null, is_pinned: false,
  created_by: by, updated_by: by, created_at: now(), updated_at: now(), ...over,
})
async function putKb(who, id, d) {
  const db = dbOf(who)
  const b = writeBatch(db)
  b.set(doc(db, 'knowledge_docs', id), d)
  b.set(doc(db, 'kb_slugs', d.slug), { doc_id: id })
  return b.commit()
}

// =============================================================================

describe('identity and roles', () => {
  test('the public internet reads nothing', async () => {
    const db = dbOf(null)
    for (const c of ['profiles', 'knowledge_docs', 'files', 'backup_runs', 'scout_entries', 'events'])
      await assertFails(getDocs(collection(db, c)))
    await assertFails(getDoc(doc(db, 'profiles', 'admin')))
  })

  test('pending reads only its own profile and cannot enumerate the roster', async () => {
    const db = dbOf('pending')
    await assertSucceeds(getDoc(doc(db, 'profiles', 'pending')))
    await assertFails(getDoc(doc(db, 'profiles', 'member')))
    await assertFails(getDocs(collection(db, 'profiles')))
    await assertFails(getDocs(collection(db, 'knowledge_docs')))
    await assertFails(getDocs(collection(db, 'files')))
    await assertFails(getDocs(collection(db, 'scout_entries')))
  })

  test('a user with no profile is pending', async () => {
    const db = dbOf('stranger')
    await assertFails(getDocs(collection(db, 'profiles')))
    await assertFails(getDocs(collection(db, 'scout_entries')))
  })

  test('a new user creates their own profile, and it can only say pending', async () => {
    const fresh = (role) => ({ full_name: 'New', grad_year: 2028, subteam: null, role, created_at: now(), updated_at: now() })
    await assertFails(setDoc(doc(dbOf('newbie'), 'profiles', 'newbie'), fresh('admin')))
    await assertFails(setDoc(doc(dbOf('newbie'), 'profiles', 'newbie'), fresh('member')))
    await assertFails(setDoc(doc(dbOf('newbie'), 'profiles', 'someone-else'), fresh('pending')))
    await assertFails(setDoc(doc(dbOf('newbie'), 'profiles', 'newbie'), { ...fresh('pending'), is_admin: true }))
    await assertSucceeds(setDoc(doc(dbOf('newbie'), 'profiles', 'newbie'), fresh('pending')))
  })

  test('nobody changes a role from a client: not a member, not a lead, not an admin', async () => {
    for (const who of ['member', 'lead', 'admin']) {
      await assertFails(updateDoc(doc(dbOf(who), 'profiles', who), { role: who === 'admin' ? 'member' : 'admin', updated_at: now() }))
      await assertFails(updateDoc(doc(dbOf(who), 'profiles', 'member2'), { role: 'lead', updated_at: now() }))
      await assertFails(updateDoc(doc(dbOf(who), 'profiles', 'pending'), { role: 'member', updated_at: now() }))
    }
  })

  test('nobody deletes a profile from a client, the last admin included', async () => {
    await assertFails(deleteDoc(doc(dbOf('admin'), 'profiles', 'admin')))
    await assertFails(deleteDoc(doc(dbOf('admin'), 'profiles', 'member2')))
    await assertFails(deleteDoc(doc(dbOf('member'), 'profiles', 'member')))
  })

  test('a user edits their own name, year and subteam; an admin edits anyone; nobody else does', async () => {
    await assertSucceeds(updateDoc(doc(dbOf('member'), 'profiles', 'member'), { full_name: 'Renamed', grad_year: 2027, updated_at: now() }))
    await assertFails(updateDoc(doc(dbOf('member'), 'profiles', 'member'), { grad_year: 1900, updated_at: now() }))
    await assertFails(updateDoc(doc(dbOf('member'), 'profiles', 'member2'), { subteam: 'x', updated_at: now() }))
    await assertFails(updateDoc(doc(dbOf('lead'), 'profiles', 'member2'), { subteam: 'x', updated_at: now() }))
    await assertSucceeds(updateDoc(doc(dbOf('admin'), 'profiles', 'member2'), { subteam: 'electrical', updated_at: now() }))
  })

  test('viewer reads the roster but no team content', async () => {
    const db = dbOf('viewer')
    await assertSucceeds(getDocs(collection(db, 'profiles')))
    await assertFails(getDocs(collection(db, 'knowledge_docs')))
    await assertFails(getDocs(collection(db, 'scout_entries')))
    await assertFails(getDocs(collection(db, 'backup_runs')))
  })

  test('mentor has a lead’s rights', async () => {
    await assertSucceeds(setDoc(doc(dbOf('mentor'), 'events', '2026test'), { key: '2026test', year: 2026, name: 'Test' }))
    await assertSucceeds(getDocs(collection(dbOf('mentor'), 'audit_log')))
  })
})

describe('files', () => {
  test('a member indexes their own upload, under the id its bucket and path derive', async () => {
    const path = '2026/abc-notes.md'
    await assertSucceeds(setDoc(doc(dbOf('member'), 'files', fileId('knowledge', path)), fileDoc('knowledge', path, 'member')))
    await assertFails(setDoc(doc(dbOf('member'), 'files', 'any-other-id'), fileDoc('knowledge', '2026/x.md', 'member')))
    await assertFails(setDoc(doc(dbOf('member'), 'files', fileId('knowledge', '2026/y.md')), fileDoc('knowledge', '2026/y.md', 'member2')))
    await assertFails(setDoc(doc(dbOf('member'), 'files', fileId('secret', 'a')), fileDoc('secret', 'a', 'member')))
    await assertFails(setDoc(doc(dbOf('viewer'), 'files', fileId('media', 'a.jpg')), fileDoc('media', 'a.jpg', 'viewer')))
  })

  test('one row per object: a second writer cannot take over an existing file row', async () => {
    const id = fileId('code', '2026/robot.zip')
    await assertSucceeds(setDoc(doc(dbOf('member'), 'files', id), fileDoc('code', '2026/robot.zip', 'member')))
    await assertFails(setDoc(doc(dbOf('member2'), 'files', id), fileDoc('code', '2026/robot.zip', 'member2')))
  })

  test('owners edit and delete their own rows; leads any; nobody reassigns ownership', async () => {
    const id = fileId('code', '2026/a.zip')
    await setDoc(doc(dbOf('member'), 'files', id), fileDoc('code', '2026/a.zip', 'member'))
    await assertSucceeds(updateDoc(doc(dbOf('member'), 'files', id), { title: 'Renamed', updated_at: now() }))
    await assertFails(updateDoc(doc(dbOf('member2'), 'files', id), { title: 'Mine now', updated_at: now() }))
    await assertFails(updateDoc(doc(dbOf('member'), 'files', id), { uploaded_by: 'member2', updated_at: now() }))
    await assertFails(updateDoc(doc(dbOf('member'), 'files', id), { path: '2026/b.zip', updated_at: now() }))
    await assertSucceeds(updateDoc(doc(dbOf('lead'), 'files', id), { title: 'Lead edit', updated_at: now() }))
    await assertFails(deleteDoc(doc(dbOf('member2'), 'files', id)))
    await assertSucceeds(deleteDoc(doc(dbOf('member'), 'files', id)))
  })

  test('viewer sees media rows only, and must ask for them by bucket', async () => {
    await admin(async (db) => {
      await setDoc(doc(db, 'files', fileId('media', 'p.jpg')), { ...fileDoc('media', 'p.jpg', 'member'), created_at: Timestamp.now(), updated_at: Timestamp.now() })
      await setDoc(doc(db, 'files', fileId('code', 'c.zip')), { ...fileDoc('code', 'c.zip', 'member'), created_at: Timestamp.now(), updated_at: Timestamp.now() })
    })
    const db = dbOf('viewer')
    await assertSucceeds(getDocs(query(collection(db, 'files'), where('bucket', 'in', ['media', 'public-media']))))
    await assertFails(getDocs(collection(db, 'files')))
    await assertFails(getDoc(doc(db, 'files', fileId('code', 'c.zip'))))
    await assertSucceeds(getDocs(collection(dbOf('member'), 'files')))
  })
})

describe('graphs and code archives', () => {
  const graph = (by, over = {}) => ({
    slug: 'drive-code', title: 'Drive code', summary: null, source: null, node_count: 10, edge_count: 20,
    community_count: 2, god_nodes: [], generated_at: null, file: null, html_file: null, created_by: by,
    created_at: now(), updated_at: now(), ...over,
  })
  test('a graph’s id is its slug, so a slug cannot be used twice', async () => {
    await assertFails(setDoc(doc(dbOf('member'), 'graphs', 'other-id'), graph('member')))
    await assertFails(setDoc(doc(dbOf('member'), 'graphs', 'Bad Slug'), graph('member', { slug: 'Bad Slug' })))
    await assertSucceeds(setDoc(doc(dbOf('member'), 'graphs', 'drive-code'), graph('member')))
    await assertFails(setDoc(doc(dbOf('member2'), 'graphs', 'drive-code'), graph('member2')))
  })
  test('members edit their own graph and cannot delete; leads manage all', async () => {
    await setDoc(doc(dbOf('member'), 'graphs', 'drive-code'), graph('member'))
    await assertSucceeds(updateDoc(doc(dbOf('member'), 'graphs', 'drive-code'), { title: 'New', updated_at: now() }))
    await assertFails(updateDoc(doc(dbOf('member2'), 'graphs', 'drive-code'), { title: 'Hijack', updated_at: now() }))
    await assertFails(deleteDoc(doc(dbOf('member'), 'graphs', 'drive-code')))
    await assertSucceeds(deleteDoc(doc(dbOf('lead'), 'graphs', 'drive-code')))
  })
  test('code archives: members add their own, viewers read none', async () => {
    const a = { repo: 'robot', ref: 'main', commit_sha: 'abc1234', season: 2026, notes: null, file: null, created_by: 'member', created_at: now(), updated_at: now() }
    await assertSucceeds(setDoc(doc(dbOf('member'), 'code_archives', 'a1'), a))
    await assertFails(setDoc(doc(dbOf('member'), 'code_archives', 'a2'), { ...a, commit_sha: 'not-a-sha' }))
    await assertFails(setDoc(doc(dbOf('member'), 'code_archives', 'a3'), { ...a, created_by: 'member2' }))
    await assertFails(getDocs(collection(dbOf('viewer'), 'code_archives')))
  })
})

describe('knowledge base', () => {
  test('a member writes a doc together with its slug; a doc without its slug index is refused', async () => {
    await assertFails(setDoc(doc(dbOf('member'), 'knowledge_docs', 'd1'), kbDoc('member')))
    await assertSucceeds(putKb('member', 'd1', kbDoc('member')))
    await assertFails(setDoc(doc(dbOf('viewer'), 'knowledge_docs', 'dv'), kbDoc('viewer', { slug: 'v' })))
  })

  test('slugs are unique: a second doc cannot claim one in use', async () => {
    await putKb('member', 'd1', kbDoc('member'))
    await assertFails(putKb('member2', 'd2', kbDoc('member2')))
    await assertSucceeds(putKb('member2', 'd2', kbDoc('member2', { slug: 'wiring-2' })))
  })

  test('any member edits any doc; a rename moves the slug in one batch', async () => {
    await putKb('member', 'd1', kbDoc('member'))
    const db = dbOf('member2')
    await assertSucceeds(updateDoc(doc(db, 'knowledge_docs', 'd1'), { body_md: 'Edited.', updated_by: 'member2', updated_at: now() }))
    // A rename that leaves the index behind is refused...
    await assertFails(updateDoc(doc(db, 'knowledge_docs', 'd1'), { slug: 'crimping', updated_by: 'member2', updated_at: now() }))
    // ...and one that moves it is not.
    const b = writeBatch(db)
    b.update(doc(db, 'knowledge_docs', 'd1'), { slug: 'crimping', updated_by: 'member2', updated_at: now() })
    b.set(doc(db, 'kb_slugs', 'crimping'), { doc_id: 'd1' })
    b.delete(doc(db, 'kb_slugs', 'wiring'))
    await assertSucceeds(b.commit())
    // The old slug cannot be released while a doc still uses it.
    await assertFails(deleteDoc(doc(db, 'kb_slugs', 'crimping')))
  })

  test('an edit must be attributed to the editor', async () => {
    await putKb('member', 'd1', kbDoc('member'))
    await assertFails(updateDoc(doc(dbOf('member2'), 'knowledge_docs', 'd1'), { body_md: 'x', updated_by: 'member', updated_at: now() }))
  })

  test('only leads delete a doc, pin one, and nobody writes history', async () => {
    await putKb('member', 'd1', kbDoc('member'))
    await assertFails(deleteDoc(doc(dbOf('member'), 'knowledge_docs', 'd1')))
    await assertFails(updateDoc(doc(dbOf('member'), 'knowledge_docs', 'd1'), { is_pinned: true, updated_by: 'member', updated_at: now() }))
    await assertSucceeds(updateDoc(doc(dbOf('lead'), 'knowledge_docs', 'd1'), { is_pinned: true, updated_by: 'lead', updated_at: now() }))
    for (const who of ['member', 'lead', 'admin'])
      await assertFails(setDoc(doc(dbOf(who), 'knowledge_docs', 'd1', 'versions', 'v1'), { title: 't', body_md: 'b' }))
    const db = dbOf('lead')
    const b = writeBatch(db)
    b.delete(doc(db, 'knowledge_docs', 'd1'))
    b.delete(doc(db, 'kb_slugs', 'wiring'))
    await assertSucceeds(b.commit())
  })

  test('a body that looks like a secret is refused, by the rules and by the client check alike', async () => {
    const secrets = [
      'Connect to 100.99.99.99 over the tailnet.',
      'The router is at 192.168.222.222.',
      'Server: 10.99.99.99',
      `token ghp_${'a'.repeat(36)}`,
      '-----BEGIN OPENSSH PRIVATE KEY-----\nabc',
      'key AKIAIOSFODNN7EXAMPLE here',
      `sk-${'b'.repeat(24)}`,
      'service_role = eyJabc',
    ]
    const fine = [
      'We met 10 times. Version 1.2.3.4 shipped. Score was 192.168 points.',
      'Ask a lead for the password; it lives in the password manager.',
      'The task was asking questions.',
    ]
    let n = 0
    for (const body of secrets) {
      assert.ok(findSecret(body), `client check should catch: ${body.slice(0, 30)}`)
      await assertFails(putKb('member', `s${n}`, kbDoc('member', { slug: `s${n++}`, body_md: body })))
    }
    for (const body of fine) {
      assert.equal(findSecret(body), null, `client check should pass: ${body.slice(0, 30)}`)
      await assertSucceeds(putKb('member', `f${n}`, kbDoc('member', { slug: `f${n++}`, body_md: body })))
    }
  })
})

describe('server-written collections', () => {
  test('audit log: leads read, members do not, nobody writes', async () => {
    await assertSucceeds(getDocs(collection(dbOf('lead'), 'audit_log')))
    await assertFails(getDocs(collection(dbOf('member'), 'audit_log')))
    for (const who of ['member', 'lead', 'admin'])
      await assertFails(setDoc(doc(dbOf(who), 'audit_log', 'x'), { action: 'role.change' }))
  })
  test('backup runs and stats: members read, nobody writes', async () => {
    await assertSucceeds(getDocs(collection(dbOf('member'), 'backup_runs')))
    await assertSucceeds(getDocs(collection(dbOf('member'), 'team_event_stats')))
    await assertFails(setDoc(doc(dbOf('admin'), 'backup_runs', 'x'), { leg: 'a', status: 'ok' }))
    await assertFails(setDoc(doc(dbOf('admin'), 'team_event_stats', '2026test_5805'), { avg_score: 999 }))
  })
  test('the public-data cache: members read, nobody writes', async () => {
    await assertSucceeds(getDoc(doc(dbOf('member'), 'public_event_data', '2026test')))
    await assertFails(getDoc(doc(dbOf('viewer'), 'public_event_data', '2026test')))
    await assertFails(setDoc(doc(dbOf('admin'), 'public_event_data', '2026test'), { teams: [] }))
  })
  test('a collection the rules do not name is closed, to admins too', async () => {
    await assertFails(setDoc(doc(dbOf('admin'), 'rate_limits', 'admin_ai'), { count: 0 }))
    await assertFails(getDocs(collection(dbOf('admin'), 'anything_else')))
  })
  test('the event cache: members read, leads write', async () => {
    await assertFails(setDoc(doc(dbOf('member'), 'events', '2026test'), { key: '2026test', year: 2026, name: 'T' }))
    await assertSucceeds(setDoc(doc(dbOf('lead'), 'events', '2026test'), { key: '2026test', year: 2026, name: 'T' }))
    await assertSucceeds(getDocs(collection(dbOf('member'), 'events')))
    await assertFails(setDoc(doc(dbOf('member'), 'event_teams', '2026test_5805'), { event_key: '2026test', team_number: 5805 }))
  })
  test('repo sources: a lead cannot add one, an admin can', async () => {
    await assertFails(setDoc(doc(dbOf('lead'), 'repo_sources', 'r'), { label: 'x' }))
    await assertSucceeds(setDoc(doc(dbOf('admin'), 'repo_sources', 'r'), { label: 'x' }))
  })
})

describe('scouting forms and settings', () => {
  test('leads author forms; members only read', async () => {
    await assertFails(setDoc(doc(dbOf('member'), 'scout_forms', 'f1'), formDoc({ created_by: 'member' })))
    await assertSucceeds(setDoc(doc(dbOf('lead'), 'scout_forms', 'f1'), formDoc()))
    await assertSucceeds(getDocs(collection(dbOf('member'), 'scout_forms')))
    await assertFails(setDoc(doc(dbOf('lead'), 'scout_forms', 'f2'), formDoc({ kind: 'bogus' })))
  })

  test('at most one active form per season and kind', async () => {
    const db = dbOf('lead')
    await setDoc(doc(db, 'scout_forms', 'f1'), formDoc())
    await setDoc(doc(db, 'scout_forms', 'f2'), formDoc({ name: 'Second' }))
    // A form cannot simply declare itself active.
    await assertFails(updateDoc(doc(db, 'scout_forms', 'f1'), { is_active: true, updated_at: now() }))
    // Activating is the form and the pointer, together.
    let b = writeBatch(db)
    b.update(doc(db, 'scout_forms', 'f1'), { is_active: true, updated_at: now() })
    b.set(doc(db, 'scout_form_active', activeFormId(2026, 'match')), { form_id: 'f1', season: 2026, kind: 'match' })
    await assertSucceeds(b.commit())
    // A second active form for the same season and kind is refused while f1 holds the pointer.
    await assertFails(updateDoc(doc(db, 'scout_forms', 'f2'), { is_active: true, updated_at: now() }))
    // Handing over is one batch.
    b = writeBatch(db)
    b.update(doc(db, 'scout_forms', 'f1'), { is_active: false, updated_at: now() })
    b.update(doc(db, 'scout_forms', 'f2'), { is_active: true, updated_at: now() })
    b.set(doc(db, 'scout_form_active', activeFormId(2026, 'match')), { form_id: 'f2', season: 2026, kind: 'match' })
    await assertSucceeds(b.commit())
    // The pointer cannot name a form that is not active, or one of another kind.
    await assertFails(setDoc(doc(db, 'scout_form_active', activeFormId(2026, 'match')), { form_id: 'f1', season: 2026, kind: 'match' }))
    await assertFails(setDoc(doc(db, 'scout_form_active', activeFormId(2026, 'pit')), { form_id: 'f2', season: 2026, kind: 'pit' }))
    // The active form cannot be deleted out from under its pointer.
    await assertFails(deleteDoc(doc(db, 'scout_forms', 'f2')))
    await assertSucceeds(deleteDoc(doc(db, 'scout_forms', 'f1')))
  })

  test('settings: one document, written by leads, with a valid window', async () => {
    await assertFails(setDoc(doc(dbOf('member'), 'scout_settings', 'main'), settingsDoc('member')))
    await assertSucceeds(setDoc(doc(dbOf('lead'), 'scout_settings', 'main'), settingsDoc('lead')))
    await assertSucceeds(getDoc(doc(dbOf('member'), 'scout_settings', 'main')))
    await assertFails(getDoc(doc(dbOf('viewer'), 'scout_settings', 'main')))
    await assertFails(setDoc(doc(dbOf('lead'), 'scout_settings', 'second'), settingsDoc('lead')))
    await assertFails(setDoc(doc(dbOf('lead'), 'scout_settings', 'main'), settingsDoc('lead', { window_start: '25:99' })))
    await assertFails(setDoc(doc(dbOf('lead'), 'scout_settings', 'main'), settingsDoc('lead', { vision_model_size: 8 })))
    await assertFails(setDoc(doc(dbOf('lead'), 'scout_settings', 'main'), settingsDoc('member')))
    await assertFails(deleteDoc(doc(dbOf('admin'), 'scout_settings', 'main')))
  })
})

describe('scouting entries', () => {
  test('a member records their own entry, under the id its fields derive', async () => {
    await assertSucceeds(putEntry('member', entry()))
    await assertFails(putEntry('member', entry({ match_key: '2026test_qm2', match_number: 2 }), 'some-random-id'))
    await assertFails(putEntry('pending', entry({ scout_id: 'pending' })))
    await assertFails(putEntry('viewer', entry({ scout_id: 'viewer' })))
  })

  test('a member cannot record as someone else; a lead can', async () => {
    await assertFails(putEntry('member', entry({ scout_id: 'member2' })))
    await assertSucceeds(putEntry('lead', entry({ scout_id: 'member2' })))
  })

  test('one entry per scout per match: the second submission is a correction of their own', async () => {
    await assertSucceeds(putEntry('member', entry()))
    // Same scout, same match, new answers: lands on the same document as an update.
    await assertSucceeds(updateDoc(doc(dbOf('member'), 'scout_entries', entryId(entry())), {
      client_uuid: 'c-2', data: { total_score: 55 }, recorded_at: Timestamp.fromDate(new Date('2026-10-10T18:05:00Z')),
    }))
    const snap = await getDoc(doc(dbOf('member'), 'scout_entries', entryId(entry())))
    assert.equal(snap.data().data.total_score, 55)
    // Another member cannot write over it, and cannot use that id for themselves.
    await assertFails(updateDoc(doc(dbOf('member2'), 'scout_entries', entryId(entry())), { notes: 'hijack' }))
    await assertFails(putEntry('member2', entry({ scout_id: 'member2' }), entryId(entry())))
    // A second scout on the same match gets their own document.
    await assertSucceeds(putEntry('member2', entry({ scout_id: 'member2', client_uuid: 'c-3' })))
  })

  test('what an entry is about cannot be edited into something else', async () => {
    await putEntry('member', entry())
    const id = entryId(entry())
    await assertFails(updateDoc(doc(dbOf('member'), 'scout_entries', id), { team_number: 4414 }))
    await assertFails(updateDoc(doc(dbOf('member'), 'scout_entries', id), { scout_id: 'member2' }))
    await assertSucceeds(updateDoc(doc(dbOf('member'), 'scout_entries', id), { notes: 'fixed a typo' }))
  })

  test('a match entry names its match and alliance', async () => {
    await assertFails(putEntry('member', entry({ alliance: null })))
    await assertFails(putEntry('member', entry({ match_number: null })))
    await assertFails(putEntry('member', entry({ alliance: 'green' })))
    await assertFails(putEntry('member', entry({ team_number: 0 })))
  })

  test('members cannot delete entries; leads can', async () => {
    await putEntry('member', entry())
    await assertFails(deleteDoc(doc(dbOf('member'), 'scout_entries', entryId(entry()))))
    await assertSucceeds(deleteDoc(doc(dbOf('lead'), 'scout_entries', entryId(entry()))))
  })

  test('two pit passes per scout per team per day, for leads too; the allowance resets with the day', async () => {
    await assertSucceeds(putEntry('member', pit({ slot: 1, client_uuid: 'p1' })))
    await assertSucceeds(putEntry('member', pit({ slot: 2, client_uuid: 'p2' })))
    await assertFails(putEntry('member', pit({ slot: 3, client_uuid: 'p3' })))
    await assertFails(putEntry('member', pit({ slot: 0, client_uuid: 'p0' })))
    // A pit pass cannot escape the limit by using a free-form id or a false day.
    await assertFails(putEntry('member', pit({ slot: 1, client_uuid: 'p4' }), 'u:p4'))
    await assertFails(putEntry('member', pit({ slot: 1, client_uuid: 'p5', recorded_day: 20261011 })))
    // Leads have the same two.
    await assertSucceeds(putEntry('lead', pit({ scout_id: 'lead', slot: 1 })))
    await assertSucceeds(putEntry('lead', pit({ scout_id: 'lead', slot: 2 })))
    await assertFails(putEntry('lead', pit({ scout_id: 'lead', slot: 3 })))
    // Another team, another kind and another day each have their own allowance.
    await assertSucceeds(putEntry('member', pit({ team_number: 4414, slot: 1 })))
    await assertSucceeds(putEntry('member', pit({ kind: 'strategy', slot: 1 })))
    await assertSucceeds(putEntry('member', pit({ slot: 1, recorded_at: new Date('2026-10-11T18:00:00Z') })))
  })

  test('match scouting is not limited to two a day', async () => {
    for (let n = 1; n <= 4; n++)
      await assertSucceeds(putEntry('member', entry({ match_key: `2026test_qm${n}`, match_number: n, client_uuid: `m${n}` })))
  })

  test('when a lead sets the active event, members scout only that event; leads are exempt', async () => {
    await setDoc(doc(dbOf('lead'), 'scout_settings', 'main'), settingsDoc('lead', { active_event_key: '2026test' }))
    await assertSucceeds(putEntry('member', entry()))
    await assertFails(putEntry('member', entry({ event_key: '2026other', match_key: '2026other_qm1' })))
    await assertFails(putEntry('member', pit({ event_key: null })))
    await assertSucceeds(putEntry('lead', entry({ scout_id: 'lead', event_key: '2026other', match_key: '2026other_qm1' })))
  })

  test('the scouting window applies to everyone, leads included, and is judged on the device’s time', async () => {
    // 08:00–18:00 Pacific (UTC-7): 15:00Z–01:00Z.
    await setDoc(doc(dbOf('lead'), 'scout_settings', 'main'), settingsDoc('lead', { lock_enabled: true }))
    const at = (iso, over = {}) => entry({ recorded_at: new Date(iso), match_key: `2026test_qm${++seq}`, match_number: seq, ...over })
    let seq = 100
    await assertSucceeds(putEntry('member', at('2026-10-10T16:00:00Z'))) // 09:00 local
    await assertSucceeds(putEntry('member', at('2026-10-11T01:00:00Z'))) // 18:00 local, inclusive
    await assertFails(putEntry('member', at('2026-10-10T14:59:00Z'))) // 07:59 local
    await assertFails(putEntry('member', at('2026-10-11T01:01:00Z'))) // 18:01 local
    await assertFails(putEntry('lead', at('2026-10-10T06:00:00Z', { scout_id: 'lead' }))) // 23:00 local
    await assertSucceeds(putEntry('lead', at('2026-10-10T17:00:00Z', { scout_id: 'lead' })))
  })

  test('an overnight window wraps past midnight', async () => {
    await setDoc(doc(dbOf('lead'), 'scout_settings', 'main'),
      settingsDoc('lead', { lock_enabled: true, window_start: '20:00', window_end: '02:00' }))
    let seq = 200
    const at = (iso) => entry({ recorded_at: new Date(iso), match_key: `2026test_qm${++seq}`, match_number: seq })
    await assertSucceeds(putEntry('member', at('2026-10-10T04:00:00Z'))) // 21:00 local
    await assertSucceeds(putEntry('member', at('2026-10-10T08:30:00Z'))) // 01:30 local
    await assertFails(putEntry('member', at('2026-10-10T19:00:00Z'))) // 12:00 local
  })

  test('with the lock off, any hour is fine', async () => {
    await setDoc(doc(dbOf('lead'), 'scout_settings', 'main'), settingsDoc('lead', { lock_enabled: false }))
    await assertSucceeds(putEntry('member', entry({ recorded_at: new Date('2026-10-10T10:00:00Z') })))
  })
})

describe('robot photos, pick lists, notes and vision', () => {
  const photo = (by, over = {}) => ({
    client_uuid: 'ph1', event_key: '2026test', team_number: 5805, angle: 'front',
    file: { id: fileId('media', 'pit/x.jpg'), bucket: 'media', path: 'pit/x.jpg' }, quality: {}, taken_by: by,
    created_at: now(), ...over,
  })
  test('photos: members add their own and cannot change or remove one', async () => {
    await assertSucceeds(setDoc(doc(dbOf('member'), 'robot_photos', 'ph1'), photo('member')))
    await assertFails(setDoc(doc(dbOf('member'), 'robot_photos', 'ph2'), photo('member2', { client_uuid: 'ph2' })))
    await assertFails(setDoc(doc(dbOf('member'), 'robot_photos', 'wrong-id'), photo('member', { client_uuid: 'ph3' })))
    await assertFails(setDoc(doc(dbOf('member'), 'robot_photos', 'ph4'), photo('member', { client_uuid: 'ph4', angle: 'underneath' })))
    await assertFails(updateDoc(doc(dbOf('member'), 'robot_photos', 'ph1'), { angle: 'side' }))
    await assertFails(deleteDoc(doc(dbOf('member'), 'robot_photos', 'ph1')))
    await assertSucceeds(deleteDoc(doc(dbOf('lead'), 'robot_photos', 'ph1')))
  })

  const list = (over = {}) => ({
    event_key: '2026test', name: 'Pick list', tiers: [{ key: 's', label: 'S' }], is_locked: false,
    locked_at: null, locked_by: null, created_by: 'lead', created_at: now(), updated_at: now(), ...over,
  })
  const pick = (team, over = {}) => ({
    team_number: team, tier: 'unranked', position: 10, note: null, overrides_ai: false,
    updated_by: 'lead', updated_at: now(), ...over,
  })
  test('pick lists: members read, leads edit, one entry per team', async () => {
    await assertFails(setDoc(doc(dbOf('member'), 'picklists', 'L'), list({ created_by: 'member' })))
    await assertSucceeds(setDoc(doc(dbOf('lead'), 'picklists', 'L'), list()))
    await assertSucceeds(setDoc(doc(dbOf('lead'), 'picklists', 'L', 'entries', '5805'), pick(5805)))
    await assertFails(setDoc(doc(dbOf('lead'), 'picklists', 'L', 'entries', 'not-the-team'), pick(4414)))
    await assertFails(setDoc(doc(dbOf('member'), 'picklists', 'L', 'entries', '4414'), pick(4414)))
    await assertSucceeds(getDocs(collection(dbOf('member'), 'picklists', 'L', 'entries')))
  })
  test('a locked pick list is frozen for everyone until it is unlocked', async () => {
    const db = dbOf('lead')
    await setDoc(doc(db, 'picklists', 'L'), list())
    await setDoc(doc(db, 'picklists', 'L', 'entries', '5805'), pick(5805))
    await updateDoc(doc(db, 'picklists', 'L'), { is_locked: true, locked_at: now(), locked_by: 'lead', updated_at: now() })
    for (const who of ['lead', 'admin']) {
      const d = dbOf(who)
      await assertFails(setDoc(doc(d, 'picklists', 'L', 'entries', '4414'), pick(4414)))
      await assertFails(updateDoc(doc(d, 'picklists', 'L', 'entries', '5805'), { tier: 's', updated_at: now() }))
      await assertFails(deleteDoc(doc(d, 'picklists', 'L', 'entries', '5805')))
    }
    await updateDoc(doc(db, 'picklists', 'L'), { is_locked: false, locked_at: null, locked_by: null, updated_at: now() })
    await assertSucceeds(updateDoc(doc(db, 'picklists', 'L', 'entries', '5805'), { tier: 's', updated_at: now() }))
  })

  test('collaboration notes: one per observer per team, their own', async () => {
    const note = (by, over = {}) => ({
      event_key: '2026test', team_number: 4414, answered_questions: true, shared_strategy: null,
      showed_up_prepared: null, responsive_in_queue: null, communication_rating: 4, coordination_rating: null,
      would_partner_again: true, note: null, observed_by: by, observed_at: Timestamp.now(), created_at: now(), ...over,
    })
    await assertSucceeds(setDoc(doc(dbOf('member'), 'team_collaboration', collabId('2026test', 4414, 'member')), note('member')))
    await assertFails(setDoc(doc(dbOf('member'), 'team_collaboration', 'second-note'), note('member')))
    await assertFails(setDoc(doc(dbOf('member'), 'team_collaboration', collabId('2026test', 4414, 'member2')), note('member2')))
    await assertFails(setDoc(doc(dbOf('member2'), 'team_collaboration', collabId('2026test', 4414, 'member2')), note('member2', { communication_rating: 9 })))
    await assertFails(updateDoc(doc(dbOf('member2'), 'team_collaboration', collabId('2026test', 4414, 'member')), { note: 'x' }))
    await assertSucceeds(deleteDoc(doc(dbOf('lead'), 'team_collaboration', collabId('2026test', 4414, 'member'))))
  })

  test('vision: frames go only into your own session', async () => {
    const session = (by) => ({
      event_key: '2026test', match_key: null, device_label: 'Pixel', model: 'coco-ssd@2.2', model_note: null,
      started_by: by, operator: 'member user', started_at: Timestamp.now(), ended_at: null, frame_count: 0,
      observations: 0, peak_count: null, count_sum: 0, created_at: now(),
    })
    const frame = () => ({ offset_ms: 100, recorded_at: Timestamp.now(), object_count: 2, detections: [], team_number: null, created_at: now() })
    await assertSucceeds(setDoc(doc(dbOf('member'), 'vision_sessions', 'S'), session('member')))
    await assertFails(setDoc(doc(dbOf('member'), 'vision_sessions', 'T'), session('member2')))
    await assertSucceeds(setDoc(doc(dbOf('member'), 'vision_sessions', 'S', 'observations', 'o1'), frame()))
    await assertFails(setDoc(doc(dbOf('member2'), 'vision_sessions', 'S', 'observations', 'o2'), frame()))
    await assertSucceeds(setDoc(doc(dbOf('lead'), 'vision_sessions', 'S', 'observations', 'o3'), frame()))
    await assertSucceeds(updateDoc(doc(dbOf('member'), 'vision_sessions', 'S'), { observations: 1, count_sum: 2, peak_count: 2 }))
    await assertFails(updateDoc(doc(dbOf('member2'), 'vision_sessions', 'S'), { frame_count: 99 }))
  })
})

describe('storage', () => {
  const bytes = new Uint8Array([1, 2, 3, 4])
  const put = (who, path, contentType, owner = who) =>
    uploadBytes(ref(storeOf(who), path), bytes, { contentType, customMetadata: owner ? { owner } : undefined })

  test('a member uploads what they own, of a type the folder takes', async () => {
    await assertSucceeds(put('member', 'media/pit/2026test/5805/front-a.jpg', 'image/jpeg'))
    await assertFails(put('member', 'media/x.exe', 'application/x-msdownload'))
    await assertFails(put('member', 'media/y.jpg', 'image/jpeg', null))
    await assertFails(put('member', 'media/z.jpg', 'image/jpeg', 'member2'))
    await assertFails(put('viewer', 'media/v.jpg', 'image/jpeg'))
    await assertFails(put('pending', 'media/p.jpg', 'image/jpeg'))
    await assertFails(put('member', 'elsewhere/a.jpg', 'image/jpeg'))
  })

  test('private folders are read by the team only; media by viewers and up', async () => {
    await put('member', 'media/a.jpg', 'image/jpeg')
    await put('member', 'code/a.zip', 'application/zip')
    await assertSucceeds(getBytes(ref(storeOf('viewer'), 'media/a.jpg')))
    await assertFails(getBytes(ref(storeOf('viewer'), 'code/a.zip')))
    await assertSucceeds(getBytes(ref(storeOf('member'), 'code/a.zip')))
    await assertFails(getBytes(ref(storeOf('pending'), 'media/a.jpg')))
    await assertFails(getBytes(ref(storeOf(null), 'media/a.jpg')))
  })

  test('a member cannot overwrite or delete another member’s upload; a lead can', async () => {
    await put('member', 'code/shared.zip', 'application/zip')
    await assertFails(put('member2', 'code/shared.zip', 'application/zip'))
    await assertFails(deleteObject(ref(storeOf('member2'), 'code/shared.zip')))
    await assertSucceeds(put('member', 'code/shared.zip', 'application/zip'))
    await assertSucceeds(put('lead', 'code/shared.zip', 'application/zip'))
  })

  test('a member deletes their own upload', async () => {
    await put('member', 'knowledge/mine.pdf', 'application/pdf')
    await assertSucceeds(deleteObject(ref(storeOf('member'), 'knowledge/mine.pdf')))
  })

  test('the public folder: anyone reads, only leads write', async () => {
    await assertFails(put('member', 'public-media/logo.png', 'image/png'))
    await assertSucceeds(put('lead', 'public-media/logo.png', 'image/png'))
    await assertSucceeds(getBytes(ref(storeOf(null), 'public-media/logo.png')))
    await assertFails(put('lead', 'public-media/clip.mp4', 'video/mp4'))
  })
})
