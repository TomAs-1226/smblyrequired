// A small in-memory memo with a time limit, for upstream answers that have no
// place in Firestore (a live match schedule, a queuing status).
//
// It lives in one instance's memory, and a function runs as many instances, so a
// miss is always correct and a hit is a bonus. Never use it where a stale answer
// is unsafe; the time limits at the call sites are chosen with that in mind.
const memo = new Map()

export function memoGet(key, ttlSeconds) {
  const entry = memo.get(key)
  if (!entry) return null
  if (Date.now() - entry.at > ttlSeconds * 1000) {
    memo.delete(key)
    return null
  }
  return entry.value
}

export function memoSet(key, value) {
  if (memo.size > 500) memo.clear() // crude, but this is a cache, not a store
  memo.set(key, { at: Date.now(), value })
}
