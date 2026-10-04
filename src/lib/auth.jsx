import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  onAuthStateChanged, signInWithEmailAndPassword, sendSignInLinkToEmail, isSignInWithEmailLink,
  signInWithEmailLink, sendPasswordResetEmail, updatePassword as fbUpdatePassword, signOut as fbSignOut,
} from 'firebase/auth'
import { doc, onSnapshot, setDoc, serverTimestamp } from 'firebase/firestore'
import { auth, db, isConfigured } from './firebase'

// Mirrors the role order in firebase/firestore.rules (`rank`). Order is privilege
// order — index comparison is what `atLeast` relies on, so this array, the rules
// and functions/src/roles.js must stay in the same sequence.
export const ROLES = ['pending', 'viewer', 'member', 'lead', 'mentor', 'admin']

export function roleAtLeast(role, minimum) {
  const a = ROLES.indexOf(role)
  const b = ROLES.indexOf(minimum)
  // An unrecognised role is treated as no privilege rather than as maximum
  // privilege — indexOf returning -1 must never read as "above the floor".
  if (a < 0 || b < 0) return false
  return a >= b
}

// Firebase reports auth failures with codes aimed at developers. Students signing
// in on a phone get something they can act on instead.
export function readableAuthError(error) {
  if (!error) return null
  const code = String(error.code || '')
  if (/invalid-credential|wrong-password|user-not-found|invalid-email|invalid-login/.test(code))
    return 'That email and password do not match.'
  if (/too-many-requests/.test(code)) return 'Too many attempts. Wait a minute and try again.'
  if (/network-request-failed/.test(code)) return 'Could not reach the server. Check your connection.'
  if (/requires-recent-login/.test(code))
    return 'For your security, sign out, sign back in, and then change your password.'
  if (/weak-password/.test(code)) return 'Choose a longer password — at least 8 characters.'
  if (/user-disabled/.test(code)) return 'This account has been disabled. Ask a lead.'
  if (/expired-action-code|invalid-action-code/.test(code))
    return 'That sign-in link has expired or was already used. Ask for a new one.'
  return String(error.message || error).replace(/^Firebase: /, '').replace(/ \(auth\/[a-z-]+\)\.?$/, '')
}

// Where a sign-in or reset email sends people back to. Firebase appends its own
// query parameters; the route is restored by main.jsx, which sees them and opens
// #/portal (a hash in this URL would not survive every mail client).
const returnUrl = () => `${window.location.origin}${window.location.pathname}?portal=signin`

// The address a sign-in link was requested for, kept so the same browser can
// finish the sign-in without asking again.
const LINK_EMAIL = 'frc5805.signin_email'

// After an email link is used, Firebase's parameters are still on the URL. Strip
// them so a copied link cannot carry a spent code around. The hash is the route
// and is preserved.
function cleanAuthParamsFromUrl() {
  if (typeof window === 'undefined') return
  const { search, hash, pathname } = window.location
  if (!search) return
  const params = new URLSearchParams(search)
  let touched = false
  for (const key of ['apiKey', 'oobCode', 'mode', 'lang', 'continueUrl', 'portal']) {
    if (params.has(key)) {
      params.delete(key)
      touched = true
    }
  }
  if (!touched) return
  const rest = params.toString()
  window.history.replaceState(null, '', `${pathname}${rest ? `?${rest}` : ''}${hash}`)
}

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [fbUser, setFbUser] = useState(null)
  const [profile, setProfile] = useState(null)
  // Starts true only when there is a backend to wait for; otherwise the portal
  // would sit on a spinner forever in an unconfigured checkout.
  const [sessionLoading, setSessionLoading] = useState(isConfigured)
  // Tracked separately because the profile arrives in a second round trip.
  // Treating the session alone as "loaded" left a window where a signed-in user
  // had no role yet, so `awaitingApproval` was briefly true and a legitimate
  // admin was told they were not on the roster.
  const [profileLoading, setProfileLoading] = useState(false)
  // Why the profile is missing, when it is. Without this a failed read left
  // `role` null, which reads exactly like "not approved yet" — so a network blip
  // told a signed-in admin they were not on the roster.
  const [profileError, setProfileError] = useState(null)
  // Bumped to re-subscribe to the profile for the SAME user after a failure.
  const [profileNonce, setProfileNonce] = useState(0)
  // Set when someone opens a sign-in link in a browser that did not ask for it:
  // Firebase needs the address again before it will finish.
  const [linkNeedsEmail, setLinkNeedsEmail] = useState(false)
  const [linkError, setLinkError] = useState(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // The session. onAuthStateChanged fires once with the restored user (or null)
  // and then only on a real sign-in or sign-out — a token refresh is not an event
  // here, so there is no spinner to mis-handle on tab focus.
  useEffect(() => {
    if (!isConfigured) return
    return onAuthStateChanged(auth, (next) => {
      if (!mounted.current) return
      if (next) setProfileLoading(true)
      setFbUser(next)
      setSessionLoading(false)
    })
  }, [])

  // Arriving from a sign-in email.
  useEffect(() => {
    if (!isConfigured || !isSignInWithEmailLink(auth, window.location.href)) return
    const email = window.localStorage.getItem(LINK_EMAIL)
    if (!email) {
      setLinkNeedsEmail(true)
      return
    }
    signInWithEmailLink(auth, email, window.location.href)
      .then(() => window.localStorage.removeItem(LINK_EMAIL))
      .catch((e) => mounted.current && setLinkError(readableAuthError(e)))
      .finally(cleanAuthParamsFromUrl)
  }, [])

  // The role comes from the profile document, never from the token or anything
  // the user can write. The server enforces this regardless — the rules are the
  // real boundary — but the UI must not disagree with the server about who you
  // are, or it will render controls that then fail on use.
  //
  // It is a live listener: a pending member is waiting for exactly one thing, an
  // admin approving them, and now sees it happen without reloading.
  const userId = fbUser?.uid ?? null
  useEffect(() => {
    if (!isConfigured || !userId) {
      setProfile(null)
      setProfileError(null)
      setProfileLoading(false)
      return
    }
    const ref = doc(db, 'profiles', userId)
    let creating = false
    return onSnapshot(
      ref,
      (snap) => {
        if (!mounted.current) return
        if (snap.exists()) {
          const d = snap.data()
          setProfile({ id: snap.id, full_name: d.full_name ?? null, grad_year: d.grad_year ?? null, subteam: d.subteam ?? null, role: d.role })
          setProfileError(null)
          setProfileLoading(false)
          return
        }
        // First sign-in: there is no profile yet, so make one. The rules let a
        // user create only their own, and only as `pending`.
        setProfile(null)
        setProfileLoading(false)
        if (creating) return
        creating = true
        setDoc(ref, {
          full_name: fbUser?.displayName?.trim() || null, grad_year: null, subteam: null, role: 'pending',
          created_at: serverTimestamp(), updated_at: serverTimestamp(),
        }).catch((e) => console.warn('[portal] could not create your profile yet:', e.code ?? e.message))
      },
      (error) => {
        if (!mounted.current) return
        console.warn('[portal] could not load profile:', error.code ?? error.message)
        // Keep the profile we already had for this same user: a listener that
        // drops mid-session must not demote the screen to "awaiting approval".
        setProfile((p) => (p?.id === userId ? p : null))
        setProfileError('Could not load your profile. Check your connection and try again.')
        setProfileLoading(false)
      }
    )
    // fbUser.displayName is read once, at first sign-in; it is not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, profileNonce])

  const refreshProfile = useCallback(() => {
    if (!isConfigured) return
    setProfileNonce((n) => n + 1)
  }, [])

  const signIn = useCallback(async (email, password) => {
    if (!isConfigured) return { error: 'The portal is not configured yet.' }
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password)
      return { error: null }
    } catch (e) {
      return { error: readableAuthError(e) }
    }
  }, [])

  // A sign-in link by email. Whatever the address, the answer is "sent": the
  // form must not be usable to test which students have accounts. A new address
  // that follows the link gets an account that is `pending` — it can see nothing
  // until a lead approves it.
  const signInWithLink = useCallback(async (email) => {
    if (!isConfigured) return { error: 'The portal is not configured yet.' }
    try {
      await sendSignInLinkToEmail(auth, email.trim(), { url: returnUrl(), handleCodeInApp: true })
      window.localStorage.setItem(LINK_EMAIL, email.trim())
      return { error: null }
    } catch (e) {
      if (/user-not-found|invalid-email/.test(String(e.code))) return { error: null }
      return { error: readableAuthError(e) }
    }
  }, [])

  // Finishing a link opened in a different browser from the one that asked.
  const completeLinkSignIn = useCallback(async (email) => {
    if (!isConfigured) return { error: 'The portal is not configured yet.' }
    try {
      await signInWithEmailLink(auth, email.trim(), window.location.href)
      setLinkNeedsEmail(false)
      cleanAuthParamsFromUrl()
      return { error: null }
    } catch (e) {
      return { error: readableAuthError(e) }
    }
  }, [])

  // The profile is cleared by the auth listener (userId goes null), not here.
  // Clearing it eagerly meant a sign-out that failed left a live session with no
  // profile — which renders as "you're not on the roster yet".
  const signOut = useCallback(async () => {
    if (!isConfigured) return { error: null }
    try {
      await fbSignOut(auth)
      return { error: null }
    } catch (e) {
      console.warn('[portal] sign-out did not complete:', e.code ?? e.message)
      return { error: readableAuthError(e) }
    }
  }, [])

  // Firebase's own page takes the new password, then sends the person back here
  // to sign in with it. Also how an account that never had a password gets one.
  const sendPasswordReset = useCallback(async (email) => {
    if (!isConfigured) return { error: 'The portal is not configured yet.' }
    try {
      await sendPasswordResetEmail(auth, email.trim(), { url: returnUrl() })
      return { error: null }
    } catch (e) {
      if (/user-not-found|invalid-email/.test(String(e.code))) return { error: null }
      return { error: readableAuthError(e) }
    }
  }, [])

  // The signed-in "Password" dialog.
  const updatePassword = useCallback(async (password) => {
    if (!isConfigured || !auth.currentUser) return { error: 'The portal is not configured yet.' }
    try {
      await fbUpdatePassword(auth.currentUser, password)
      return { error: null }
    } catch (e) {
      return { error: readableAuthError(e) }
    }
  }, [])

  const loading = sessionLoading || profileLoading

  const value = useMemo(() => {
    const role = profile?.role ?? null
    // The rest of the portal reads `user.id`; Firebase calls it `uid`.
    const user = fbUser ? { id: fbUser.uid, email: fbUser.email ?? null } : null
    // Only surfaced when there is no profile at all. A failed refresh behind a
    // profile we already hold is invisible on purpose: the screen stays right.
    const shownProfileError = profile ? null : profileError
    return {
      configured: isConfigured,
      loading,
      session: user ? { user } : null,
      user,
      profile,
      role,
      signedIn: Boolean(user),
      // A signed-in account with no approved role yet. This is the expected
      // state for a new account and needs its own UI — it is not an error.
      // A profile that failed to LOAD is not this state, and is excluded.
      awaitingApproval: Boolean(user) && !shownProfileError && (!role || role === 'pending'),
      profileError: shownProfileError,
      refreshProfile,
      atLeast: (minimum) => roleAtLeast(role, minimum),
      // Password recovery happens on Firebase's own page, so the portal never
      // sits in a recovery session.
      recovery: false,
      linkNeedsEmail,
      linkError,
      signIn,
      signInWithLink,
      completeLinkSignIn,
      signOut,
      sendPasswordReset,
      updatePassword,
    }
  }, [
    loading, fbUser, profile, profileError, linkNeedsEmail, linkError, refreshProfile, signIn,
    signInWithLink, completeLinkSignIn, signOut, sendPasswordReset, updatePassword,
  ])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
