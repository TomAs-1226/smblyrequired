// Cloud Functions against the emulators (Auth, Firestore, Storage, Functions).
//
//   npx firebase --config firebase.functions-test.json emulators:exec \
//     --project demo-frc5805 "node --test functions/test/"
//
// A `demo-` project needs no credentials and cannot reach a real one. Nothing
// here calls The Blue Alliance, Nexus, Statbotics or OpenAI: the paths that
// would are exercised with a stand-in `fetch`, by importing the handler.
//
// Seeding is done with the Admin SDK (which bypasses the rules, as the functions
// do). Callables are called the way the portal calls them: through the client
// SDK, signed in against the Auth emulator.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'

import { deleteApp as deleteAdminApp, getApps as adminApps, initializeApp as initAdmin } from 'firebase-admin/app'
import { getAuth as adminAuth } from 'firebase-admin/auth'
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'

import { deleteApp, initializeApp } from 'firebase/app'
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword } from 'firebase/auth'
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions'

const underEmulators = Boolean(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST)
const config = JSON.parse(readFileSync(new URL('../../firebase.functions-test.json', import.meta.url), 'utf8'))
const PORTS = config.emulators
const HOST = '127.0.0.1'
const PROJECT = process.env.GCLOUD_PROJECT || 'demo-frc5805'
const REGION = 'us-west1'

const PENDING = 'Your account is still pending approval. Ask a lead to approve it.'
const NO_ACCESS = 'You do not have access to that.'

describe('Cloud Functions', { skip: underEmulators ? false : 'needs the emulators: see the command at the top of this file' }, () => {
  let db
  let bucket
  const clientApps = []
  const users = {}

  // ---- helpers --------------------------------------------------------------

  const now = () => FieldValue.serverTimestamp()

  function clientFor(name) {
    const app = initializeApp(
      { apiKey: 'demo-key', projectId: PROJECT, appId: 'demo-app', authDomain: `${PROJECT}.firebaseapp.com` },
      `${name}-${randomUUID()}`
    )
    clientApps.push(app)
    const auth = getAuth(app)
    connectAuthEmulator(auth, `http://${HOST}:${PORTS.auth.port}`, { disableWarnings: true })
    const functions = getFunctions(app, REGION)
    connectFunctionsEmulator(functions, HOST, PORTS.functions.port)
    return { auth, call: (fn, payload) => httpsCallable(functions, fn)(payload).then((r) => r.data) }
  }

  // A throwaway account in the Auth emulator, signed in, with a profile unless
  // the role is null (a signed-in user with no profile is `pending`).
  async function makeUser(name, role) {
    const uid = `${name}-${randomUUID().slice(0, 8)}`
    const email = `${uid}@example.invalid`
    const password = randomUUID()
    await adminAuth().createUser({ uid, email, password })
    if (role) {
      await db.doc(`profiles/${uid}`).set({
        full_name: name, grad_year: null, subteam: null, role, created_at: now(), updated_at: now(),
      })
    }
    const client = clientFor(name)
    await signInWithEmailAndPassword(client.auth, email, password)
    return { uid, call: client.call }
  }

  // The client SDK appends the HTTP status to a callable's message
  // ("No such member. [404]"). The sentence is what the function wrote, so the
  // status is taken off before comparing.
  const sentence = (err) => String(err.message).replace(/ \[\d{3}\]$/, '')

  async function refused(promise, code, message) {
    await assert.rejects(promise, (err) => {
      assert.equal(err.code, `functions/${code}`, `expected ${code}, got ${err.code}: ${err.message}`)
      if (message instanceof RegExp) assert.match(sentence(err), message)
      else if (message) assert.equal(sentence(err), message)
      return true
    })
  }

  // Triggers run after the write that caused them, so their effects are waited for.
  async function eventually(check, what, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs
    let last
    for (;;) {
      try {
        const value = await check()
        if (value) return value
        last = new Error('condition not met')
      } catch (err) {
        last = err
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${last?.message}`)
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  const roleOf = async (uid) => (await db.doc(`profiles/${uid}`).get()).get('role')
  const adminCount = async () => (await db.collection('profiles').where('role', '==', 'admin').get()).size
  const auditFor = async (entityId, action) =>
    (await db.collection('audit_log').where('entity_id', '==', entityId).get()).docs
      .map((d) => d.data())
      .filter((r) => r.action === action)

  let seq = 0
  function entry(fields) {
    const recorded = new Date(Date.UTC(2026, 2, 20, 12, seq++))
    const e = {
      client_uuid: randomUUID(), form_id: null, kind: 'match', event_key: '2026test', team_number: 4414,
      match_key: null, match_number: 1, comp_level: 'qm', alliance: 'red', data: {}, notes: null,
      scout_id: 'scout-a', recorded_at: Timestamp.fromDate(recorded),
      recorded_day: recorded.getUTCFullYear() * 10000 + (recorded.getUTCMonth() + 1) * 100 + recorded.getUTCDate(),
      slot: null, created_at: now(), ...fields,
    }
    if (e.kind !== 'match') Object.assign(e, { match_number: null, alliance: null, comp_level: null, slot: e.slot ?? 1 })
    return e
  }
  const addEntry = async (fields) => {
    const ref = db.collection('scout_entries').doc(`u:${randomUUID()}`)
    await ref.set(entry(fields))
    return ref
  }
  const statsDoc = (eventKey, team) => db.doc(`team_event_stats/${eventKey}_${team}`)

  // ---- setup ----------------------------------------------------------------

  before(async () => {
    initAdmin({ projectId: PROJECT, storageBucket: `${PROJECT}.appspot.com` })
    db = getFirestore()
    bucket = getStorage().bucket()

    users.admin = await makeUser('admin', 'admin')
    users.lead = await makeUser('lead', 'lead')
    users.member = await makeUser('member', 'member')
    users.viewer = await makeUser('viewer', 'viewer')
    users.pending = await makeUser('pending', null)
    users.target = await makeUser('target', 'member')
  })

  after(async () => {
    await Promise.all(clientApps.map((app) => deleteApp(app)))
    await Promise.all(adminApps().map((app) => deleteAdminApp(app)))
  })

  // ---- setMemberRole --------------------------------------------------------

  describe('setMemberRole', () => {
    test('needs a sign-in', async () => {
      const anonymous = clientFor('anonymous')
      await refused(anonymous.call('setMemberRole', { targetId: users.target.uid, role: 'lead' }), 'unauthenticated', 'Sign in to use this.')
    })

    test('a pending account, a member and a lead are all refused', async () => {
      const ask = (who) => who.call('setMemberRole', { targetId: users.target.uid, role: 'lead' })
      await refused(ask(users.pending), 'permission-denied', PENDING)
      await refused(ask(users.viewer), 'permission-denied', NO_ACCESS)
      await refused(ask(users.member), 'permission-denied', NO_ACCESS)
      await refused(ask(users.lead), 'permission-denied', NO_ACCESS)
      assert.equal(await roleOf(users.target.uid), 'member')
      assert.equal((await auditFor(users.target.uid, 'role.change')).length, 0)
    })

    test('an admin changes a role, gets the profile back, and the change is audited', async () => {
      const profile = await users.admin.call('setMemberRole', { targetId: users.target.uid, role: 'lead' })
      assert.equal(profile.id, users.target.uid)
      assert.equal(profile.role, 'lead')
      assert.equal(profile.full_name, 'target')
      // Plain JSON: times are ISO strings, as the rest of the portal's rows are.
      assert.match(profile.updated_at, /^\d{4}-\d{2}-\d{2}T/)
      assert.match(profile.created_at, /^\d{4}-\d{2}-\d{2}T/)
      assert.equal(await roleOf(users.target.uid), 'lead')

      const rows = await auditFor(users.target.uid, 'role.change')
      assert.equal(rows.length, 1)
      assert.equal(rows[0].actor, users.admin.uid)
      assert.equal(rows[0].entity, 'profiles')
      assert.deepEqual(rows[0].detail, { from: 'member', to: 'lead' })
      assert.ok(rows[0].created_at instanceof Timestamp)
    })

    test('setting the role a member already has is not an event', async () => {
      const profile = await users.admin.call('setMemberRole', { targetId: users.target.uid, role: 'lead' })
      assert.equal(profile.role, 'lead')
      assert.equal((await auditFor(users.target.uid, 'role.change')).length, 1)
    })

    test('an admin cannot change their own role, up or down', async () => {
      const self = (role) => users.admin.call('setMemberRole', { targetId: users.admin.uid, role })
      await refused(self('member'), 'failed-precondition', 'You cannot change your own role.')
      await refused(self('admin'), 'failed-precondition', 'You cannot change your own role.')
      assert.equal(await roleOf(users.admin.uid), 'admin')
    })

    test('an unknown role, a missing member and a bad id are refused', async () => {
      await refused(users.admin.call('setMemberRole', { targetId: users.target.uid, role: 'owner' }), 'invalid-argument', /role must be one of/)
      await refused(users.admin.call('setMemberRole', { targetId: 'nobody-here', role: 'member' }), 'not-found', 'No such member.')
      await refused(users.admin.call('setMemberRole', { targetId: 'a/b', role: 'member' }), 'invalid-argument')
      await refused(users.admin.call('setMemberRole', { role: 'member' }), 'invalid-argument')
      assert.equal(await roleOf(users.target.uid), 'lead')
    })

    test('the role comes from the profile, not from anything the caller holds', async () => {
      // The member's sign-in is unchanged; only the profile document differs.
      await db.doc(`profiles/${users.member.uid}`).update({ role: 'admin' })
      const profile = await users.member.call('setMemberRole', { targetId: users.target.uid, role: 'member' })
      assert.equal(profile.role, 'member')
      await db.doc(`profiles/${users.member.uid}`).update({ role: 'member' })
      await refused(users.member.call('setMemberRole', { targetId: users.target.uid, role: 'lead' }), 'permission-denied', NO_ACCESS)
    })

    test('the last admin cannot be demoted', async () => {
      // You cannot target yourself, so through the callable the last admin is
      // only ever targeted by someone who was an admin when the call began and
      // is not any more. That caller is built here by calling the handler
      // directly, against the same emulator.
      assert.equal(await adminCount(), 1)
      const { setMemberRole } = await import('../src/members.js')
      await assert.rejects(
        setMemberRole({ data: { targetId: users.admin.uid, role: 'member' } }, { uid: users.lead.uid, role: 'admin' }),
        (err) => err.code === 'failed-precondition' && err.message === 'Refusing to remove the last remaining admin.'
      )
      assert.equal(await roleOf(users.admin.uid), 'admin')
      // With a second admin the same demotion is fine, but not from a caller who
      // has stopped being an admin.
      await db.doc(`profiles/${users.viewer.uid}`).update({ role: 'admin' })
      await assert.rejects(
        setMemberRole({ data: { targetId: users.viewer.uid, role: 'viewer' } }, { uid: users.lead.uid, role: 'admin' }),
        (err) => err.code === 'permission-denied'
      )
      const back = await users.admin.call('setMemberRole', { targetId: users.viewer.uid, role: 'viewer' })
      assert.equal(back.role, 'viewer')
      assert.equal(await adminCount(), 1)
    })

    test('two admins demoting each other at once leave exactly one admin', async () => {
      const a = await makeUser('admin-a', 'admin')
      const b = await makeUser('admin-b', 'admin')
      // Only these two are admins for the length of the race.
      await db.doc(`profiles/${users.admin.uid}`).update({ role: 'lead' })
      try {
        const results = await Promise.allSettled([
          a.call('setMemberRole', { targetId: b.uid, role: 'member' }),
          b.call('setMemberRole', { targetId: a.uid, role: 'member' }),
        ])
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one demotion goes through')
        const loser = results.find((r) => r.status === 'rejected').reason
        assert.ok(
          ['functions/failed-precondition', 'functions/permission-denied'].includes(loser.code),
          `the other is refused, got ${loser.code}: ${loser.message}`
        )
        assert.equal(await adminCount(), 1)
      } finally {
        await db.doc(`profiles/${users.admin.uid}`).update({ role: 'admin' })
        await db.doc(`profiles/${a.uid}`).update({ role: 'member' })
        await db.doc(`profiles/${b.uid}`).update({ role: 'member' })
      }
      assert.equal(await adminCount(), 1)
    })
  })

  // ---- deleteMember ---------------------------------------------------------

  describe('deleteMember', () => {
    test('only an admin, and never themselves', async () => {
      await refused(users.lead.call('deleteMember', { targetId: users.target.uid }), 'permission-denied', NO_ACCESS)
      await refused(users.admin.call('deleteMember', { targetId: users.admin.uid }), 'failed-precondition', 'You cannot delete your own account.')
      await refused(users.admin.call('deleteMember', { targetId: 'nobody-here' }), 'not-found', 'No such member.')
      assert.equal((await db.doc(`profiles/${users.admin.uid}`).get()).exists, true)
    })

    test('the last admin cannot be deleted', async () => {
      const { deleteMember } = await import('../src/members.js')
      await assert.rejects(
        deleteMember({ data: { targetId: users.admin.uid } }, { uid: users.lead.uid, role: 'admin' }),
        (err) => err.code === 'failed-precondition' && err.message === 'Refusing to delete the last remaining admin.'
      )
      assert.equal(await roleOf(users.admin.uid), 'admin')
      await adminAuth().getUser(users.admin.uid)
    })

    test('removes the profile and the sign-in account, and audits it', async () => {
      const gone = await makeUser('leaver', 'member')
      const result = await users.admin.call('deleteMember', { targetId: gone.uid })
      assert.deepEqual(result, { id: gone.uid, deleted: true, role: 'member' })
      assert.equal((await db.doc(`profiles/${gone.uid}`).get()).exists, false)
      await assert.rejects(adminAuth().getUser(gone.uid), (err) => err.code === 'auth/user-not-found')

      const rows = await auditFor(gone.uid, 'member.delete')
      assert.equal(rows.length, 1)
      assert.equal(rows[0].actor, users.admin.uid)
      assert.deepEqual(rows[0].detail, { role: 'member', full_name: 'leaver' })
    })
  })

  // ---- team_event_stats -----------------------------------------------------

  describe('onScoutEntryWritten / onRobotPhotoWritten', () => {
    const refs = []

    test('entries produce the statistics document', async () => {
      refs.push(await addEntry({ data: { total_score: 12 }, scout_id: 'scout-a' }))
      refs.push(await addEntry({ data: { total_score: '8' }, scout_id: 'scout-b', match_number: 2 }))
      refs.push(await addEntry({ data: { total_score: 'lots', broke: 'yes', no_show: 'maybe' }, scout_id: 'scout-a', match_number: 3 }))
      refs.push(await addEntry({ kind: 'pit', data: { total_score: 40 }, scout_id: 'scout-c' }))
      refs.push(await addEntry({ kind: 'strategy', notes: 'fast cycles', scout_id: 'scout-a' }))

      const s = await eventually(async () => {
        const d = (await statsDoc('2026test', 4414).get()).data()
        return d && d.matches_scouted === 3 && d.pit_visits === 1 && d.notes_logged === 1 ? d : null
      }, 'team_event_stats/2026test_4414')

      assert.equal(s.event_key, '2026test')
      assert.equal(s.team_number, 4414)
      assert.equal(s.scored_matches, 2)
      assert.equal(s.avg_score, 10)
      assert.equal(s.min_score, 8)
      assert.equal(s.max_score, 12)
      assert.ok(Math.abs(s.score_stddev - Math.sqrt(8)) < 1e-9)
      assert.equal(s.pit_estimate, 40)
      assert.equal(s.breakdowns, 1)
      assert.equal(s.no_shows, 0)
      assert.equal(s.scouts_contributing, 2)
      assert.equal(s.scouts, 3)
      assert.equal(s.photos, 0)
      assert.ok(s.last_seen instanceof Timestamp)
      assert.ok(s.updated_at instanceof Timestamp)
      assert.deepEqual(Object.keys(s).sort(), [
        'avg_score', 'breakdowns', 'event_key', 'last_seen', 'matches_scouted', 'max_score', 'min_score', 'no_shows',
        'notes_logged', 'photos', 'pit_estimate', 'pit_visits', 'score_stddev', 'scored_matches', 'scouts',
        'scouts_contributing', 'team_number', 'updated_at',
      ])
    })

    test('a correction is counted once, with its new answer', async () => {
      await refs[0].update({ data: { total_score: 16 } })
      const s = await eventually(async () => {
        const d = (await statsDoc('2026test', 4414).get()).data()
        return d?.avg_score === 12 ? d : null
      }, 'the corrected average')
      assert.equal(s.matches_scouted, 3)
      assert.equal(s.max_score, 16)
    })

    test('a photo is counted, and a team with only photos still has a document', async () => {
      const photo = (team) => ({
        client_uuid: randomUUID(), event_key: '2026test', team_number: team, angle: 'front',
        file: { id: 'media~none.jpg', bucket: 'media', path: 'none.jpg' }, quality: {}, taken_by: 'scout-a', created_at: now(),
      })
      refs.push(db.doc(`robot_photos/${randomUUID()}`))
      await refs.at(-1).set(photo(4414))
      refs.push(db.doc(`robot_photos/${randomUUID()}`))
      await refs.at(-1).set(photo(1678))

      await eventually(async () => (await statsDoc('2026test', 4414).get()).get('photos') === 1, 'photos on 4414')
      const only = await eventually(async () => (await statsDoc('2026test', 1678).get()).data(), 'a document for 1678')
      assert.equal(only.photos, 1)
      assert.equal(only.matches_scouted, 0)
      assert.equal(only.avg_score, null)
      assert.equal(only.last_seen, null)
    })

    test('an edit that moves an entry refreshes both teams', async () => {
      await refs[1].update({ team_number: 5805 })
      const moved = await eventually(async () => {
        const d = (await statsDoc('2026test', 5805).get()).data()
        return d?.matches_scouted === 1 ? d : null
      }, 'team_event_stats/2026test_5805')
      assert.equal(moved.avg_score, 8)
      assert.equal(moved.score_stddev, null)

      const left = await eventually(async () => {
        const d = (await statsDoc('2026test', 4414).get()).data()
        return d?.matches_scouted === 2 ? d : null
      }, 'the entry to leave 4414')
      assert.equal(left.scored_matches, 1)
      assert.equal(left.avg_score, 16)
      assert.equal(left.score_stddev, null)
      assert.equal(left.scouts_contributing, 1)
    })

    test('an entry with no event has no statistics document', async () => {
      refs.push(await addEntry({ event_key: null, team_number: 9999, data: { total_score: 5 } }))
      // A later write is waited for, so the trigger for the one above has had its turn.
      refs.push(await addEntry({ team_number: 9998, data: { total_score: 5 } }))
      await eventually(async () => (await statsDoc('2026test', 9998).get()).exists, 'the entry after it')
      const all = await db.collection('team_event_stats').get()
      assert.deepEqual(all.docs.map((d) => d.id).filter((id) => id.includes('9999')), [])
    })

    test('the document is removed when nothing is left', async () => {
      await Promise.all(refs.map((r) => r.delete()))
      for (const team of [4414, 5805, 1678, 9998]) {
        await eventually(async () => !(await statsDoc('2026test', team).get()).exists, `team_event_stats/2026test_${team} to go`)
      }
      assert.equal((await db.collection('team_event_stats').where('event_key', '==', '2026test').get()).size, 0)
    })
  })

  // ---- knowledge doc history -------------------------------------------------

  describe('onKnowledgeDocUpdated', () => {
    test('a version holds the previous title and body, and only when they change', async () => {
      const ref = db.collection('knowledge_docs').doc()
      const versions = async () =>
        (await ref.collection('versions').get()).docs.map((d) => d.data())

      await ref.set({
        slug: 'bumper-rules', title: 'Bumper rules', body_md: 'First draft.', category: 'build', is_pinned: false,
        created_by: users.member.uid, updated_by: users.member.uid, created_at: now(), updated_at: now(),
      })

      await ref.update({ body_md: 'Second draft.', updated_by: users.lead.uid, updated_at: now() })
      const [first] = await eventually(async () => {
        const v = await versions()
        return v.length === 1 ? v : null
      }, 'the first version')
      assert.equal(first.title, 'Bumper rules')
      assert.equal(first.body_md, 'First draft.')
      assert.equal(first.edited_by, users.lead.uid)
      assert.ok(first.created_at instanceof Timestamp)
      assert.deepEqual(Object.keys(first).sort(), ['body_md', 'created_at', 'edited_by', 'title'])

      // Pinning is not an edit to the text. The title change after it is, and when
      // its version has arrived the pin has had its turn and left nothing.
      await ref.update({ is_pinned: true, updated_by: users.lead.uid, updated_at: now() })
      await ref.update({ title: 'Bumper rules 2026', updated_by: users.member.uid, updated_at: now() })
      const all = await eventually(async () => {
        const v = await versions()
        return v.length >= 2 ? v : null
      }, 'the second version')
      await new Promise((r) => setTimeout(r, 1500))
      assert.equal((await versions()).length, 2)

      const second = all.find((v) => v.body_md === 'Second draft.')
      assert.equal(second.title, 'Bumper rules')
      assert.equal(second.edited_by, users.member.uid)
      // The doc itself holds the newest text; the history never does.
      assert.ok(!all.some((v) => v.title === 'Bumper rules 2026'))
    })
  })

  // ---- file delete cascade ---------------------------------------------------

  describe('onFileDeleted', () => {
    test('removes the stored object, the photos, and the references to it', async () => {
      const path = `pit/2026test/254/front-${randomUUID().slice(0, 8)}.jpg`
      const fileId = `media~${path.replace(/\//g, '~')}`
      const fileRef = { id: fileId, bucket: 'media', path }
      const object = bucket.file(`media/${path}`)
      await object.save(Buffer.from('not really a jpeg'), { contentType: 'image/jpeg', resumable: false })
      assert.deepEqual(await object.exists(), [true])

      const keep = bucket.file(`media/keep-${randomUUID().slice(0, 8)}.jpg`)
      await keep.save(Buffer.from('another'), { contentType: 'image/jpeg', resumable: false })
      const otherRef = { id: 'graphs~other.json', bucket: 'graphs', path: 'other.json' }

      await db.doc(`files/${fileId}`).set({
        bucket: 'media', path, title: 'Team 254 — front', description: null, kind: 'photo', season: 2026, tags: [],
        byte_size: 17, sha256: null, uploaded_by: users.member.uid, created_at: now(), updated_at: now(),
      })
      const photo = db.doc(`robot_photos/${randomUUID()}`)
      await photo.set({
        client_uuid: photo.id, event_key: '2026test', team_number: 254, angle: 'front', file: fileRef,
        quality: {}, taken_by: users.member.uid, created_at: now(),
      })
      const otherPhoto = db.doc(`robot_photos/${randomUUID()}`)
      await otherPhoto.set({
        client_uuid: otherPhoto.id, event_key: '2026test', team_number: 254, angle: 'side',
        file: { id: 'media~elsewhere.jpg', bucket: 'media', path: 'elsewhere.jpg' },
        quality: {}, taken_by: users.member.uid, created_at: now(),
      })
      const graph = (slug, file, html_file) => ({
        slug, title: slug, summary: null, source: null, node_count: null, edge_count: null, community_count: null,
        god_nodes: [], generated_at: null, file, html_file, created_by: users.member.uid, created_at: now(), updated_at: now(),
      })
      await db.doc('graphs/as-json').set(graph('as-json', fileRef, otherRef))
      await db.doc('graphs/as-html').set(graph('as-html', otherRef, fileRef))
      await db.doc('graphs/unrelated').set(graph('unrelated', otherRef, null))
      const archive = db.collection('code_archives').doc()
      await archive.set({
        repo: 'robot-2026', ref: 'main', commit_sha: null, season: 2026, notes: null,
        file: { ...fileRef, byte_size: 17 }, created_by: users.member.uid, created_at: now(), updated_at: now(),
      })
      await eventually(async () => (await statsDoc('2026test', 254).get()).get('photos') === 2, 'both photos to be counted')

      await db.doc(`files/${fileId}`).delete()

      await eventually(async () => !(await object.exists())[0], 'the stored object to be removed')
      await eventually(async () => !(await photo.get()).exists, 'the photo to be deleted')
      await eventually(async () => (await db.doc('graphs/as-json').get()).get('file') === null, 'graphs.file to be cleared')
      await eventually(async () => (await db.doc('graphs/as-html').get()).get('html_file') === null, 'graphs.html_file to be cleared')
      await eventually(async () => (await archive.get()).get('file') === null, 'code_archives.file to be cleared')

      // What pointed elsewhere is untouched.
      assert.deepEqual((await db.doc('graphs/as-json').get()).get('html_file'), otherRef)
      assert.deepEqual((await db.doc('graphs/as-html').get()).get('file'), otherRef)
      assert.deepEqual((await db.doc('graphs/unrelated').get()).get('file'), otherRef)
      assert.equal((await otherPhoto.get()).exists, true)
      assert.deepEqual(await keep.exists(), [true])
      assert.equal((await archive.get()).get('repo'), 'robot-2026')
      // And the deleted photo's own trigger lowered the team's count.
      await eventually(async () => (await statsDoc('2026test', 254).get()).get('photos') === 1, 'the photo count to drop')
    })

    test('a file whose object is already gone still cascades', async () => {
      const fileId = 'graphs~graphify~2026~gone-graph.json'
      await db.doc(`files/${fileId}`).set({
        bucket: 'graphs', path: 'graphify/2026/gone-graph.json', title: 'gone', description: null, kind: 'graph',
        season: 2026, tags: [], byte_size: null, sha256: null, uploaded_by: users.member.uid, created_at: now(), updated_at: now(),
      })
      const archive = db.collection('code_archives').doc()
      await archive.set({
        repo: 'x', ref: null, commit_sha: null, season: 2026, notes: null,
        file: { id: fileId, bucket: 'graphs', path: 'graphify/2026/gone-graph.json' },
        created_by: users.member.uid, created_at: now(), updated_at: now(),
      })
      await db.doc(`files/${fileId}`).delete()
      await eventually(async () => (await archive.get()).get('file') === null, 'the reference to be cleared')
    })
  })

  // ---- the proxies -----------------------------------------------------------

  describe('tbaProxy, nexusProxy, statboticsProxy', () => {
    const upstream = (routes) => {
      const calls = []
      const fetch = async (url, init) => {
        calls.push({ url: String(url), init })
        const hit = Object.entries(routes).find(([suffix]) => String(url).endsWith(suffix))
        const [status, body] = hit ? hit[1] : [404, { Error: 'no such thing' }]
        return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
      }
      return { fetch, calls }
    }

    test('members and up only, and only the listed actions', async () => {
      for (const fn of ['tbaProxy', 'nexusProxy', 'statboticsProxy', 'ai']) {
        await refused(users.pending.call(fn, { action: 'events', year: 2026 }), 'permission-denied', PENDING)
        await refused(users.viewer.call(fn, { action: 'events', year: 2026 }), 'permission-denied', NO_ACCESS)
      }
      await refused(users.member.call('tbaProxy', { action: 'anything', path: '/status' }), 'invalid-argument',
        'Unknown action. Expected one of: events, event_teams, event_matches, team_history, team_event_detail.')
      await refused(users.member.call('tbaProxy', { action: 'events', year: 1800 }), 'invalid-argument', 'year must be a season year, e.g. 2026.')
      await refused(users.member.call('tbaProxy', { action: 'event_teams', eventKey: '../../status' }), 'invalid-argument', 'eventKey must look like 2026casd.')
      await refused(users.member.call('tbaProxy', { action: 'team_event_detail', eventKey: '2026casd', teamNumber: 0 }), 'invalid-argument', 'teamNumber must be a positive integer.')
      await refused(users.member.call('nexusProxy', { action: 'event_status', eventKey: 'nope' }), 'invalid-argument', 'eventKey must look like 2026casd.')
      await refused(users.member.call('nexusProxy', { action: 'other' }), 'invalid-argument', 'Unknown action. Expected: event_status.')
      await refused(users.member.call('statboticsProxy', { action: 'team_event', team: 'x', event: '2026casd' }), 'invalid-argument', 'team must be a positive integer.')
      await refused(users.member.call('statboticsProxy', { action: 'other' }), 'invalid-argument', 'Unknown action. Expected one of: event_teams, team_event.')
      await refused(users.member.call('tbaProxy', { action: 'events', pad: 'x'.repeat(5000) }), 'invalid-argument', 'Request too large (limit 4000 bytes).')
    })

    test('a fresh Firestore cache is answered without going upstream', async () => {
      const synced = Timestamp.fromDate(new Date(Date.now() - 60_000))
      const team = (n, nickname) => ({
        event_key: '2031cached', team_number: n, nickname, name: null, city: null, state_prov: null, country: null,
        rookie_year: null, synced_at: synced,
      })
      await db.doc('event_teams/2031cached_5805').set(team(5805, 'SMbly Required'))
      await db.doc('event_teams/2031cached_254').set(team(254, 'The Cheesy Poofs'))

      const res = await users.member.call('tbaProxy', { action: 'event_teams', eventKey: '2031CACHED' })
      assert.equal(res.cached, true)
      assert.equal(res.synced_at, synced.toDate().toISOString())
      assert.deepEqual(res.teams.map((t) => t.team_number), [254, 5805])
      assert.equal(res.teams[1].nickname, 'SMbly Required')
      assert.equal(res.teams[1].synced_at, synced.toDate().toISOString())
    })

    test('events are fetched once, cached in Firestore, and served from there', async () => {
      const { handleTba } = await import('../src/tba.js')
      const { fetch, calls } = upstream({
        '/events/2032': [200, [
          { key: '2032casd', year: 2032, name: 'San Diego Regional', short_name: 'San Diego', event_type: 0,
            event_type_string: 'Regional', city: 'San Diego', state_prov: 'CA', country: 'USA',
            start_date: '2032-03-10', end_date: '2032-03-13', week: 2 },
          { key: '2032caoc', year: 2032, name: 'Orange County Regional', event_type: 0,
            start_date: '2032-02-28', end_date: '2032-03-02' },
        ]],
      })
      const deps = { fetch, key: 'test-key' }

      const first = await handleTba({ action: 'events', year: '2032' }, deps)
      assert.equal(first.cached, false)
      assert.deepEqual(first.events.map((e) => e.key), ['2032caoc', '2032casd'])
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, 'https://www.thebluealliance.com/api/v3/events/2032')
      assert.equal(calls[0].init.headers['X-TBA-Auth-Key'], 'test-key')

      const stored = (await db.doc('events/2032casd').get()).data()
      assert.equal(stored.start_date, '2032-03-10') // a string, not a Timestamp
      assert.equal(stored.event_type, 'Regional')
      assert.equal(stored.week, 2)
      assert.ok(stored.synced_at instanceof Timestamp)
      assert.equal(stored.synced_at.toDate().toISOString(), first.synced_at)
      const sparse = (await db.doc('events/2032caoc').get()).data()
      assert.equal(sparse.event_type, '0')
      assert.equal(sparse.short_name, null)
      assert.equal(sparse.week, null)

      const second = await handleTba({ action: 'events', year: 2032 }, deps)
      assert.equal(second.cached, true)
      assert.equal(calls.length, 1)
      assert.deepEqual(second.events.map((e) => e.key), ['2032caoc', '2032casd'])
      assert.equal(second.synced_at, first.synced_at)
      assert.equal(typeof second.events[0].synced_at, 'string')

      const forced = await handleTba({ action: 'events', year: 2032, force: true }, deps)
      assert.equal(forced.cached, false)
      assert.equal(calls.length, 2)
    })

    test('a team list caches its event first, and a stale cache is refreshed', async () => {
      const { handleTba } = await import('../src/tba.js')
      const { fetch, calls } = upstream({
        '/event/2033test': [200, { key: '2033test', year: 2033, name: 'Test Regional', event_type_string: 'Regional' }],
        '/event/2033test/teams': [200, [
          { team_number: 5805, nickname: 'SMbly Required', rookie_year: 2016, city: 'Rancho Santa Margarita' },
          { team_number: 254, nickname: 'The Cheesy Poofs', rookie_year: 1999 },
        ]],
      })
      const deps = { fetch, key: 'test-key' }
      // Seven hours old: past the six-hour limit, so it is not served.
      await db.doc('event_teams/2033test_1').set({
        event_key: '2033test', team_number: 1, nickname: 'stale', synced_at: Timestamp.fromDate(new Date(Date.now() - 7 * 3600_000)),
      })

      const res = await handleTba({ action: 'event_teams', eventKey: '2033test' }, deps)
      assert.equal(res.cached, false)
      assert.deepEqual(res.teams.map((t) => t.team_number), [254, 5805])
      assert.deepEqual(calls.map((c) => c.url.replace('https://www.thebluealliance.com/api/v3', '')), ['/event/2033test', '/event/2033test/teams'])
      assert.equal((await db.doc('events/2033test').get()).get('name'), 'Test Regional')
      const stored = (await db.doc('event_teams/2033test_5805').get()).data()
      assert.equal(stored.rookie_year, 2016)
      assert.equal(stored.name, null)
      assert.ok(stored.synced_at instanceof Timestamp)
    })

    test('an upstream refusal becomes one plain sentence, and its body is never relayed', async () => {
      const { handleTba } = await import('../src/tba.js')
      const { handleNexus } = await import('../src/nexus.js')
      const { handleStatbotics } = await import('../src/statbotics.js')
      const leaky = 'Invalid key: sk-' + 'x'.repeat(30)
      const says = async (promise, code, message) =>
        assert.rejects(promise, (err) => {
          assert.equal(err.code, code)
          assert.equal(err.message, message)
          return true
        })

      await says(handleTba({ action: 'events', year: 2034 }, { ...upstream({ '/events/2034': [401, leaky] }), key: 'k' }), 'internal', 'The Blue Alliance rejected our API key.')
      await says(handleTba({ action: 'event_matches', eventKey: '2034none' }, { ...upstream({}), key: 'k' }), 'not-found', 'Not found on The Blue Alliance.')
      await says(handleTba({ action: 'events', year: 2035 }, { ...upstream({ '/events/2035': [503, leaky] }), key: 'k' }), 'internal', 'The Blue Alliance returned 503.')
      await says(handleTba({ action: 'events', year: 2036 }, { fetch: upstream({}).fetch, key: '' }), 'internal', 'TBA_KEY is not configured on the server.')
      await says(handleNexus({ action: 'event_status', eventKey: '2034casd' }, { ...upstream({ '/event/2034casd': [403, leaky] }), key: 'k' }), 'internal', 'Nexus rejected our API key. A lead needs to check NEXUS_KEY.')
      await says(handleNexus({ action: 'event_status', eventKey: '2034caoc' }, { ...upstream({ '/event/2034caoc': [429, leaky] }), key: 'k' }), 'resource-exhausted', 'Nexus is rate-limiting us — try again shortly.')
      await says(handleStatbotics({ action: 'event_teams', event: '2034casd' }, upstream({ 'limit=1000': [500, leaky] })), 'internal', 'Statbotics is unavailable right now (500).')
    })

    test('nexus and statbotics pass the upstream answer through, and remember it', async () => {
      const { handleNexus } = await import('../src/nexus.js')
      const { handleStatbotics } = await import('../src/statbotics.js')

      const nexus = upstream({
        '/event/2035casd': [200, {
          dataAsOfTime: 1900000000000, nowQueuing: null, announcements: [{}], partsRequests: [],
          matches: [{ label: 'Qualification 11', status: 'On field' }, { label: 'Qualification 12', status: 'Now queuing' }],
        }],
      })
      const live = await handleNexus({ action: 'event_status', eventKey: '2035casd' }, { ...nexus, key: 'k' })
      assert.equal(live.cached, false)
      assert.equal(live.event_key, '2035casd')
      assert.equal(live.nexus.matches.length, 2)
      assert.deepEqual(live.summary, {
        now_queuing: 'Qualification 12', match_count: 2, announcement_count: 1, parts_request_count: 0, data_as_of: 1900000000000,
      })
      assert.equal(nexus.calls[0].init.headers['Nexus-Api-Key'], 'k')
      assert.equal((await handleNexus({ action: 'event_status', eventKey: '2035casd' }, { ...nexus, key: 'k' })).cached, true)
      assert.equal(nexus.calls.length, 1)
      await handleNexus({ action: 'event_status', eventKey: '2035casd', force: true }, { ...nexus, key: 'k' })
      assert.equal(nexus.calls.length, 2)

      const sb = upstream({ 'event=2035casd&limit=1000': [200, [{ team: 5805, epa: { total_points: { mean: 31.5 } } }]] })
      const epa = await handleStatbotics({ action: 'event_teams', event: '2035casd' }, sb)
      assert.deepEqual(epa, { event: '2035casd', team_events: [{ team: 5805, epa: { total_points: { mean: 31.5 } } }], cached: false })
      assert.equal((await handleStatbotics({ action: 'event_teams', event: '2035casd' }, sb)).cached, true)
      assert.equal(sb.calls.length, 1)
    })
  })

  // ---- ai ---------------------------------------------------------------------

  describe('ai', () => {
    // The handler is called directly as a fresh uid each time, so these calls do
    // not spend the allowance of the member the callable tests sign in as.
    const someone = () => `ai-${randomUUID()}`
    const model = (text, extra = {}) => {
      const calls = []
      const fetch = async (url, init) => {
        calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) })
        return new Response(JSON.stringify({ model: 'answering-model', usage: { total_tokens: 42 }, choices: [{ message: { content: text } }], ...extra }), { status: 200 })
      }
      return { fetch, calls }
    }

    test('with nothing to summarise it says so, and never calls a model', async () => {
      const summary = await users.member.call('ai', { task: 'scouting_summary', teamNumber: 7777, eventKey: '2026empty' })
      assert.deepEqual(summary, {
        task: 'scouting_summary', team_number: 7777, event_key: '2026empty', matches_scouted: 0,
        summary: 'No scouting entries have been recorded for team 7777 at 2026empty yet. There is nothing to summarise — treat this team as unknown, not as weak.',
        model: null, usage: null,
      })
      const picks = await users.member.call('ai', { task: 'picklist_help', eventKey: '2026empty' })
      assert.equal(picks.teams_considered, 0)
      assert.equal(picks.model, null)
      assert.match(picks.answer, /^No scouting data exists for 2026empty yet/)
      const kb = await users.member.call('ai', { task: 'kb_answer', question: 'Where is the zzyzx torque wrench?' })
      assert.deepEqual(kb.citations, [])
      assert.equal(kb.model, null)
      const notes = await users.member.call('ai', { task: 'summarise_notes', teamNumber: 7777 })
      assert.equal(notes.note_count, 0)
      assert.equal(notes.summary, 'No scout has written a note about team 7777.')

      await refused(users.member.call('ai', { task: 'write_my_essay' }), 'invalid-argument',
        'Unknown task. Expected one of: scouting_summary, picklist_help, kb_answer, form_suggest, summarise_notes.')
      await refused(users.member.call('ai', { task: 'form_suggest', season: 1999, game: 'x' }), 'invalid-argument', 'season must be a year between 2000 and 2100.')
    })

    test('the rate limit is a document, so it holds across instances', async () => {
      const limited = await makeUser('chatty', 'member')
      const ref = db.doc(`rate_limits/${limited.uid}_ai`)

      await limited.call('ai', { task: 'summarise_notes', teamNumber: 7777 })
      const first = (await ref.get()).data()
      assert.equal(first.hits.length, 1)
      assert.equal(first.uid, limited.uid)

      // Fourteen more inside the window, written as another instance would have.
      await ref.update({ hits: [...first.hits, ...Array.from({ length: 14 }, (_, i) => Date.now() - i * 1000)] })
      await refused(limited.call('ai', { task: 'summarise_notes', teamNumber: 7777 }), 'resource-exhausted', /^Too many AI requests\. Wait a few minutes — the limit is about 15 every 5 minutes\.$/)
      // A refusal is not itself counted.
      assert.equal((await ref.get()).get('hits').length, 15)

      // Once the old requests fall out of the window, the allowance is back.
      await ref.update({ hits: Array.from({ length: 15 }, () => Date.now() - 301_000) })
      await limited.call('ai', { task: 'summarise_notes', teamNumber: 7777 })
      assert.equal((await ref.get()).get('hits').length, 1)
    })

    test('a summary sends the stored statistics and entries, under the honesty prompt', async () => {
      const { handleAi } = await import('../src/ai.js')
      const made = []
      made.push(await addEntry({ event_key: '2026aitest', team_number: 4414, match_key: '2026aitest_qm1', data: { total_score: 10 }, notes: 'Intake jammed twice.' }))
      made.push(await addEntry({ event_key: '2026aitest', team_number: 4414, match_key: '2026aitest_qm2', match_number: 2, data: { total_score: 14, broke: true }, scout_id: 'scout-b' }))
      made.push(await addEntry({ event_key: '2026aitest', team_number: 4414, kind: 'pit', data: { total_score: 99 }, notes: 'Says they can do 99.' }))
      await eventually(async () => (await statsDoc('2026aitest', 4414).get()).get('matches_scouted') === 2, 'the statistics')

      const { fetch, calls } = model('Only 2 matches scouted. …')
      const res = await handleAi(someone(), { task: 'scouting_summary', teamNumber: '4414', eventKey: '2026AITEST' }, { fetch, key: 'test-key' })
      assert.deepEqual(res, {
        task: 'scouting_summary', team_number: 4414, event_key: '2026aitest', matches_scouted: 2,
        summary: 'Only 2 matches scouted. …', model: 'answering-model', usage: { total_tokens: 42 },
      })

      assert.equal(calls.length, 1)
      const { url, headers, body } = calls[0]
      assert.equal(url, 'https://api.openai.com/v1/chat/completions')
      assert.equal(headers.Authorization, 'Bearer test-key')
      assert.equal(body.model, 'gpt-5.3-chat-latest')
      assert.equal(body.max_completion_tokens, 500)
      // The GPT-5 family refuses a temperature; it must not be sent.
      assert.ok(!('temperature' in body))
      assert.ok(!('response_format' in body))
      assert.equal(body.messages[0].role, 'system')
      assert.ok(body.messages[0].content.startsWith('You are a scouting analyst for FRC Team 5805.'))
      assert.ok(body.messages[0].content.includes('- Never invent a statistic, a match, or an event that is not in the input.'))
      assert.ok(body.messages[0].content.endsWith('Breakdowns and no-shows outrank average score; say so if they are non-zero.'))

      const context = JSON.parse(body.messages[1].content)
      assert.equal(context.matches_scouted, 2)
      assert.equal(context.scouts_contributing, 2)
      assert.equal(context.avg_score, 12)
      assert.equal(context.score_stddev, 2.8)
      assert.equal(context.breakdowns, 1)
      // Match entries only, newest first; the pit visit is not a match.
      assert.deepEqual(context.entries.map((e) => e.match), ['2026aitest_qm2', '2026aitest_qm1'])
      assert.equal(context.entries[1].notes, 'Intake jammed twice.')

      // An older model still takes a temperature, and the reasoning model is used for pick lists only.
      const old = model('ok')
      await handleAi(someone(), { task: 'scouting_summary', teamNumber: 4414, eventKey: '2026aitest' }, { ...old, key: 'k', model: 'gpt-4o-mini' })
      assert.equal(old.calls[0].body.temperature, 0.2)
      const picks = model('ranking…')
      const ranked = await handleAi(someone(), { task: 'picklist_help', eventKey: '2026aitest', question: 'Who is reliable?' }, { ...picks, key: 'k', model: 'base', reasoningModel: 'heavy' })
      assert.equal(picks.calls[0].body.model, 'heavy')
      assert.equal(picks.calls[0].body.max_completion_tokens, 900)
      assert.equal(ranked.teams_considered, 1)
      assert.equal(JSON.parse(picks.calls[0].body.messages[1].content).question, 'Who is reliable?')

      // Notes come from every kind of entry that has one.
      const notes = model('Two notes…')
      const summed = await handleAi(someone(), { task: 'summarise_notes', teamNumber: 4414, eventKey: '2026aitest' }, { ...notes, key: 'k' })
      assert.equal(summed.note_count, 2)
      assert.deepEqual(JSON.parse(notes.calls[0].body.messages[1].content).notes, ['Says they can do 99.', 'Intake jammed twice.'])

      await Promise.all(made.map((r) => r.delete()))
    })

    test('a knowledge answer cites the docs it was given, and a form draft is checked', async () => {
      const { handleAi } = await import('../src/ai.js')
      const doc = db.collection('knowledge_docs').doc()
      await doc.set({
        slug: 'battery-care', title: 'Battery care', body_md: 'Charge to green. ' + 'x'.repeat(3000), category: 'electrical',
        is_pinned: false, created_by: users.member.uid, updated_by: users.member.uid, created_at: now(), updated_at: now(),
      })

      const kb = model('Charge to green [battery-care].\nSources: battery-care')
      const answer = await handleAi(someone(), { task: 'kb_answer', question: 'How do we charge a battery?' }, { ...kb, key: 'k' })
      assert.deepEqual(answer.citations, [{ slug: 'battery-care', title: 'Battery care' }])
      const sent = JSON.parse(kb.calls[0].body.messages[1].content)
      assert.equal(sent.documents.length, 1)
      assert.ok(sent.documents[0].body.endsWith('\n…[excerpt truncated]'))
      assert.equal(sent.documents[0].body.length, 2500 + '\n…[excerpt truncated]'.length)

      const form = model(JSON.stringify({
        name: 'Match 2026', description: 'd',
        fields: [
          { key: 'total_score', label: 'Total', type: 'counter' },
          { key: 'Bad Key', label: 'x', type: 'number' },
          { key: 'total_score', label: 'again', type: 'number' },
          { key: 'level', label: 'Level', type: 'select', options: [] },
          { key: 'broke', label: 'Broke down', type: 'boolean' },
        ],
      }))
      const draft = await handleAi(someone(), { task: 'form_suggest', season: 2026, game: 'Score fuel.', kind: 'match' }, { ...form, key: 'k' })
      assert.deepEqual(form.calls[0].body.response_format, { type: 'json_object' })
      assert.equal(form.calls[0].body.max_completion_tokens, 1200)
      assert.deepEqual(draft.draft.fields.map((f) => f.key), ['total_score', 'broke'])
      assert.equal(draft.draft.is_active, false)
      assert.equal(draft.rejected_fields.length, 3)
      // A draft is written nowhere.
      assert.equal((await db.collection('scout_forms').get()).size, 0)

      await doc.delete()
    })

    test('a model error says what happened without repeating what the model said', async () => {
      const { handleAi } = await import('../src/ai.js')
      const leaky = async () => new Response('Incorrect API key provided: sk-' + 'y'.repeat(30), { status: 401 })
      const ask = (fetch, key = 'k') =>
        handleAi(someone(), { task: 'form_suggest', season: 2026, game: 'Score fuel.' }, { fetch, key })
      await assert.rejects(ask(leaky), (err) => err.code === 'internal' && err.message === 'The AI service rejected our API key.')
      await assert.rejects(ask(async () => new Response('slow down', { status: 429 })), (err) => err.code === 'resource-exhausted')
      await assert.rejects(ask(leaky, ''), (err) => err.message === 'OPENAI_API_KEY is not configured on the server.')
      await assert.rejects(
        ask(async () => new Response(JSON.stringify({ choices: [{ message: { content: '  ' } }] }), { status: 200 })),
        (err) => err.message === 'The model returned an empty response.'
      )
    })
  })
})
