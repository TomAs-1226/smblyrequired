// Fill the local emulators with a believable event, so the portal can be looked
// at (and worked on) with something in it: 24 teams, 40 qualification matches
// scouted by the seeded members, pit passes, forms, settings, two knowledge docs
// and a backup run.
//
//   npm run emulators
//   npm run seed:emulators      (the accounts)
//   npm run seed:demo           (this)
//
// EMULATORS ONLY. It refuses to run without FIRESTORE_EMULATOR_HOST, so it can
// never write invented scouting data into a real project.
process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080'
process.env.FIREBASE_STORAGE_EMULATOR_HOST ||= '127.0.0.1:9199'
if (!/^(127\.0\.0\.1|localhost):/.test(process.env.FIRESTORE_EMULATOR_HOST)) {
  console.error('seed-demo writes invented data and only ever talks to a local emulator.')
  process.exit(1)
}

const { db, FieldValue, Timestamp } = await import('./admin.mjs')
const { entryId, recordedDay, eventTeamId, activeFormId, minutesOf } = await import('../../src/lib/ids.js')

const EVENT = '2026demo'
const now = () => FieldValue.serverTimestamp()

// A small fixed generator: the same demo every run.
let seed = 5805
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 4294967296)
const between = (lo, hi) => Math.round(lo + rnd() * (hi - lo))

const TEAMS = [
  [5805, 'SMbly Required'], [581, 'Blazing Bulldogs'], [4414, 'HighTide'], [1678, 'Citrus Circuits'],
  [254, 'The Cheesy Poofs'], [3476, 'Code Orange'], [2485, 'W.A.R. Lords'], [1538, 'The Holy Cows'],
  [3255, 'SuperNURDs'], [5199, 'Robot Dolphins From Outer Space'], [4201, 'The Vitruvian Bots'],
  [6560, 'Charging Champions'], [968, 'RAWC'], [7157, 'µBotics'], [3647, 'Millennium Falcons'],
  [4738, 'Patribots'], [2659, 'RoboWarriors'], [5124, 'West Torrance Robotics'], [1836, 'The MilkenKnights'],
  [9084, 'Crescendo'], [3128, 'Aluminum Narwhals'], [8033, 'Highlander Robotics'], [4276, 'Surf City Vikings'],
  [6995, 'NOMAD'],
]

const profiles = await db.collection('profiles').get()
const scouts = profiles.docs.filter((d) => ['member', 'lead', 'admin'].includes(d.data().role)).map((d) => d.id)
if (!scouts.length) {
  console.error('no member accounts found — run `npm run seed:emulators` first')
  process.exit(1)
}
const lead = profiles.docs.find((d) => d.data().role === 'lead')?.id ?? scouts[0]

const batch = () => {
  let b = db.batch()
  let n = 0
  return {
    async set(ref, data) {
      b.set(ref, data)
      if (++n >= 400) { await b.commit(); b = db.batch(); n = 0 }
    },
    async done() { if (n) await b.commit() },
  }
}
const w = batch()

await w.set(db.collection('events').doc(EVENT), {
  key: EVENT, year: 2026, name: 'Demo Regional', short_name: 'Demo', event_type: 'Regional', city: 'Rancho Santa Margarita',
  state_prov: 'CA', country: 'USA', start_date: '2026-10-09', end_date: '2026-10-11', week: null, synced_at: now(),
})
for (const [team_number, nickname] of TEAMS) {
  await w.set(db.collection('event_teams').doc(eventTeamId(EVENT, team_number)), {
    event_key: EVENT, team_number, nickname, name: null, city: null, state_prov: 'CA', country: 'USA', rookie_year: null, synced_at: now(),
  })
}

// Forms, the active pointers and the settings.
const fields = {
  match: [
    { key: 'auto_fuel', label: 'FUEL in auto', type: 'counter', section: 'Autonomous' },
    { key: 'teleop_fuel', label: 'FUEL in teleop', type: 'counter', section: 'Teleop' },
    { key: 'total_score', label: 'Estimated points', type: 'number', section: 'Summary' },
    { key: 'defense', label: 'Defence', type: 'rating', section: 'Summary', max: 5 },
    { key: 'broke', label: 'Broke down', type: 'boolean', section: 'Summary' },
    { key: 'no_show', label: 'No show', type: 'boolean', section: 'Summary' },
  ],
  pit: [
    { key: 'drivetrain', label: 'Drivetrain', type: 'select', options: ['Swerve', 'Tank', 'Other'] },
    { key: 'total_score', label: 'Points per match (their estimate)', type: 'number' },
    { key: 'auto', label: 'Auto routines', type: 'textarea' },
  ],
}
for (const kind of ['match', 'pit']) {
  const form = db.collection('scout_forms').doc(`demo-${kind}`)
  await w.set(form, {
    season: 2026, kind, name: kind === 'match' ? 'REBUILT match scouting' : 'REBUILT pit scouting', description: null,
    fields: fields[kind], is_active: true, created_by: lead, created_at: now(), updated_at: now(),
  })
  await w.set(db.collection('scout_form_active').doc(activeFormId(2026, kind)), { form_id: form.id, season: 2026, kind })
}
await w.set(db.collection('scout_settings').doc('main'), {
  active_event_key: EVENT, lock_enabled: false, window_start: '08:00', window_end: '18:00',
  window_start_min: minutesOf('08:00'), window_end_min: minutesOf('18:00'), timezone: 'America/Los_Angeles', utc_offset_min: -420,
  vision_model_url: null, vision_model_name: null, vision_model_labels: [], vision_model_size: 640, updated_by: lead, updated_at: now(),
})

// Matches: six teams each, three a side; every robot in a match is scouted by one
// of the members. Each team has a level it plays around, so the rankings mean something.
const level = new Map(TEAMS.map(([t], i) => [t, 30 + Math.round(70 * Math.pow(1 - i / TEAMS.length, 1.6)) + between(-6, 6)]))
const day0 = new Date('2026-10-10T16:00:00Z').getTime()
let entries = 0
for (let m = 1; m <= 40; m++) {
  const order = TEAMS.map(([t]) => t).sort(() => rnd() - 0.5).slice(0, 6)
  const at = new Date(day0 + m * 9 * 60_000)
  for (let i = 0; i < 6; i++) {
    const team_number = order[i]
    // The last three teams in the list are never scouted: coverage has something to say.
    if (TEAMS.findIndex(([t]) => t === team_number) >= TEAMS.length - 3) continue
    const scout_id = scouts[(m + i) % scouts.length]
    const base = level.get(team_number)
    const broke = rnd() < 0.06
    const total = Math.max(0, Math.round(base * (broke ? 0.3 : 1) + between(-12, 12)))
    const e = {
      client_uuid: `demo-${m}-${team_number}`, form_id: 'demo-match', kind: 'match', event_key: EVENT, team_number,
      match_key: `${EVENT}_qm${m}`, match_number: m, comp_level: 'qm', alliance: i < 3 ? 'red' : 'blue',
      data: { auto_fuel: between(0, 8), teleop_fuel: Math.round(total / 3), total_score: total, defense: between(1, 5), broke, no_show: false },
      notes: broke ? 'Stopped moving mid-match; came back for endgame.' : rnd() < 0.2 ? 'Quick cycles, clean auto.' : null,
      scout_id, recorded_at: Timestamp.fromDate(at), recorded_day: recordedDay(at), slot: null, created_at: now(),
    }
    await w.set(db.collection('scout_entries').doc(entryId(e)), e)
    entries++
  }
}
// Pit passes on the first twelve teams.
for (const [team_number] of TEAMS.slice(0, 12)) {
  const at = new Date(day0 - 3600_000)
  const e = {
    client_uuid: `demo-pit-${team_number}`, form_id: 'demo-pit', kind: 'pit', event_key: EVENT, team_number, match_key: null,
    match_number: null, comp_level: null, alliance: null,
    data: { drivetrain: 'Swerve', total_score: level.get(team_number) + between(-5, 15), auto: 'Two-piece from the centre.' },
    notes: null, scout_id: scouts[team_number % scouts.length], recorded_at: Timestamp.fromDate(at), recorded_day: recordedDay(at),
    slot: 1, created_at: now(),
  }
  await w.set(db.collection('scout_entries').doc(entryId(e)), e)
  entries++
}

// Knowledge base, with their slug indexes.
const docs = [
  ['pit-checklist', 'Pit checklist', 'pit', '# Before every match\n\n- Battery above 12.5 V, strapped in\n- Bumpers on, numbers the right way round\n- Radio light solid\n- **Tug-test** every connector you touched'],
  ['wiring-standards', 'Wiring standards', 'electrical', '# Wiring standards\n\nCrimp, then tug. Label both ends. CAN is one continuous chain: yellow to yellow, green to green.'],
]
for (const [slug, title, category, body_md] of docs) {
  const at = db.collection('knowledge_docs').doc(`demo-${slug}`)
  await w.set(at, { slug, title, body_md, category, is_pinned: slug === 'pit-checklist', created_by: lead, updated_by: lead, created_at: now(), updated_at: now() })
  await w.set(db.collection('kb_slugs').doc(slug), { doc_id: at.id })
}

await w.set(db.collection('backup_runs').doc('demo-run'), {
  leg: 'firebase->server', status: 'ok', started_at: Timestamp.fromDate(new Date(Date.now() - 5 * 3600_000)),
  finished_at: Timestamp.fromDate(new Date(Date.now() - 5 * 3600_000 + 120_000)), object_count: 42, byte_total: 180_000_000,
  db_dump_bytes: 2_400_000, manifest_sha: 'a'.repeat(64), restore_tested_at: null, error: null, created_at: now(),
})

await w.done()
console.log(`event ${EVENT}: ${TEAMS.length} teams, ${entries} entries, 2 forms, 2 knowledge docs`)
console.log('the statistics appear a few seconds later, as the functions emulator works through the entries')
