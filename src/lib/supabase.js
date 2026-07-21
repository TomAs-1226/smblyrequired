import { createClient } from '@supabase/supabase-js'

// -----------------------------------------------------------------------------
// Supabase client.
//
// Two things worth knowing before touching this file:
//
// 1. The anon key belongs in the browser. It is a public identifier, not a
//    secret — every row it can reach is decided by the RLS policies in
//    supabase/migrations/, not by hiding the key. The service-role key is the
//    opposite: it bypasses RLS entirely and must never appear in this bundle,
//    in a VITE_-prefixed variable, or anywhere else Vite can inline it. It
//    belongs only in the backup job's environment.
//
// 2. PKCE, not implicit. The default implicit flow returns the session in the
//    URL *hash* — and this site is hash-routed (`#/portal`), so the two would
//    fight over the same fragment. PKCE returns `?code=` in the query string
//    instead, which passes through the router untouched.
// -----------------------------------------------------------------------------

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// The public site has to keep working whether or not a backend exists. Anyone
// can clone this repo and `npm run dev` without credentials; the portal then
// reports itself unconfigured instead of taking the marketing pages down with
// it. Never let this module throw at import time.
export const isConfigured = Boolean(url && anonKey)

export const supabase = isConfigured
  ? createClient(url, anonKey, {
      auth: {
        flowType: 'pkce',
        detectSessionInUrl: true,
        persistSession: true,
        autoRefreshToken: true,
      },
    })
  : null

if (!isConfigured && import.meta.env.DEV) {
  console.info(
    '[portal] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are unset — the portal ' +
      'will render its unconfigured state. See docs/PORTAL.md to set them up.'
  )
}

// After PKCE completes, Supabase leaves `?code=...&state=...` on the URL. Strip
// it so a copied link cannot carry a spent authorization code around, and so a
// refresh does not attempt to redeem it a second time. The hash is preserved —
// it is the route.
export function cleanAuthParamsFromUrl() {
  if (typeof window === 'undefined') return
  const { search, hash, pathname } = window.location
  if (!search) return
  const params = new URLSearchParams(search)
  let touched = false
  for (const key of ['code', 'state', 'error', 'error_description']) {
    if (params.has(key)) {
      params.delete(key)
      touched = true
    }
  }
  if (!touched) return
  const rest = params.toString()
  window.history.replaceState(null, '', `${pathname}${rest ? `?${rest}` : ''}${hash}`)
}

// Supabase surfaces auth failures with messages aimed at developers. Students
// signing in on a phone get something they can act on instead.
export function readableAuthError(error) {
  if (!error) return null
  const raw = String(error.message || error)
  if (/invalid login credentials/i.test(raw)) return 'That email and password do not match.'
  if (/email not confirmed/i.test(raw)) return 'Check your inbox and confirm your email first.'
  if (/rate limit|too many requests/i.test(raw))
    return 'Too many attempts. Wait a minute and try again.'
  if (/network|fetch/i.test(raw)) return 'Could not reach the server. Check your connection.'
  return raw
}
