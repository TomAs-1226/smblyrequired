import { lazy, Suspense, useEffect, useRef } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import Lenis from 'lenis'
import { setLenis, getLenis } from './lib/smoothScroll'
import { prefersReducedMotion } from './lib/prefersReducedMotion'
import { useRoute } from './hooks/useRoute'

import Grain from './components/Grain'
import Nav from './components/Nav'
import Footer from './components/Footer'
import BackToTop from './components/BackToTop'

import HomePage from './pages/HomePage'

// Only the landing page is in the main bundle. Every other page is its own chunk,
// fetched when it is first opened — and, so that opening one is still instant, all
// of them are fetched quietly once the landing page has settled (see below).
const loaders = {
  '/team': () => import('./pages/TeamPage'),
  '/join': () => import('./pages/JoinPage'),
  '/mentors': () => import('./pages/MentorsPage'),
  '/robots': () => import('./pages/RobotsPage'),
  '/season': () => import('./pages/SeasonPage'),
  '/sponsor': () => import('./pages/SponsorPage'),
  '/catalyst': () => import('./pages/CatalystPage'),
  '/gallery': () => import('./pages/GalleryPage'),
  '/contact': () => import('./pages/ContactPage'),
  '/blog': () => import('./components/BlogIndex'),
  '/donate': () => import('./components/Donate'),
}
const RobotDetail = lazy(() => import('./components/RobotDetail'))
const BlogPost = lazy(() => import('./components/BlogPost'))
const NotFound = lazy(() => import('./pages/NotFound'))
// The portal pulls in the Firebase client, and the overwhelming majority of
// visitors are sponsors and prospective students who will never sign in. They
// should not pay to download it, so it is never part of the background fetch.
const Portal = lazy(() => import('./components/portal/Portal'))

gsap.registerPlugin(ScrollTrigger, useGSAP)

const ROUTES = {
  '/': HomePage,
  ...Object.fromEntries(Object.entries(loaders).map(([path, load]) => [path, lazy(load)])),
}

// Warm the page chunks while the browser is idle, a few seconds after first
// paint, so a click on the nav does not wait on the network. Skipped on a
// connection that asked to save data.
function prefetchPages() {
  if (navigator.connection?.saveData) return
  const run = () => {
    for (const load of Object.values(loaders)) load().catch(() => {})
    import('./components/RobotDetail').catch(() => {})
    import('./components/BlogPost').catch(() => {})
  }
  if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 6000 })
  else setTimeout(run, 4000)
}

// Resolve a path to a component + props (handles dynamic /robots/:slug, /blog/:slug).
function resolve(path) {
  if (ROUTES[path]) return [ROUTES[path], {}]
  if (path.startsWith('/robots/')) return [RobotDetail, { slug: path.slice(8) }]
  if (path.startsWith('/blog/')) return [BlogPost, { slug: path.slice(6) }]
  // `/portal` and `/portal/<panel>` both resolve here; the panel decides its own
  // gate. Nothing about the portal is reachable without a session — but the
  // route existing is not itself a leak, since every read is behind RLS.
  if (path === '/portal') return [Portal, { sub: '' }]
  if (path.startsWith('/portal/')) return [Portal, { sub: path.slice(8) }]
  return [NotFound, {}]
}

export default function App() {
  const root = useRef(null)
  const raw = useRoute()
  const path = raw !== '/' ? raw.replace(/\/+$/, '') : '/'
  const [Page, pageProps] = resolve(path)
  const isHome = path === '/'

  // One Lenis instance for the whole app; it persists across route changes.
  useGSAP(
    () => {
      document.body.classList.remove('is-loading')
      if (prefersReducedMotion()) {
        ScrollTrigger.refresh()
        return
      }
      const lenis = new Lenis({
        duration: 1.1,
        lerp: 0.1,
        smoothWheel: true,
        syncTouch: false,
        autoRaf: false,
      })
      setLenis(lenis)
      lenis.on('scroll', ScrollTrigger.update)
      const raf = (t) => lenis.raf(t * 1000)
      gsap.ticker.add(raf)
      gsap.ticker.lagSmoothing(0)
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => ScrollTrigger.refresh())
      }
      return () => {
        gsap.ticker.remove(raf)
        lenis.destroy()
        setLenis(null)
      }
    },
    { scope: root }
  )

  useEffect(() => {
    const t = setTimeout(prefetchPages, 2500)
    return () => clearTimeout(t)
  }, [])

  const isPortal = path.startsWith('/portal')

  // Portal sub-tabs are ONE page, not eleven.
  //
  // Keying <main> on the full path remounts the whole subtree on every route
  // change. Inside the portal that means remounting AuthProvider on every tab
  // click — so each one re-ran getSession(), refetched the profile, flashed
  // "Checking your session…", and made every panel start from nothing. It read
  // as a full page reload because functionally it was one.
  //
  // Public pages still key per route: they genuinely are separate pages and the
  // remount is what plays their entrance animation.
  const pageKey = isPortal ? '/portal' : path

  // On every route change — including a portal tab switch — jump to the top.
  //
  // This used to be skipped inside the portal to "keep your place in a long
  // list", but that backfired: the nav rail is sticky, so clicking from a tall
  // tab to a shorter one left the browser's scroll clamped to the new content's
  // bottom — you landed at the foot of the tab you just opened. Each tab is
  // different content, so there is no place worth preserving across a switch;
  // top is where a freshly opened tab should start. `immediate` (no smooth
  // scroll) because a tab click happens constantly and must feel instant.
  //
  // Only the public pages own scroll-driven animation, so only they re-measure
  // ScrollTrigger afterward; the portal has none.
  useEffect(() => {
    const lenis = getLenis()
    if (lenis) lenis.scrollTo(0, { immediate: true })
    else window.scrollTo(0, 0)
    if (isPortal) return
    const id = requestAnimationFrame(() => ScrollTrigger.refresh())
    return () => cancelAnimationFrame(id)
  }, [path, isPortal])

  return (
    <div ref={root}>
      <Grain />
      <Nav />
      <main key={pageKey} className={`page ${isHome ? '' : 'page--sub'}`}>
        {/* No spinner in the fallback: the portal chunk resolves in a few
            hundred ms on any real connection, and a spinner that flashes for
            200ms reads as jank rather than as progress. Reserving the height
            keeps the footer from jumping up and back. */}
        <Suspense fallback={<div style={{ minHeight: '70vh' }} />}>
          <Page {...pageProps} />
        </Suspense>
      </main>
      <Footer />
      {/* The sticky "Sponsor Us" CTA is aimed at prospective sponsors reading
          the public site. Inside the portal the audience is already on the
          team, so it is just a bar covering the UI. */}
      <BackToTop path={path} />
    </div>
  )
}
