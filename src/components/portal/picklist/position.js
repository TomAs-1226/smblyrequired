// =============================================================================
// Sparse ordering for pick list entries.
//
// `picklist_entries.position` is a `numeric` spaced 10, 20, 30 … (migration
// 0006). The spacing is not decoration: it is what makes a drag ONE row update
// instead of a renumber of everything below the drop point.
//
// The scenario this is built for is the one where it matters. Alliance
// selection, eight minutes, a tablet on a venue wifi that is already carrying
// four thousand phones. A renumber-everything scheme turns a single drag into
// thirty writes over exactly that network — and if the fifteenth one fails, the
// list is now in a state nobody authored. Bisecting between the two neighbours
// touches one row, so a drag either lands or it does not.
//
// Re-spacing is the escape hatch, not the mechanism. It runs only when the gap
// between two neighbours has been bisected so many times that halving it again
// stops being meaningful, and it rewrites one tier rather than the whole list.
//
// Everything here is pure — no React, no network — because this is the part
// that has to be right.
// =============================================================================

/** Spacing for a freshly numbered tier, and the step used past either end. */
export const STEP = 10

// The floor for bisection. Positions survive a round trip through JSON as IEEE
// doubles, so the real limit is ~50 halvings of a gap of 10; stopping at 1e-4
// (about 17 consecutive drops into the SAME slot) leaves an enormous margin and
// keeps stored values short enough to read in a database client during a
// post-mortem. Re-spacing early is cheap; re-spacing late is a rounding bug
// that reorders someone's list silently.
export const MIN_GAP = 1e-4

/**
 * Deterministic order for a tier.
 *
 * Ties are broken by team number rather than left to sort stability, because
 * two clients that disagree about the order of two equal positions would show
 * two different lists to two people arguing about the same board. Duplicate
 * positions are not hypothetical: they are what a concurrent edit produces.
 */
export function byPosition(a, b) {
  const d = Number(a.position) - Number(b.position)
  if (d !== 0 && Number.isFinite(d)) return d
  return a.team_number - b.team_number
}

export function sortEntries(entries) {
  return [...entries].sort(byPosition)
}

/**
 * The position a card should take when dropped at `index`.
 *
 * `siblings` is the destination tier, already sorted, with the moving card
 * REMOVED — the caller has to do that, because an index computed against a list
 * that still contains the card being dragged is off by one for every drop below
 * its old slot, and that off-by-one only shows up as "it lands one place too
 * high sometimes", which is miserable to debug at a competition.
 *
 * Returns `{ position }` for the one-row case, or `{ respace: true }` when the
 * neighbours are too close together to bisect and the tier needs renumbering.
 */
export function positionForDrop(siblings, index) {
  const before = index > 0 ? siblings[index - 1] : null
  const after = index < siblings.length ? siblings[index] : null

  // Empty tier. Start at STEP rather than 0 so there is room to drop something
  // above this card later without going negative on the very first move.
  if (!before && !after) return { position: STEP, respace: false }

  // Off the top. Negative positions are legal (the column has no lower bound)
  // and sort correctly, so dropping repeatedly at the top just walks downward
  // through the number line instead of forcing a renumber every time.
  if (!before) return { position: Number(after.position) - STEP, respace: false }

  // Off the bottom.
  if (!after) return { position: Number(before.position) + STEP, respace: false }

  const lo = Number(before.position)
  const hi = Number(after.position)
  const gap = hi - lo

  // `!(gap > MIN_GAP)` rather than `gap <= MIN_GAP` so NaN lands here too. A NaN
  // position means the data is already damaged; re-spacing repairs it instead of
  // writing a second NaN on top and making it permanent. A gap of 0 (duplicate
  // positions from a concurrent edit) takes the same path and self-heals.
  if (!(gap > MIN_GAP)) return { position: null, respace: true }

  return { position: lo + gap / 2, respace: false }
}

/**
 * Work out what to write for a move, without writing it.
 *
 * Two shapes come back, and the caller sends exactly one request either way:
 *
 *   { respace: false, position }  → UPDATE one row.
 *   { respace: true,  rows }      → renumber this ONE tier, moved card included,
 *                                   in a single batched upsert.
 *
 * The re-space path deliberately places the card as part of the renumber rather
 * than doing "renumber, then move". Two writes is two chances to half-apply,
 * and a half-applied re-space is a tier in an order nobody chose.
 */
export function planMove(siblings, mover, index) {
  const clamped = Math.max(0, Math.min(index, siblings.length))
  const { position, respace } = positionForDrop(siblings, clamped)
  if (!respace) return { respace: false, position }

  const ordered = [...siblings]
  ordered.splice(clamped, 0, mover)
  return { respace: true, rows: renumber(ordered) }
}

/** 10, 20, 30 … over an already-ordered list. */
export function renumber(ordered) {
  return ordered.map((entry, i) => ({ ...entry, position: (i + 1) * STEP }))
}

/**
 * Where does `entryId` currently sit inside its tier, and how long is that tier?
 * Used for the keyboard announcements — a screen reader user gets the same
 * "3rd of 9 in A" the sighted user reads off the board.
 */
export function locate(entries, tier, entryId) {
  const lane = sortEntries(entries.filter((e) => e.tier === tier))
  return { index: lane.findIndex((e) => e.id === entryId), size: lane.length }
}
