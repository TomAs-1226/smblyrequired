// The snapshot encoding, with no emulator and no network: `npm test` in
// scripts/backup. The round trip through a real Firestore is in
// roundtrip.test.mjs; this pins the format itself, value by value.

import assert from 'node:assert/strict'
import { initializeApp } from 'firebase-admin/app'
import { getFirestore, Timestamp, GeoPoint, FieldValue } from 'firebase-admin/firestore'

import { encode, decode, encodeDocument, toRestValue, toRestFields } from '../encoding.mjs'

// Never used to make a request: it only gives references something to belong to.
const db = getFirestore(initializeApp({ projectId: 'demo-encoding-test' }))
const ROOT = 'projects/demo-encoding-test/databases/(default)/documents'

let failures = 0
function check(name, fn) {
  try {
    fn()
    console.log(`  ok    ${name}`)
  } catch (err) {
    failures += 1
    console.log(`  FAIL  ${name}`)
    console.error(err)
  }
}

// As the Admin SDK hands values over with useBigInt on: integers are BigInt,
// doubles are number.
const cases = [
  ['null', null, null],
  ['true', true, true],
  ['string', 'plain — · ←', 'plain — · ←'],
  ['integer', 5805n, 5805],
  ['negative integer', -7n, -7],
  ['largest safe integer', 9007199254740991n, 9007199254740991],
  ['integer past 2^53', 9007199254740993n, { $int: '9007199254740993' }],
  ['int64 minimum', -9223372036854775808n, { $int: '-9223372036854775808' }],
  ['double with a fraction', 0.1, 0.1],
  ['whole-number double', 2, { $double: '2' }],
  ['zero as a double', 0, { $double: '0' }],
  ['huge whole double', 1e300, { $double: '1e+300' }],
  ['NaN', NaN, { $double: 'NaN' }],
  ['Infinity', Infinity, { $double: 'Infinity' }],
  ['-Infinity', -Infinity, { $double: '-Infinity' }],
  ['negative zero', -0, { $double: '-0' }],
  ['timestamp, microseconds', new Timestamp(1767225600, 123456000), { $ts: '2026-01-01T00:00:00.123456000Z' }],
  ['timestamp, nanoseconds', new Timestamp(1767225600, 1), { $ts: '2026-01-01T00:00:00.000000001Z' }],
  ['timestamp before 1970', new Timestamp(-14182940, 500000000), { $ts: '1969-07-20T20:17:40.500000000Z' }],
  ['timestamp, year 1', new Timestamp(-62135596800, 0), { $ts: '0001-01-01T00:00:00.000000000Z' }],
  ['geopoint', new GeoPoint(47.6205, -122.3493), { $geo: [47.6205, -122.3493] }],
  ['geopoint on the equator', new GeoPoint(0, 180), { $geo: [0, 180] }],
  ['bytes', Buffer.from([0, 1, 2, 253, 254, 255]), { $bytes: 'AAEC/f7/' }],
  ['empty bytes', Buffer.alloc(0), { $bytes: '' }],
  ['reference', db.doc('profiles/abc'), { $ref: 'profiles/abc' }],
  ['deep reference', db.doc('picklists/a/entries/5805'), { $ref: 'picklists/a/entries/5805' }],
  ['array', [1n, 'two', null, [3n]], [1, 'two', null, [3]]],
  ['empty array', [], []],
  ['empty map', {}, {}],
  ['map, keys sorted', { b: 1n, a: { d: true, c: null } }, { a: { c: null, d: true }, b: 1 }],
  ['map with a $ key', { $ts: 'just a string' }, { $map: { $ts: 'just a string' } }],
  ['map with a $ key among others', { a: 1n, $b: 2n }, { $map: { $b: 2, a: 1 } }],
  ['nested map with a $ key', { outer: { $int: 'no' } }, { outer: { $map: { $int: 'no' } } }],
]

console.log('snapshot encoding\n')

for (const [name, value, expected] of cases) {
  check(`${name}: encodes as documented, and comes back the same`, () => {
    const encoded = encode(value)
    assert.deepEqual(encoded, expected)
    // Through text, as it is on disk. deepEqual tells -0 from 0 and treats NaN
    // as equal to itself, which is exactly the comparison wanted here.
    const back = decode(JSON.parse(JSON.stringify(encoded)), db)
    assert.deepEqual(back, toWrite(value))
  })
}

/**
 * What decode() should hand the SDK for a value the SDK read: the same value,
 * except that an integer small enough to be a JavaScript number is one (the SDK
 * writes a whole `number` as an integer, so nothing is lost).
 */
function toWrite(v) {
  if (typeof v === 'bigint') return v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v
  if (Array.isArray(v)) return v.map(toWrite)
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toWrite(x)]))
  }
  return v
}

check('a decoded value has the right JavaScript type', () => {
  const ts = decode({ $ts: '1969-07-20T20:17:40.500000000Z' }, db)
  assert.ok(ts instanceof Timestamp)
  assert.equal(ts.seconds, -14182940)
  assert.equal(ts.nanoseconds, 500000000)
  assert.ok(decode({ $geo: [1.5, -2.5] }, db).isEqual(new GeoPoint(1.5, -2.5)))
  assert.ok(Buffer.isBuffer(decode({ $bytes: 'AAEC' }, db)))
  assert.equal(decode({ $ref: 'profiles/abc' }, db).path, 'profiles/abc')
  assert.equal(decode({ $int: '9007199254740993' }, db), 9007199254740993n)
  assert.ok(Object.is(decode({ $double: '-0' }, db), -0))
  assert.ok(Number.isNaN(decode({ $double: 'NaN' }, db)))
  assert.deepEqual(decode({ $map: { $ts: 'text' } }, db), { $ts: 'text' })
})

check('whole-number doubles are counted, because the SDK cannot write them', () => {
  const notes = { wholeDoubles: 0 }
  decode({ a: { $double: '2' }, b: [{ $double: '0' }, { $double: 'NaN' }, { $double: '-0' }, { $double: '1e+300' }, 0.5] }, db, notes)
  // 2 and 0 would be sent as integers. NaN, -0 and 1e300 the SDK already sends as doubles.
  assert.equal(notes.wholeDoubles, 2)
})

check('a tag this version does not know is an error, not a map', () => {
  assert.throws(() => decode({ $decimal128: '1.5' }, db), /unknown tag \$decimal128/)
  assert.throws(() => decode({ $ts: 'yesterday' }, db), /not a \$ts value/)
})

check('one document is one line: path first, keys sorted, no whitespace', () => {
  assert.equal(
    encodeDocument('picklists/a/entries/254', { tier: 'first', position: 2, team_number: 254n, note: null }),
    '{"path":"picklists/a/entries/254","data":{"note":null,"position":{"$double":"2"},"team_number":254,"tier":"first"}}'
  )
})

check('the REST form says the type of every value', () => {
  assert.deepEqual(
    toRestFields(
      {
        n: null, t: true, s: 'x', i: 5, big: { $int: '9007199254740993' }, d: 0.5, whole: { $double: '2' }, nan: { $double: 'NaN' }, nz: { $double: '-0' },
        ts: { $ts: '2026-01-01T00:00:00.123456000Z' }, geo: { $geo: [1.5, 2] }, bytes: { $bytes: 'AAEC' }, ref: { $ref: 'profiles/abc' },
        list: [1, { $double: '1' }], map: { a: 1 }, odd: { $map: { $ts: 'x' } },
      },
      ROOT
    ),
    {
      n: { nullValue: null }, t: { booleanValue: true }, s: { stringValue: 'x' }, i: { integerValue: '5' }, big: { integerValue: '9007199254740993' },
      d: { doubleValue: 0.5 }, whole: { doubleValue: 2 }, nan: { doubleValue: 'NaN' }, nz: { doubleValue: '-0' },
      ts: { timestampValue: '2026-01-01T00:00:00.123456000Z' }, geo: { geoPointValue: { latitude: 1.5, longitude: 2 } }, bytes: { bytesValue: 'AAEC' },
      ref: { referenceValue: `${ROOT}/profiles/abc` },
      list: { arrayValue: { values: [{ integerValue: '1' }, { doubleValue: 1 }] } },
      map: { mapValue: { fields: { a: { integerValue: '1' } } } },
      odd: { mapValue: { fields: { $ts: { stringValue: 'x' } } } },
    }
  )
  assert.deepEqual(toRestValue({ $vector: [0.5, 1] }, ROOT), {
    mapValue: { fields: { __type__: { stringValue: '__vector__' }, value: { arrayValue: { values: [{ doubleValue: 0.5 }, { doubleValue: 1 }] } } } },
  })
})

check('a vector encodes as its numbers', () => {
  assert.deepEqual(encode(FieldValue.vector([0.5, 1, -2.25])), { $vector: [0.5, 1, -2.25] })
})

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
