#!/usr/bin/env node
/**
 * The portal's Node-runnable suites, in one command:
 *
 *   npm run test:portal
 *
 * offline-queue  what the queue keeps, retries or drops for each server answer
 * upload-types   the Content-Type each bucket upload is sent with
 * csv-export     RFC 4180 quoting and formula-injection neutralising
 *
 * No network and no browser: each suite imports a pure module from src/lib.
 * The database rules are tested separately by `npm run test:db`.
 */

for (const suite of ['./offline-queue.mjs', './upload-types.mjs', './csv-export.mjs']) {
  console.log(`\n=== ${suite.slice(2, -4)} ===`)
  await import(suite)
}

if (process.exitCode) {
  console.error('\nPORTAL TESTS FAILED')
} else {
  console.log('\nALL PORTAL TESTS PASSED')
}
