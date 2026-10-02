import Impact from '../components/Impact'
import Timeline from '../components/Timeline'
import SeasonTracker from '../components/SeasonTracker'
import News from '../components/News'

// Competition record + schedule, the team's history, live season tracker, then
// the latest updates.
export default function SeasonPage() {
  return (
    <>
      <Impact />
      <Timeline />
      <SeasonTracker />
      <News />
    </>
  )
}
