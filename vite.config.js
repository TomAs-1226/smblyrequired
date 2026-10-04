import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { existsSync, readFileSync } from 'node:fs'
import { join, normalize } from 'node:path'

// A static page under public/ with its own index.html (public/fabworks-discount/)
// is served at its folder URL by GitHub Pages, but Vite's dev and preview servers
// only serve public files by exact name: a folder URL falls through to the app's
// own index.html, so the link opened the home page locally. This serves the
// folder's index.html the way the host does.
function publicDirIndex() {
  const serve = (publicDir) => (req, res, next) => {
    const path = decodeURIComponent((req.url ?? '').split('?')[0])
    if (req.method !== 'GET' || path === '/' || !path.endsWith('/') || path.includes('..')) return next()
    const file = normalize(join(publicDir, path, 'index.html'))
    if (!file.startsWith(normalize(publicDir)) || !existsSync(file)) return next()
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(readFileSync(file))
  }
  return {
    name: 'public-dir-index',
    configureServer(server) {
      server.middlewares.use(serve(server.config.publicDir))
    },
    configurePreviewServer(server) {
      server.middlewares.use(serve(server.config.build.outDir))
    },
  }
}

// base: './' keeps asset paths relative so the production build works from any
// host or sub-folder (GitHub Pages project sites, Netlify, opened from disk).
export default defineConfig({
  plugins: [react(), publicDirIndex()],
  base: './',
  build: {
    rollupOptions: {
      output: {
        // Rollup names an async chunk after its entry module's filename. Several
        // dependencies have a top-level `index.js` — TensorFlow among them — so
        // the default naming produces a second `index-<hash>.js` sitting next to
        // the real entry bundle, at well over a megabyte.
        //
        // That matters because the public bundle size is a thing we actively
        // check before deploying: two `index-*.js` lines in the build output,
        // one of them 1.28 MB, reads as "the public bundle exploded" when in
        // fact it is a lazily-loaded model runtime that no public page fetches.
        // Naming vendor chunks after their package removes the ambiguity.
        chunkFileNames(chunkInfo) {
          const id = chunkInfo.facadeModuleId ?? Object.keys(chunkInfo.modules ?? {})[0] ?? ''
          const m = id.match(/node_modules[\\/](?:(@[^\\/]+)[\\/])?([^\\/]+)/)
          if (m) {
            const pkg = `${m[1] ? `${m[1].replace('@', '')}-` : ''}${m[2]}`
            return `assets/vendor-${pkg.replace(/[^a-z0-9-]/gi, '')}-[hash].js`
          }
          return 'assets/[name]-[hash].js'
        },
      },
    },
  },
})
