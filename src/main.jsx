import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import { isHome } from './lib/router'

// The landing page always opens at the top, on the title card. Its opening is a
// scroll-driven story, and the browser restoring a mid-page position on refresh
// replayed the whole teardown to get back there. Every other page keeps normal
// restoration. Set before the first render, so the restore never happens.
function syncScrollRestoration() {
  if ('scrollRestoration' in window.history) {
    window.history.scrollRestoration = isHome() ? 'manual' : 'auto'
  }
}
syncScrollRestoration()
if (isHome()) window.scrollTo(0, 0)
window.addEventListener('hashchange', syncScrollRestoration)

// Note: intentionally not using <StrictMode>. Its double-invoke in development
// would mount Lenis and GSAP timelines twice, causing janky duplicate motion.
createRoot(document.getElementById('root')).render(<App />)
