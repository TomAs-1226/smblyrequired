# Deploying / updating the Team 5805 site

## ✅ Live now

- **Site:** https://tomas-1226.github.io/smblyrequired/
- **Repo:** https://github.com/TomAs-1226/smblyrequired
- **Host:** GitHub Pages, served from the `gh-pages` branch.

## Update the live site (one command)

```bash
npm run deploy
```

That runs `vite build` and pushes `dist/` to the `gh-pages` branch — GitHub Pages
redeploys in ~30–60s. (Source code lives on `main`; the built site lives on `gh-pages`.)

To change content first, edit `src/data/*.js`, then `npm run deploy` (see `README.md`).

## Putting it on the custom domain `frc5805.com`

The site is ready for the domain — this is the only step that needs your DNS provider
(only the domain owner can change DNS). At your registrar / DNS host, add:

| Type  | Name  | Value                 |
|-------|-------|-----------------------|
| A     | `@`   | `185.199.108.153`     |
| A     | `@`   | `185.199.109.153`     |
| A     | `@`   | `185.199.110.153`     |
| A     | `@`   | `185.199.111.153`     |
| CNAME | `www` | `tomas-1226.github.io`|

(On Cloudflare use the same records with proxy **off / DNS only**.)

Then enable the custom domain (either tell Claude to do it, or run):

```bash
# add the CNAME file so Pages serves the domain, and set it in repo settings
echo "frc5805.com" > public/CNAME && npm run deploy
gh api -X PUT repos/TomAs-1226/smblyrequired/pages -f cname=frc5805.com -F https_enforced=true
```

GitHub provisions HTTPS automatically once DNS resolves. After this, the `github.io`
URL redirects to `frc5805.com`.

## Notes

- `vite.config.js` uses `base: './'` (relative), so the build works at the Pages
  subpath **and** at the apex domain with no changes.
- Hash routing means no server rewrites are needed. `public/_redirects` is a harmless
  SPA fallback for Netlify/Cloudflare if you ever switch hosts.
- The Blue Alliance data is baked in at build time — no API key ships to the browser.
