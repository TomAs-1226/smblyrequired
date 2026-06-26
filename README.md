# FRC Team 5805 — SMbly Required · Website

The official site for **FIRST Robotics Competition Team 5805**, Santa Margarita Catholic High School.
Built to win sponsors, support the FIRST Impact Award, and recruit students.

Design concept: **"Field Telemetry"** — a dark, cinematic engineering canvas. Oversized condensed
type, cyan data lines, and gold reserved for what's been *earned*.

## Stack

Vite 6 · React 18 · GSAP + `@gsap/react` (ScrollTrigger) · Lenis smooth scroll · split-type ·
CSS Modules + a global design-token sheet. No backend required (static site).

## Run it

```bash
npm install
npm run dev      # local dev server
npm run build    # production build -> dist/
npm run preview  # preview the production build
```

## ✏️ How to update the site (no coding needed)

**All content lives in `src/data/` — edit those files, nothing else.** The components just render
the data, so a non-coder can keep the site current across graduating classes.

| File | What it controls |
|---|---|
| `src/data/team.js` | Name, mission, motto, stats, pillars, mentors, contact info, "What is FIRST" facts |
| `src/data/robots.js` | The robot lineage (Genesis → Numbers). Add next season's robot here |
| `src/data/achievements.js` | Competition results / track record |
| `src/data/schedule.js` | The competition schedule + livestream link |
| `src/data/sponsors.js` | Sponsor **tiers & perks**, current partners, budget breakdown, in-kind list |
| `src/data/roster.js` | Student roster + captain |

**Examples**

- *Add a sponsor:* open `src/data/sponsors.js`, add `{ name: 'Acme Co', type: 'company' }` to `currentSponsors`.
- *Add a robot:* open `src/data/robots.js`, copy a block, set `name`, `season`, `result`, `status`, `image`.
- *Update a result:* edit the matching entry in `src/data/achievements.js`.

### Photos & logos

Drop images in `public/photos/` and reference them as `photos/your-file.jpg` in the data files.
- `logo.png` is the transparent team logo; `logo.jpg` is the original on white.
- Replace the sponsor wordmark plates with real sponsor logos when available (add a `logo` field to each
  entry in `sponsors.js` and render it in `Tiers.jsx`).

## Design system

`src/index.css` holds the single source of truth: semantic color tokens, the Oswald/Inter type scale,
spacing, radius, elevation. **Components reference CSS variables, never raw hex** — change the brand
once at the top of `index.css` and it cascades everywhere. The official team blue is `#164988`.

Reusable building blocks live in `src/components/`: `Section`, `Eyebrow`, `SplitHeading`, `StatNumeral`,
`Marquee`, `MagneticButton`, `Icon`, `Reveal`, `Counter`, plus `Grain`, `ScrollRail`, `MobileStickyCTA`.

## Deploy

`vite.config.js` sets `base: './'` so the build works on any static host:
GitHub Pages, Netlify, Cloudflare Pages, or even opened from disk. Just deploy `dist/`.

## TODO / QC checklist (hand-off)

- [ ] Swap sponsor wordmark plates for real **sponsor logo images**.
- [ ] Add **real outreach metrics** for the Impact section if you want hard numbers (kept honest — none are invented).
- [ ] Wire the contact form to a backend (Formspree/Netlify Forms) or confirm the mailto flow is enough.
- [ ] Real **social links** in the footer (currently placeholders).
- [ ] Confirm a **donate / tax-deductibility (EIN / 501(c)(3))** flow with the school.
- [ ] Optional: a 3D robot viewer (CAD → `.glb`/STL) in the Robot Lineage when CAD is exported.

---

FIRST® is a registered trademark of For Inspiration and Recognition of Science and Technology (FIRST),
which does not sponsor, authorize, or endorse this website.
