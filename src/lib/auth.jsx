import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { supabase, isConfigured, cleanAuthParamsFromUrl, readableAuthError } from './supabase'
import SetPassword from '../components/portal/SetPassword'

// Mirrors the member_role enum in supabase/migrations/0001_identity.sql.
// Order is privilege order — index comparison is what `atLeast` relies on, so
// this array and the SQL enum must stay in the same sequence.
export const ROLES = ['pending', 'viewer', 'member', 'lead', 'mentor', 'admin']

export function roleAtLeast(role, minimum) {
  const a = ROLES.indexOf(role)
  const b = ROLES.indexOf(minimum)
  // An unrecognised role is treated as no privilege rather than as maximum
  // privilege — indexOf returning -1 must never read as "above the floor".
  if (a < 0 || b < 0) return false
  return a >= b
}

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  // Starts true only when there is a backend to wait for; otherwise the portal
  // would sit on a spinner forever in an unconfigured checkout.
  const [sessionLoading, setSessionLoading] = useState(isConfigured)
  // Tracked separately because the profile is fetched in a second round trip.
  // Treating the session alone as "loaded" left a window where a signed-in user
  // had no role yet, so `awaitingApproval` was briefly true and a legitimate
  // admin was told they were not on the roster — on every single page load.
  const [profileLoading, setProfileLoading] = useState(false)
  // True while the user is inside a password-recovery link. Supabase signs them
  // in with a limited recovery session and fires PASSWORD_RECOVERY; the only
  // sane thing to show then is "set your new password", not the dashboard.
  const [recovery, setRecovery] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Which user we have already fetched a profile for.
  //
  // This exists because of a genuinely nasty bug: Supabase fires
  // onAuthStateChange on tab focus (TOKEN_REFRESHED, and SIGNED_IN on some
  // browsers — Edge does it every single time you tab back in). The old code
  // set profileLoading on *any* event, but the effect that clears the flag keys
  // on userId — which has NOT changed on a refresh. So the effect never re-ran,
  // the flag was never cleared, and the portal sat on "Checking your session…"
  // permanently until a hard reload.
  //
  // Only a genuine change of identity may re-enter the loading state.
  const loadedFor = useRef(null)

  useEffect(() => {
    if (!isConfigured) return

    const apply = (next) => {
      if (!mounted.current) return
      const nextId = next?.user?.id ?? null
      if (nextId && nextId !== loadedFor.current) setProfileLoading(true)
      // Signed out: drop the marker so signing back in re-fetches.
      if (!nextId) loadedFor.current = null
      setSession(next)
      setSessionLoading(false)
      cleanAuthParamsFromUrl()
    }

    supabase.auth.getSession().then(({ data }) => apply(data.session ?? null))

    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      // A token refresh is not a login. The session object is new but the person
      // is the same, so there is nothing to re-resolve and nothing to show a
      // spinner for.
      if (event === 'PASSWORD_RECOVERY') setRecovery(true)
      if (event === 'TOKEN_REFRESHED' && next?.user?.id === loadedFor.current) {
        setSession(next)
        return
      }
      apply(next)
    })

    return () => sub.subscription.unsubscribe()
  }, [])

  // The role comes from the profiles row, never from user metadata. Metadata is
  // writable by the user it belongs to; trusting it for authorization would let
  // anyone promote themselves. The server enforces this regardless — RLS is the
  // real boundary — but the UI must not disagree with the server about who you
  // are, or it will render controls that then fail on use.
  const userId = session?.user?.id
  useEffect(() => {
    if (!isConfigured || !userId) {
      setProfile(null)
      setProfileLoading(false)
      return
    }
    let cancelled = false
    ;(async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, grad_year, subteam, role')
        .eq('id', userId)
        .maybeSingle()
      if (cancelled || !mounted.current) return
      if (error) {
        console.warn('[portal] could not load profile:', error.message)
        setProfile(null)
        setProfileLoading(false)
        // Deliberately NOT marking this user as loaded — a failed fetch should
        // be retried on the next auth event, not remembered as done.
        return
      }
      setProfile(data ?? null)
      loadedFor.current = userId
      setProfileLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [userId])

  const signIn = useCallback(async (email, password) => {
    if (!isConfigured) return { error: 'The portal is not configured yet.' }
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return { error: readableAuthError(error) }
  }, [])

  const signInWithLink = useCallback(async (email) => {
    if (!isConfigured) return { error: 'The portal is not configured yet.' }
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        // Land back on the portal route. PKCE appends `?code=` ahead of the
        // hash, so the router still resolves `#/portal` correctly.
        emailRedirectTo: `${window.location.origin}${window.location.pathname}#/portal`,
      },
    })
    return { error: readableAuthError(error) }
  }, [])

  const signOut = useCallback(async () => {
    if (!isConfigured) return
    await supabase.auth.signOut()
    setProfile(null)
  }, [])

  // Works for accounts that have no password yet — Supabase sends the same
  // recovery email either way, which is exactly what a first-time set needs.
  const sendPasswordReset = useCallback(async (email) => {
    if (!isConfigured) return { error: 'The portal is not configured yet.' }
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}${window.location.pathname}#/portal`,
    })
    return { error: readableAuthError(error) }
  }, [])

  // Called from inside the recovery session. On success the user is a normal
  // signed-in member with a password, so recovery mode ends.
  const updatePassword = useCallback(async (password) => {
    if (!isConfigured) return { error: 'The portal is not configured yet.' }
    const { error } = await supabase.auth.updateUser({ password })
    if (!error) setRecovery(false)
    return { error: readableAuthError(error) }
  }, [])

  const loading = sessionLoading || profileLoading

  const value = useMemo(() => {
    const role = profile?.role ?? null
    return {
      configured: isConfigured,
      loading,
      session,
      user: session?.user ?? null,
      profile,
      role,
      signedIn: Boolean(session),
      // A signed-in account with no approved role yet. This is the expected
      // state right after signup and needs its own UI — it is not an error.
      awaitingApproval: Boolean(session) && (!role || role === 'pending'),
      atLeast: (minimum) => roleAtLeast(role, minimum),
      recovery,
      signIn,
      signInWithLink,
      signOut,
      sendPasswordReset,
      updatePassword,
    }
  }, [loading, session, profile, recovery, signIn, signInWithLink, signOut, sendPasswordReset, updatePassword])

  // The set-password overlay pre-empts everything else. Rendering it here rather
  // than threading `recovery` through Portal keeps the whole flow in files the
  // rest of the portal does not need to know about.
  return (
    <AuthContext.Provider value={value}>
      {recovery ? <SetPassword /> : children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
