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
CSS Modules + a global token sheet · Firebase (Auth + Firestore + Cloud Storage +
Cloud Functions) for the portal only.

Static frontend. There is no server — the portal talks to Firebase directly from
the browser, and `firebase/firestore.rules` and `firebase/storage.rules` are the
access boundary. Cloud Functions (`functions/`) exist only for what a browser must
not do: change a role, hold an API key, keep aggregates. Do not introduce a build
step that requires a Node runtime at request time; it would break the hosting
model. The data model and the rules/functions/client contract are in
`docs/FIREBASE.md`; setup is in `docs/PORTAL.md`.

## Layout

| Path | What |
|---|---|
| `src/data/*.js` | All site content. Non-coders edit here, nothing else. |
| `src/index.css` | The design system. Single source of truth for tokens. |
| `src/components/` | Public-site components, one CSS module each. |
| `src/components/portal/` | The private portal. Lazy-loaded. |
| `src/lib/` | Router, auth, Firebase client, markdown, motion helpers. |
| `firebase/` | `firestore.rules`, `storage.rules`, indexes, Storage CORS, and `test/` (the rules tests). |
| `functions/` | Cloud Functions (region `us-west1`) and their tests in `functions/test/`. |
| `scripts/backup/` | The nightly mirror, restore test, systemd units. |
| `scripts/firebase/` | `seed-emulators.mjs`, the local test accounts. |
| `docs/` | `PORTAL.md` (setup), `FIREBASE.md` (data model and contract), `BACKUP.md` (the backup runbook). |

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

8. **Hash routing vs. auth.** The site is hash-routed (`#/team`), so anything
   that returns to it in the URL *hash* collides with the route. Firebase's
   email-link and password-reset links come back with query parameters
   (`?mode=…&oobCode=…`) instead, and `src/main.jsx` sees them on a hash-less
   URL and opens `#/portal`; `src/lib/auth.jsx` then reads them and strips them
   from the address bar. Do not move the return URL into the hash.

9. **`SHA256SUMS` must be LF.** Windows autocrlf rewrites it on checkout and
   `sha256sum -c` then fails to find every file listed, which looks exactly like
   total backup corruption. Enforced in `.gitattributes`.

10. **A whole-number double cannot be restored through the Node Admin SDK.** It
   sends any number with no fraction as an integer, so `2.0` comes back as `2`,
   and the rules check `is int` and `is timestamp`, so the encoding keeps the
   difference (`{"$double":"2"}`). `restore.mjs` therefore writes every
   document that holds one through the Firestore REST API (`toRestFields` in
   `scripts/backup/encoding.mjs`), and the round-trip test compares through the
   REST API too, so an encoder and a decoder that are wrong in the same way
   cannot agree their way to a pass. Do not "simplify" the restore back to
   `set()` for everything.

11. **The Auth password-hash parameters are in no snapshot.** The export carries
   each account's hash, but the signer key, salt separator, rounds and memory
   cost that make a hash usable live only in the Firebase console, and the
   signer key is a secret that must not sit beside the hashes it protects. A
   restore needs them as `AUTH_HASH_*`; without them every account still comes
   back, with the same uid, and members sign in by email link or reset. Keep
   them in the password manager (`docs/BACKUP.md`, *Install → 5*).

12. **A snapshot is not point-in-time, and discovery has one blind spot.** The
   Postgres dump was one transaction; the Firestore walk is not, so a document
   and its slug index written at the wrong second can disagree in one night's
   snapshot. Subcollections whose parents are all deleted are found only for
   the names in `KNOWN_SUBCOLLECTIONS` in `scripts/backup/lib.mjs`. Add a name
   there when the data model gains a subcollection.

13. **Storage rules must decide create-vs-overwrite by `resource == null`.**
   Storage can evaluate an overwrite of an existing object as a *create*, so a
   rule split into `allow create` (members) and `allow update` (owners) let a
   member overwrite another member's file until it became one `create, update`
   rule: `mayWrite()` in `firebase/storage.rules` checks whether an object is
   already there and applies the create or the replace condition accordingly.
   Do not split it back; `npm run test:rules` has the overwrite case.

14. **A plain Firestore write does not fail offline, and a plain read answers
   from an empty cache.** The SDK queues a write and lands it later, with the
   promise pending, and a `getDoc` with no connection can resolve with a
   document that "does not exist". Both look like success. So reads that must be
   true use `getDocFromServer` / `getDocsFromServer`, and writes that must be
   acknowledged are transactions (sent now or failed now). The offline scouting
   queue (`src/lib/offlineQueue.js`) is built on this: it writes with
   transactions so that *it*, not the SDK, decides when to retry.

15. **The callable SDK decorates messages, and function messages are the
   function's own.** The client appends the HTTP status (` [404]`) to a callable
   error's message, and a `permission-denied` from a *function* is a sentence the
   function wrote for the reader ("You cannot change your own role."), unlike a
   rules refusal, which has no sentence at all. `call()` in `src/lib/db.js`
   strips the suffix and keeps the message; only a failure to reach the function
   is replaced by the generic one. Do not route function errors through `wrap()`
   alone.

16. **`node --test <dir>` fails on Node 24.** It treats the directory as a module
   to load. Name the file or use a glob (`node --test functions/test/*.test.mjs`),
   as the `test:*` scripts do.

17. **Lazy page chunks load their CSS after `index.css`.** On a lazy page (the
   portal, the robot and blog pages, `NotFound`) a CSS-module rule now beats a
   global rule of equal specificity, because its stylesheet arrives later.
   Components in the main bundle (Nav, Footer, the landing page) still load before
   `index.css`, so there the global rule wins. Check which bundle a component is in
   before assuming an order.

## Security posture

- The repo is **public**. The Firebase **web config** (`VITE_FIREBASE_*`) ships in
  the bundle and that is fine — it identifies the project, it is not a secret,
  and what a signed-in user can read or write is decided by the security rules.
- A **service-account key bypasses the rules entirely**. It must never carry a
  `VITE_` prefix, never appear in this repo, and never reach the frontend. It
  lives only on the backup host. See `docs/BACKUP.md`.
- Default deny: `firebase/firestore.rules` ends in a catch-all
  (`match /{document=**}`) that refuses everything not named above it, and
  signed-out users read nothing. A new account lands in the `pending` role and can
  read nothing but its own profile until an admin promotes it. **Signing in is not
  the same as being on the team.**
- `profiles.role` is written only by the `setMemberRole` Cloud Function, which
  checks the caller is an admin (from `profiles`, not a token claim), refuses
  your own role and the last admin, and writes the audit log. The rules refuse any
  client write that touches `role`. Do not add a direct update path.
- `knowledge_docs` bodies are checked in the rules (`looksSecret`) against common
  secret patterns (private/tailnet IPs, private keys, GitHub/AWS/API keys,
  `service_role` assignments), and `src/lib/secretPatterns.js` holds the same six
  so the portal can say which matched. Keep the two in step. It is a backstop for
  the obvious accident, **not** a guarantee — it only catches patterns it knows.
  Read what you are about to store.
- `src/lib/markdown.js` is safe by construction: it escapes HTML *first*, then
  applies formatting to already-escaped text. **Do not reverse that ordering**
  and do not add a rule that re-emits raw input. `npm run test:markdown` runs 21
  attack cases against it.

## Commands

```bash
npm run dev              # local dev server (real Firebase project, from .env.local)
npm run build            # production build -> dist/
npm run emulators        # Auth + Firestore + Storage + Functions, locally (needs Java 21+)
npm run seed:emulators   # one test account per role in the running emulators
npm run dev:emulators    # dev server pointed at the emulators, http://localhost:5174
npm test                 # everything below, in order
npm run test:markdown    # 21 XSS cases + 12 feature cases for the kb renderer
npm run test:portal      # offline queue, upload types, CSV export, analytics maths (node, no network)
npm run test:rules       # 52 tests of the Firestore and Storage rules, against the emulator
npm run test:functions   # 53 tests of the Cloud Functions, against the emulator
npm run seed:demo        # demo data (scripts/firebase/seed-demo.mjs)
npm run deploy:backend   # firestore rules + indexes, storage rules, functions
npm run deploy           # fetch TBA data, build, push dist/ to gh-pages

# the backup scripts have their own package.json (Node 22+, `npm ci` in scripts/backup first)
cd scripts/backup && npm test               # the encoding, value by value; no emulator
cd scripts/backup && npm run test:emulators # mirror -> wipe -> restore round trip + archiver, on emulators
```

`npm run test:rules` runs on its own emulator ports through `firebase.rules-test.json`,
so it can run while the dev emulators are up. The backup's emulator suite does the
same through `firebase.backup-test.json`.

**Run `npm run test:rules` after touching `firebase/firestore.rules` or
`firebase/storage.rules`, and `npm run test:functions` after touching
`functions/`.** Both need Java 21+ for the emulators and run under the
placeholder project `demo-frc5805`, never a real one. The 52 rules tests are the
actual proof that the access model holds — that a member cannot escalate, that a
signed-out visitor reads nothing, that a member cannot overwrite another member's
file. Reading the rules is not the same as testing them; the overwrite hole in
gotcha 13 was found this way. Changing a rule means changing
`docs/FIREBASE.md`, the functions and the client too: they are one contract.

The five `VITE_FIREBASE_*` variables must be present **at build time** — Vite
inlines them. A build without them still succeeds; the portal simply renders its
"not configured" state and the public site is unaffected. That is deliberate.

## Content editing

All site copy lives in `src/data/`. See `README.md` for the file-by-file map.
Components render data; they do not contain content. Keep it that way — a
graduating roster should be able to update the site without touching a component.
