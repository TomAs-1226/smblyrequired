// Single source of truth for the OS "reduce motion" preference. GSAP/JS
// animations are gated on this so motion-sensitive visitors land on the final
// state instead of watching it animate.
export function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}
