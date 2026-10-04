// The small pure pieces: secret scrubbing, parameter validation, knowledge-base
// matching. No emulator, no network.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fail, readBody, scrub } from '../src/safe.js'
import { matchDocs, searchTerms } from '../src/search.js'
import { asEventKey, asTeamNumber, asText, asYear } from '../src/validate.js'

// Built at run time so no line of this file looks like a credential to a scanner.
const fake = (prefix, n) => prefix + 'a1B2'.repeat(Math.ceil(n / 4)).slice(0, n)

test('scrub removes anything shaped like a key or a token', () => {
  const openai = fake('sk-', 40)
  const github = fake('ghp_', 36)
  const pat = fake('github_pat_', 30)
  const jwt = [fake('eyJ', 20), fake('', 24), fake('', 30)].join('.')
  const text = `key ${openai}, token ${github}, pat ${pat}, jwt ${jwt}, header Bearer ${fake('', 32)}`
  const out = scrub(text)
  for (const secret of [openai, github, pat, jwt]) assert.ok(!out.includes(secret), `still contains ${secret.slice(0, 6)}…`)
  assert.equal(out.match(/\[redacted\]/g).length, 5)
  assert.equal(scrub('The Blue Alliance returned 500.'), 'The Blue Alliance returned 500.')
  assert.equal(scrub(null), '')
})

test('an error thrown to the browser is scrubbed and carries a code the portal passes through', () => {
  const err = fail(`upstream said ${fake('sk-', 30)}`, 502)
  assert.equal(err.code, 'internal')
  assert.equal(err.message, 'upstream said [redacted]')
  assert.equal(fail('x').code, 'invalid-argument')
  assert.equal(fail('x', 404).code, 'not-found')
  assert.equal(fail('x', 429).code, 'resource-exhausted')
})

test('readBody takes an object under the size cap and refuses anything else', () => {
  assert.deepEqual(readBody(undefined, 100), {})
  assert.deepEqual(readBody({ action: 'events' }, 100), { action: 'events' })
  assert.throws(() => readBody('events', 100), /must be a JSON object/)
  assert.throws(() => readBody([1], 100), /must be a JSON object/)
  assert.throws(() => readBody({ game: 'x'.repeat(200) }, 100), /Request too large \(limit 100 bytes\)/)
})

test('validators are strict about what may become part of an upstream URL', () => {
  assert.equal(asYear(2026), 2026)
  assert.equal(asYear('2026'), 2026)
  for (const bad of [1991, 2101, 2026.5, 'abc', null, undefined, true, {}]) assert.equal(asYear(bad), null)

  assert.equal(asEventKey('2026casd'), '2026casd')
  assert.equal(asEventKey(' 2026CASD '), '2026casd')
  for (const bad of ['casd', '2026', '2026ca/sd', '2026casd/../x', '2026ca sd', '', null, 2026, {}]) {
    assert.equal(asEventKey(bad), null, `asEventKey(${JSON.stringify(bad)})`)
  }

  assert.equal(asTeamNumber(5805), 5805)
  assert.equal(asTeamNumber('5805'), 5805)
  for (const bad of [0, -1, 100000, 58.5, '', 'frc5805', null, true]) assert.equal(asTeamNumber(bad), null)

  assert.equal(asText('  hello ', 10), 'hello')
  assert.equal(asText('', 10), null)
  assert.equal(asText('x'.repeat(11), 10), null)
  assert.equal(asText(null, 10), null)
})

test('searchTerms drops the words a question is padded with', () => {
  assert.deepEqual(searchTerms('How do I set up the portal?'), ['set', 'portal'])
  assert.deepEqual(searchTerms('Swerve SWERVE swerve'), ['swerve'])
  assert.deepEqual(searchTerms('what is it?'), [])
})

test('matchDocs keeps docs where every term appears in the title, category or body', () => {
  const at = (ms) => ({ toMillis: () => ms })
  const docs = [
    { slug: 'setup-portal', title: 'Setting up the portal', category: 'ops', body_md: 'Sign in, then…', updated_at: at(1) },
    { slug: 'swerve', title: 'Swerve tuning', category: 'drivetrain', body_md: 'The portal has the logs.', updated_at: at(3) },
    { slug: 'pit', title: 'Pit checklist', category: 'ops', body_md: 'Batteries, bumpers.', updated_at: at(2) },
    { slug: 'broken', title: null, category: null, body_md: null, updated_at: null },
  ]
  const slugs = (q, cap) => matchDocs(docs, q, cap).map((d) => d.slug)

  // A title match outranks a body match.
  assert.deepEqual(slugs('portal'), ['setup-portal', 'swerve'])
  // Every term, not any term; the category counts.
  assert.deepEqual(slugs('portal ops'), ['setup-portal'])
  assert.deepEqual(slugs('where is the pit checklist'), ['pit'])
  assert.deepEqual(slugs('portal batteries'), [])
  // Case does not matter, and a question that is all filler matches nothing.
  assert.deepEqual(slugs('SWERVE Tuning'), ['swerve'])
  assert.deepEqual(slugs('what is it'), [])
  // The cap; among equal matches the most recently edited first.
  assert.deepEqual(slugs('ops', 1), ['pit'])
})
