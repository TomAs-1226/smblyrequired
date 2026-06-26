import { useRef } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import Lenis from 'lenis'
import { setLenis } from './lib/smoothScroll'
import { prefersReducedMotion } from './lib/prefersReducedMotion'

import Grain from './components/Grain'
import Nav from './components/Nav'
import ScrollRail from './components/ScrollRail'
import MobileStickyCTA from './components/MobileStickyCTA'
import Hero from './components/Hero'
import About from './components/About'
import RobotLineage from './components/RobotLineage'
import WhySponsor from './components/WhySponsor'
import Tiers from './components/Tiers'
import Impact from './components/Impact'
import Catalyst from './components/Catalyst'
import News from './components/News'
import Gallery from './components/Gallery'
import Faq from './components/Faq'
import Contact from './components/Contact'
import Footer from './components/Footer'

gsap.registerPlugin(ScrollTrigger, useGSAP)

export default function App() {
  const root = useRef(null)

  useGSAP(
    () => {
      document.body.classList.remove('is-loading')

      // Reduced motion: skip Lenis entirely, let ScrollTrigger ride native scroll.
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
      const raf = (time) => lenis.raf(time * 1000)
      gsap.ticker.add(raf)
      gsap.ticker.lagSmoothing(0)

      // Re-measure pinned/scrubbed triggers once web fonts have loaded.
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

  return (
    <div ref={root}>
      <Grain />
      <Nav />
      <ScrollRail />
      <main>
        <Hero />
        <About />
        <RobotLineage />
        <WhySponsor />
        <Tiers />
        <Impact />
        <Catalyst />
        <News />
        <Gallery />
        <Faq />
        <Contact />
      </main>
      <Footer />
      <MobileStickyCTA />
    </div>
  )
}
