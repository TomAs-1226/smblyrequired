import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base: './' keeps asset paths relative so the production build works from any
// host or sub-folder (GitHub Pages project sites, Netlify, opened from disk).
export default defineConfig({
  plugins: [react()],
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
