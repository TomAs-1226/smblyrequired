import { useEffect, useState } from 'react'
import { currentPath } from '../lib/router'

// Subscribe to hash-route changes.
export function useRoute() {
  const [path, setPath] = useState(currentPath())
  useEffect(() => {
    const on = () => {
      const h = decodeURIComponent(window.location.hash || '')
      const p = h.slice(1)
      // Only "#/route" (or an empty hash) is a route change. A bare "#anchor"
      // is an in-page scroll link and must NOT bounce us back to Home.
      if (h === '' || h === '#' || p.startsWith('/')) setPath(currentPath())
    }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return path
}
