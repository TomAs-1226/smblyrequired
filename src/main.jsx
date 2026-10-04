import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { isHome } from './lib/router'

// The landing page always opens at the top, on the title card. Its opening is a
// scroll-driven story, and the browser restoring a mid-page position on refresh
// replayed the whole teardown to get back there. Every other page keeps normal
// restoration.
//
// Set it through ScrollTrigger, not on `history` directly: ScrollTrigger copies
// `history.scrollRestoration` when it registers — during the imports above, before
// this runs — and writes its copy back on every refresh, so a plain assignment
// was silently reset to 'auto' a moment later. `clearScrollMemory` updates its copy.
function syncScrollRestoration() {
  if ('scrollRestoration' in window.history) {
    ScrollTrigger.clearScrollMemory(isHome() ? 'manual' : 'auto')
  }
}
// Arriving from a sign-in or password-reset email: Firebase sends people back to
// the site's root with its parameters in the query string. Open the portal, which
// is what reads them (src/lib/auth.jsx).
if (!window.location.hash && /[?&](portal=signin|mode=signIn)/.test(window.location.search)) {
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/portal`)
}

syncScrollRestoration()
if (isHome()) window.scrollTo(0, 0)
window.addEventListener('hashchange', syncScrollRestoration)
// Belt and braces for the refresh itself: leave the landing page at the top, so
// whatever the browser records for this entry is the title card.
window.addEventListener('pagehide', () => {
  if (isHome()) window.scrollTo(0, 0)
})

// Note: intentionally not using <StrictMode>. Its double-invoke in development
// would mount Lenis and GSAP timelines twice, causing janky duplicate motion.
createRoot(document.getElementById('root')).render(<App />)
