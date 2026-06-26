import { useEffect, useState } from 'react'
import { currentPath } from '../lib/router'

// Subscribe to hash-route changes.
export function useRoute() {
  const [path, setPath] = useState(currentPath())
  useEffect(() => {
    const on = () => setPath(currentPath())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return path
}
