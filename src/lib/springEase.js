// Spring easing for GSAP, from the same constants as the CSS `--spring-*` tokens.
//
// The site has two motion engines: CSS transitions (state changes) and GSAP
// (scroll-driven reveals). Before this, they used different curves — CSS used
// expo-out, GSAP used `ease: 'expo.out'`, and the two only looked alike by
// coincidence. Anything retuned in one silently diverged from the other.
//
// This evaluates the real spring, so a token in index.css and a tween in a
// component can be driven by one pair of numbers.
//
// The physics (Detent, matching Apple's duration/bounce model):
//   mass 1, stiffness = (2pi/d)^2, damping = 4pi(1 - b)/d   for bounce b >= 0
// `duration` is PERCEPTUAL — the undamped period — not the settling time.
// Settling takes longer and grows with bounce, which is why `settle()` below
// returns the number GSAP should actually be given as its tween duration.

const TAU = Math.PI * 2

// Normalised spring position at time t: 0 at t=0, approaching 1.
function position(t, omega0, zeta) {
  if (zeta < 1) {
    // Underdamped — overshoots, then rings down.
    const omegaD = omega0 * Math.sqrt(1 - zeta * zeta)
    return (
      1 -
      Math.exp(-zeta * omega0 * t) *
        (Math.cos(omegaD * t) + ((zeta * omega0) / omegaD) * Math.sin(omegaD * t))
    )
  }
  // Critically damped (zeta === 1). Overdamped springs are not reachable from
  // duration/bounce with b >= 0, so they are not handled.
  return 1 - Math.exp(-omega0 * t) * (1 + omega0 * t)
}

// When the spring is within `epsilon` of rest and stays there. Sampled rather
// than solved: the analytic bound is loose for low bounce and would hand GSAP a
// tween far longer than the motion, delaying anything sequenced after it.
function settle(omega0, zeta, epsilon = 0.001, max = 4) {
  const step = 1 / 240
  let last = 0
  for (let t = 0; t <= max; t += step) {
    if (Math.abs(position(t, omega0, zeta) - 1) > epsilon) last = t
  }
  return Math.min(max, last + step)
}

/**
 * Build a GSAP-compatible ease from a spring.
 *
 * GSAP eases take progress in [0,1] and return eased progress, so real time is
 * recovered as `p * duration` — which only lines up if the tween runs for
 * exactly the returned `duration`. Spread the result into the tween vars:
 *
 *   gsap.fromTo(el, { y: 40 }, { y: 0, ...springEase({ duration: 0.5 }) })
 *
 * @param {object}  spec
 * @param {number}  spec.duration  Perceptual duration in seconds (Apple's `d`).
 * @param {number}  spec.bounce    0 = no overshoot; keep <= 0.3 for UI.
 * @returns {{ ease: (p: number) => number, duration: number }}
 */
export function springEase({ duration = 0.5, bounce = 0 } = {}) {
  const stiffness = (TAU / duration) ** 2
  const damping = (4 * Math.PI * (1 - bounce)) / duration
  const omega0 = Math.sqrt(stiffness)
  const zeta = damping / (2 * Math.sqrt(stiffness))
  const total = settle(omega0, zeta)

  return {
    duration: total,
    // Normalised so ease(1) is exactly 1. Sampling leaves the spring a hair
    // short of rest at `total`, and GSAP snaps that residue on the final frame
    // — which is visible as a 1px jump on a long translate.
    ease: (p) => position(p * total, omega0, zeta) / position(total, omega0, zeta),
  }
}

// The named springs. These mirror the `--spring-*` tokens in index.css; change
// one and change the other.
export const SPRINGS = {
  // apple-swiftui-smooth — duration 0.5, bounce 0. Scroll reveals.
  reveal: { duration: 0.5, bounce: 0 },
  // Our tuning on Apple's .snappy shape. Things that appear.
  pop: { duration: 0.35, bounce: 0.15 },
  // apple-wwdc18-drawer-settle — response 0.4, damping 1.0.
  drawer: { duration: 0.4, bounce: 0 },
}
