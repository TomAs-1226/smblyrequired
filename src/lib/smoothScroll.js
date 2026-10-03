// Tiny module-level bridge so any component can drive the single Lenis instance
// created in App.jsx (nav anchor clicks, "back to top").
let lenis = null

export function setLenis(instance) {
  lenis = instance
}

export function getLenis() {
  return lenis
}

export function scrollTo(target, options = {}) {
  if (!lenis) {
    // Fallback when Lenis isn't ready (reduced motion / not yet mounted).
    if (typeof target === 'number') {
      window.scrollTo({ top: target, behavior: 'smooth' })
      return
    }
    const el = typeof target === 'string' ? document.querySelector(target) : target
    if (el) el.scrollIntoView({ behavior: 'smooth' })
    return
  }
  lenis.scrollTo(target, { duration: 1.3, offset: 0, ...options })
}
