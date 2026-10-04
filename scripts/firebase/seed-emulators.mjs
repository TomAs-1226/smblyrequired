// Seed the local Firebase emulators with one account per role, so the portal can
// be tried end to end without a real project.
//
//   npm run emulators          (one terminal)
//   npm run seed:emulators     (once the emulators are up)
//   npm run dev:emulators      (the site, pointed at them)
//
// Talks only to 127.0.0.1. The accounts exist only in the emulator and vanish
// when it stops; the password below is not a secret and unlocks nothing real.
const PROJECT = 'demo-frc5805'
const AUTH = 'http://127.0.0.1:9099'
const STORE = `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents`
const PASSWORD = 'emulator-only'

const people = [
  ['admin@example.test', 'Ada Admin', 'admin'],
  ['lead@example.test', 'Lee Lead', 'lead'],
  ['member@example.test', 'Mel Member', 'member'],
  ['viewer@example.test', 'Val Viewer', 'viewer'],
  ['pending@example.test', 'Pat Pending', 'pending'],
]

// "owner" is the emulators' own admin credential: it bypasses the security rules.
const owner = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }
const str = (v) => (v == null ? { nullValue: null } : { stringValue: v })
const time = () => ({ timestampValue: new Date().toISOString() })

async function account(email, name) {
  const res = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, displayName: name, returnSecureToken: true }),
  })
  const body = await res.json()
  if (body.localId) return body.localId
  if (body.error?.message === 'EMAIL_EXISTS') {
    const again = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
    })
    return (await again.json()).localId
  }
  throw new Error(`could not create ${email}: ${JSON.stringify(body.error)}`)
}

async function put(path, fields) {
  const res = await fetch(`${STORE}/${path}`, { method: 'PATCH', headers: owner, body: JSON.stringify({ fields }) })
  if (!res.ok) throw new Error(`could not write ${path}: ${res.status} ${await res.text()}`)
}

for (const [email, name, role] of people) {
  const uid = await account(email, name)
  await put(`profiles/${uid}`, {
    full_name: str(name), grad_year: { nullValue: null }, subteam: { nullValue: null },
    role: str(role), created_at: time(), updated_at: time(),
  })
  console.log(`${role.padEnd(8)} ${email}`)
}
console.log(`\nPassword for all of them: ${PASSWORD}`)
