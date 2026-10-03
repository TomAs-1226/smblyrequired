#!/usr/bin/env node
/**
 * The Content-Type each upload is sent with.
 *
 *   npm run test:portal   (or: node scripts/test/upload-types.mjs)
 *
 * Buckets enforce allowed_mime_types (migration 0002) against what the browser
 * reports, and Windows reports .zip as application/x-zip-compressed while .md,
 * .7z and CAD files arrive with no type at all. These cases are the uploads
 * that were being refused.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { uploadType, BUCKET_TYPES } from '../../src/lib/uploadTypes.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

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

const t = (bucket, name, reported) => uploadType(bucket, name, reported)

check('Windows .zip goes into code', t('code', 'robot.zip', 'application/x-zip-compressed').type === 'application/zip')
check('Windows .zip goes into graphs', t('graphs', 'out.zip', 'application/x-zip-compressed').ok)
check('untyped .md goes into knowledge as markdown', t('knowledge', 'notes.md', '').type === 'text/markdown')
check('untyped .md goes into media as markdown', t('media', 'minutes.md', '').ok)
check('.step / .stl / .7z go into code as octet-stream',
  ['arm.step', 'bumper.stl', 'src.7z', 'drive.f3d'].every((n) => t('code', n, '').type === 'application/octet-stream'))
check('model/stl reported by the OS still lands in code', t('code', 'part.stl', 'model/stl').ok)
check('graphify JSON keeps its type', t('graphs', 'graph.json', 'application/json').type === 'application/json')
check('photos pass through unchanged', t('media', 'pit.jpg', 'image/jpeg').type === 'image/jpeg')
check('image/jpg alias is normalised', t('media', 'pit.jpg', 'image/jpg').type === 'image/jpeg')
check('.tgz reported as x-compressed goes into code', t('code', 'snap.tgz', 'application/x-compressed').type === 'application/gzip')
check('a .docx is refused up front for knowledge',
  !t('knowledge', 'plan.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document').ok)
check('a video is refused up front for knowledge', !t('knowledge', 'clip.mp4', 'video/mp4').ok)

// BUCKET_TYPES must stay a mirror of the migration, or the pre-check above
// refuses (or admits) the wrong things.
const sql = readFileSync(path.join(ROOT, 'supabase/migrations/0002_storage.sql'), 'utf8')
for (const [bucket, types] of Object.entries(BUCKET_TYPES)) {
  const row = new RegExp(`\\('${bucket}', '${bucket}',[^;]*?array\\[([^\\]]*)\\]`, 's').exec(sql)
  const fromSql = row ? [...row[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort() : null
  check(`BUCKET_TYPES.${bucket} matches 0002_storage.sql`,
    JSON.stringify(fromSql) === JSON.stringify([...types].sort()),
    `sql=${JSON.stringify(fromSql)}`)
}

console.log(`\n${passed} upload-type case(s) passed`)
if (process.exitCode) console.error('UPLOAD TYPE TESTS FAILED')
