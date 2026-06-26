import Impact from '../components/Impact'
import SeasonTracker from '../components/SeasonTracker'
import News from '../components/News'

// Competition record + schedule, live season tracker, then the latest updates.
export default function SeasonPage() {
  return (
    <>
      <Impact />
      <SeasonTracker />
      <News />
    </>
  )
}
