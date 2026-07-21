import { useEffect, useState } from 'react'
import { subscribe, getState, drain } from '../lib/offlineQueue'

/**
 * Live view of the offline write queue.
 *
 * Returns { online, syncing, pending, failing, oldest, sync }.
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
  })

  useEffect(() => {
    let alive = true
    getState().then((s) => alive && setState(s))
    const off = subscribe((s) => alive && setState(s))
    return () => {
      alive = false
      off()
    }
  }, [])

  return { ...state, sync: drain }
}
