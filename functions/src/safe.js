import { HttpsError } from 'firebase-functions/https'
import * as logger from 'firebase-functions/logger'

// Secret scrubbing.
//
// Upstream APIs do this to us: OpenAI's 401 body quotes back a partly masked
// copy of the key it was sent, and an error can echo a token in a URL. Passing an
// upstream error to the browser, or into a log, is therefore a leak path even
// though no line here prints a key on purpose. Everything that could have come
// from upstream goes through `scrub` first, and upstream error bodies are never
// relayed at all.
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g, // OpenAI, current and legacy prefixes
  /gh[pousr]_[A-Za-z0-9]{8,}/g, // GitHub personal access, OAuth and refresh tokens
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, // any JWT, a Firebase ID token included
  /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{12,}=*/g,
]

export function scrub(text) {
  let out = typeof text === 'string' ? text : String(text ?? '')
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]')
  return out
}

const line = (parts) => parts.map((p) => scrub(typeof p === 'string' ? p : JSON.stringify(p))).join(' ')

// Every log line goes through these. Function logs are readable by anyone with
// console access to the project, which is more people than may hold the keys.
export const logSafe = (...parts) => logger.info(line(parts))
export const warnSafe = (...parts) => logger.warn(line(parts))

// The old backend answered with HTTP statuses; a callable answers with a code.
// The codes are chosen so the sentence reaches the reader: the portal replaces
// the message of `unavailable` with "check your connection", which is the wrong
// thing to say when an upstream API refused us, so a 502 is `internal` here.
const CODE_FOR_STATUS = {
  400: 'invalid-argument',
  401: 'unauthenticated',
  403: 'permission-denied',
  404: 'not-found',
  413: 'invalid-argument',
  429: 'resource-exhausted',
  500: 'internal',
  502: 'internal',
}

/** An error to throw from a callable. The message is what the student reads. */
export function fail(message, status = 400) {
  return new HttpsError(CODE_FOR_STATUS[status] ?? 'internal', scrub(message))
}

/**
 * The request payload, as an object, with a size cap.
 *
 * These endpoints take a handful of scalars. A cap this low removes "paste a
 * novel into the prompt" as a way to run up somebody else's bill.
 */
export function readBody(data, maxBytes) {
  if (data == null) return {}
  if (typeof data !== 'object' || Array.isArray(data)) throw fail('Request body must be a JSON object.')
  if (Buffer.byteLength(JSON.stringify(data), 'utf8') > maxBytes) {
    throw fail(`Request too large (limit ${maxBytes} bytes).`, 413)
  }
  return data
}

/** A fetch failure as text, without the stack and without anything secret. */
export const reason = (err) => scrub(err instanceof Error ? err.message : err)
