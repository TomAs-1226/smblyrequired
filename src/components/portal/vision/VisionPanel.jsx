import { useState } from 'react'
import Icon from '../../Icon'
import VisionCapture from './VisionCapture'
import VisionSessions from './VisionSessions'
import styles from './Vision.module.css'

// =============================================================================
// VisionPanel — the "Vision" tab: run the master device, or review what it saw.
//
// Two modes on purpose. CAPTURE is a phone job done standing at the field;
// REVIEW is a laptop job done afterwards. Splitting them keeps the capture screen
// free of everything that is not "point and count", which is what the operator
// needs when a match is about to start.
//
// This whole feature is framed, everywhere the user can see it, as a PIPELINE:
// the plumbing that turns on-device inference into a reviewable, timestamped data
// stream, ready for a purpose-trained model to replace the generic detector. It
// does not pretend to score a match today, and nothing here says it does.
// =============================================================================

const TABS = [
  { id: 'capture', label: 'Capture', icon: 'cpu' },
  { id: 'sessions', label: 'Sessions', icon: 'bars' },
]

export default function VisionPanel() {
  const [tab, setTab] = useState('capture')
  // Bumped when a capture ends so the Sessions view reloads its list the next
  // time it is shown, without a full page reload.
  const [reloadKey, setReloadKey] = useState(0)

  return (
    <div className={styles.panel}>
      <div className={styles.intro}>
        <h2 className={styles.introTitle}>Vision pipeline</h2>
        <p className={styles.introText}>
          A master device runs an object detector <strong>on the phone itself</strong> and streams
          timestamped counts into scouting. The video never leaves the device. Today it runs a
          generic model as a stand-in — this is the pipeline and the training-data collector for a
          purpose-built FRC model, not a match scorer.
        </p>
      </div>

      <div className={styles.tabs} role="tablist" aria-label="Vision mode">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`${styles.tab} ${tab === t.id ? styles.tabOn : ''}`}
            onClick={() => setTab(t.id)}
          >
            <Icon name={t.icon} size={16} />
            {t.label}
          </button>
        ))}
      </div>

      {/* Both stay mounted-by-choice: Capture is unmounted when not shown so its
          camera and wake lock are released the moment the operator leaves it —
          leaving a camera running behind a hidden tab is exactly the bug that
          gets a tool uninstalled. */}
      {tab === 'capture' ? (
        <VisionCapture onSessionEnd={() => setReloadKey((k) => k + 1)} />
      ) : (
        <VisionSessions reloadKey={reloadKey} />
      )}
    </div>
  )
}
