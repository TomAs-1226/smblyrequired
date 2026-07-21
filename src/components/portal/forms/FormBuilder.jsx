import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../../Icon'
import FormRenderer from '../scouting/FormRenderer'
import { activateForm, formEntryCount, saveForm } from '../../../lib/scoutingApi'
import styles from '../Portal.module.css'
import b from './FormBuilder.module.css'

// -----------------------------------------------------------------------------
// The scouting form builder.
//
// A mentor authors the season's questions here instead of writing SQL. Two
// things make that harder than it sounds, and most of this file is about them.
//
// 1. `validate_scout_fields()` (migration 0005) is the real authority. It
//    rejects non-snake_case keys, unknown types, duplicate keys, missing labels
//    and option-less selects — as a Postgres exception, at save time, after the
//    mentor has typed thirty fields. So every one of those rules is mirrored
//    here and enforced BEFORE save. The mirror is not a replacement: if the
//    server still refuses, its message is shown word for word, because it was
//    written to be read by exactly this person.
//
// 2. A key is data, not a label. Renaming one on a form that already has
//    entries orphans every answer stored under the old name, and does it
//    silently. Keys therefore lock the moment entries exist, and the three keys
//    the analysis reads BY NAME lock harder than that. See PROTECTED below.
// -----------------------------------------------------------------------------

/**
 * The palette — every type `validate_scout_fields()` allows, and no other. Each
 * one is rendered by FormRenderer, so anything creatable here is guaranteed to
 * actually appear in front of a scout.
 *
 * The blurbs are load-bearing. `counter` and `number` both store a number and a
 * mentor choosing between them from the type name alone will pick wrong about
 * half the time — the difference is that one is a pair of big buttons for a
 * thumb during a match and the other is a keyboard.
 */
export const FIELD_TYPES = [
  {
    type: 'counter',
    label: 'Counter',
    icon: 'plus',
    blurb: 'Big +/− buttons. For match play — tapped without looking, dozens of times.',
  },
  {
    type: 'number',
    label: 'Number',
    icon: 'grid',
    blurb: 'A typed number and a keyboard. For a value entered once, calmly.',
  },
  {
    type: 'text',
    label: 'Short text',
    icon: 'pin',
    blurb: 'One line. Motor type, wheel size — a short specific answer.',
  },
  {
    type: 'textarea',
    label: 'Long text',
    icon: 'book',
    blurb: 'A paragraph. Observations nobody could have listed in advance.',
  },
  {
    type: 'select',
    label: 'Choose one',
    icon: 'check',
    blurb: 'One from a fixed list. Starting position, drivetrain type.',
  },
  {
    type: 'multiselect',
    label: 'Choose many',
    icon: 'menu',
    blurb: 'Any number from a list. Scoring locations, capabilities.',
  },
  {
    type: 'boolean',
    label: 'Yes / no',
    icon: 'flag',
    blurb: 'Two buttons — and "no" stays distinguishable from "not answered".',
  },
  {
    type: 'rating',
    label: 'Rating',
    icon: 'star',
    blurb: '1 to max, as buttons. Judgement calls: driver skill, defence.',
  },
  {
    type: 'timer',
    label: 'Timer',
    icon: 'calendar',
    blurb: 'Start/stop stopwatch. Cycle times, seconds spent disabled.',
  },
  {
    type: 'heading',
    label: 'Heading',
    icon: 'bars',
    blurb: 'Not a question — a sub-title inside the current section.',
  },
]

/**
 * THE THREE PROTECTED KEYS.
 *
 * `team_event_stats` (migration 0005) reads these three out of `data` by name:
 *
 *     avg((e.data ->> 'total_score')::numeric)
 *     count(*) filter (where (e.data ->> 'broke')::boolean)
 *     count(*) filter (where (e.data ->> 'no_show')::boolean)
 *
 * The pick list and every AI summary are built on that view. A match or pit form
 * without them produces entries that are perfectly valid and completely
 * invisible to the analysis — every team shows a null average and a flawless
 * reliability record, and nothing raises an error to say why.
 *
 * That failure mode is the reason this builder exists at all, so the guard rail
 * around it is the strongest thing in the file: a prominent warning when one is
 * missing, one click to add them, and a typed confirmation before anyone can
 * rename or delete one.
 */
export const PROTECTED = {
  total_score: {
    key: 'total_score',
    type: 'number',
    label: 'Total score',
    min: 0,
    why: 'team_event_stats reads total_score by name for average, spread, min and max — the numbers the pick list ranks on.',
    byKind: {
      match: {
        label: 'Points this robot contributed',
        help: 'Everything this team scored this match, as one number.',
      },
      pit: {
        label: 'Expected points per match',
        help: 'Your estimate, from what they told you and what the robot looks like.',
      },
      strategy: { label: 'Impact estimate', help: 'Rough points-per-match impact.' },
    },
  },
  broke: {
    key: 'broke',
    type: 'boolean',
    label: 'Broke down',
    why: 'team_event_stats counts breakdowns by this exact key. Without it every team looks perfectly reliable.',
    byKind: {
      match: { label: 'Broke down or was disabled' },
      pit: { label: 'Known reliability problems' },
      strategy: { label: 'Reliability concern' },
    },
  },
  no_show: {
    key: 'no_show',
    type: 'boolean',
    label: 'No show',
    why: 'team_event_stats counts no-shows by this exact key. Without it a robot that never appeared is averaged in as one that merely scored nothing.',
    byKind: {
      match: { label: 'Never showed up' },
      pit: { label: 'Pit empty / would not talk' },
      strategy: { label: 'Did not compete' },
    },
  },
}

export const PROTECTED_KEYS = Object.keys(PROTECTED)

/**
 * A ready-to-insert standard field, worded for the kind of form it is joining.
 *
 * The wording comes from the team's own seeded 2026 forms rather than from
 * something generic invented here — "Expected points per match" is what a pit
 * scout is actually estimating, and a field labelled "Total score" in a pit form
 * gets answered as if it were a match.
 */
export function standardField(key, kind) {
  const { why, byKind, ...def } = PROTECTED[key]
  return { ...def, ...(byKind?.[kind] ?? {}) }
}

/**
 * Which kinds get the loud banner.
 *
 * Match and pit are the ones a missing key genuinely breaks. `strategy` gets a
 * quieter note instead: `team_event_stats` does not filter by kind, so a
 * strategy entry does feed those aggregates and the seeded 2026 strategy form
 * carries all three — but a free-form note without a score is a reasonable thing
 * to want on purpose, and shouting about it would train people to dismiss the
 * banner that matters.
 */
const NEEDS_PROTECTED = new Set(['match', 'pit'])

export const KINDS = [
  { id: 'match', label: 'Match' },
  { id: 'pit', label: 'Pit' },
  { id: 'strategy', label: 'Notes' },
]

const ALLOWED = new Set(FIELD_TYPES.map((t) => t.type))
const NEEDS_OPTIONS = new Set(['select', 'multiselect'])
const NUMERIC = new Set(['counter', 'number', 'rating'])

// The trigger's own regex, character for character. Diverging from it here would
// mean the UI accepts something the database then refuses.
const KEY_RE = /^[a-z][a-z0-9_]*$/

// --- pure helpers -------------------------------------------------------------

/**
 * label -> lower_snake_case key.
 *
 * The leading-letter rule is not cosmetic: the trigger requires `^[a-z]`, so a
 * label like "2026 goals" cannot simply be slugified — "2026_goals" would be
 * rejected at save time, long after the mentor stopped thinking about it.
 */
export function slugKey(label) {
  const base = String(label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!base) return ''
  return /^[a-z]/.test(base) ? base : `f_${base}`
}

function uniqueKey(base, taken) {
  if (!base) return ''
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}_${n}`)) n += 1
  return `${base}_${n}`
}

/**
 * A working block -> the object that actually gets stored.
 *
 * Optional properties are dropped rather than written as empty strings, so the
 * stored JSON stays the shape migration 0005 documents instead of accumulating
 * `"help": ""` on every field anyone ever opened.
 */
export function cleanField(f) {
  const out = { key: f.key, type: f.type }
  const label = f.label?.trim()
  if (label) out.label = label
  const section = f.section?.trim()
  if (section) out.section = section
  const help = f.help?.trim()
  if (help) out.help = help
  if (f.required) out.required = true
  if (NUMERIC.has(f.type)) {
    if (Number.isFinite(f.min)) out.min = f.min
    if (Number.isFinite(f.max)) out.max = f.max
  }
  if (NEEDS_OPTIONS.has(f.type)) {
    out.options = (f.options ?? []).map((o) => String(o).trim()).filter(Boolean)
  }
  return out
}

/**
 * Every rule `validate_scout_fields()` enforces, checked before the round trip.
 *
 * Two rules here are deliberately STRICTER than the trigger. It accepts a label
 * of `""` (it only tests for null) and lets a `heading` have no label at all —
 * both produce a field that renders as a blank space in front of a student, so
 * the builder refuses them. Being stricter is safe; being looser would mean
 * promising a save that the database is going to reject.
 */
export function validateFields(fields) {
  const problems = []
  const seen = new Set()

  fields.forEach((f, i) => {
    const where = f.label?.trim() || f.key || `Block ${i + 1}`

    if (!f.key) {
      problems.push({ i, msg: `${where} has no key yet — give it a label and one is derived.` })
    } else if (!KEY_RE.test(f.key)) {
      problems.push({
        i,
        msg: `“${f.key}” is not a valid key. It must start with a lower-case letter, then only lower-case letters, digits or underscores.`,
      })
    } else if (seen.has(f.key)) {
      problems.push({
        i,
        msg: `Two blocks both use the key “${f.key}”. They would share one answer and the second would win.`,
      })
    }
    if (f.key) seen.add(f.key)

    if (!ALLOWED.has(f.type)) {
      problems.push({ i, msg: `${where}: “${f.type}” is not a type this portal can render.` })
    }
    if (!f.label?.trim()) {
      problems.push({ i, msg: `Block ${i + 1} has no label — a scout would see a blank space.` })
    }
    if (NEEDS_OPTIONS.has(f.type) && !(f.options ?? []).length) {
      problems.push({ i, msg: `${where} is a “${f.type}”, so it needs at least one option.` })
    }
  })

  return problems
}

// Blocks carry a client-side uid so React keeps the same DOM node across a
// reorder — which is what lets keyboard focus survive moving a block. It is
// never stored: `cleanField` builds the saved object from scratch.
let seq = 0
const nextUid = () => `blk${(seq += 1)}`

export function toBlocks(fields) {
  return (fields ?? []).map((f) => ({
    uid: nextUid(),
    autoKey: false, // an existing key is somebody's decision, not a derivation
    field: { options: [], required: false, ...f },
  }))
}

/**
 * The renderer's grouping rule, mirrored exactly.
 *
 * FormRenderer starts a new screen whenever the `section` value CHANGES, not
 * whenever it sees a new name. So the same section used in two places that are
 * not adjacent produces two separate screens with the same title — which is
 * almost never what someone meant, and is invisible until a scout is looking at
 * it. The builder draws the groups it computes here, and warns about splits.
 */
function groupBlocks(blocks) {
  const groups = []
  const rows = []
  let cur = null
  blocks.forEach((blk, i) => {
    const name = blk.field.section?.trim() || ''
    if (!cur || cur.name !== name) {
      cur = { name, ordinal: groups.length, from: i, count: 0 }
      groups.push(cur)
    }
    cur.count += 1
    rows.push({ group: cur, isStart: cur.from === i })
  })
  return { groups, rows }
}

function signature(meta, fields) {
  return JSON.stringify([meta.season, meta.kind, meta.name, meta.description ?? '', fields])
}

// --- the builder --------------------------------------------------------------

export default function FormBuilder({ form, onDone, onSaved, canWrite = true }) {
  const [meta, setMeta] = useState(() => ({
    id: form?.id ?? null,
    season: form?.season ?? new Date().getFullYear(),
    kind: form?.kind ?? 'match',
    name: form?.name ?? '',
    description: form?.description ?? '',
    is_active: form?.is_active ?? false,
  }))
  const [blocks, setBlocks] = useState(() => toBlocks(form?.fields))
  const [expanded, setExpanded] = useState(null)
  const [unlocked, setUnlocked] = useState(() => new Set())
  const [entryCount, setEntryCount] = useState(null)
  const [saving, setSaving] = useState(false)
  const [serverError, setServerError] = useState(null)
  const [showProblems, setShowProblems] = useState(false)
  const [announce, setAnnounce] = useState('')
  const [confirm, setConfirm] = useState(null)
  const [preview, setPreview] = useState({})
  const [baseline, setBaseline] = useState(() =>
    signature(
      {
        season: form?.season ?? new Date().getFullYear(),
        kind: form?.kind ?? 'match',
        name: form?.name ?? '',
        description: form?.description ?? '',
      },
      (form?.fields ?? []).map(cleanField)
    )
  )

  const listRef = useRef(null)
  const rowRefs = useRef(new Map())
  const dragRef = useRef(null)
  const [drag, setDrag] = useState(null)
  const focusRef = useRef(null)

  const fields = useMemo(() => blocks.map((blk) => cleanField(blk.field)), [blocks])
  const problems = useMemo(() => validateFields(fields), [fields])
  const { groups, rows } = useMemo(() => groupBlocks(blocks), [blocks])
  const dirty = signature(meta, fields) !== baseline

  // Whether a key may still be edited at all. Loaded once per form; until it
  // resolves the builder assumes the cautious answer.
  useEffect(() => {
    let alive = true
    setEntryCount(null)
    ;(async () => {
      const { data } = await formEntryCount(form?.id)
      if (alive) setEntryCount(data)
    })()
    return () => {
      alive = false
    }
  }, [form?.id])

  // A newly added block opens with its label focused — the label is what the
  // key is derived from, so it is always the first thing to type.
  useEffect(() => {
    if (!focusRef.current) return
    const el = listRef.current?.querySelector(`[data-label-for="${focusRef.current}"]`)
    focusRef.current = null
    el?.focus()
  }, [blocks.length])

  const hasEntries = (entryCount ?? 0) > 0

  const keyLock = useCallback(
    (blk) => {
      if (unlocked.has(blk.uid)) return null
      // Protected regardless of age: a `total_score` added a moment ago is
      // load-bearing the instant it is saved, and letting it be renamed while
      // still warm defeats the point of having offered to add it.
      if (PROTECTED[blk.field.key]) return 'protected'
      // A block added in this session has no data stored under it yet, so its
      // key is still free even on a form with thousands of entries. Locking it
      // would be theatre — and would block the ordinary act of adding a
      // question mid-competition.
      if (hasEntries && !blk.isNew) return 'entries'
      return null
    },
    [hasEntries, unlocked]
  )

  const sectionNames = useMemo(
    () => [...new Set(groups.map((g) => g.name).filter(Boolean))],
    [groups]
  )

  // The same name in two non-adjacent runs. Worth surfacing loudly: it is the
  // single most confusing thing the renderer does, and it looks like a typo in
  // the data rather than a consequence of ordering.
  const splitSections = useMemo(() => {
    const counts = new Map()
    groups.forEach((g) => {
      if (g.name) counts.set(g.name, (counts.get(g.name) ?? 0) + 1)
    })
    return [...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name)
  }, [groups])

  const missingProtected = useMemo(() => {
    const have = new Set(blocks.map((blk) => blk.field.key))
    return PROTECTED_KEYS.filter((k) => !have.has(k))
  }, [blocks])

  const loudlyMissing = missingProtected.length > 0 && NEEDS_PROTECTED.has(meta.kind)

  // The preview is the real renderer, fed the real definition. While a block is
  // still being typed its key can be empty or a duplicate, either of which
  // breaks list reconciliation inside FormRenderer — so the preview substitutes
  // a placeholder rather than going blank. Keeping up with the typing is the
  // entire point of having it.
  const previewFields = useMemo(() => {
    const used = new Set()
    return fields.map((f, i) => {
      let key = f.key
      if (!key || used.has(key)) key = `draft_${i}`
      used.add(key)
      return { ...f, key, label: f.label || 'Untitled' }
    })
  }, [fields])

  // --- mutation ---------------------------------------------------------------

  const patch = useCallback((uid, changes) => {
    setBlocks((bs) =>
      bs.map((blk) => (blk.uid === uid ? { ...blk, field: { ...blk.field, ...changes } } : blk))
    )
  }, [])

  const changeLabel = useCallback(
    (uid, label) => {
      setBlocks((bs) => {
        const taken = new Set(
          bs.filter((x) => x.uid !== uid).map((x) => x.field.key).filter(Boolean)
        )
        return bs.map((blk) => {
          if (blk.uid !== uid) return blk
          const field = { ...blk.field, label }
          // Derive only while the key is still untouched AND still free to
          // change. A locked key must not drift because someone fixed a typo in
          // the label, which is the whole reason it is locked. Kept in step with
          // `keyLock` above, including the exemption for a block added in this
          // session — it has no stored data to orphan yet.
          const locked =
            PROTECTED[blk.field.key] || (hasEntries && !blk.isNew && !unlocked.has(uid))
          if (blk.autoKey && !locked) field.key = uniqueKey(slugKey(label), taken)
          return { ...blk, field }
        })
      })
    },
    [hasEntries, unlocked]
  )

  const changeKey = useCallback((uid, raw) => {
    // Typing is not corrected as it happens — that fights the person — but the
    // characters the trigger cannot accept are simply not accepted.
    const key = raw.toLowerCase().replace(/[^a-z0-9_]/g, '_')
    setBlocks((bs) =>
      bs.map((blk) => (blk.uid === uid ? { ...blk, autoKey: false, field: { ...blk.field, key } } : blk))
    )
  }, [])

  // The uid is minted out here, not inside the updater: a state updater has to
  // be pure enough to run twice, and both the focus target and the newly opened
  // editor have to name the same block that actually got appended.
  const addBlock = useCallback((type) => {
    const uid = nextUid()
    focusRef.current = uid
    setExpanded(uid)
    setBlocks((bs) => {
      const last = bs[bs.length - 1]
      const field = {
        key: '',
        type,
        label: '',
        // Inherit the section it lands after, so adding a block to a screen does
        // not silently start a new one.
        section: last?.field.section ?? '',
        help: '',
        required: false,
        options: NEEDS_OPTIONS.has(type) ? [''] : [],
      }
      if (type === 'rating') field.max = 5
      return [...bs, { uid, autoKey: true, isNew: true, field }]
    })
  }, [])

  const addStandardFields = useCallback(() => {
    const have = new Set(blocks.map((x) => x.field.key))
    const last = blocks[blocks.length - 1]
    const added = PROTECTED_KEYS.filter((k) => !have.has(k)).map((k) => ({
      uid: nextUid(),
      autoKey: false,
      field: {
        section: last?.field.section ?? '',
        required: false,
        options: [],
        ...standardField(k, meta.kind),
      },
    }))
    if (!added.length) return
    setBlocks((bs) => [...bs, ...added])
    setAnnounce(`${added.map((x) => x.field.key).join(', ')} added at the end of the form.`)
  }, [blocks, meta.kind])

  const removeBlock = useCallback((uid) => {
    setBlocks((bs) => bs.filter((blk) => blk.uid !== uid))
    setExpanded((e) => (e === uid ? null : e))
  }, [])

  const move = useCallback((from, to) => {
    setBlocks((bs) => {
      if (to < 0 || to >= bs.length || to === from) return bs
      const next = bs.slice()
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }, [])

  const announceMove = useCallback(
    (from, to) => {
      const blk = blocks[from]
      if (!blk) return
      const name = blk.field.label?.trim() || blk.field.key || 'Block'
      // The destination section is named because moving a block across a section
      // boundary changes which screen a scout answers it on, and that is not
      // visible to someone driving this from the keyboard.
      const into = blocks[to]?.field.section?.trim()
      setAnnounce(
        `${name} moved to position ${to + 1} of ${blocks.length}${into ? `, in ${into}` : ''}.`
      )
    },
    [blocks]
  )

  const moveByKey = useCallback(
    (from, to) => {
      if (to < 0 || to >= blocks.length) return
      announceMove(from, to)
      move(from, to)
    },
    [announceMove, blocks.length, move]
  )

  // --- drag reorder -----------------------------------------------------------
  //
  // Pointer Events, written directly. Not HTML5 drag-and-drop, which does not
  // fire on touch at all — and this gets used on a tablet on a pit table. Not a
  // library either: one dependency for one interaction is not a trade this
  // bundle makes.
  //
  // Every geometry decision comes from rects measured once at pointerdown. The
  // blocks the drag passes over shift by exactly the dragged block's own outer
  // height, which is correct whatever the others measure — rows here are not a
  // uniform height, because a section banner makes the first row of a group
  // taller than the rest.

  const onHandleDown = useCallback(
    (e, index, uid) => {
      if (e.button != null && e.button > 0) return
      const rects = blocks.map((blk) => rowRefs.current.get(blk.uid)?.getBoundingClientRect())
      if (rects.some((r) => !r)) return

      e.currentTarget.setPointerCapture?.(e.pointerId)
      const gap = rects.length > 1 ? Math.max(0, rects[1].top - rects[0].bottom) : 0
      dragRef.current = { uid, from: index, over: index, startY: e.clientY, rects, pointerId: e.pointerId }
      setDrag({ uid, from: index, over: index, dy: 0, h: rects[index].height + gap })
    },
    [blocks]
  )

  const onHandleMove = useCallback((e) => {
    const s = dragRef.current
    if (!s || e.pointerId !== s.pointerId) return
    const dy = e.clientY - s.startY
    const centre = s.rects[s.from].top + s.rects[s.from].height / 2 + dy

    let over = s.from
    for (let i = 0; i < s.rects.length; i += 1) {
      if (i === s.from) continue
      const mid = s.rects[i].top + s.rects[i].height / 2
      if (i < s.from && centre < mid) over = Math.min(over, i)
      else if (i > s.from && centre > mid) over = Math.max(over, i)
    }

    s.over = over
    setDrag((d) => (d ? { ...d, over, dy } : d))
  }, [])

  const onHandleUp = useCallback(
    (e) => {
      const s = dragRef.current
      if (!s) return
      dragRef.current = null
      try {
        e.currentTarget.releasePointerCapture?.(s.pointerId)
      } catch {
        // The capture is already gone (pointercancel, element unmounted). The
        // reorder below is what matters and does not depend on it.
      }
      setDrag(null)
      if (s.over !== s.from) {
        announceMove(s.from, s.over)
        move(s.from, s.over)
      }
    },
    [announceMove, move]
  )

  const shiftFor = useCallback(
    (i) => {
      if (!drag) return undefined
      if (i === drag.from) return `translateY(${drag.dy}px)`
      if (drag.over > drag.from && i > drag.from && i <= drag.over) return `translateY(${-drag.h}px)`
      if (drag.over < drag.from && i >= drag.over && i < drag.from) return `translateY(${drag.h}px)`
      return undefined
    },
    [drag]
  )

  // --- save -------------------------------------------------------------------

  async function commit({ activate = false } = {}) {
    setServerError(null)
    if (problems.length) {
      setShowProblems(true)
      return
    }
    if (!meta.name.trim()) {
      setServerError('Give the form a name — it is how everyone else will find it.')
      return
    }

    setSaving(true)
    const payload = {
      id: meta.id,
      season: Number(meta.season),
      kind: meta.kind,
      name: meta.name.trim(),
      description: meta.description?.trim() || null,
      fields,
      is_active: activate ? true : meta.is_active,
    }
    const { data, error } = activate ? await activateForm(payload) : await saveForm(payload)
    setSaving(false)

    if (error) {
      // Verbatim. `saveForm` already forwards the trigger's own wording for a
      // field problem and its own sentence for an activation collision, and both
      // were written for the person reading this screen.
      setServerError(error)
      return
    }

    setMeta((m) => ({ ...m, id: data.id, is_active: data.is_active }))
    setBaseline(signature({ ...meta, id: data.id }, fields))
    setUnlocked(new Set())
    setEntryCount((c) => c ?? 0)
    // Saved fields stop being new: from here on a rename would orphan whatever
    // gets recorded against them, so they fall under the same lock as the rest.
    setBlocks((bs) => bs.map((blk) => (blk.isNew ? { ...blk, isNew: false } : blk)))
    setAnnounce(activate ? 'Form saved and published.' : 'Form saved.')
    onSaved?.(data)
  }

  // --- confirmations ----------------------------------------------------------

  function askUnlockKey(blk) {
    const prot = PROTECTED[blk.field.key]
    if (prot) {
      setConfirm({
        title: `Rename ${blk.field.key}?`,
        danger: true,
        typed: blk.field.key,
        confirmLabel: 'Let me rename it',
        body: (
          <>
            <p>
              <code className={b.code}>{blk.field.key}</code> is read <strong>by name</strong> by
              the analysis. {prot.why}
            </p>
            <p>
              Rename it and this form stops feeding that number. Nothing will break, no error will
              appear, and the teams scouted with it will simply be missing from the picture.
            </p>
            {hasEntries && (
              <p>
                {entryCount} {entryCount === 1 ? 'entry has' : 'entries have'} already been recorded
                against this form. Those keep the old key.
              </p>
            )}
          </>
        ),
        onConfirm: () => {
          setUnlocked((s) => new Set(s).add(blk.uid))
          setConfirm(null)
        },
      })
      return
    }

    setConfirm({
      title: 'Edit this key?',
      danger: true,
      confirmLabel: 'Unlock the key',
      body: (
        <>
          <p>
            {entryCount} {entryCount === 1 ? 'entry has' : 'entries have'} already been recorded
            against this form, stored under{' '}
            <code className={b.code}>{blk.field.key}</code>.
          </p>
          <p>
            Changing it now leaves those answers behind under the old name. They are not deleted —
            they just stop being read, and every average built on this field quietly starts ignoring
            them.
          </p>
          <p>Safe if this form has only been tested. Not safe mid-competition.</p>
        </>
      ),
      onConfirm: () => {
        setUnlocked((s) => new Set(s).add(blk.uid))
        setConfirm(null)
      },
    })
  }

  function askRemove(blk) {
    const prot = PROTECTED[blk.field.key]
    const name = blk.field.label?.trim() || blk.field.key

    if (prot) {
      setConfirm({
        title: `Delete ${blk.field.key}?`,
        danger: true,
        typed: blk.field.key,
        confirmLabel: 'Delete it anyway',
        body: (
          <>
            <p>
              <code className={b.code}>{blk.field.key}</code> is one of the three fields the
              analysis reads by name. {prot.why}
            </p>
            <p>
              Without it, entries recorded on this form are still saved and still valid — they are
              simply invisible to the pick list and to every summary. That is why this asks you to
              type the key: it fails silently, so it has to be refused loudly.
            </p>
          </>
        ),
        onConfirm: () => {
          removeBlock(blk.uid)
          setConfirm(null)
        },
      })
      return
    }

    // An empty draft nobody has typed into yet is not worth a dialog.
    if (!blk.field.label?.trim() && !blk.field.key) {
      removeBlock(blk.uid)
      return
    }

    setConfirm({
      title: `Delete “${name}”?`,
      confirmLabel: 'Delete',
      danger: true,
      body: hasEntries ? (
        <p>
          Answers already recorded under <code className={b.code}>{blk.field.key}</code> stay in the
          database. This form just stops asking the question.
        </p>
      ) : (
        <p>This form has no entries yet, so nothing is lost.</p>
      ),
      onConfirm: () => {
        removeBlock(blk.uid)
        setConfirm(null)
      },
    })
  }

  // --- render -----------------------------------------------------------------

  const kindLabel = KINDS.find((k) => k.id === meta.kind)?.label ?? meta.kind

  return (
    <div className={b.builder}>
      <div className={b.bar}>
        <button type="button" className={b.back} onClick={() => onDone?.()}>
          <Icon name="arrowLeft" size={16} />
          All forms
        </button>

        <div className={b.barActions}>
          {dirty && (
            <span className={b.dirty}>
              <span className={b.dirtyDot} aria-hidden="true" />
              Unsaved
            </span>
          )}
          {meta.is_active && <span className={b.liveTag}>Live</span>}
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => commit()}
            disabled={saving || !canWrite}
          >
            {saving ? <span className={styles.spinnerSm} aria-hidden="true" /> : <Icon name="check" size={16} />}
            Save
          </button>
          {!meta.is_active && (
            <button
              type="button"
              className="btn btn--gold"
              onClick={() => commit({ activate: true })}
              disabled={saving || !canWrite}
              title={`Make this the form every scout gets for ${meta.season} ${kindLabel.toLowerCase()}`}
            >
              Save &amp; publish
            </button>
          )}
        </div>
      </div>

      {!canWrite && (
        <p className={b.note}>
          You can look at this form but not change it — authoring is limited to leads and mentors,
          and the database enforces that regardless of what this screen shows.
        </p>
      )}

      {/* --- identity --- */}
      <section className={b.metaGrid}>
        <label className={b.field}>
          <span className={b.label}>Form name</span>
          <input
            className={b.input}
            value={meta.name}
            onChange={(e) => setMeta((m) => ({ ...m, name: e.target.value }))}
            placeholder="2026 match scouting"
          />
        </label>
        <label className={b.field}>
          <span className={b.label}>Season</span>
          <input
            className={b.input}
            type="number"
            inputMode="numeric"
            value={meta.season}
            onChange={(e) => setMeta((m) => ({ ...m, season: e.target.value }))}
          />
        </label>
        <label className={b.field}>
          <span className={b.label}>Type</span>
          <select
            className={b.input}
            value={meta.kind}
            onChange={(e) => setMeta((m) => ({ ...m, kind: e.target.value }))}
          >
            {KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        <label className={`${b.field} ${b.fieldWide}`}>
          <span className={b.label}>Description</span>
          <input
            className={b.input}
            value={meta.description ?? ''}
            onChange={(e) => setMeta((m) => ({ ...m, description: e.target.value }))}
            placeholder="What this form is for, and anything a scout should know before using it"
          />
        </label>
      </section>

      {/* --- the guard rail --- */}
      {loudlyMissing && (
        <section className={`${b.banner} ${b.bannerBad}`} role="alert">
          <div className={b.bannerIcon} aria-hidden="true">
            <Icon name="alert" size={20} />
          </div>
          <div className={b.bannerMain}>
            <h3 className={b.bannerTitle}>
              This {kindLabel.toLowerCase()} form is missing{' '}
              {missingProtected.length === 1 ? 'a standard field' : 'standard fields'}
            </h3>
            <p className={b.bannerText}>
              Entries recorded on it will save without complaint and will be{' '}
              <strong>invisible</strong> to the pick list, the team comparison and every AI summary.
              Nothing reports this — the rows are valid, they simply cannot be read.
            </p>
            <ul className={b.bannerList}>
              {missingProtected.map((k) => (
                <li key={k}>
                  <code className={b.code}>{k}</code>
                  <span>{PROTECTED[k].why}</span>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="btn btn--gold"
              onClick={addStandardFields}
              disabled={!canWrite}
            >
              <Icon name="plus" size={16} />
              Add the missing standard {missingProtected.length === 1 ? 'field' : 'fields'}
            </button>
          </div>
        </section>
      )}

      {/* A notes form without a score is a defensible choice, so this informs
          rather than alarms — but team_event_stats does not filter by kind, so
          it is still worth saying out loud. */}
      {missingProtected.length > 0 && !loudlyMissing && (
        <div className={`${b.note} ${b.noteWarn} ${b.noteStack}`}>
          <p className={b.note}>
            <Icon name="alert" size={15} />
            <span>
              No {missingProtected.join(', ')} on this form, so its entries stay out of the
              aggregates. Defensible for pure notes — though the seeded 2026 notes form carries all
              three.
            </span>
          </p>
          {canWrite && (
            <button type="button" className={b.addOpt} onClick={addStandardFields}>
              <Icon name="plus" size={14} />
              Add them anyway
            </button>
          )}
        </div>
      )}

      {splitSections.length > 0 && (
        <p className={`${b.note} ${b.noteWarn}`}>
          <Icon name="alert" size={15} />
          <span>
            {splitSections.map((s) => `“${s}”`).join(', ')}{' '}
            {splitSections.length === 1 ? 'appears' : 'appear'} in more than one place in the order,
            so {splitSections.length === 1 ? 'it becomes' : 'they become'} two separate screens with
            the same title. Move the blocks next to each other if you meant one screen.
          </span>
        </p>
      )}

      <div className={b.cols}>
        {/* --- editor --- */}
        <div className={b.editorCol}>
          <h2 className={styles.sectionTitle}>
            Blocks
            <span className={styles.countBadge}>{blocks.length}</span>
          </h2>

          <p className={b.note}>
            A scout answers one <strong>section</strong> per screen, and a screen starts wherever the
            section value changes. A <strong>Heading</strong> block is a sub-title <em>inside</em> a
            screen — it does not start a new one.
          </p>

          {hasEntries && (
            <p className={`${b.note} ${b.noteLock}`}>
              <Icon name="pin" size={15} />
              <span>
                {entryCount} {entryCount === 1 ? 'entry has' : 'entries have'} been recorded on this
                form, so the keys of the fields already in it are locked. Labels, help text, order
                and any block you add now are still free to change.
              </span>
            </p>
          )}

          {blocks.length === 0 ? (
            <p className={b.note}>Nothing here yet. Add a block below to start.</p>
          ) : (
            <ul className={`${b.list} ${drag ? b.listDragging : ''}`} ref={listRef}>
              {blocks.map((blk, i) => (
                <BlockRow
                  key={blk.uid}
                  blk={blk}
                  index={i}
                  total={blocks.length}
                  row={rows[i]}
                  sectionNames={sectionNames}
                  expanded={expanded === blk.uid}
                  dragging={drag?.uid === blk.uid}
                  transform={shiftFor(i)}
                  lock={keyLock(blk)}
                  canWrite={canWrite}
                  registerRef={(el) => {
                    if (el) rowRefs.current.set(blk.uid, el)
                    else rowRefs.current.delete(blk.uid)
                  }}
                  onToggle={() => setExpanded((e) => (e === blk.uid ? null : blk.uid))}
                  onPatch={(changes) => patch(blk.uid, changes)}
                  onLabel={(v) => changeLabel(blk.uid, v)}
                  onKeyText={(v) => changeKey(blk.uid, v)}
                  onUnlock={() => askUnlockKey(blk)}
                  onRemove={() => askRemove(blk)}
                  onPointerDown={(e) => onHandleDown(e, i, blk.uid)}
                  onPointerMove={onHandleMove}
                  onPointerUp={onHandleUp}
                  onMoveKey={(delta) => moveByKey(i, i + delta)}
                  onMoveEdge={(edge) => moveByKey(i, edge === 'top' ? 0 : blocks.length - 1)}
                />
              ))}
            </ul>
          )}

          <section className={b.palette}>
            <h3 className={styles.sectionTitle}>Add a block</h3>
            <div className={b.paletteGrid}>
              {FIELD_TYPES.map((t) => (
                <button
                  key={t.type}
                  type="button"
                  className={b.paletteBtn}
                  onClick={() => addBlock(t.type)}
                  disabled={!canWrite}
                >
                  <span className={b.paletteHead}>
                    <Icon name={t.icon} size={16} />
                    <span className={b.paletteName}>{t.label}</span>
                  </span>
                  <span className={b.paletteBlurb}>{t.blurb}</span>
                </button>
              ))}
            </div>
          </section>

          {showProblems && problems.length > 0 && (
            <div className={b.problems} role="alert">
              <h3 className={b.problemsTitle}>
                <Icon name="alert" size={16} />
                {problems.length === 1
                  ? 'One thing to fix before this can save'
                  : `${problems.length} things to fix before this can save`}
              </h3>
              <ul className={b.problemList}>
                {problems.map((p, i) => (
                  <li key={i}>{p.msg}</li>
                ))}
              </ul>
            </div>
          )}

          <div className={styles.errorSlot} role="alert" aria-live="polite">
            {serverError && (
              <span className={styles.error}>
                <Icon name="alert" size={15} />
                {serverError}
              </span>
            )}
          </div>
        </div>

        {/* --- preview --- */}
        <div className={b.previewCol}>
          <h2 className={styles.sectionTitle}>What a scout sees</h2>
          <p className={b.note}>
            The real renderer, on the real definition — not a mock-up of it.
          </p>
          <div className={b.device}>
            {previewFields.length === 0 ? (
              <p className={b.deviceEmpty}>Blocks appear here as you add them.</p>
            ) : (
              <FormRenderer fields={previewFields} value={preview} onChange={setPreview} />
            )}
          </div>
        </div>
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>

      {confirm && <Confirm {...confirm} onCancel={() => setConfirm(null)} />}
    </div>
  )
}

// --- one block ----------------------------------------------------------------

function BlockRow({
  blk,
  index,
  total,
  row,
  sectionNames,
  expanded,
  dragging,
  transform,
  lock,
  canWrite,
  registerRef,
  onToggle,
  onPatch,
  onLabel,
  onKeyText,
  onUnlock,
  onRemove,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onMoveKey,
  onMoveEdge,
}) {
  const f = blk.field
  const type = FIELD_TYPES.find((t) => t.type === f.type)
  const protectedField = PROTECTED[f.key]
  const isHeading = f.type === 'heading'

  function onHandleKeyDown(e) {
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      onMoveKey(-1)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      onMoveKey(1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      onMoveEdge('top')
    } else if (e.key === 'End') {
      e.preventDefault()
      onMoveEdge('bottom')
    }
  }

  return (
    <li
      ref={registerRef}
      className={`${b.item} ${dragging ? b.itemDragging : ''} ${isHeading ? b.itemHeading : ''}`}
      style={transform ? { transform } : undefined}
    >
      {row?.isStart && (
        <div className={b.sectionBanner}>
          <Icon name="bars" size={13} />
          <span className={b.sectionName}>{row.group.name || 'No section'}</span>
          <span className={b.sectionCount}>
            {row.group.count} {row.group.count === 1 ? 'block' : 'blocks'} on one screen
          </span>
        </div>
      )}

      <div className={b.itemBody}>
        <button
          type="button"
          className={b.handle}
          aria-label={`Reorder ${f.label || f.key || 'block'}, position ${index + 1} of ${total}. Use the arrow keys to move it.`}
          disabled={!canWrite}
          onPointerDown={canWrite ? onPointerDown : undefined}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onHandleKeyDown}
        >
          <Icon name="menu" size={16} />
        </button>

        <button type="button" className={b.summary} onClick={onToggle} aria-expanded={expanded}>
          <span className={b.summaryTop}>
            <span className={b.typeTag}>{type?.label ?? f.type}</span>
            <span className={b.blockLabel}>{f.label || <em>Untitled</em>}</span>
            {f.required && (
              <span className={b.reqTag} title="Required">
                required
              </span>
            )}
            {protectedField && (
              <span className={b.protTag} title="Read by name by the analysis">
                <Icon name="star" size={11} />
                standard
              </span>
            )}
          </span>
          <span className={b.summaryKey}>
            <code className={b.keyText}>{f.key || '—'}</code>
            {lock && (
              <>
                {/* Icon sets aria-hidden on itself, so the meaning has to be
                    carried by real text rather than a label it would ignore. */}
                <Icon name="pin" size={12} />
                <span className="sr-only">Key locked</span>
              </>
            )}
          </span>
        </button>

        <button
          type="button"
          className={`${b.iconBtn} ${b.iconBtnDanger}`}
          onClick={onRemove}
          disabled={!canWrite}
          aria-label={`Delete ${f.label || f.key || 'block'}`}
        >
          <Icon name="close" size={16} />
        </button>
      </div>

      {expanded && (
        <div className={b.editor}>
          <div className={b.editorGrid}>
            <label className={`${b.field} ${b.fieldWide}`}>
              <span className={b.label}>{isHeading ? 'Heading text' : 'Label'}</span>
              <input
                className={b.input}
                data-label-for={blk.uid}
                value={f.label ?? ''}
                disabled={!canWrite}
                onChange={(e) => onLabel(e.target.value)}
                placeholder={isHeading ? 'Autonomous' : 'Auto speaker notes'}
              />
            </label>

            <label className={b.field}>
              <span className={b.label}>
                Key
                {lock && <span className={b.lockTag}>locked</span>}
              </span>
              <div className={b.keyRow}>
                <input
                  className={`${b.input} ${b.keyInput}`}
                  value={f.key ?? ''}
                  readOnly={!!lock || !canWrite}
                  aria-readonly={!!lock}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  onChange={(e) => onKeyText(e.target.value)}
                />
                {lock && canWrite && (
                  <button type="button" className={b.unlockBtn} onClick={onUnlock}>
                    Change…
                  </button>
                )}
              </div>
              <span className={b.hint}>
                {lock === 'protected'
                  ? 'Read by name by the analysis. Renaming it is possible but has to be confirmed.'
                  : lock === 'entries'
                    ? 'Locked because entries exist. Renaming it would orphan them.'
                    : 'Derived from the label. This is what the answer is stored under.'}
              </span>
            </label>

            <label className={b.field}>
              <span className={b.label}>Section (screen)</span>
              <input
                className={b.input}
                list="fb-sections"
                value={f.section ?? ''}
                disabled={!canWrite}
                onChange={(e) => onPatch({ section: e.target.value })}
                placeholder="Autonomous"
              />
              <datalist id="fb-sections">
                {sectionNames.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
              <span className={b.hint}>Blocks sharing this, next to each other, share a screen.</span>
            </label>

            {!isHeading && (
              <label className={`${b.field} ${b.fieldWide}`}>
                <span className={b.label}>Help text</span>
                <input
                  className={b.input}
                  value={f.help ?? ''}
                  disabled={!canWrite}
                  onChange={(e) => onPatch({ help: e.target.value })}
                  placeholder="Count scored, not attempted"
                />
              </label>
            )}

            {NUMERIC.has(f.type) && (
              <>
                {f.type !== 'rating' && (
                  <label className={b.field}>
                    <span className={b.label}>Lowest</span>
                    <input
                      className={b.input}
                      type="number"
                      inputMode="numeric"
                      value={Number.isFinite(f.min) ? f.min : ''}
                      disabled={!canWrite}
                      onChange={(e) =>
                        onPatch({ min: e.target.value === '' ? undefined : Number(e.target.value) })
                      }
                      placeholder={f.type === 'counter' ? '0' : ''}
                    />
                  </label>
                )}
                <label className={b.field}>
                  <span className={b.label}>{f.type === 'rating' ? 'Out of' : 'Highest'}</span>
                  <input
                    className={b.input}
                    type="number"
                    inputMode="numeric"
                    value={Number.isFinite(f.max) ? f.max : ''}
                    disabled={!canWrite}
                    onChange={(e) =>
                      onPatch({ max: e.target.value === '' ? undefined : Number(e.target.value) })
                    }
                    placeholder={f.type === 'rating' ? '5' : f.type === 'counter' ? '999' : ''}
                  />
                </label>
              </>
            )}

            {NEEDS_OPTIONS.has(f.type) && (
              <div className={`${b.field} ${b.fieldWide}`}>
                <span className={b.label}>Options</span>
                <div className={b.options}>
                  {(f.options ?? []).map((opt, oi) => (
                    <div className={b.optionRow} key={oi}>
                      <input
                        className={b.input}
                        value={opt}
                        disabled={!canWrite}
                        onChange={(e) => {
                          const next = [...(f.options ?? [])]
                          next[oi] = e.target.value
                          onPatch({ options: next })
                        }}
                        placeholder={`Option ${oi + 1}`}
                      />
                      <button
                        type="button"
                        className={`${b.iconBtn} ${b.iconBtnDanger}`}
                        disabled={!canWrite}
                        aria-label={`Remove option ${oi + 1}`}
                        onClick={() =>
                          onPatch({ options: (f.options ?? []).filter((_, x) => x !== oi) })
                        }
                      >
                        <Icon name="close" size={15} />
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  className={b.addOpt}
                  disabled={!canWrite}
                  onClick={() => onPatch({ options: [...(f.options ?? []), ''] })}
                >
                  <Icon name="plus" size={14} />
                  Add option
                </button>
                <span className={b.hint}>
                  A “{type?.label}” with no options is refused by the database.
                </span>
              </div>
            )}

            {!isHeading && (
              <label className={b.checkRow}>
                <input
                  type="checkbox"
                  className={b.check}
                  checked={!!f.required}
                  disabled={!canWrite}
                  onChange={(e) => onPatch({ required: e.target.checked })}
                />
                <span>
                  Required — a scout cannot save without it
                </span>
              </label>
            )}
          </div>
        </div>
      )}
    </li>
  )
}

// --- confirmation -------------------------------------------------------------

/**
 * `typed` turns this into a typed confirmation: the exact string has to be
 * entered before the action is possible. Reserved for the changes that fail
 * silently — where a normal "are you sure" gets clicked through by muscle memory
 * and the consequence is not discovered for a week.
 */
export function Confirm({ title, body, danger, typed, confirmLabel, onCancel, onConfirm }) {
  const [text, setText] = useState('')
  const dialogRef = useRef(null)
  const ok = !typed || text.trim() === typed

  // Escape is bound on the document rather than on the dialog: without a typed
  // field there is nothing inside to hold focus, so a handler scoped to the
  // subtree would never hear the key.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    dialogRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className={b.scrim} role="presentation" onPointerDown={onCancel}>
      <div
        ref={dialogRef}
        className={b.dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="fb-confirm-title"
        tabIndex={-1}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <h3 className={b.dialogTitle} id="fb-confirm-title">
          {title}
        </h3>
        <div className={b.dialogBody}>{body}</div>

        {typed && (
          <label className={b.field}>
            <span className={b.label}>
              Type <code className={b.code}>{typed}</code> to confirm
            </span>
            <input
              className={b.input}
              value={text}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              onChange={(e) => setText(e.target.value)}
            />
          </label>
        )}

        <div className={b.dialogActions}>
          <button type="button" className="btn btn--ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${danger ? b.btnDanger : 'btn--cyan'}`}
            disabled={!ok}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
