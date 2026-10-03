import RobotLineage from '../components/RobotLineage'
import Testbeds from '../components/Testbeds'

// The robot lineage, each with its CAD on a turntable where there is one, then the bench.
export default function RobotsPage() {
  return (
    <>
      <RobotLineage />
      <Testbeds />
    </>
  )
}
