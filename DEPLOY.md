# Deploying the Team 5805 site to smblyrequired.com

This is a static site (`npm run build` → `dist/`, relative asset paths, hash routing),
so it hosts anywhere with **no server config**. Recommended: **Cloudflare Pages** (free,
fast, easy custom domain, auto-HTTPS, auto-deploy on every push).

## Option A — Cloudflare Pages (recommended)

1. Push this folder to a GitHub repo (e.g. `team5805/website`).
2. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** → pick the repo.
3. Build settings:
   - **Framework preset:** Vite (or None)
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
4. Deploy. You'll get a `*.pages.dev` URL to preview.
5. **Custom domain:** Pages project → **Custom domains → Set up a domain →** `smblyrequired.com`
   (and `www.smblyrequired.com`). Cloudflare adds the DNS records automatically if the domain's
   nameservers are on Cloudflare; otherwise add the CNAME it shows you at your DNS provider.

Every `git push` to the main branch now redeploys automatically.

## Option B — Netlify

1. Push to GitHub (or drag-and-drop the `dist/` folder at app.netlify.com/drop).
2. New site from Git → build command `npm run build`, publish directory `dist`.
3. Domain settings → add custom domain `smblyrequired.com` → follow the DNS instructions.

## Option C — GitHub Pages

1. Push to GitHub. In repo Settings → Pages, deploy from a GitHub Action (Vite static).
2. Add `smblyrequired.com` as the custom domain (creates a `CNAME` file).
   Note: `vite.config.js` already uses `base: './'`, so it works from a project subpath too.

## Notes

- `public/_redirects` provides an SPA fallback (used by Netlify/Cloudflare Pages). Harmless elsewhere.
- No environment variables or secrets are required — the site is fully static.
- The Blue Alliance data is baked in at build time (in `src/data/`), so no API key ships to the browser.
- To update content, edit `src/data/*.js` and push — see `README.md`.
