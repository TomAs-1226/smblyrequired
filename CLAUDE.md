# CLAUDE.md — working notes for this repo

Context for anyone (human or agent) picking this codebase up cold. Public repo:
**no IPs, hostnames, ports, keys, or network topology in this file, ever.**
Operational details that need those live in a password manager and are referred
to here by name only.

## What this is

The public website for FRC Team 5805 (SMbly Required), plus a private team
portal. Live at `frc5805.com`, hosted on **GitHub Pages** from the `gh-pages`
branch. Source lives on `main`.

## Stack

Vite 6 · React 18 · GSAP + `@gsap/react` (ScrollTrigger) · Lenis smooth scroll ·
CSS Modules + a global token sheet · Supabase (Postgres + Storage + Auth) for the
portal only.

Static frontend. There is no server — the portal talks to Supabase directly from
the browser, and RLS is the access boundary. Do not introduce a build step that
requires a Node runtime at request time; it would break the hosting model.

## Layout

| Path | What |
|---|---|
| `src/data/*.js` | All site content. Non-coders edit here, nothing else. |
| `src/index.css` | The design system. Single source of truth for tokens. |
| `src/components/` | Public-site components, one CSS module each. |
| `src/components/portal/` | The private portal. Lazy-loaded. |
| `src/lib/` | Router, auth, Supabase client, markdown, motion helpers. |
| `supabase/migrations/` | Schema + RLS. Apply in numeric order. |
| `scripts/backup/` | The nightly mirror, restore test, systemd units. |
| `docs/` | `PORTAL.md` (setup), `BACKUP.md` (the backup runbook). |

## Design system — the rules that matter

`src/index.css` holds semantic tokens for colour, type, spacing, elevation, and
**motion**. The discipline is: *components reference tokens, never raw values.*
That applies to easing and duration exactly as it applies to colour.

- `--ease-out` is the house curve (expo-out). Enter, lift, release.
- Never `ease-in` on UI. It delays the moment the user is watching most closely.
- Interactive motion stays **under 300ms**. `--dur-press` 120ms for `:active`,
  `--dur-fast` 160ms for colour, `--dur-ui` 200ms for transforms,
  `--dur-panel` 260ms for panels. `--dur-ambient` 800ms is for scroll reveals
  and marketing only — never for something the user is waiting on.
- Every `:hover` rule is wrapped in `@media (hover: hover) and (pointer: fine)`.
  Touch devices synthesise hover on tap and then latch it.
- Every pressable element has an `:active` state (`scale(0.97)`, or `0.92` for
  small icon buttons, `0.98` for large cards).
- Wherever `:hover` gives real affordance, there is a matching `:focus-visible`
  rule **outside** the hover media query. Keyboard users get the same
  information, not just an outline.
- Animate `transform` and `opacity`. Not `width`, `height`, `gap`, or padding.
  The "cyan wipe" motif is `scaleX()` with `transform-origin: left` everywhere.

## Gotchas that have already bitten

These are real, were found the hard way, and are easy to reintroduce.

1. **GSAP leaves an inline transform behind.** `gsap.to(el, { y: 0 })` ends with
   `transform: translate(0px, 0px)` set inline, and inline styles beat every
   selector. This silently killed the CSS hover lift and press state on every
   scroll-revealed card. `Reveal.jsx` and Gallery's `ScrollTrigger.batch` now
   pass `clearProps: 'transform'`. **Any new GSAP tween that animates transform
   on an element with CSS hover/active states must do the same.**

2. **`backdrop-filter` also creates a containing block for `position: fixed`.**
   Same trap as #1, different property, and much less well known. The nav bar's
   blur made `<header>` the containing block for the mobile overlay inside it,
   so `inset: 0` resolved against the 72px bar — the menu opened as a **71px
   strip** on every subpage. Diagnosed by setting `backdropFilter = 'none'` at
   runtime and watching it snap to 812px.
   Two defences, both applied: the overlay renders as a **sibling** of
   `<header>`, and the blur lives on `.nav::before` rather than `.nav`.
   The general rule: `transform`, `filter`, `backdrop-filter`, `perspective`,
   `contain: paint`, and `will-change` on any of those all capture fixed
   descendants. If a `position: fixed` element is mysteriously the wrong size,
   walk its ancestors looking for those before anything else.

3. **`overflow: hidden` does not stop Lenis.** `body { overflow: hidden }` only
   blocks *user* scrolling; the element stays a scroll container and `scrollTop`
   stays writable. Lenis scrolls programmatically, so with the menu open a wheel
   gesture still drove the page (measured: 400 → 1000). Call `getLenis()?.stop()`
   / `.start()` around any modal, and keep the body lock only as the fallback for
   the reduced-motion path where Lenis is never constructed.

4. **`none` → `blur(12px)` is not smoothly interpolable.** Engines step it, which
   is the flicker on the nav's surface transition. Keep the filter constant on a
   pseudo-element and animate only its `opacity`. Firefox historically degraded
   `backdrop-filter` to fully transparent, so always pair it with an
   `@supports not (backdrop-filter: …)` opaque fallback — otherwise nav text sits
   unreadable over page content.

5. **`hidden` cannot be transitioned.** It applies `display: none`, so an
   element with `hidden={!open}` never animates in or out — the mobile menu's
   fade did nothing in either direction. Drive visibility from CSS
   (`visibility` + a delayed transition) and use `inert` for focus management.
   In React 18, spread `inert` conditionally: `inert={false}` renders
   `inert="false"`, and per spec *any* value makes the subtree inert.

6. **`transform` does not apply to inline elements.** A `:active { scale() }` on
   a non-replaced inline `<a>` silently does nothing. Add `display: inline-block`.

7. **`:focus-visible` must not set `border-radius`.** Outlines already follow the
   element's own radius; setting one there overrides it and snaps pills and
   circles into rectangles while focused. `index.css` is injected after the CSS
   modules, so it wins.

8. **Hash routing vs. Supabase auth.** The site is hash-routed (`#/team`), and
   Supabase's default implicit flow returns the session in the URL *hash* — the
   two collide. The client is configured with `flowType: 'pkce'`, which returns
   `?code=` in the query string instead. Do not change this.

9. **`SHA256SUMS` must be LF.** Windows autocrlf rewrites it on checkout and
   `sha256sum -c` then fails to find every file listed, which looks exactly like
   total backup corruption. Enforced in `.gitattributes`.

10. **A public-only `pg_dump` is not restorable.** `public.profiles.id` is a
   foreign key onto `auth.users`. pg_dump adds constraints *after* loading data,
   and `ADD CONSTRAINT` runs a validation scan that `session_replication_role =
   replica` does **not** suppress — so the restore dies on `profiles_id_fkey`.
   The backup therefore writes two files: `auth_users.sql.gz` (`--data-only`,
   because auth.users' DDL carries a trigger referencing a `public` function
   that does not exist yet at that point) and `db.sql.gz`. Restore order is
   stub-auth-and-roles → auth data → public. Verified by actually doing it; do
   not "simplify" it back to one file.

## Security posture

- The repo is **public**. The Supabase **anon key ships in the bundle** and that
  is fine — it is a public identifier, and what it can read is decided by RLS.
- The **service-role key bypasses RLS entirely**. It must never carry a `VITE_`
  prefix, never appear in this repo, and never reach the frontend. It lives only
  on the backup host. See `docs/BACKUP.md`.
- Default deny: RLS is on for every table, and no policy grants `anon` anything.
  A new signup lands in the `pending` role and can read nothing until a lead
  promotes them. **Signing up is not the same as being on the team.**
- `profiles.role` has no column-level UPDATE grant for `authenticated`. The only
  path that writes it is the `set_member_role()` RPC, which checks the caller is
  an admin. Do not add a direct update path.
- `knowledge_docs` has a database-side trigger that rejects common secret
  patterns (private/tailnet IPs, private keys, GitHub/AWS/Supabase tokens) on
  write. It is a backstop for the obvious accident, **not** a guarantee — it
  only catches patterns it knows. Read what you are about to store.
- `src/lib/markdown.js` is safe by construction: it escapes HTML *first*, then
  applies formatting to already-escaped text. **Do not reverse that ordering**
  and do not add a rule that re-emits raw input. `npm run test:markdown` runs 21
  attack cases against it.

## Commands

```bash
npm run dev            # local dev server
npm run build          # production build -> dist/
npm run test:markdown  # 21 XSS cases + 12 feature cases for the kb renderer
npm run test:db        # apply migrations to a throwaway local DB, run the RLS suite
npm run deploy         # fetch TBA data, build, push dist/ to gh-pages
```

**Run `npm run test:db` after touching anything in `supabase/migrations/`.** It
needs a local PostgreSQL 15+ and never touches a Supabase project. The 21
assertions in `supabase/local-test/01_rls_tests.sql` are the actual proof that
the access model holds — that a member cannot escalate, that `anon` reads
nothing, that the last admin cannot be deleted. Reading the policies is not the
same as testing them; two real holes were found this way.

The two `VITE_SUPABASE_*` variables must be present **at build time** — Vite
inlines them. A build without them still succeeds; the portal simply renders its
"not configured" state and the public site is unaffected. That is deliberate.

## Content editing

All site copy lives in `src/data/`. See `README.md` for the file-by-file map.
Components render data; they do not contain content. Keep it that way — a
graduating roster should be able to update the site without touching a component.
