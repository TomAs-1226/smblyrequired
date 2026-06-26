import { useEffect, useRef } from 'react'
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
import MobileStickyCTA from './components/MobileStickyCTA'

import HomePage from './pages/HomePage'
import TeamPage from './pages/TeamPage'
import RobotsPage from './pages/RobotsPage'
import SeasonPage from './pages/SeasonPage'
import SponsorPage from './pages/SponsorPage'
import CatalystPage from './pages/CatalystPage'
import GalleryPage from './pages/GalleryPage'
import ContactPage from './pages/ContactPage'
import NotFound from './pages/NotFound'
import RobotDetail from './components/RobotDetail'
import BlogIndex from './components/BlogIndex'
import BlogPost from './components/BlogPost'
import Donate from './components/Donate'

gsap.registerPlugin(ScrollTrigger, useGSAP)

const ROUTES = {
  '/': HomePage,
  '/team': TeamPage,
  '/robots': RobotsPage,
  '/season': SeasonPage,
  '/sponsor': SponsorPage,
  '/catalyst': CatalystPage,
  '/gallery': GalleryPage,
  '/contact': ContactPage,
  '/blog': BlogIndex,
  '/donate': Donate,
}

// Resolve a path to a component + props (handles dynamic /robots/:slug, /blog/:slug).
function resolve(path) {
  if (ROUTES[path]) return [ROUTES[path], {}]
  if (path.startsWith('/robots/')) return [RobotDetail, { slug: path.slice(8) }]
  if (path.startsWith('/blog/')) return [BlogPost, { slug: path.slice(6) }]
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

  // On every route change: jump to top, then re-measure ScrollTriggers once the
  // new page has painted.
  useEffect(() => {
    const lenis = getLenis()
    if (lenis) lenis.scrollTo(0, { immediate: true })
    else window.scrollTo(0, 0)
    const id = requestAnimationFrame(() => ScrollTrigger.refresh())
    return () => cancelAnimationFrame(id)
  }, [path])

  return (
    <div ref={root}>
      <Grain />
      <Nav />
      <main key={path} className={`page ${isHome ? '' : 'page--sub'}`}>
        <Page {...pageProps} />
      </main>
      <Footer />
      <MobileStickyCTA />
    </div>
  )
}
