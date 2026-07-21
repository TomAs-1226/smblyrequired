// =============================================================================
// ai — OpenAI, without shipping the key.
//
// This is the function with a bill attached, so it is the one where the caller
// check matters most: a `pending` account holds a valid JWT and, without the
// role floor in _shared/auth.ts, could spend the team's money on request. See
// that file for the reasoning; this one just enforces the floor.
//
// Every read below goes through the CALLER'S client, never the service role.
// The ai function never needs to see a row the person asking could not see for
// themselves, so it is built so that it cannot: RLS is doing the same work here
// that it does for the browser.
//
// THE HONESTY REQUIREMENT
//
// Alliance selection happens on eight minutes of notice with these summaries
// open. A model that smooths "two matches, one of which the robot was dead for"
// into confident prose is worse than no summary at all, because a student will
// read it aloud to a drive team who will believe it. Every prompt below is built
// around forcing the model to state its sample size and to refuse to extrapolate
// past it. If you edit these prompts, keep that property.
// =============================================================================

import {
  fail,
  logSafe,
  ok,
  preflight,
  rateLimit,
  readJsonBody,
  requireCaller,
  scrub,
} from '../_shared/auth.ts'
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

// A request here is a handful of scalars. The bulk of what reaches the model is
// fetched server-side from tables the caller can already read — never uploaded
// by the caller — so there is no legitimate reason for a large body, and a cap
// this low removes "paste a novel into the prompt" as a way to run up a bill.
const MAX_BODY_BYTES = 8_000

// Best-effort, per-isolate. Read the limitation note in _shared/auth.ts before
// treating this as a spend control, because it is not one.
const RATE_MAX = Number(Deno.env.get('AI_RATE_MAX') ?? '15')
const RATE_WINDOW_SECONDS = Number(Deno.env.get('AI_RATE_WINDOW_SECONDS') ?? '300')

// Per-task model and output cap.
//
// gpt-4o-mini for the grounded, high-volume work: scouting summaries and note
// condensation are "restate these numbers without embellishing them", which is
// instruction-following rather than reasoning, and they run once per team per
// event — dozens of calls in an afternoon.
//
// gpt-4o for picklist_help alone. Comparing thirty teams on several axes at once
// and explaining the ordering is the one task here that is genuinely reasoning,
// it runs a few times per event rather than dozens, and it is the output that
// most directly moves a pick. That is the trade worth paying for.
//
// max_completion_tokens rather than max_tokens: the latter is deprecated in
// Chat Completions and only still works for non-reasoning models, so using the
// current name is what keeps this from breaking on a future model swap.
const TASKS = {
  scouting_summary: { model: 'gpt-4o-mini', maxOut: 500, temperature: 0.2 },
  picklist_help: { model: 'gpt-4o', maxOut: 900, temperature: 0.2 },
  kb_answer: { model: 'gpt-4o-mini', maxOut: 700, temperature: 0.1 },
  form_suggest: { model: 'gpt-4o-mini', maxOut: 1200, temperature: 0.4 },
  summarise_notes: { model: 'gpt-4o-mini', maxOut: 350, temperature: 0.2 },
} as const

type TaskName = keyof typeof TASKS

// Row caps. Feeding a whole event's raw entries to the model is both expensive
// and counterproductive — it buries the aggregate the reader actually wants.
const MAX_ENTRIES = 40
const MAX_NOTES = 60
const MAX_KB_DOCS = 6
const MAX_KB_CHARS_PER_DOC = 2_500
const MAX_PICKLIST_TEAMS = 60

interface Usage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

interface Completion {
  text: string
  usage: Usage
  model: string
}

async function complete(
  task: TaskName,
  system: string,
  user: string,
  { json = false } = {}
): Promise<Completion | { error: string; status: number }> {
  const key = Deno.env.get('OPENAI_API_KEY')
  if (!key) return { error: 'OPENAI_API_KEY is not configured on the server.', status: 500 }

  const cfg = TASKS[task]
  let res: Response
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        temperature: cfg.temperature,
        max_completion_tokens: cfg.maxOut,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    })
  } catch (err) {
    return { error: `Could not reach the model: ${scrub(err)}`, status: 502 }
  }

  if (!res.ok) {
    // OpenAI's 401 body quotes back a masked copy of the key it was given, and
    // other errors can echo request content. None of it is forwarded — the
    // status is enough for a student, and the detail is in the (scrubbed) log.
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
  return { text, usage: (payload?.usage ?? {}) as Usage, model: payload?.model ?? cfg.model }
}

// --- parameter validation ----------------------------------------------------

function asEventKey(v: unknown): string | null {
  const s = String(v ?? '').trim().toLowerCase()
  return /^\d{4}[a-z0-9]{1,20}$/.test(s) ? s : null
}

function asTeamNumber(v: unknown): number | null {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 && n < 100000 ? n : null
}

function asText(v: unknown, max: number): string | null {
  const s = String(v ?? '').trim()
  return s && s.length <= max ? s : null
}

const round = (n: unknown, places = 1) =>
  n == null || Number.isNaN(Number(n)) ? null : Number(Number(n).toFixed(places))

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

async function scoutingSummary(req: Request, db: SupabaseClient, p: Record<string, unknown>) {
  const teamNumber = asTeamNumber(p.teamNumber)
  const eventKey = asEventKey(p.eventKey)
  if (!teamNumber) return fail(req, 'teamNumber must be a positive integer.')
  if (!eventKey) return fail(req, 'eventKey must look like 2026casd.')

  const { data: stats } = await db
    .from('team_event_stats')
    .select('*')
    .eq('event_key', eventKey)
    .eq('team_number', teamNumber)
    .maybeSingle()

  const { data: entries, error } = await db
    .from('scout_entries')
    .select('match_key, comp_level, alliance, data, notes, recorded_at')
    .eq('event_key', eventKey)
    .eq('team_number', teamNumber)
    .eq('kind', 'match')
    .order('recorded_at', { ascending: false })
    .limit(MAX_ENTRIES)
  if (error) return fail(req, error.message, 400)

  // No data means no model call. Spending a token to have gpt-4o-mini phrase
  // "nobody has scouted this team" is both wasteful and an invitation for it to
  // fill the silence with something plausible.
  if (!entries?.length) {
    return ok(req, {
      task: 'scouting_summary',
      team_number: teamNumber,
      event_key: eventKey,
      matches_scouted: 0,
      summary: `No scouting entries have been recorded for team ${teamNumber} at ${eventKey} yet. There is nothing to summarise — treat this team as unknown, not as weak.`,
      model: null,
      usage: null,
    })
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
    JSON.stringify(context)
  )
  if ('error' in result) return fail(req, result.error, result.status)

  return ok(req, {
    task: 'scouting_summary',
    team_number: teamNumber,
    event_key: eventKey,
    matches_scouted: context.matches_scouted,
    summary: result.text,
    model: result.model,
    usage: result.usage,
  })
}

async function picklistHelp(req: Request, db: SupabaseClient, p: Record<string, unknown>) {
  const eventKey = asEventKey(p.eventKey)
  if (!eventKey) return fail(req, 'eventKey must look like 2026casd.')

  const limit = Math.min(Number(p.limit ?? 30) || 30, MAX_PICKLIST_TEAMS)
  const question = asText(p.question, 500) // optional: "who complements our cycle speed?"

  const { data: stats, error } = await db
    .from('team_event_stats')
    .select('*')
    .eq('event_key', eventKey)
    .order('avg_score', { ascending: false, nullsFirst: false })
    .limit(limit)
  if (error) return fail(req, error.message, 400)

  if (!stats?.length) {
    return ok(req, {
      task: 'picklist_help',
      event_key: eventKey,
      teams_considered: 0,
      answer: `No scouting data exists for ${eventKey} yet, so there is nothing to rank. Any ordering produced now would be invented.`,
      model: null,
      usage: null,
    })
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
    JSON.stringify(context)
  )
  if ('error' in result) return fail(req, result.error, result.status)

  return ok(req, {
    task: 'picklist_help',
    event_key: eventKey,
    teams_considered: stats.length,
    answer: result.text,
    model: result.model,
    usage: result.usage,
  })
}

async function kbAnswer(req: Request, db: SupabaseClient, p: Record<string, unknown>) {
  const question = asText(p.question, 1_000)
  if (!question) return fail(req, 'question is required (1–1000 characters).')

  // Retrieval, not wholesale. The knowledge base is the team's operational
  // memory and it grows without bound; sending all of it every time would be
  // expensive, would exceed the context window within a season, and would send
  // documents the answer never needed to a third party. The `search` tsvector
  // and its GIN index from 0003 exist for exactly this.
  const { data: docs, error } = await db
    .from('knowledge_docs')
    .select('slug, title, category, body_md, updated_at')
    .textSearch('search', question, { type: 'websearch' })
    .limit(MAX_KB_DOCS)
  if (error) return fail(req, error.message, 400)

  // Nothing matched: answer that, do not ask a model to. This is the failure
  // mode the requirement names — an invented answer citing a doc that does not
  // exist is worse than "nobody has written this down yet", which at least
  // tells a student what to do next.
  if (!docs?.length) {
    return ok(req, {
      task: 'kb_answer',
      question,
      answer:
        'Nothing in the knowledge base matches that question. It has not been written down yet — worth adding a doc once you find the answer.',
      citations: [],
      model: null,
      usage: null,
    })
  }

  const context = docs.map((d) => ({
    slug: d.slug,
    title: d.title,
    category: d.category,
    // Truncated per document so one long runbook cannot crowd out five relevant
    // shorter docs. Marked, so the model can say the excerpt was cut off rather
    // than assume the document ends there.
    body:
      d.body_md.length > MAX_KB_CHARS_PER_DOC
        ? `${d.body_md.slice(0, MAX_KB_CHARS_PER_DOC)}\n…[excerpt truncated]`
        : d.body_md,
  }))

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
    JSON.stringify({ question, documents: context })
  )
  if ('error' in result) return fail(req, result.error, result.status)

  return ok(req, {
    task: 'kb_answer',
    question,
    answer: result.text,
    // The slugs that were *available*. Which ones the model actually leaned on
    // are named in its own Sources line; this list is what the portal links.
    citations: docs.map((d) => ({ slug: d.slug, title: d.title })),
    model: result.model,
    usage: result.usage,
  })
}

// Mirrors the validation in public.validate_scout_fields() (migration 0005).
// Duplicated deliberately: the trigger is the real enforcement and stays that
// way, but a draft that would be rejected on save wastes a mentor's time
// discovering it. Anything invalid is dropped here and reported, so what comes
// back is known to be storable.
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

function validateFields(raw: unknown): { fields: unknown[]; rejected: string[] } {
  const fields: unknown[] = []
  const rejected: string[] = []
  const seen = new Set<string>()

  if (!Array.isArray(raw)) return { fields, rejected: ['model did not return an array of fields'] }

  for (const f of raw) {
    if (!f || typeof f !== 'object') {
      rejected.push('a field was not an object')
      continue
    }
    const field = f as Record<string, unknown>
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
    if (
      (type === 'select' || type === 'multiselect') &&
      (!Array.isArray(field.options) || field.options.length === 0)
    ) {
      rejected.push(`field "${key}" is a ${type} but has no options`)
      continue
    }
    seen.add(key)
    fields.push(field)
  }
  return { fields, rejected }
}

async function formSuggest(req: Request, p: Record<string, unknown>) {
  const season = Number(p.season)
  if (!Number.isInteger(season) || season < 2000 || season > 2100) {
    return fail(req, 'season must be a year between 2000 and 2100.')
  }
  const game = asText(p.game, 4_000)
  if (!game) return fail(req, 'game is required — describe the season\'s game (1–4000 characters).')
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
    { json: true }
  )
  if ('error' in result) return fail(req, result.error, result.status)

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(result.text)
  } catch {
    return fail(req, 'The model returned something that was not valid JSON.', 502)
  }

  const { fields, rejected } = validateFields(parsed.fields)

  // Returned as a draft and written nowhere. `scout_forms` has a partial unique
  // index allowing exactly one active form per (season, kind) — an auto-created
  // or auto-activated form could displace the one students are mid-event
  // submitting against, and split a season's data across two incompatible
  // schemas. A human reviews this and saves it through the portal.
  return ok(req, {
    task: 'form_suggest',
    draft: {
      season,
      kind,
      name: String(parsed.name ?? `${season} ${kind} scouting`),
      description: String(parsed.description ?? ''),
      fields,
      is_active: false,
    },
    rejected_fields: rejected,
    note: 'This is a draft. Review and edit it before saving, and activate it deliberately — activating replaces the current form for this season and kind.',
    model: result.model,
    usage: result.usage,
  })
}

async function summariseNotes(req: Request, db: SupabaseClient, p: Record<string, unknown>) {
  const teamNumber = asTeamNumber(p.teamNumber)
  if (!teamNumber) return fail(req, 'teamNumber must be a positive integer.')
  const eventKey = p.eventKey == null ? null : asEventKey(p.eventKey)
  if (p.eventKey != null && !eventKey) return fail(req, 'eventKey must look like 2026casd.')

  // Read from the database rather than accepting notes in the request body: the
  // caller's RLS decides what they may see, and it keeps the request small.
  let q = db
    .from('scout_entries')
    .select('notes, recorded_at, match_key, kind')
    .eq('team_number', teamNumber)
    .not('notes', 'is', null)
    .order('recorded_at', { ascending: false })
    .limit(MAX_NOTES)
  if (eventKey) q = q.eq('event_key', eventKey)

  const { data: rows, error } = await q
  if (error) return fail(req, error.message, 400)

  const notes = (rows ?? []).map((r) => String(r.notes ?? '').trim()).filter(Boolean)
  if (!notes.length) {
    return ok(req, {
      task: 'summarise_notes',
      team_number: teamNumber,
      event_key: eventKey,
      note_count: 0,
      summary: `No scout has written a note about team ${teamNumber}${eventKey ? ` at ${eventKey}` : ''}.`,
      model: null,
      usage: null,
    })
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
    JSON.stringify({ team_number: teamNumber, event_key: eventKey, note_count: notes.length, notes })
  )
  if ('error' in result) return fail(req, result.error, result.status)

  return ok(req, {
    task: 'summarise_notes',
    team_number: teamNumber,
    event_key: eventKey,
    note_count: notes.length,
    summary: result.text,
    model: result.model,
    usage: result.usage,
  })
}

// -----------------------------------------------------------------------------

Deno.serve(async (req) => {
  const pre = preflight(req)
  if (pre) return pre
  if (req.method !== 'POST') return fail(req, 'Use POST.', 405)

  const auth = await requireCaller(req, 'member')
  if (!auth.ok) return auth.response
  const { userId, client } = auth.caller

  if (!rateLimit(`ai:${userId}`, RATE_MAX, RATE_WINDOW_SECONDS)) {
    return fail(
      req,
      `Too many AI requests. Wait a few minutes — the limit is about ${RATE_MAX} every ${Math.round(RATE_WINDOW_SECONDS / 60)} minutes.`,
      429
    )
  }

  const parsed = await readJsonBody(req, MAX_BODY_BYTES)
  if ('error' in parsed) return fail(req, parsed.error, /too large/.test(parsed.error) ? 413 : 400)

  const { task, ...params } = parsed.body as Record<string, unknown>

  try {
    switch (task) {
      case 'scouting_summary':
        return await scoutingSummary(req, client, params)
      case 'picklist_help':
        return await picklistHelp(req, client, params)
      case 'kb_answer':
        return await kbAnswer(req, client, params)
      case 'form_suggest':
        return await formSuggest(req, params)
      case 'summarise_notes':
        return await summariseNotes(req, client, params)
      default:
        return fail(
          req,
          'Unknown task. Expected one of: scouting_summary, picklist_help, kb_answer, form_suggest, summarise_notes.'
        )
    }
  } catch (err) {
    logSafe('[ai] unhandled:', err instanceof Error ? err.message : String(err))
    return fail(req, 'That AI request failed unexpectedly.', 500)
  }
})
