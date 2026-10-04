import { initializeApp } from 'firebase/app'
import { getAuth, connectAuthEmulator } from 'firebase/auth'
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore'
import { getStorage, connectStorageEmulator } from 'firebase/storage'
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions'

// -----------------------------------------------------------------------------
// Firebase client.
//
// Two things worth knowing before touching this file:
//
// 1. The web config belongs in the browser. apiKey and the rest identify the
//    project; they are not secrets. What a signed-in user can read or write is
//    decided by firebase/firestore.rules and firebase/storage.rules, not by
//    hiding these values. The opposite of that is a service-account key: it
//    bypasses the rules entirely and must never appear in this bundle, in a
//    VITE_-prefixed variable, or in this repo. It belongs only on the backup
//    host and in Cloud Functions' own runtime.
//
// 2. The public site has to keep working whether or not a backend exists. Anyone
//    can clone this repo and `npm run dev` without credentials; the portal then
//    reports itself unconfigured instead of taking the marketing pages down with
//    it. Never let this module throw at import time.
// -----------------------------------------------------------------------------

const env = import.meta.env
const config = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  appId: env.VITE_FIREBASE_APP_ID,
}

// `npm run dev:emulators` points the app at the local emulators: a throwaway
// project that needs no credentials and never touches the real one.
export const usingEmulators = env.VITE_FIREBASE_EMULATORS === '1'
const emulatorConfig = {
  apiKey: 'demo-key',
  authDomain: 'demo-frc5805.firebaseapp.com',
  projectId: 'demo-frc5805',
  storageBucket: 'demo-frc5805.appspot.com',
  appId: 'demo-app',
}

export const isConfigured = usingEmulators || Boolean(config.apiKey && config.projectId && config.appId)

/** Where Cloud Functions are deployed. Must match REGION in functions/index.js. */
export const FUNCTIONS_REGION = env.VITE_FIREBASE_FUNCTIONS_REGION || 'us-west1'

export const app = isConfigured ? initializeApp(usingEmulators ? emulatorConfig : config) : null
export const auth = app ? getAuth(app) : null
export const db = app ? getFirestore(app) : null
export const storage = app ? getStorage(app) : null
export const functions = app ? getFunctions(app, FUNCTIONS_REGION) : null

if (app && usingEmulators) {
  const host = env.VITE_FIREBASE_EMULATOR_HOST || '127.0.0.1'
  connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true })
  connectFirestoreEmulator(db, host, 8080)
  connectStorageEmulator(storage, host, 9199)
  connectFunctionsEmulator(functions, host, 5001)
}

if (!isConfigured && env.DEV) {
  console.info(
    '[portal] VITE_FIREBASE_* are unset — the portal will render its unconfigured state. ' +
      'See docs/PORTAL.md to set them up, or run `npm run dev:emulators`.'
  )
}
