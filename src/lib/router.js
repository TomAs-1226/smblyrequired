// Minimal hash router — works on any static host (and file://) with no server
// rewrites. Routes use `#/path`; bare `#anchor` links are treated as Home so
// in-page section scrolling still works.
export function currentPath() {
  const h = decodeURIComponent(window.location.hash || '')
  if (!h || h === '#') return '/'
  const p = h.slice(1)
  return p.startsWith('/') ? p : '/'
}

export function navigate(path) {
  const target = '#' + path
  if (window.location.hash === target) {
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  } else {
    window.location.hash = target
  }
}

export function isHome() {
  return currentPath() === '/'
}
