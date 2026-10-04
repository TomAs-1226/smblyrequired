/**
 * How a Firestore document becomes one line of JSON, and back.
 *
 * JSON has six types and Firestore has twelve, so a plain JSON.stringify of a
 * document is a lossy copy: a Timestamp turns into a string nobody can tell from
 * a string, an integer and a double become the same number, bytes become
 * whatever the serialiser felt like. A restore from that is a different
 * database that merely resembles the old one, and the rules (which check
 * `is timestamp`, `is int`) would refuse half of it.
 *
 * The encoding, version 1. Everything JSON can hold exactly is left alone:
 *
 *   null, true/false, strings          as they are
 *   integer                            a JSON number without a fraction
 *   double with a fraction             a JSON number with one
 *   array                              a JSON array
 *   map                                a JSON object, keys sorted
 *
 * Everything else is an object with exactly one key, which starts with `$`:
 *
 *   {"$ts":"2026-10-04T03:15:42.123456000Z"}   Timestamp, UTC, always 9 digits
 *   {"$geo":[47.6,-122.3]}                     GeoPoint, [latitude, longitude]
 *   {"$bytes":"aGVsbG8="}                      bytes, standard base64
 *   {"$ref":"profiles/abc"}                    reference, path from the database root
 *   {"$int":"9223372036854775807"}             integer too large for a JSON number
 *   {"$double":"2"}                            double with no fraction (2.0), or
 *                                              "NaN" / "Infinity" / "-Infinity" / "-0"
 *   {"$vector":[0.1,0.2]}                      vector
 *   {"$map":{"$ts":"just a string"}}           a map with a key that starts with `$`,
 *                                              so it cannot be mistaken for a tag
 *
 * A reference is stored relative to the database root, not as the full
 * `projects/…/databases/…` name, so a snapshot restored into a different
 * project points at that project's documents.
 *
 * Reading requires the client to be opened with `useBigInt: true`, which
 * `connect({ exact: true })` in lib.mjs does. That is what makes integers arrive
 * as BigInt and doubles as number; without it both are `number` and 2 and 2.0
 * cannot be told apart.
 *
 * Keys are sorted and the output has no whitespace, so the same document always
 * encodes to the same bytes. The restore test relies on that: it re-reads what
 * it restored and compares lines.
 */

import { Timestamp, GeoPoint, DocumentReference, FieldValue } from 'firebase-admin/firestore'

export const ENCODING_VERSION = 1

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const TAGS = new Set(['$ts', '$geo', '$bytes', '$ref', '$int', '$double', '$vector', '$map'])

/** A double as JSON: itself when JSON can hold it, otherwise its name. */
const looseDouble = (n) => (Number.isFinite(n) && !Object.is(n, -0) ? n : Object.is(n, -0) ? '-0' : String(n))

const isVector = (v) => v?.constructor?.name === 'VectorValue' && typeof v.toArray === 'function'

function timestampToString(ts) {
  // toISOString() gives milliseconds; the seconds part is cut from it and the
  // fraction is written from the nanoseconds, so nothing is rounded.
  const whole = new Date(ts.seconds * 1000).toISOString().slice(0, 19)
  return `${whole}.${String(ts.nanoseconds).padStart(9, '0')}Z`
}

function timestampFromString(text) {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)\.(\d{9})Z$/.exec(text)
  if (!m) throw new Error(`not a $ts value: ${JSON.stringify(text)}`)
  const ms = Date.parse(m[1] + 'Z')
  if (Number.isNaN(ms)) throw new Error(`not a $ts value: ${JSON.stringify(text)}`)
  return new Timestamp(ms / 1000, Number(m[2]))
}

/** A value as the Admin SDK returned it -> a JSON-safe value. */
export function encode(v) {
  if (v === null) return null
  switch (typeof v) {
    case 'boolean':
    case 'string':
      return v
    case 'bigint':
      return v >= -MAX_SAFE && v <= MAX_SAFE ? Number(v) : { $int: v.toString() }
    case 'number':
      // A double: integers arrive as BigInt. One with a fraction is written
      // bare; a whole one is tagged, or it would come back as an integer.
      return Number.isFinite(v) && !Number.isInteger(v) ? v : { $double: Object.is(v, -0) ? '-0' : String(v) }
    case 'object':
      break
    default:
      throw new Error(`cannot encode a ${typeof v}`)
  }
  if (v instanceof Timestamp) return { $ts: timestampToString(v) }
  if (v instanceof GeoPoint) return { $geo: [looseDouble(v.latitude), looseDouble(v.longitude)] }
  if (v instanceof DocumentReference) return { $ref: v.path }
  if (v instanceof Uint8Array) return { $bytes: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') }
  if (isVector(v)) return { $vector: v.toArray().map(looseDouble) }
  if (Array.isArray(v)) return v.map(encode)

  const out = {}
  let clash = false
  for (const key of Object.keys(v).sort()) {
    if (key.startsWith('$')) clash = true
    out[key] = encode(v[key])
  }
  return clash ? { $map: out } : out
}

/** The one line a document becomes. */
export function encodeDocument(path, data) {
  return JSON.stringify({ path, data: encode(data) })
}

/**
 * A decoded JSON value -> what the Admin SDK should be handed to write it.
 *
 * `notes.wholeDoubles` counts doubles with no fraction (2.0). The SDK cannot
 * write those: it sends any whole number as an integer. restore.mjs writes the
 * documents that contain one through the REST API instead (see toRestFields).
 */
export function decode(j, db, notes = { wholeDoubles: 0 }) {
  if (j === null || typeof j === 'boolean' || typeof j === 'string') return j
  if (typeof j === 'number') return j
  if (Array.isArray(j)) return j.map((x) => decode(x, db, notes))
  if (typeof j !== 'object') throw new Error(`cannot decode a ${typeof j}`)

  const keys = Object.keys(j)
  if (keys.length === 1 && keys[0].startsWith('$')) {
    const tag = keys[0]
    const body = j[tag]
    switch (tag) {
      case '$ts':
        return timestampFromString(body)
      case '$geo':
        return new GeoPoint(Number(body[0]), Number(body[1]))
      case '$bytes':
        return Buffer.from(body, 'base64')
      case '$ref':
        return db.doc(body)
      case '$int':
        return BigInt(body)
      case '$double': {
        const n = Number(body)
        if (Number.isSafeInteger(n) && !Object.is(n, -0)) notes.wholeDoubles += 1
        return n
      }
      case '$vector':
        return FieldValue.vector(body.map(Number))
      case '$map':
        return decodeMap(body, db, notes)
      default:
        throw new Error(`unknown tag ${tag}: this snapshot was written by a newer encoding`)
    }
  }
  return decodeMap(j, db, notes)
}

function decodeMap(obj, db, notes) {
  const out = {}
  for (const key of Object.keys(obj)) out[key] = decode(obj[key], db, notes)
  return out
}

/**
 * The same decoded JSON, as the Firestore REST API's typed values. Used only for
 * documents holding a whole-number double, which the SDK would write as an
 * integer. `root` is `projects/<id>/databases/(default)/documents`.
 */
export function toRestValue(j, root) {
  if (j === null) return { nullValue: null }
  if (typeof j === 'boolean') return { booleanValue: j }
  if (typeof j === 'string') return { stringValue: j }
  if (typeof j === 'number') return Number.isInteger(j) ? { integerValue: String(j) } : { doubleValue: j }
  if (Array.isArray(j)) return { arrayValue: { values: j.map((x) => toRestValue(x, root)) } }

  const keys = Object.keys(j)
  if (keys.length === 1 && TAGS.has(keys[0])) {
    const tag = keys[0]
    const body = j[tag]
    switch (tag) {
      case '$ts':
        return { timestampValue: body }
      case '$geo':
        return { geoPointValue: { latitude: restDouble(Number(body[0])), longitude: restDouble(Number(body[1])) } }
      case '$bytes':
        return { bytesValue: body }
      case '$ref':
        return { referenceValue: `${root}/${body}` }
      case '$int':
        return { integerValue: body }
      case '$double':
        return { doubleValue: restDouble(Number(body)) }
      case '$vector':
        return {
          mapValue: {
            fields: {
              __type__: { stringValue: '__vector__' },
              value: { arrayValue: { values: body.map((x) => ({ doubleValue: restDouble(Number(x)) })) } },
            },
          },
        }
      case '$map':
        return { mapValue: { fields: toRestFields(body, root) } }
    }
  }
  return { mapValue: { fields: toRestFields(j, root) } }
}

// proto3 JSON takes a double as a number or as a string; the string form is the
// only way to say NaN, the infinities and negative zero.
const restDouble = (n) => (Number.isFinite(n) && !Object.is(n, -0) ? n : Object.is(n, -0) ? '-0' : String(n))

export function toRestFields(obj, root) {
  const fields = {}
  for (const key of Object.keys(obj)) fields[key] = toRestValue(obj[key], root)
  return fields
}
