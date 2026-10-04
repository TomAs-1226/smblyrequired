import { FieldValue } from 'firebase-admin/firestore'
import './admin.js'

/**
 * Keeps the previous title and body of a knowledge doc whenever either changes.
 *
 * The rules let any member edit any doc, which is what makes the knowledge base
 * get written at all; this is what makes that safe. The version holds what the
 * doc said BEFORE the edit, attributed to whoever made the edit, and the rules
 * give no client a way to change or remove it.
 *
 * The version's id is the event's id. A trigger may be delivered more than once
 * for one edit, and the second delivery must find the version already there
 * rather than add a duplicate.
 */
export async function snapshotKnowledgeDoc(event) {
  const before = event.data?.before?.data()
  const after = event.data?.after?.data()
  if (!before || !after) return
  // Pinning a doc or moving it to another category is not a new version.
  if (before.title === after.title && before.body_md === after.body_md) return

  const version = event.data.after.ref.collection('versions').doc(event.id)
  try {
    await version.create({
      title: before.title ?? '',
      body_md: before.body_md ?? '',
      edited_by: after.updated_by ?? null,
      created_at: FieldValue.serverTimestamp(),
    })
  } catch (err) {
    // ALREADY_EXISTS: this delivery is a repeat.
    if (err?.code !== 6) throw err
  }
}
