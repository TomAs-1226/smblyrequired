import { FieldValue } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import { db } from './admin.js'
import { logSafe, reason } from './safe.js'

// What SQL did with foreign keys when a `files` row went away: the stored object
// was the client's job (and was sometimes left behind), a robot photo pointing at
// the file was deleted with it, and a graph or code archive lost its reference
// and stayed. Firestore has no foreign keys, so this trigger does all of it.

const BUCKETS = ['graphs', 'code', 'knowledge', 'media', 'public-media']

async function removeObject(file) {
  // The folder is checked, not trusted: this runs with the Admin SDK, and a
  // document that named some other path must not be able to delete it.
  if (!BUCKETS.includes(file.bucket) || typeof file.path !== 'string' || !file.path || file.path.includes('..')) {
    logSafe('[onFileDeleted] not a stored object, nothing to remove')
    return
  }
  // Already gone is the outcome we wanted: the portal removes the object itself
  // when an upload fails half way.
  await getStorage().bucket().file(`${file.bucket}/${file.path}`).delete({ ignoreNotFound: true })
}

// Every document in `collection` whose `field` is a file reference to this id.
const referencing = (collection, field, fileId) => db.collection(collection).where(`${field}.id`, '==', fileId).get()

/**
 * The cascade for a deleted files/{id} document. Every step is safe to repeat,
 * so a retried delivery finishes whatever an earlier one did not.
 */
export async function cascadeFileDelete(event) {
  const fileId = event.params.id
  const file = event.data?.data() ?? {}

  // The object first, and its failure does not stop the rest: a dangling
  // reference in a graph is a broken page for a member, while an orphaned object
  // is only wasted space that the next backup run will list.
  try {
    await removeObject(file)
  } catch (err) {
    logSafe('[onFileDeleted] could not remove the stored object:', reason(err))
  }

  const [photos, graphs, htmlGraphs, archives] = await Promise.all([
    referencing('robot_photos', 'file', fileId),
    referencing('graphs', 'file', fileId),
    referencing('graphs', 'html_file', fileId),
    referencing('code_archives', 'file', fileId),
  ])

  const touched = { updated_at: FieldValue.serverTimestamp() }
  const writes = [
    // A photo is nothing without its image, so it goes. Its own trigger then
    // lowers the team's photo count.
    ...photos.docs.map((d) => (batch) => batch.delete(d.ref)),
    // A graph or an archive is still a record worth keeping; it just no longer
    // has that file.
    ...graphs.docs.map((d) => (batch) => batch.update(d.ref, { file: null, ...touched })),
    ...htmlGraphs.docs.map((d) => (batch) => batch.update(d.ref, { html_file: null, ...touched })),
    ...archives.docs.map((d) => (batch) => batch.update(d.ref, { file: null, ...touched })),
  ]
  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch()
    for (const write of writes.slice(i, i + 400)) write(batch)
    await batch.commit()
  }
}
