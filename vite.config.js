import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base: './' keeps asset paths relative so the production build works from any
// host or sub-folder (GitHub Pages project sites, Netlify, opened from disk).
export default defineConfig({
  plugins: [react()],
  base: './',
})
