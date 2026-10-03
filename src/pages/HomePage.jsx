import Spine from '../components/spine/Spine'
import FabworksDiscount from '../components/FabworksDiscount'
import SponsorWall from '../components/SponsorWall'
import HomeTeasers from '../components/HomeTeasers'

// Landing page — the team and this season's robot first (the spine), then the
// title sponsor's discount, the sponsors, and the way into the rest of the site.
export default function HomePage() {
  return (
    <>
      <Spine />
      <FabworksDiscount />
      <SponsorWall />
      <HomeTeasers />
    </>
  )
}
