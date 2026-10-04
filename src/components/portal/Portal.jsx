import { Component, useEffect, useState } from 'react'
import Icon from '../Icon'
import { AuthProvider, useAuth } from '../../lib/auth'
import { navigate } from '../../lib/router'
import SignIn from './SignIn'
import SetPassword from './SetPassword'
import Dashboard from './panels/Dashboard'
import Scouting from './panels/Scouting'
import Checklist from './panels/Checklist'
import Compare from './compare/Compare'
import Analytics from './panels/Analytics'
import TeamDetail from './panels/TeamDetail'
import PickList from './picklist/PickList'
import VisionPanel from './vision/VisionPanel'
import Forms from './forms/Forms'
import Control from './panels/Control'
import Files from './panels/Files'
import Graphs from './panels/Graphs'
import CodeArchive from './panels/CodeArchive'
import Knowledge from './panels/Knowledge'
import Roster from './panels/Roster'
import Admin from './panels/Admin'
import { ErrorState } from './ui'
import styles from './Portal.module.css'

// Panels are declared with the privilege floor they require. The gate below is
// convenience only — RLS in the database is the actual boundary. Hiding a tab
// the server would refuse anyway just avoids showing people doors that do not
// open for them.
const PANELS = [
  { id: '', label: 'Overview', icon: 'grid', min: 'viewer', Component: Dashboard },
  // Second, deliberately. At a competition this is the only tab that matters,
  // and it should not be buried under the archive tabs nobody opens in a pit.
  { id: 'scout', label: 'Scout', icon: 'flag', min: 'member', Component: Scouting },
  // Coverage sits next to Scout because "who still needs scouting?" is the
  // question asked between matches, by the same person, on the same phone.
  { id: 'checklist', label: 'Coverage', icon: 'check', min: 'member', Component: Checklist },
  { id: 'compare', label: 'Compare', icon: 'bars', min: 'member', Component: Compare },
  // The Catalyst engine on screen: power rankings computed from our own scouting
  // (with Statbotics EPA alongside when it answers), plus a match predictor. The
  // strategy cluster's overview — where a lead starts before drilling in.
  { id: 'analytics', label: 'Analytics', icon: 'compass', min: 'member', Component: Analytics },
  // Drill into one team: their scouting, photos, official TBA numbers, and how
  // workable they are as a partner. The strategy-analysis cluster's detail view.
  { id: 'team', label: 'Team detail', icon: 'user', min: 'member', Component: TeamDetail },
  // Members can read the board — everyone benefits from knowing the ranking.
  // Editing is lead+, enforced in RLS: one careless drag during selection is
  // expensive and hard to notice.
  { id: 'picks', label: 'Pick list', icon: 'trophy', min: 'member', Component: PickList },
  // The master-device vision pipeline: a phone runs an object detector on-device
  // and streams timestamped counts into scouting. `cpu` icon, not a camera one,
  // deliberately — the honest framing is "on-device model", not "it sees the
  // game". Member floor: running it is a scout's job, RLS (0011) is the real gate.
  { id: 'vision', label: 'Vision', icon: 'cpu', min: 'member', Component: VisionPanel },
  // Authoring the season's questions is a mentor/lead job, not a scout's.
  { id: 'forms', label: 'Forms', icon: 'cog', min: 'lead', Component: Forms },
  // Leadership sets the active event and the scouting window here; both are
  // enforced in the database (migration 0010), not just this screen.
  { id: 'control', label: 'Event control', icon: 'calendar', min: 'lead', Component: Control },
  { id: 'files', label: 'Files', icon: 'folder', min: 'viewer', Component: Files },
  { id: 'graphs', label: 'Graphs', icon: 'share', min: 'member', Component: Graphs },
  { id: 'code', label: 'Code', icon: 'code', min: 'member', Component: CodeArchive },
  { id: 'kb', label: 'Knowledge', icon: 'book', min: 'member', Component: Knowledge },
  { id: 'roster', label: 'Team', icon: 'users', min: 'lead', Component: Roster },
  // Last, and admin-only. Approvals, role changes, the audit trail, and storage
  // health — the controls a lead can see the results of but only an admin may
  // touch. RLS is the real gate; `min: 'admin'` just hides a door that would not
  // open anyway.
  { id: 'admin', label: 'Admin', icon: 'cog', min: 'admin', Component: Admin },
]

// AuthProvider lives here rather than in App so that the Firebase client is
// reached only through this module — which App lazy-loads. A sponsor reading
// the public site never downloads the auth stack at all.
export default function Portal({ sub = '' }) {
  return (
    <AuthProvider>
      <PortalInner sub={sub} />
    </AuthProvider>
  )
}

function PortalInner({ sub }) {
  const {
    configured,
    loading,
    signedIn,
    awaitingApproval,
    profile,
    profileError,
    refreshProfile,
    role,
    atLeast,
    signOut,
  } = useAuth()
  const [menuOpen, setMenuOpen] = useState(false)
  // Lets any signed-in user change their password with no email round trip —
  // the path a teammate uses to replace an admin-issued temporary password.
  const [changingPw, setChangingPw] = useState(false)

  useEffect(() => {
    setMenuOpen(false)
  }, [sub])

  if (!configured) return <NotConfigured />
  // Only the very first session resolution shows a spinner. Later navigations
  // reuse the resolved session, so panels never flash a loading state on tab
  // change — the frame stays put and only the panel body swaps.
  if (loading) return <Booting />
  if (!signedIn) return <SignIn />
  if (profileError)
    return <ProfileFailed error={profileError} onRetry={refreshProfile} onSignOut={signOut} />
  if (awaitingApproval)
    return <AwaitingApproval profile={profile} onCheck={refreshProfile} onSignOut={signOut} />

  const active = PANELS.find((p) => p.id === sub) ?? PANELS[0]
  const visible = PANELS.filter((p) => atLeast(p.min))
  const allowed = atLeast(active.min)
  const Panel = active.Component

  return (
    <div className={`container ${styles.wrap}`}>
      <header className={styles.head}>
        <div>
          <span className={styles.eyebrow}>Team Portal</span>
          <h1 className={styles.title}>{active.label}</h1>
        </div>
        <div className={styles.identity}>
          <span className={styles.who}>
            <span className={styles.whoName}>{profile?.full_name || 'Signed in'}</span>
            <span className={`${styles.roleTag} ${styles[`role_${role}`] ?? ''}`}>{role}</span>
          </span>
          <button type="button" className={styles.signOut} onClick={() => setChangingPw(true)}>
            Password
          </button>
          <button type="button" className={styles.signOut} onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      {changingPw && <SetPassword onClose={() => setChangingPw(false)} />}

      <button
        type="button"
        className={styles.panelToggle}
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((v) => !v)}
      >
        <Icon name={menuOpen ? 'close' : 'menu'} size={18} />
        {active.label}
      </button>

      <div className={styles.body}>
        <nav
          className={`${styles.rail} ${menuOpen ? styles.railOpen : ''}`}
          aria-label="Portal sections"
        >
          {visible.map((p) => {
            const isActive = p.id === active.id
            return (
              <a
                key={p.id || 'overview'}
                href={`#/portal${p.id ? `/${p.id}` : ''}`}
                className={`${styles.railLink} ${isActive ? styles.railLinkActive : ''}`}
                aria-current={isActive ? 'page' : undefined}
              >
                <Icon name={p.icon} size={17} />
                {p.label}
              </a>
            )
          })}
        </nav>

        <div className={styles.panel}>
          {allowed ? (
            <PanelBoundary key={active.id}>
              <Panel />
            </PanelBoundary>
          ) : (
            <NoAccess need={active.min} have={role} />
          )}
        </div>
      </div>
    </div>
  )
}

function Booting() {
  return (
    <div className={`container ${styles.wrap}`}>
      <div className={styles.center} role="status" aria-live="polite">
        <span className={styles.spinner} aria-hidden="true" />
        <p className={styles.centerText}>Checking your session…</p>
      </div>
    </div>
  )
}

function NotConfigured() {
  return (
    <div className={`container ${styles.wrap}`}>
      <div className={styles.center}>
        <span className={`pill ${styles.centerPill}`}>Backend not connected</span>
        <h1 className={styles.title}>The portal is not set up yet</h1>
        <p className={styles.centerText}>
          This build has no Firebase configuration, so there is nothing to sign in to. The public
          site is unaffected. Setup steps are in <code>docs/PORTAL.md</code>.
        </p>
        <button type="button" className="btn btn--ghost" onClick={() => navigate('/')}>
          Back to the site
        </button>
      </div>
    </div>
  )
}

// Signing up is not the same as being on the team. New accounts land here until
// an admin grants them a role — see the `pending` default in migration 0001.
//
// The role is re-read when the tab regains focus and on "Check again", so the
// approval shows up the moment it happens. Previously the profile was fetched
// once per sign-in, and the only way to discover an approval was to know to
// reload the page — most people instead concluded it had not happened.
function AwaitingApproval({ profile, onCheck, onSignOut }) {
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') onCheck()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [onCheck])

  return (
    <div className={`container ${styles.wrap}`}>
      <div className={styles.center}>
        <span className={`pill ${styles.centerPill}`}>Awaiting approval</span>
        <h1 className={styles.title}>You're signed in — but not on the roster yet</h1>
        <p className={styles.centerText}>
          {profile?.full_name ? `Thanks, ${profile.full_name.split(' ')[0]}. ` : ''}
          An account exists for you, but an admin still has to add you before anything is
          visible. Ask in the build channel and someone will approve it.
        </p>
        <div className={styles.centerActions}>
          <button type="button" className="btn btn--cyan" onClick={onCheck}>
            Check again
          </button>
          <button type="button" className="btn btn--ghost" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  )
}

// The profile could not be read at all — usually the network. Distinct from
// AwaitingApproval on purpose: telling an approved member "you're not on the
// roster" because a request failed sends them to ask an admin to fix something
// that is not broken.
function ProfileFailed({ error, onRetry, onSignOut }) {
  return (
    <div className={`container ${styles.wrap}`}>
      <div className={styles.center} role="alert">
        <span className={`pill ${styles.centerPill}`}>Connection problem</span>
        <h1 className={styles.title}>We couldn't load your account</h1>
        <p className={styles.centerText}>{error}</p>
        <div className={styles.centerActions}>
          <button type="button" className="btn btn--cyan" onClick={onRetry}>
            Try again
          </button>
          <button type="button" className="btn btn--ghost" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  )
}

function NoAccess({ need, have }) {
  return (
    <div className={styles.center}>
      <span className={`pill ${styles.centerPill}`}>Restricted</span>
      <p className={styles.centerText}>
        This section needs the <strong>{need}</strong> role. Yours is <strong>{have}</strong>. Ask
        an <strong>admin</strong> to change it — only admins can grant roles, not leads.
      </p>
    </div>
  )
}

// One panel throwing during render used to take the whole portal with it — React
// unmounts the tree on an uncaught render error, so one malformed row blanked
// the page, the rail and the sign-out button included. This keeps a failure
// inside the panel that had it. Keyed by panel id in the caller, so switching
// tabs gives the next panel a clean slate.
class PanelBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[portal] panel crashed:', error, info?.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <ErrorState
        error={`This section hit an error and stopped: ${this.state.error?.message ?? this.state.error}`}
        onRetry={() => this.setState({ error: null })}
      />
    )
  }
}
