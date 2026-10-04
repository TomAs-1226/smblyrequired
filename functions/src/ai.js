import { db } from './admin.js'
import { OPENAI_API_KEY, aiSettings } from './config.js'
import { teamStatId } from './ids.js'
import { takeToken } from './rateLimit.js'
import { fail, logSafe, readBody, reason, scrub } from './safe.js'
import { matchDocs } from './search.js'
import { asEventKey, asTeamNumber, asText } from './validate.js'

// =============================================================================
// ai — OpenAI, without shipping the key.
//
// This is the function with a bill attached, so it is the one where the caller
// check matters most: a `pending` account is signed in and, without the role
// floor, could spend the team's money on request.
//
// What reaches the model is read here, from Firestore, after the role check, and
// never uploaded by the caller. Members may read all of it themselves (stats,
// entries, knowledge docs are all member-readable in the rules), so reading it
// with the Admin SDK shows the model nothing its asker could not open.
//
// The honesty requirement.
//
// Alliance selection happens on eight minutes of notice with these summaries
// open. A model that smooths "two matches, one of which the robot was dead for"
// into confident prose is worse than no summary at all, because a student will
// read it aloud to a drive team who will believe it. Every prompt below is built
// around forcing the model to state its sample size and to refuse to extrapolate
// past it. If you edit these prompts, keep that property.
// =============================================================================

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

// A request here is a handful of scalars, so there is no legitimate reason for a
// large body.
const MAX_BODY_BYTES = 8_000

// Output cap and temperature per task. max_completion_tokens rather than
// max_tokens: the latter is deprecated in Chat Completions.
const TASKS = {
  scouting_summary: { maxOut: 500, temperature: 0.2 },
  picklist_help: { maxOut: 900, temperature: 0.2, reasoning: true },
  kb_answer: { maxOut: 700, temperature: 0.1 },
  form_suggest: { maxOut: 1200, temperature: 0.4 },
  summarise_notes: { maxOut: 350, temperature: 0.2 },
}

// Row caps. Feeding a whole event's raw entries to the model is both expensive
// and counterproductive: it buries the aggregate the reader actually wants.
const MAX_ENTRIES = 40
const MAX_NOTES = 60
const MAX_KB_DOCS = 6
const MAX_KB_CHARS_PER_DOC = 2_500
const MAX_PICKLIST_TEAMS = 60

// How far back to look for notes, and how much of the knowledge base to search.
// Both are bounds on a read, not on the result.
const NOTES_SCAN = 400
const KB_SCAN = 500

async function complete(task, system, user, deps, { json = false } = {}) {
  if (!deps.key) return { error: 'OPENAI_API_KEY is not configured on the server.', status: 500 }

  const cfg = TASKS[task]
  const model = cfg.reasoning ? deps.reasoningModel : deps.model
  // The GPT-5 family dropped the `temperature` parameter: sending it, at any
  // value, is a 400. Only gpt-4 and gpt-3.5 still accept it, so it goes out only
  // for those. That is correct rather than merely tolerated: these are
  // restate-the-numbers tasks, and the honesty prompt, not the sampler, is what
  // keeps them tight.
  const acceptsTemperature = /gpt-4|gpt-3/i.test(model)

  let res
  try {
    res = await deps.fetch(OPENAI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${deps.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        ...(acceptsTemperature ? { temperature: cfg.temperature } : {}),
        max_completion_tokens: cfg.maxOut,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    })
  } catch (err) {
    return { error: `Could not reach the model: ${reason(err)}`, status: 502 }
  }

  if (!res.ok) {
    // OpenAI's 401 body quotes back a masked copy of the key it was given, and
    // other errors can echo request content. None of it is forwarded: the status
    // is enough for a student, and the detail is in the scrubbed log.
    const detail = scrub(await res.text().catch(() => ''))
    logSafe('[ai]', task, 'openai ->', String(res.status), detail.slice(0, 300))
    if (res.status === 401) return { error: 'The AI service rejected our API key.', status: 502 }
    if (res.status === 429) {
      return { error: 'The AI service is rate limiting us. Try again in a minute.', status: 429 }
    }
    return { error: `The AI service returned ${res.status}.`, status: 502 }
  }

  const payload = await res.json().catch(() => null)
  const text = payload?.choices?.[0]?.message?.content
  if (typeof text !== 'string' || !text.trim()) {
    return { error: 'The model returned an empty response.', status: 502 }
  }
  return { text, usage: payload?.usage ?? {}, model: payload?.model ?? model }
}

const round = (n, places = 1) => (n == null || Number.isNaN(Number(n)) ? null : Number(Number(n).toFixed(places)))

// A shared preamble rather than five copies, because the honesty rules are the
// part that must not drift between tasks.
const HONESTY = `
You are a scouting analyst for FRC Team 5805. You write for high-school students
making alliance-selection decisions under time pressure.

Non-negotiable rules:
- Cite the actual numbers you were given. Never round a claim up into a vibe.
- State the sample size in the first sentence whenever it is small. "Only 2
  matches scouted" is the most important thing on the page, not a footnote.
- If the data does not support a conclusion, say that plainly. "Not enough data
  to say" is a correct and useful answer; a confident guess is not.
- Never invent a statistic, a match, or an event that is not in the input.
- Scouting data is subjective and sparse. Distinguish what was observed from
  what you are inferring, and label inferences as inferences.
- Be brief. Students are reading this between matches.
`.trim()

// -----------------------------------------------------------------------------
// Tasks
// -----------------------------------------------------------------------------

async function scoutingSummary(p, deps) {
  const teamNumber = asTeamNumber(p.teamNumber)
  const eventKey = asEventKey(p.eventKey)
  if (!teamNumber) throw fail('teamNumber must be a positive integer.')
  if (!eventKey) throw fail('eventKey must look like 2026casd.')

  const statsSnap = await db.doc(`team_event_stats/${teamStatId(eventKey, teamNumber)}`).get()
  const stats = statsSnap.exists ? statsSnap.data() : null

  const entriesSnap = await db
    .collection('scout_entries')
    .where('event_key', '==', eventKey)
    .where('team_number', '==', teamNumber)
    .where('kind', '==', 'match')
    .orderBy('recorded_at', 'desc')
    .limit(MAX_ENTRIES)
    .get()
  const entries = entriesSnap.docs.map((d) => d.data())

  // No data means no model call. Spending a token to have the model phrase
  // "nobody has scouted this team" is both wasteful and an invitation for it to
  // fill the silence with something plausible.
  if (!entries.length) {
    return {
      task: 'scouting_summary',
      team_number: teamNumber,
      event_key: eventKey,
      matches_scouted: 0,
      summary: `No scouting entries have been recorded for team ${teamNumber} at ${eventKey} yet. There is nothing to summarise — treat this team as unknown, not as weak.`,
      model: null,
      usage: null,
    }
  }

  const context = {
    team_number: teamNumber,
    event_key: eventKey,
    matches_scouted: stats?.matches_scouted ?? entries.length,
    scouts_contributing: stats?.scouts_contributing ?? null,
    avg_score: round(stats?.avg_score),
    score_stddev: round(stats?.score_stddev),
    min_score: round(stats?.min_score),
    max_score: round(stats?.max_score),
    breakdowns: stats?.breakdowns ?? null,
    no_shows: stats?.no_shows ?? null,
    entries: entries.map((e) => ({
      match: e.match_key ?? e.comp_level,
      alliance: e.alliance,
      data: e.data,
      notes: e.notes ?? null,
    })),
  }

  const result = await complete(
    'scouting_summary',
    `${HONESTY}

Summarise one team's performance at one event. Structure: one line on sample
size and overall read, then what they do well, then concerns, then a one-line
verdict for a picklist. Mention consistency explicitly when a standard
deviation is present — a team that always scores 5 is usually a better partner
than one alternating 0 and 10, and the spread is the only place that shows up.
Breakdowns and no-shows outrank average score; say so if they are non-zero.`,
    JSON.stringify(context),
    deps
  )
  if ('error' in result) throw fail(result.error, result.status)

  return {
    task: 'scouting_summary',
    team_number: teamNumber,
    event_key: eventKey,
    matches_scouted: context.matches_scouted,
    summary: result.text,
    model: result.model,
    usage: result.usage,
  }
}

async function picklistHelp(p, deps) {
  const eventKey = asEventKey(p.eventKey)
  if (!eventKey) throw fail('eventKey must look like 2026casd.')

  const asked = Math.floor(Number(p.limit ?? 30)) || 30
  const limit = Math.min(Math.max(asked, 1), MAX_PICKLIST_TEAMS)
  const question = asText(p.question, 500) // optional: "who complements our cycle speed?"

  // Best average first; a team with no scored match (avg_score null) sorts last.
  const snap = await db
    .collection('team_event_stats')
    .where('event_key', '==', eventKey)
    .orderBy('avg_score', 'desc')
    .limit(limit)
    .get()
  const stats = snap.docs.map((d) => d.data())

  if (!stats.length) {
    return {
      task: 'picklist_help',
      event_key: eventKey,
      teams_considered: 0,
      answer: `No scouting data exists for ${eventKey} yet, so there is nothing to rank. Any ordering produced now would be invented.`,
      model: null,
      usage: null,
    }
  }

  // Aggregates only, never raw entries. Thirty teams' worth of raw rows would
  // blow the context window and bury the comparison in noise.
  const context = {
    event_key: eventKey,
    teams: stats.map((s) => ({
      team_number: s.team_number,
      matches_scouted: s.matches_scouted,
      avg_score: round(s.avg_score),
      score_stddev: round(s.score_stddev),
      min_score: round(s.min_score),
      max_score: round(s.max_score),
      breakdowns: s.breakdowns,
      no_shows: s.no_shows,
    })),
    question: question ?? null,
  }

  const result = await complete(
    'picklist_help',
    `${HONESTY}

Compare the teams supplied and propose a ranking for alliance selection.

Additional rules for this task:
- A team with 2 matches scouted and a high average is NOT ranked above a team
  with 12 matches and a slightly lower one. Say when a ranking is driven by a
  sample too small to trust, and place those teams in a separate "unknown, needs
  eyes on" group rather than pretending to rank them.
- Reliability beats peak. Breakdowns and no-shows are disqualifying signals and
  must be called out by name.
- Give a short reason per team, referencing its actual numbers.
- End with what you would go and watch to resolve the biggest uncertainty.`,
    JSON.stringify(context),
    deps
  )
  if ('error' in result) throw fail(result.error, result.status)

  return {
    task: 'picklist_help',
    event_key: eventKey,
    teams_considered: stats.length,
    answer: result.text,
    model: result.model,
    usage: result.usage,
  }
}

async function kbAnswer(p, deps) {
  const question = asText(p.question, 1_000)
  if (!question) throw fail('question is required (1–1000 characters).')

  // Retrieval, not wholesale. The knowledge base is the team's operational
  // memory and it grows without bound; sending all of it every time would be
  // expensive, would outgrow the context window within a season, and would send
  // documents the answer never needed to a third party.
  const snap = await db
    .collection('knowledge_docs')
    .select('slug', 'title', 'category', 'body_md', 'updated_at')
    .limit(KB_SCAN)
    .get()
  const docs = matchDocs(
    snap.docs.map((d) => d.data()),
    question,
    MAX_KB_DOCS
  )

  // Nothing matched: answer that, do not ask a model to. An invented answer
  // citing a doc that does not exist is worse than "nobody has written this down
  // yet", which at least tells a student what to do next.
  if (!docs.length) {
    return {
      task: 'kb_answer',
      question,
      answer:
        'Nothing in the knowledge base matches that question. It has not been written down yet — worth adding a doc once you find the answer.',
      citations: [],
      model: null,
      usage: null,
    }
  }

  const context = docs.map((d) => {
    const body = String(d.body_md ?? '')
    return {
      slug: d.slug,
      title: d.title,
      category: d.category ?? null,
      // Truncated per document so one long runbook cannot crowd out five shorter
      // relevant docs. Marked, so the model can say the excerpt was cut off
      // rather than assume the document ends there.
      body: body.length > MAX_KB_CHARS_PER_DOC ? `${body.slice(0, MAX_KB_CHARS_PER_DOC)}\n…[excerpt truncated]` : body,
    }
  })

  const result = await complete(
    'kb_answer',
    `${HONESTY}

Answer the question using ONLY the documents supplied. They are the team's own
knowledge base.

- Cite the doc slug inline for every claim, like [setup-portal].
- If the documents do not answer the question, say exactly that and name what is
  missing. Do not fall back on general FRC knowledge and present it as ours —
  our conventions are frequently not the common ones.
- If two documents disagree, say so and cite both rather than picking one.
- End with a "Sources:" line listing the slugs you actually used.`,
    JSON.stringify({ question, documents: context }),
    deps
  )
  if ('error' in result) throw fail(result.error, result.status)

  return {
    task: 'kb_answer',
    question,
    answer: result.text,
    // The slugs that were available. Which ones the model leaned on are named in
    // its own Sources line; this list is what the portal links.
    citations: docs.map((d) => ({ slug: d.slug, title: d.title })),
    model: result.model,
    usage: result.usage,
  }
}

// The same checks validateFields in src/lib/scoutingApi.js makes before a form
// is saved. Duplicated deliberately: a draft that would be refused on save
// wastes a mentor's time discovering it. Anything invalid is dropped here and
// reported, so what comes back is known to be storable.
const ALLOWED_FIELD_TYPES = [
  'counter',
  'number',
  'text',
  'textarea',
  'select',
  'multiselect',
  'boolean',
  'rating',
  'timer',
  'heading',
]

export function validateFields(raw) {
  const fields = []
  const rejected = []
  const seen = new Set()

  if (!Array.isArray(raw)) return { fields, rejected: ['model did not return an array of fields'] }

  for (const field of raw) {
    if (!field || typeof field !== 'object') {
      rejected.push('a field was not an object')
      continue
    }
    const key = String(field.key ?? '')
    const type = String(field.type ?? '')

    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      rejected.push(`key "${key || '(missing)'}" is not lower_snake_case`)
      continue
    }
    if (seen.has(key)) {
      rejected.push(`duplicate key "${key}"`)
      continue
    }
    if (!ALLOWED_FIELD_TYPES.includes(type)) {
      rejected.push(`field "${key}" has unsupported type "${type || '(missing)'}"`)
      continue
    }
    if (type !== 'heading' && !String(field.label ?? '').trim()) {
      rejected.push(`field "${key}" has no label`)
      continue
    }
    if ((type === 'select' || type === 'multiselect') && (!Array.isArray(field.options) || field.options.length === 0)) {
      rejected.push(`field "${key}" is a ${type} but has no options`)
      continue
    }
    seen.add(key)
    fields.push(field)
  }
  return { fields, rejected }
}

async function formSuggest(p, deps) {
  const season = Number(p.season)
  if (!Number.isInteger(season) || season < 2000 || season > 2100) {
    throw fail('season must be a year between 2000 and 2100.')
  }
  const game = asText(p.game, 4_000)
  if (!game) throw fail("game is required — describe the season's game (1–4000 characters).")
  const kind = ['match', 'pit', 'strategy'].includes(String(p.kind)) ? String(p.kind) : 'match'

  const result = await complete(
    'form_suggest',
    `You design scouting forms for FRC Team 5805.

Return JSON only, shaped exactly:
{"name": "...", "description": "...", "fields": [ ... ]}

Each field is an object:
  key      required, lower_snake_case, unique, matches ^[a-z][a-z0-9_]*$
  label    required unless type is "heading"
  type     one of: ${ALLOWED_FIELD_TYPES.join(', ')}
  section  optional, groups fields onto one screen
  required optional boolean
  min/max  optional, for number/counter/rating
  options  required non-empty array for select/multiselect
  help     optional one-line hint

Design rules that come from using these on a phone in a loud arena:
- A scout has ~15 seconds between actions. Prefer counter and boolean over text.
- Order fields in the order the match happens; group with "section".
- Include a "total_score" number or counter if the game has a scoring total —
  the team_event_stats aggregate reads that exact key.
- Include boolean fields keyed "broke" and "no_show"; the aggregate reads those
  keys by name too.
- One free-text "notes"-style field at most. Free text does not aggregate.
- Keep it under 25 fields. A form nobody finishes produces no data.`,
    JSON.stringify({ season, kind, game }),
    deps,
    { json: true }
  )
  if ('error' in result) throw fail(result.error, result.status)

  let parsed
  try {
    parsed = JSON.parse(result.text)
  } catch {
    throw fail('The model returned something that was not valid JSON.', 502)
  }

  const { fields, rejected } = validateFields(parsed?.fields)

  // Returned as a draft and written nowhere. Only one form may be active per
  // season and kind: an auto-created or auto-activated form could displace the
  // one students are submitting against mid-event, and split a season's data
  // across two incompatible forms. A human reviews this and saves it through
  // the portal.
  return {
    task: 'form_suggest',
    draft: {
      season,
      kind,
      name: String(parsed?.name ?? `${season} ${kind} scouting`),
      description: String(parsed?.description ?? ''),
      fields,
      is_active: false,
    },
    rejected_fields: rejected,
    note: 'This is a draft. Review and edit it before saving, and activate it deliberately — activating replaces the current form for this season and kind.',
    model: result.model,
    usage: result.usage,
  }
}

async function summariseNotes(p, deps) {
  const teamNumber = asTeamNumber(p.teamNumber)
  if (!teamNumber) throw fail('teamNumber must be a positive integer.')
  const eventKey = p.eventKey == null ? null : asEventKey(p.eventKey)
  if (p.eventKey != null && !eventKey) throw fail('eventKey must look like 2026casd.')

  // Read from the database rather than accepted in the request: it keeps the
  // request small, and nobody can feed the model notes that were never written.
  // The newest entries are read and the ones without a note dropped here; asking
  // Firestore for "notes is not null" would need an index for that alone.
  let q = db.collection('scout_entries')
  if (eventKey) q = q.where('event_key', '==', eventKey)
  const snap = await q.where('team_number', '==', teamNumber).orderBy('recorded_at', 'desc').limit(NOTES_SCAN).get()

  const notes = snap.docs
    .map((d) => String(d.get('notes') ?? '').trim())
    .filter(Boolean)
    .slice(0, MAX_NOTES)

  if (!notes.length) {
    return {
      task: 'summarise_notes',
      team_number: teamNumber,
      event_key: eventKey,
      note_count: 0,
      summary: `No scout has written a note about team ${teamNumber}${eventKey ? ` at ${eventKey}` : ''}.`,
      model: null,
      usage: null,
    }
  }

  const result = await complete(
    'summarise_notes',
    `${HONESTY}

Condense these free-text notes from different scouts about one team into a
single short paragraph.

- Say how many notes there were.
- Where scouts contradict each other, report the disagreement rather than
  averaging it away — two scouts disagreeing about whether the intake jams is
  itself the finding.
- Keep concrete, checkable observations. Drop opinion with nothing behind it.`,
    JSON.stringify({ team_number: teamNumber, event_key: eventKey, note_count: notes.length, notes }),
    deps
  )
  if ('error' in result) throw fail(result.error, result.status)

  return {
    task: 'summarise_notes',
    team_number: teamNumber,
    event_key: eventKey,
    note_count: notes.length,
    summary: result.text,
    model: result.model,
    usage: result.usage,
  }
}

// -----------------------------------------------------------------------------

/**
 * The callable's body, after the role check. `deps` lets the tests stand in for
 * OpenAI; in production it is the real fetch, key and models.
 */
export async function handleAi(uid, data, deps = {}) {
  const settings = aiSettings()
  const rateMax = deps.rateMax ?? settings.rateMax
  const rateWindow = deps.rateWindowSeconds ?? settings.rateWindowSeconds

  // Before anything else, a malformed request included: every call counts.
  if (!(await takeToken(uid, 'ai', rateMax, rateWindow))) {
    throw fail(
      `Too many AI requests. Wait a few minutes — the limit is about ${rateMax} every ${Math.round(rateWindow / 60)} minutes.`,
      429
    )
  }

  const { task, ...params } = readBody(data, MAX_BODY_BYTES)

  const model = deps.model ?? settings.model
  const d = {
    fetch: deps.fetch ?? globalThis.fetch,
    // Read only when a model is actually about to be called: most refusals and
    // every "nothing to summarise" answer never need the key at all.
    get key() {
      return deps.key ?? OPENAI_API_KEY.value()
    },
    model,
    reasoningModel: deps.reasoningModel ?? (deps.model ? model : settings.reasoningModel),
  }

  switch (task) {
    case 'scouting_summary':
      return scoutingSummary(params, d)
    case 'picklist_help':
      return picklistHelp(params, d)
    case 'kb_answer':
      return kbAnswer(params, d)
    case 'form_suggest':
      return formSuggest(params, d)
    case 'summarise_notes':
      return summariseNotes(params, d)
    default:
      throw fail('Unknown task. Expected one of: scouting_summary, picklist_help, kb_answer, form_suggest, summarise_notes.')
  }
}
