#!/usr/bin/env node
/**
 * Applies the migrations to a throwaway local database and runs the RLS suite.
 *
 *   npm run test:db
 *
 * This is the check that the schema and — more importantly — the access rules
 * still do what they claim. Run it after touching anything in
 * supabase/migrations/. It needs a local PostgreSQL 15+; it never touches a
 * Supabase project.
 *
 * Override the connection with PGHOST / PGPORT / PGUSER / PGPASSWORD.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DB = process.env.TEST_DB ?? 'frc5805_test'

// Windows installs psql outside PATH more often than not.
function findPsql() {
  if (spawnSync('psql', ['--version'], { shell: false }).status === 0) return 'psql'
  const base = 'C:/Program Files/PostgreSQL'
  if (existsSync(base)) {
    const versions = readdirSync(base).sort((a, b) => Number(b) - Number(a))
    for (const v of versions) {
      const candidate = path.join(base, v, 'bin', 'psql.exe')
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

const psql = findPsql()
if (!psql) {
  console.error(
    'psql not found. Install PostgreSQL 15+ (winget install PostgreSQL.PostgreSQL.17),\n' +
      'or put psql on PATH.'
  )
  process.exit(1)
}

const env = { ...process.env }
env.PGHOST ??= 'localhost'
env.PGUSER ??= 'postgres'
env.PGPASSWORD ??= 'postgres'

function run(args, { db, file, label }) {
  const target = db ? `postgresql://${env.PGUSER}@${env.PGHOST}/${db}` : undefined
  const argv = [
    ...(target ? [target] : ['-U', env.PGUSER, '-h', env.PGHOST]),
    '-v', 'ON_ERROR_STOP=1',
    ...(file ? ['-f', file] : []),
    ...args,
  ]
  const res = spawnSync(psql, argv, { env, encoding: 'utf8' })
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
  if (res.status !== 0) {
    console.error(`\nFAILED: ${label}\n`)
    console.error(out.split('\n').filter((l) => /ERROR|FATAL|DETAIL|HINT/.test(l)).slice(0, 12).join('\n') || out)
    process.exit(1)
  }
  return out
}

console.log(`using ${psql}`)
console.log(`recreating database ${DB}\n`)
run([`-c`, `drop database if exists ${DB};`, '-c', `create database ${DB};`], {
  label: 'create database',
})

const files = [
  'supabase/local-test/00_stub.sql',
  'supabase/migrations/0001_identity.sql',
  'supabase/migrations/0002_storage.sql',
  'supabase/migrations/0003_content.sql',
  'supabase/migrations/0004_audit_backup.sql',
  'supabase/migrations/0005_scouting.sql',
]

for (const f of files) {
  run(['-q'], { db: DB, file: path.join(ROOT, f), label: f })
  console.log(`  applied  ${f}`)
}

// 02 depends on the users seeded by 01, so the order here is load-bearing.
const suites = ['01_rls_tests.sql', '02_scouting_tests.sql']
console.log('\nrunning suites\n')
let out = ''
for (const s of suites) {
  out += run(['-q'], { db: DB, file: path.join(ROOT, 'supabase/local-test', s), label: s })
}

// psql routes RAISE NOTICE to stderr; surface only the assertions.
//
// The match is anchored on the NOTICE prefix specifically. A looser /PASS|FAIL/
// also caught the suite's own closing `\echo 'ALL RLS TESTS PASSED'` line and
// inflated the count by one — a test runner that overstates how much it tested
// is worse than no count at all.
const lines = out.split('\n').filter((l) => /NOTICE:\s*(PASS|FAIL)\b/.test(l))
for (const l of lines) console.log('  ' + l.replace(/^.*NOTICE:\s*/, '').trim())

const passed = lines.filter((l) => /NOTICE:\s*PASS\b/.test(l)).length
console.log(`\n  ${passed} assertion(s) passed`)
if (passed === 0) {
  console.error('  no assertions ran — the suite did not execute')
  process.exit(1)
}
