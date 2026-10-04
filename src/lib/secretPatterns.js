// The secret patterns the knowledge base refuses to store.
//
// firebase/firestore.rules holds the enforcing copy (`looksSecret`): the server
// refuses a doc body that matches. Rules can only say "denied", so the portal
// checks the same patterns first and names what it found. The two lists must
// match; firebase/test/rules.test.mjs runs the same payloads through both.
//
// This is a backstop for the obvious accident, not a guarantee: it catches only
// the patterns it knows. Read what you are about to publish.

const PATTERNS = [
  {
    what: 'a private or tailnet IP address',
    re: /(^|[^0-9.])(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})/,
  },
  { what: 'a private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { what: 'a GitHub token', re: /(^|[^A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{20,}/ },
  { what: 'an API secret key', re: /(^|[^A-Za-z0-9_])(sk-[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{20,})/ },
  { what: 'an AWS access key id', re: /(^|[^A-Za-z0-9_])AKIA[0-9A-Z]{16}([^A-Za-z0-9_]|$)/ },
  { what: 'a service-role key', re: /(^|[^a-z0-9_])(service_role|supabase_service_role_key)\s*[:=]/i },
]

/** What the text looks like it contains, or null. First match wins, in the order above. */
export function findSecret(text) {
  const body = String(text ?? '')
  for (const p of PATTERNS) if (p.re.test(body)) return p.what
  return null
}

/** The sentence shown when a doc is refused. */
export function secretRefusal(what) {
  return (
    `Refusing to store this document: it looks like it contains ${what}. ` +
    'Remove the secret, or put it in a password manager and reference it by name. ' +
    'This guard catches common patterns only — it is not a substitute for reading what you are about to publish.'
  )
}
