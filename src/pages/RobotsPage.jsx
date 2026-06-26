import RobotLineage from '../components/RobotLineage'
import SwerveDemo from '../components/SwerveDemo'

// The robot lineage (readable, vertical) + the interactive swerve explainer.
export default function RobotsPage() {
  return (
    <>
      <RobotLineage />
      <SwerveDemo />
    </>
  )
}
