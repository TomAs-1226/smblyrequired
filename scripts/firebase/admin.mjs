// The Admin SDK, for scripts a trusted person runs from their own machine.
//
// It BYPASSES the security rules — that is the point (a script has no role), and
// the reason these scripts are never run in a browser or from CI.
//
//   GOOGLE_APPLICATION_CREDENTIALS   path to a service-account key file (never in
//                                    the repo, never in a VITE_ variable)
//   FIREBASE_PROJECT_ID              the project
//   FIREBASE_STORAGE_BUCKET          its Storage bucket (Project settings → General)
//
// With the emulators running (`npm run emulators`), set FIRESTORE_EMULATOR_HOST
// and FIREBASE_STORAGE_EMULATOR_HOST instead of a key file to try a script out.
import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'

const emulated = Boolean(process.env.FIRESTORE_EMULATOR_HOST)
const projectId = process.env.FIREBASE_PROJECT_ID || (emulated ? 'demo-frc5805' : '')
const storageBucket = process.env.FIREBASE_STORAGE_BUCKET || (emulated ? 'demo-frc5805.appspot.com' : '')

if (!projectId || !storageBucket || (!emulated && !process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
  console.error(
    'set FIREBASE_PROJECT_ID, FIREBASE_STORAGE_BUCKET and GOOGLE_APPLICATION_CREDENTIALS\n' +
      '(or FIRESTORE_EMULATOR_HOST and FIREBASE_STORAGE_EMULATOR_HOST to use the emulators)'
  )
  process.exit(1)
}

initializeApp({ projectId, storageBucket, ...(emulated ? {} : { credential: applicationDefault() }) })

export const db = getFirestore()
export const bucket = getStorage().bucket()
export { FieldValue, Timestamp }

/** Upload bytes to `{folder}/{path}`, owned by "script" so only a lead can replace it from the portal. */
export async function putObject(folder, path, bytes, contentType) {
  await bucket.file(`${folder}/${path}`).save(bytes, {
    resumable: false,
    metadata: { contentType, cacheControl: 'private, max-age=3600', metadata: { owner: 'script' } },
  })
}
