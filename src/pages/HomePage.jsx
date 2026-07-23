import Hero from '../components/Hero'
import FabworksDiscount from '../components/FabworksDiscount'
import HomeTeasers from '../components/HomeTeasers'

// Landing page — full-screen hero, the title sponsor's discount (obvious, high
// on the page), then the explore/teaser body.
export default function HomePage() {
  return (
    <>
      <Hero />
      <FabworksDiscount />
      <HomeTeasers />
    </>
  )
}
