import { useEffect, useState } from 'react'
import { subscribe, getState, drain, discard } from '../lib/offlineQueue'

/**
 * Live view of the offline write queue.
 *
 * Returns { online, syncing, pending, failing, oldest, problems, sync, discard }.
 *
 * The pending count is the number that matters to a scout: it is the answer to
 * "if I close this now, do I lose anything?" — so it should be visible on every
 * scouting screen, not buried in a settings page.
 */
export function useOfflineQueue() {
  const [state, setState] = useState({
    online: true,
    syncing: false,
    pending: 0,
    failing: 0,
    oldest: null,
    problems: [],
  })

  useEffect(() => {
    let alive = true
    // IndexedDB can be unavailable (some private modes) or fail to open. The
    // badge then keeps its optimistic defaults instead of throwing into React.
    getState()
      .then((s) => alive && setState(s))
      .catch((err) => console.warn('[queue] could not read the offline queue:', err?.message ?? err))
    const off = subscribe((s) => alive && setState(s))
    return () => {
      alive = false
      off()
    }
  }, [])

  // A tap on the badge is a person asking for a retry now, so it overrides the
  // backoff and retries refused rows too (see drain's `force`).
  return { ...state, sync: () => drain({ force: true }), discard }
}
