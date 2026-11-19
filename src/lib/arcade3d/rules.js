// The match timeline: which period it is, and whether each hub counts.
// Pure functions of the match clock, so they are tested on their own.
import { MATCH } from './config.js'

/** 'countdown' | 'auto' | 'transition' | 'shift' | 'endgame' | 'over' */
export function periodOf(t) {
  if (t < 0) return 'countdown'
  if (t < MATCH.auto) return 'auto'
  if (t < MATCH.transition) return 'transition'
  if (t < MATCH.endgame) return 'shift'
  if (t < MATCH.total) return 'endgame'
  return 'over'
}

/** 1–4 during the shifts, else 0. */
export function shiftOf(t) {
  if (periodOf(t) !== 'shift') return 0
  let n = 0
  for (const start of MATCH.shifts) if (t >= start) n++
  return n
}

/**
 * Is `team`'s hub scoring at match time t? Both are live in auto, the
 * transition and the endgame. In the shifts they alternate: the alliance that
 * scored more fuel in auto sits out shift 1 (and 3); a tie goes to blue.
 */
export function hubActive(t, team, autoWinner) {
  const s = shiftOf(t)
  if (s === 0) return periodOf(t) !== 'over' && periodOf(t) !== 'countdown'
  const winnerActive = s % 2 === 0
  return team === autoWinner ? winnerActive : !winnerActive
}

/** Seconds until `team`'s hub next changes state (Infinity once it never will). */
export function untilHubChange(t, team, autoWinner) {
  const now = hubActive(t, team, autoWinner)
  const marks = [MATCH.auto, MATCH.transition, ...MATCH.shifts.slice(1), MATCH.endgame, MATCH.total]
  for (const m of marks) {
    if (m > t && hubActive(m + 1e-6, team, autoWinner) !== now) return m - t
  }
  return Infinity
}

export function periodLabel(t) {
  const p = periodOf(t)
  if (p === 'shift') return `Shift ${shiftOf(t)}`
  return { countdown: 'Ready', auto: 'Auto', transition: 'Transition', endgame: 'Endgame', over: 'Final' }[p]
}
