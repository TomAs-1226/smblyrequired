// =============================================================================
// Reading the `picklist_help` answer.
//
// IMPORTANT, because it constrains everything below: the `ai` edge function
// returns PROSE, not structured tiers. Its response is
//
//   { task, event_key, teams_considered, answer, model, usage }
//
// where `answer` is free text written for a student to read. There is no
// machine-readable ranking in it and this file does not pretend otherwise.
//
// So the split is:
//
//   * The answer is rendered VERBATIM, always, unparsed. The edge function is
//     prompted to lead with sample size and to refuse to rank teams it does not
//     have the matches to rank, and that disclosure is the most valuable thing
//     on the screen. Summarising it here would delete exactly the part that was
//     hardest to get the model to produce.
//
//   * On top of that, a best-effort extraction turns "team N appears under a
//     heading that maps to tier T" into an OFFER. Each offer carries the source
//     line it came from, so a human accepts a suggestion having read the actual
//     sentence rather than trusting this parser.
//
// The parser is heuristic and is allowed to find nothing. A missed suggestion
// costs a drag; an invented one puts a team in a tier no model ever proposed
// and no human ever chose. Every rule below is biased toward finding nothing.
// =============================================================================

// Words a heading uses when the model is doing what it was told: quarantining
// teams it cannot rank rather than ranking them anyway.
const UNRANKED_HINTS =
  /\b(unknown|unranked|needs? eyes|not enough|insufficient|too few|do not rank|don't rank|no data|unscouted)\b/

/** Strip markdown furniture so headings compare cleanly. */
function normalise(line) {
  return line
    .replace(/[*_`#>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Does this line read as a section heading rather than a team?
 *
 * Deliberately narrow. Anything that is not obviously a heading is treated as
 * body text, which at worst means a team keeps the previous heading's tier —
 * and a suggestion attached to the wrong tier is still shown next to its source
 * line, where a human will catch it.
 */
function isHeading(raw) {
  const line = raw.trim()
  if (!line) return false
  if (/^#{1,6}\s/.test(line)) return true
  // A whole line in bold, e.g. "**Tier 1 — first pick**".
  if (/^\*\*[^*]+\*\*:?$/.test(line)) return true
  // "Tier 2:" / "Group B —" / "S tier"
  if (/^[-*\s]*(tier|group|bucket|band)\b/i.test(line)) return true
  if (/^[^.]{0,60}:$/.test(line) && !/\d{2,}/.test(line)) return true
  return false
}

/**
 * Map a heading to one of the list's own tier keys.
 *
 * The tiers come from `picklists.tiers`, which every team renames — so nothing
 * is hardcoded to S/A/B/C. Three ways in, most specific first, and `null` when
 * none of them is convincing.
 */
function tierFromHeading(heading, tiers) {
  const text = normalise(heading)
  if (!text) return null

  const unrankedTier =
    tiers.find((t) => t.key === 'unranked') ??
    tiers.find((t) => UNRANKED_HINTS.test(normalise(t.label ?? ''))) ??
    null
  if (UNRANKED_HINTS.test(text) && unrankedTier) {
    return { key: unrankedTier.key, basis: 'named' }
  }

  // 1. The tier's own label, or its key as a standalone token. `\bs\b` is why
  //    this runs on normalised text — "S — first pick" and "s tier" both hit.
  for (const tier of tiers) {
    const label = normalise(tier.label ?? '')
    const key = normalise(tier.key ?? '')
    if (label && label.length > 1 && text.includes(label)) return { key: tier.key, basis: 'named' }
    if (key && new RegExp(`(^|[^a-z0-9])${escapeRe(key)}([^a-z0-9]|$)`).test(text)) {
      return { key: tier.key, basis: 'named' }
    }
  }

  // 2. "Tier 1" / "Group 2" — positional, so it depends on the tier order in
  //    the list matching the model's ordering. Reported as a weaker basis so the
  //    UI can say so rather than presenting it with the same confidence.
  const ordinal = text.match(/\b(?:tier|group|bucket|band)\s*(\d{1,2})\b/)
  if (ordinal) {
    const idx = Number(ordinal[1]) - 1
    if (idx >= 0 && idx < tiers.length) return { key: tiers[idx].key, basis: 'ordinal' }
  }

  return null
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Pull the team this line is about.
 *
 * The load-bearing filter is `roster`: only numbers that are actually teams at
 * this event count. Without it, "12 matches, avg 45.2" offers up three
 * candidate team numbers per line and the parser confidently mis-attributes
 * reasoning to whichever it saw first. Team 12 and team 45 exist, so a bare
 * number-shaped-like-a-team test is not enough — membership in the event roster
 * is the only check that actually discriminates.
 */
function teamFromLine(line, roster) {
  const explicit = line.match(/\bteams?\s*#?\s*(\d{1,5})\b/i)
  if (explicit && roster.has(Number(explicit[1]))) return Number(explicit[1])

  // Otherwise the first roster number on the line. The model writes
  // "1678 (12 matches …)", so the subject comes before its statistics.
  for (const match of line.matchAll(/\b(\d{1,5})\b/g)) {
    const n = Number(match[1])
    if (roster.has(n)) return n
  }
  return null
}

/**
 * Parse `answer` into per-team offers.
 *
 * @param answer  the model's text, exactly as returned
 * @param tiers   `picklists.tiers`
 * @param roster  Set of team numbers at this event
 * @returns [{ teamNumber, tier, basis, excerpt }] — first mention of each team
 *          wins, because models restate teams in a closing "what to watch"
 *          paragraph and that restatement carries no tier.
 */
export function parseProposal(answer, tiers, roster) {
  if (typeof answer !== 'string' || !answer.trim()) return []
  if (!Array.isArray(tiers) || !tiers.length) return []

  const offers = []
  const seen = new Set()
  let currentTier = null

  for (const raw of answer.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue

    if (isHeading(line)) {
      const hit = tierFromHeading(line, tiers)
      // An unrecognised heading CLEARS the tier rather than leaving the previous
      // one in force. Text under "What I would go and watch" is not a ranking,
      // and letting the last real tier leak into it is how a closing paragraph
      // turns into four bogus suggestions.
      currentTier = hit ?? null
      continue
    }

    if (!currentTier) continue

    const teamNumber = teamFromLine(line, roster)
    if (teamNumber == null || seen.has(teamNumber)) continue

    seen.add(teamNumber)
    offers.push({
      teamNumber,
      tier: currentTier.key,
      basis: currentTier.basis,
      // Kept verbatim, markdown and all. It is shown next to the accept button
      // so the decision is made against the model's sentence, not this parse.
      excerpt: line.replace(/^[-*•]\s*/, ''),
    })
  }

  return offers
}
