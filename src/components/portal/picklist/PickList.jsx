import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Icon from '../../Icon'
import { useAuth } from '../../../lib/auth'
import { getLenis } from '../../../lib/smoothScroll'
import {
  listEvents,
  listEventTeams,
  teamStats,
  eventCoverage,
  askAi,
  listPicklists,
  createPicklist,
  picklistEntries,
  addPicklistTeams,
  movePicklistEntry,
  respacePicklistTier,
  setPicklistNote,
  setPicklistLock,
  DEFAULT_PICKLIST_TIERS,
} from '../../../lib/scoutingApi'
import { sortEntries, planMove, locate } from './position'
import { parseProposal } from './aiProposal'
import { Loading, Empty, ErrorState } from '../ui'
import portal from '../Portal.module.css'
import styles from './PickList.module.css'

// -----------------------------------------------------------------------------
// The pick list board.
//
// Alliance selection is eight minutes of the whole season where being wrong is
// expensive and being slow is also expensive. Three things follow:
//
//   * A drag writes ONE row. The sparse `position` scheme in ./position.js is
//     what makes that possible; the alternative renumbers a tier on every move,
//     over the worst network of the year.
//   * Keyboard works. A tablet gets handed around, someone ends up on a laptop,
//     and "you have to drag it" is not an answer at 4pm on a Saturday.
//   * Nothing here silently reorders. Every move is announced, and the AI can
//     only ever propose — never apply.
//
// THE PROBE. The card in the hand is `position: fixed` and follows the pointer.
// Fixed is only measured from the viewport when no ancestor has a transform,
// filter or similar — and the page wrapper does: its entry animation ends on
// `transform: translateY(0)` and keeps it. So fixed coordinates in here are
// relative to that wrapper, which scrolls. Rather than assume either case, a
// zero-sized fixed element (`styles.probe`) is asked where the origin actually
// is, and the card is placed relative to that. Remove it and the card jumps by
// the scroll offset the moment it is picked up.
// -----------------------------------------------------------------------------

const DEFAULT_NAME = 'Pick list'
// Movement before a press on the grip counts as a drag, in px.
const DRAG_SLOP = 6
// A lane the pointer is near the top or bottom edge of the window scrolls the
// page, so a card can be carried from Unranked up to the first tier on a phone.
const EDGE = 72
const MAX_SCROLL_STEP = 18

/** How much scouting is behind a card. Thin data must not look like thick data. */
function confidenceOf(matches) {
  return matches === 0 ? 'none' : matches < 3 ? 'thin' : matches < 6 ? 'some' : 'good'
}

function sameTarget(a, b) {
  return a === b || (a && b && a.tier === b.tier && a.index === b.index)
}

export default function PickList() {
  const { atLeast, user } = useAuth()
  const canEdit = atLeast('lead')
  // A refused write (most often: someone else locked the list a moment ago) is
  // shown above the board. It used to go into `state.error` and then load()
  // cleared it in the same tick, so the explanation never appeared at all.
  const [actionError, setActionError] = useState(null)

  const [eventKey, setEventKey] = useState(() => localStorage.getItem('frc5805.event') ?? '')
  const [events, setEvents] = useState([])
  const [list, setList] = useState(null)
  const [entries, setEntries] = useState([])
  const [teams, setTeams] = useState([])
  const [stats, setStats] = useState({})
  const [coverage, setCoverage] = useState(null)
  const [state, setState] = useState({ loading: true, error: null })
  const [announce, setAnnounce] = useState('')
  // What the board draws while a card is in the hand: which one, how big, and
  // where it would land. The pointer position itself never goes through React —
  // see dragRef.
  const [drag, setDrag] = useState(null)
  const [settledId, setSettledId] = useState(null)
  const [proposal, setProposal] = useState(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState(null)
  const boardRef = useRef(null)
  const probeRef = useRef(null)
  const overlayRef = useRef(null)
  const dragRef = useRef(null)
  const focusAfter = useRef(null)

  const tiers = list?.tiers?.length ? list.tiers : DEFAULT_PICKLIST_TIERS
  const editable = canEdit && Boolean(list) && !list.is_locked

  useEffect(() => {
    listEvents(new Date().getFullYear()).then(({ data }) => setEvents(data))
  }, [])

  useEffect(() => {
    if (eventKey) localStorage.setItem('frc5805.event', eventKey)
  }, [eventKey])

  const load = useCallback(async () => {
    if (!eventKey) {
      setState({ loading: false, error: null })
      return
    }
    setState({ loading: true, error: null })

    const [found, { data: st }, cov, roster] = await Promise.all([
      listPicklists(eventKey),
      teamStats(eventKey),
      eventCoverage(eventKey),
      listEventTeams(eventKey),
    ])

    setStats(Object.fromEntries((st ?? []).map((s) => [s.team_number, s])))
    setCoverage(cov?.data ?? null)
    setTeams(roster?.data ?? [])

    // A read that failed is not "no list yet". Treating it as one would create a
    // second list for the event, and — worse, below — re-seed a board that
    // already holds an afternoon of ranking.
    if (found.error) {
      setState({ loading: false, error: found.error })
      return
    }

    // The most recently touched list for the event.
    let current = found.data[0] ?? null

    // Create on first visit rather than showing an empty-state button. The list
    // is the point of the screen, and one fewer click at 4pm on a Saturday is
    // worth more than the tidiness of an explicit "create" step.
    if (!current && canEdit) {
      const { data: made, error } = await createPicklist({ eventKey, name: DEFAULT_NAME, userId: user?.id })
      if (error) {
        setState({ loading: false, error })
        return
      }
      current = made
    }
    if (!current) {
      setState({ loading: false, error: null })
      setList(null)
      return
    }

    const existing = await picklistEntries(current.id)
    if (existing.error) {
      setState({ loading: false, error: existing.error })
      return
    }

    // Seed from the roster on first open so the board starts populated rather
    // than making someone add sixty teams by hand. Only ever into a list that was
    // read and found empty, and not a locked one: an entry's id is its team
    // number, so seeding over a populated board would reset every card on it.
    let seeded = existing.data
    if (!seeded.length && canEdit && !current.is_locked) {
      const teamRows = roster?.data
      if (teamRows?.length) {
        const { data: added } = await addPicklistTeams(
          current.id,
          teamRows.map((t, i) => ({ team_number: t.team_number, tier: 'unranked', position: (i + 1) * 10 })),
          user?.id
        )
        seeded = added ?? []
      }
    }

    setList(current)
    setEntries(seeded)
    setState({ loading: false, error: null })
  }, [eventKey, canEdit, user?.id])

  useEffect(() => {
    load()
  }, [load])

  const byTier = useMemo(() => {
    const out = {}
    for (const t of tiers) out[t.key] = sortEntries(entries.filter((e) => e.tier === t.key))
    return out
  }, [entries, tiers])

  // Entries whose tier is not one of the list's tiers any more. They keep a lane
  // of their own — a renamed tier must not make a team vanish off the board.
  const orphanTiers = useMemo(() => {
    const known = new Set(tiers.map((t) => t.key))
    const keys = [...new Set(entries.map((e) => e.tier).filter((k) => !known.has(k)))]
    return keys.map((key) => ({ key, label: key, orphan: true, entries: sortEntries(entries.filter((e) => e.tier === key)) }))
  }, [entries, tiers])

  const nicknames = useMemo(
    () => Object.fromEntries(teams.map((t) => [t.team_number, t.nickname])),
    [teams]
  )

  // Teams on the board (or at the event) with no match entry at all.
  const unscouted = useMemo(() => {
    const numbers = teams.length ? teams.map((t) => t.team_number) : entries.map((e) => e.team_number)
    return numbers.filter((n) => !(stats[n]?.matches_scouted > 0)).sort((a, b) => a - b)
  }, [teams, entries, stats])

  // --- moving -----------------------------------------------------------------

  async function move(entry, toTier, toIndex) {
    if (!canEdit || list?.is_locked) return

    const siblings = sortEntries(
      entries.filter((e) => e.tier === toTier && e.id !== entry.id)
    )
    const plan = planMove(siblings, entry, toIndex)

    // With a suggestion on screen, a move either follows it or goes against it,
    // and the card says which. With none, the flag is left exactly as it was.
    const offered = proposal?.offers.find((o) => o.teamNumber === entry.team_number)
    const overridesAi = offered ? offered.tier !== toTier : undefined

    // Optimistic. The board must respond to the finger immediately; a drag that
    // waits on a round trip feels broken on a venue network.
    const optimistic = plan.respace
      ? entries.map((e) => {
          const r = plan.rows.find((x) => x.id === e.id)
          return r ? { ...e, tier: toTier, position: r.position } : e
        })
      : entries.map((e) =>
          e.id === entry.id
            ? {
                ...e,
                tier: toTier,
                position: plan.position,
                ...(overridesAi == null ? null : { overrides_ai: overridesAi }),
              }
            : e
        )
    setEntries(optimistic)

    const { index, size } = locate(optimistic, toTier, entry.id)
    const tierLabel = tiers.find((t) => t.key === toTier)?.label ?? toTier
    setAnnounce(`Team ${entry.team_number} moved to ${tierLabel}, position ${index + 1} of ${size}`)

    // Through scoutingApi rather than inline queries: those writes stamp
    // updated_by (the table's "every change is attributed" promise was never
    // kept from this screen), and the re-space sends only the ordering columns,
    // so it cannot write a stale copy of someone's note back over a fresh one.
    setActionError(null)
    const { error } = plan.respace
      ? await respacePicklistTier({
          picklistId: list.id,
          rows: plan.rows.map((r) => ({ ...r, tier: toTier })),
          userId: user?.id,
        })
      : await movePicklistEntry({
          id: entry.id,
          picklistId: list.id,
          tier: toTier,
          position: plan.position,
          overridesAi,
          userId: user?.id,
        })

    if (error) {
      // Already readable: for a locked list scoutingApi says so, in the words
      // written for whoever hits it. Reload to drop the optimistic move and pick
      // up whatever state made the write fail.
      setActionError(error)
      load()
    }
  }

  // --- notes ------------------------------------------------------------------

  // Why a team sits where it does. Written straight away like a move, and for
  // the same reason not queued: a note is about the list as it is now.
  async function saveNote(entry, text) {
    if (!canEdit || list?.is_locked) return
    const note = text.trim() ? text.trim() : null
    if ((entry.note ?? null) === note) return
    const previous = entry.note ?? null
    setEntries((rows) => rows.map((e) => (e.id === entry.id ? { ...e, note } : e)))
    setActionError(null)
    const { error } = await setPicklistNote({
      picklistId: list.id,
      id: entry.id,
      note,
      userId: user?.id,
    })
    if (error) {
      setEntries((rows) => rows.map((e) => (e.id === entry.id ? { ...e, note: previous } : e)))
      setActionError(error)
    }
  }

  // --- pointer drag ------------------------------------------------------------
  //
  // The pointer is captured by the BOARD, not by the grip that was pressed. The
  // card under the finger is taken out of its lane the moment the drag starts
  // (a copy follows the pointer instead), and a capture held by an element that
  // has just been unmounted is simply gone.

  /** Where a card dropped at (x, y) would go: which lane, and before which card. */
  function dropTarget(x, y, moverId) {
    const lane = document.elementFromPoint(x, y)?.closest('[data-tier]')
    if (!lane || !boardRef.current?.contains(lane)) return null
    // Fresh rectangles every time rather than cached ones: the page scrolls
    // under a drag and cached geometry is stale the moment it does. Reading
    // order — a card on a later row, or the same row and further right, comes
    // after the pointer. The card being moved is not one of its own neighbours
    // (it is still in its lane for the first frame of a drag).
    const cards = [...lane.querySelectorAll('[data-entry]')].filter(
      (card) => card.dataset.entry !== String(moverId)
    )
    let index = cards.length
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect()
      if (y < r.top || (y <= r.bottom && x < r.left + r.width / 2)) {
        index = i
        break
      }
    }
    return { tier: lane.dataset.tier, index }
  }

  /** Pin the copy to the pointer. Written to the element, not through state. */
  function placeOverlay() {
    const d = dragRef.current
    const el = overlayRef.current
    if (!d || !el) return
    const origin = probeRef.current?.getBoundingClientRect()
    el.style.transform = `translate(${d.x - d.dx - (origin?.left ?? 0)}px, ${d.y - d.dy - (origin?.top ?? 0)}px)`
  }

  function trackDrag() {
    const d = dragRef.current
    if (!d?.active) return
    placeOverlay()
    const over = dropTarget(d.x, d.y, d.entry.id)
    d.over = over
    setDrag((current) =>
      current && sameTarget(current.over, over)
        ? current
        : { entry: d.entry, width: d.width, height: d.height, over }
    )
  }

  function edgeScroll() {
    const d = dragRef.current
    if (!d?.active) return
    const top = EDGE + 24
    const bottom = window.innerHeight - EDGE
    let step = 0
    if (d.y < top) step = -Math.min(MAX_SCROLL_STEP, Math.ceil((top - d.y) / 5))
    else if (d.y > bottom) step = Math.min(MAX_SCROLL_STEP, Math.ceil((d.y - bottom) / 5))
    if (step) {
      // Lenis keeps its own idea of where the page is; scrolling behind its back
      // makes the next wheel tick snap back to where it thought it was.
      const lenis = getLenis()
      if (lenis) lenis.scrollTo(window.scrollY + step, { immediate: true, force: true })
      else window.scrollBy(0, step)
      trackDrag()
    }
    d.raf = requestAnimationFrame(edgeScroll)
  }

  function onPointerDown(e, entry) {
    if (!editable || e.button !== 0) return
    const card = e.currentTarget.closest('[data-entry]')
    if (!card || !boardRef.current) return
    const r = card.getBoundingClientRect()
    try {
      boardRef.current.setPointerCapture(e.pointerId)
    } catch {
      // The pointer is already gone (a tap that ended before this ran).
      return
    }
    dragRef.current = {
      entry,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      // Where on the card it was grabbed, so it does not jump to its corner.
      dx: e.clientX - r.left,
      dy: e.clientY - r.top,
      width: r.width,
      height: r.height,
      active: false,
      over: null,
      raf: 0,
    }
  }

  function onPointerMove(e) {
    const d = dragRef.current
    if (!d || e.pointerId !== d.pointerId) return
    d.x = e.clientX
    d.y = e.clientY
    if (!d.active) {
      if (Math.abs(d.x - d.startX) + Math.abs(d.y - d.startY) <= DRAG_SLOP) return
      d.active = true
      d.raf = requestAnimationFrame(edgeScroll)
    }
    trackDrag()
  }

  function endDrag(commit, pointerId) {
    const d = dragRef.current
    // A second finger lifting is not the end of the first one's drag.
    if (!d || (pointerId != null && pointerId !== d.pointerId)) return
    dragRef.current = null
    cancelAnimationFrame(d.raf)
    if (boardRef.current?.hasPointerCapture?.(d.pointerId)) {
      boardRef.current.releasePointerCapture(d.pointerId)
    }
    setDrag(null)
    if (!d.active) return
    // The grip that was pressed went away with the card; put focus back on the
    // card wherever it ends up, so the keyboard carries on from there.
    focusAfter.current = d.entry.id
    if (!commit || !d.over) return

    // Dropped back where it was: nothing to write.
    if (d.over.tier === d.entry.tier) {
      const lane = sortEntries(entries.filter((x) => x.tier === d.entry.tier))
      if (lane.findIndex((x) => x.id === d.entry.id) === d.over.index) return
    }
    setSettledId(d.entry.id)
    move(d.entry, d.over.tier, d.over.index)
  }

  // The copy has to be in place before the first paint it appears in, and again
  // whenever the board re-renders around it.
  useLayoutEffect(() => {
    if (drag) placeOverlay()
  }, [drag])

  // Escape puts the card back; a scroll (wheel, or the edge scroll above) moves
  // the lanes under a pointer that has not moved.
  useEffect(() => {
    if (!drag) return
    const onKey = (e) => {
      if (e.key === 'Escape') endDrag(false)
    }
    const onScroll = () => trackDrag()
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll)
    }
    // endDrag and trackDrag read everything they need from refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(drag)])

  useEffect(
    () => () => {
      if (dragRef.current) cancelAnimationFrame(dragRef.current.raf)
    },
    []
  )

  useEffect(() => {
    if (!settledId) return
    const t = setTimeout(() => setSettledId(null), 400)
    return () => clearTimeout(t)
  }, [settledId])

  // A card that changed lane is a new element, so focus is put back by hand.
  useEffect(() => {
    const id = focusAfter.current
    if (!id || drag) return
    focusAfter.current = null
    boardRef.current?.querySelector(`[data-entry="${CSS.escape(String(id))}"] [data-grip]`)?.focus()
  }, [entries, drag])

  // --- keyboard ----------------------------------------------------------------
  //
  // Lanes are stacked and cards run left to right inside one, so the arrows mean
  // what they look like: left/right is order within the tier, up/down is the
  // tier above or below. Going up lands at the end of that tier (the next best
  // after everyone already there), going down at the front.

  function onKeyDown(e, entry) {
    if (!editable) return
    const tierIdx = tiers.findIndex((t) => t.key === entry.tier)
    const lane = byTier[entry.tier] ?? []
    const pos = lane.findIndex((x) => x.id === entry.id)

    let target = null
    if (e.key === 'ArrowLeft' && pos > 0) target = [entry.tier, pos - 1]
    else if (e.key === 'ArrowRight' && pos > -1 && pos < lane.length - 1) target = [entry.tier, pos + 1]
    else if (e.key === 'ArrowUp' && tierIdx > 0) {
      const above = tiers[tierIdx - 1].key
      target = [above, (byTier[above] ?? []).length]
    } else if (e.key === 'ArrowDown' && tierIdx < tiers.length - 1) {
      target = [tiers[tierIdx + 1].key, 0]
    } else if (e.key === 'ArrowDown' && tierIdx === -1 && tiers.length) {
      // Out of an orphaned lane, into the last real tier.
      target = [tiers[tiers.length - 1].key, 0]
    }
    if (!target) return
    e.preventDefault()
    focusAfter.current = entry.id
    move(entry, target[0], target[1])
  }

  // --- AI ----------------------------------------------------------------------

  async function suggest() {
    setAiBusy(true)
    setAiError(null)
    const { data, error } = await askAi('picklist_help', { eventKey })
    setAiBusy(false)
    if (error) {
      setAiError(error)
      return
    }
    const answer = data?.answer ?? ''
    setProposal({
      answer,
      // The roster is what keeps "12 matches, avg 45" from being read as teams
      // 12 and 45: only numbers on this board count.
      offers: parseProposal(answer, tiers, new Set(entries.map((e) => e.team_number))),
      model: data?.model,
    })
  }

  async function acceptOffer(offer) {
    const entry = entries.find((e) => e.team_number === offer.teamNumber)
    if (!entry) return
    const lane = sortEntries(entries.filter((x) => x.tier === offer.tier && x.id !== entry.id))
    setSettledId(entry.id)
    await move(entry, offer.tier, lane.length)
  }

  // setPicklistLock records who froze the list (locked_by was never set from
  // here) and clears both stamps on unlock. A failure is shown, not swallowed —
  // a lead who believes the list is frozen when it is not is the worst case.
  async function toggleLock() {
    if (!list) return
    setActionError(null)
    const { data, error } = await setPicklistLock({
      id: list.id,
      locked: !list.is_locked,
      userId: user?.id,
    })
    if (error) {
      setActionError(error)
      return
    }
    // Laid over the list on screen, so a lock that landed but could not be read
    // back in full still shows as locked, with its name and tiers intact.
    setList((current) => ({ ...current, ...data }))
  }

  // --- render ------------------------------------------------------------------

  if (state.loading) return <Loading rows={5} label="Loading pick list" />
  if (state.error) return <ErrorState error={state.error} onRetry={load} />

  const picker = <EventPicker events={events} value={eventKey} onChange={setEventKey} />

  if (!eventKey) {
    return (
      <div className={styles.wrap}>
        {picker}
        <Empty icon="trophy" title="Pick an event">
          The pick list is per event — choose one and the board loads with every team on it.
        </Empty>
      </div>
    )
  }

  if (!list) {
    return (
      <div className={styles.wrap}>
        {picker}
        <Empty icon="trophy" title="No pick list for this event">
          A lead or mentor needs to open this first — the board is created on their first visit.
        </Empty>
      </div>
    )
  }

  const event = events.find((e) => e.key === eventKey)
  const eventName = event?.short_name || event?.name || eventKey
  const customName = list.name && list.name !== DEFAULT_NAME
  const lanes = [
    ...tiers.map((t, i) => ({
      ...t,
      entries: byTier[t.key] ?? [],
      tone: t.key === 'unranked' ? 'tier4' : `tier${Math.min(i, 4)}`,
    })),
    ...orphanTiers.map((t) => ({ ...t, tone: 'tierOrphan' })),
  ]
  const tierLabel = (key) => tiers.find((t) => t.key === key)?.label ?? key
  const cardProps = (entry) => ({
    entry,
    stat: stats[entry.team_number],
    nickname: nicknames[entry.team_number],
    canEdit,
    editable,
  })

  return (
    <div className={styles.wrap}>
      <header className={styles.head}>
        <div className={styles.headMain}>
          <h2 className={styles.listName}>{customName ? list.name : eventName}</h2>
          <span className={styles.listMeta}>
            {customName ? `${eventName} · ` : ''}
            {entries.length} {entries.length === 1 ? 'team' : 'teams'} on the board
            {canEdit ? '' : ' · read-only'}
          </span>
        </div>
        <div className={styles.headActions}>
          {picker}
          {canEdit && (
            <>
              <button
                type="button"
                className={`${styles.action} ${proposal ? styles.actionOn : ''}`}
                onClick={suggest}
                disabled={aiBusy}
              >
                {aiBusy ? (
                  <span className={portal.spinnerSm} aria-hidden="true" />
                ) : (
                  <Icon name="spark" size={15} />
                )}
                Ask AI
              </button>
              <button
                type="button"
                className={`${styles.action} ${list.is_locked ? '' : styles.actionLock}`}
                onClick={toggleLock}
              >
                {list.is_locked ? 'Unlock' : 'Lock list'}
              </button>
            </>
          )}
        </div>
      </header>

      {list.is_locked && <LockedBanner list={list} canEdit={canEdit} />}

      {actionError && (
        <div className={portal.adminAlert} role="alert">
          <Icon name="alert" size={16} />
          <span>{actionError}</span>
        </div>
      )}

      {aiError && (
        <p className={styles.aiError} role="alert">
          {aiError}
        </p>
      )}

      <Coverage coverage={coverage} unscouted={unscouted} />

      {/* Live region for moves — a screen reader user gets the same
          "3rd of 9 in A" a sighted user reads off the board. */}
      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>

      <div className={`${styles.split} ${proposal ? styles.splitOpen : ''}`}>
        <div
          className={`${styles.board} ${drag ? styles.boardDragging : ''}`}
          ref={boardRef}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => endDrag(true, e.pointerId)}
          onPointerCancel={(e) => endDrag(false, e.pointerId)}
        >
          {lanes.map((lane) => {
            const cards = drag ? lane.entries.filter((e) => e.id !== drag.entry.id) : lane.entries
            const landing = drag?.over?.tier === lane.key ? drag.over.index : -1
            const short = String(lane.label ?? '').length <= 2
            return (
              <section
                key={lane.key}
                className={`${styles.lane} ${styles[lane.tone]} ${landing >= 0 ? styles.laneActive : ''}`}
                data-tier={lane.key}
                aria-label={`${lane.label} tier, ${lane.entries.length} teams`}
              >
                <header className={styles.laneHead}>
                  <span className={`${styles.laneKey} ${short ? styles.laneKeyShort : ''}`}>
                    {lane.label}
                  </span>
                  <span className={styles.laneCount}>
                    {lane.entries.length} {lane.entries.length === 1 ? 'team' : 'teams'}
                    {lane.orphan ? ' · tier removed' : ''}
                  </span>
                </header>
                <ul className={styles.laneCards}>
                  {cards.map((entry, i) => [
                    landing === i && <Placeholder key="landing" drag={drag} />,
                    <TeamCard
                      key={entry.id}
                      {...cardProps(entry)}
                      settling={settledId === entry.id}
                      onGripDown={(e) => onPointerDown(e, entry)}
                      onGripKey={(e) => onKeyDown(e, entry)}
                      onSaveNote={(text) => saveNote(entry, text)}
                    />,
                  ])}
                  {landing >= cards.length && <Placeholder key="landing" drag={drag} />}
                  {!cards.length && landing < 0 && (
                    <li className={styles.laneEmpty}>
                      {editable ? 'Nobody here yet — drop a team in.' : 'Nobody here yet.'}
                    </li>
                  )}
                </ul>
              </section>
            )
          })}
        </div>

        {proposal && (
          <Proposal
            proposal={proposal}
            entries={entries}
            nicknames={nicknames}
            tierLabel={tierLabel}
            editable={editable}
            onAccept={acceptOffer}
            onDismiss={() => setProposal(null)}
          />
        )}
      </div>

      {editable && (
        <p className={styles.hint}>
          Drag a card by its handle. With a handle focused, <kbd>←</kbd> <kbd>→</kbd> reorder inside
          a tier and <kbd>↑</kbd> <kbd>↓</kbd> move it to the tier above or below. Each move saves
          as it lands.
        </p>
      )}

      {/* See THE PROBE at the top of this file. */}
      <span className={styles.probe} ref={probeRef} aria-hidden="true" />
      {drag && (
        <TeamCard
          {...cardProps(drag.entry)}
          overlay
          overlayRef={overlayRef}
          style={{ width: drag.width, height: drag.height }}
        />
      )}
    </div>
  )
}

function EventPicker({ events, value, onChange }) {
  return (
    <select
      className={`${portal.input} ${styles.eventSelect}`}
      aria-label="Event"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">Select an event…</option>
      {events.map((e) => (
        <option key={e.key} value={e.key}>
          {e.short_name || e.name}
        </option>
      ))}
    </select>
  )
}

function Placeholder({ drag }) {
  return <li className={styles.placeholder} style={{ minHeight: drag.height }} aria-hidden="true" />
}

function LockedBanner({ list, canEdit }) {
  const at = list.locked_at ? new Date(list.locked_at) : null
  const when =
    at && !Number.isNaN(at.getTime())
      ? at.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })
      : null
  return (
    <div className={`${styles.banner} ${styles.bannerLocked}`} role="status">
      <Icon name="alert" size={18} className={styles.bannerIcon} />
      <div className={styles.bannerMain}>
        <span className={styles.bannerTitle}>This list is locked{when ? ` — since ${when}` : ''}</span>
        <p className={styles.bannerText}>
          It is frozen as it was read out on the field: no card can be moved and no note changed.
          {canEdit ? ' Unlock it to carry on editing.' : ' A lead can unlock it.'}
        </p>
      </div>
    </div>
  )
}

// How much of the field the ranking rests on. A warning, not a block: a strategy
// group with four teams unscouted still has to build a list; they just need to
// know which four.
function Coverage({ coverage, unscouted }) {
  if (!coverage || !coverage.teams_at_event) return null
  const { teams_scouted: scouted, teams_at_event: total, fully_covered: full } = coverage
  const share = total ? scouted / total : 0
  const tone = full ? styles.bannerOk : share < 0.5 ? styles.bannerBad : styles.bannerWarn
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 'es'}`

  return (
    <section className={`${styles.banner} ${tone}`} aria-label="Scouting coverage">
      <Icon name={full ? 'check' : 'alert'} size={18} className={styles.bannerIcon} />
      <div className={styles.bannerMain}>
        <div className={styles.coverageFigure}>
          <span className={styles.coverageBig}>{scouted}</span>
          <span className={styles.coverageOf}>
            of {total} teams have match data
            {coverage.avg_matches != null ? ` · ${coverage.avg_matches} matches a team on average` : ''}
          </span>
        </div>
        <div className={styles.coverageTrack} aria-hidden="true">
          <span
            className={`${styles.coverageFill} ${full ? styles.coverageFillFull : ''}`}
            style={{ '--pct': share }}
          />
        </div>
        {full ? (
          <p className={styles.bannerText}>
            Every team has been watched at least once. The thinnest has{' '}
            {plural(coverage.min_matches, 'match')} behind it — cards with fewer than three are
            marked.
          </p>
        ) : (
          <>
            <p className={styles.bannerText}>
              {coverage.teams_unscouted === 1
                ? 'One team has no match data.'
                : `${coverage.teams_unscouted} teams have no match data.`}{' '}
              Their cards are marked — treat where they sit as a guess, not a ranking.
            </p>
            {unscouted.length > 0 && (
              <div className={styles.missingList}>
                <span className={styles.missingLabel}>Not scouted:</span>
                {unscouted.map((n) => (
                  <span key={n} className={styles.missingTeam}>
                    {n}
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}

function TeamCard({
  entry,
  stat,
  nickname,
  canEdit,
  editable,
  settling,
  overlay,
  overlayRef,
  style,
  onGripDown,
  onGripKey,
  onSaveNote,
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const matches = stat?.matches_scouted ?? 0
  const avg = stat?.avg_score
  const sd = stat?.score_stddev
  const confidence = confidenceOf(matches)

  // Spread relative to the average, and only once there are enough matches for
  // a spread to mean anything.
  const swing = matches >= 3 && sd != null && avg > 0 ? Number(sd) / Number(avg) : null
  const flags = []
  if (confidence === 'none') flags.push(['flagNone', 'No match data'])
  else if (confidence === 'thin') flags.push(['flagThin', 'Thin data'])
  if (swing != null && swing <= 0.2) flags.push(['flagSteady', 'Steady'])
  if (swing != null && swing >= 0.4) flags.push(['flagSwingy', 'Swingy'])
  if (stat?.breakdowns > 0) flags.push(['flagBad', `Broke ×${stat.breakdowns}`])
  if (stat?.no_shows > 0) flags.push(['flagBad', `No-show ×${stat.no_shows}`])
  if (entry.overrides_ai) flags.push(['flagOverride', 'Against AI'])

  const className = [
    styles.card,
    confidence === 'thin' ? styles.confThin : '',
    confidence === 'none' ? styles.confNone : '',
    overlay ? styles.cardDragging : '',
    settling ? styles.cardSettling : '',
  ].join(' ')

  function startEditing() {
    setDraft(entry.note ?? '')
    setEditing(true)
  }
  function commit() {
    setEditing(false)
    onSaveNote?.(draft)
  }

  // The copy in the hand is a picture of the card, not a second control.
  const Tag = overlay ? 'div' : 'li'

  return (
    <Tag
      className={className}
      style={style}
      ref={overlayRef}
      data-entry={overlay ? undefined : entry.id}
      aria-hidden={overlay ? 'true' : undefined}
    >
      {canEdit && (
        <button
          type="button"
          className={styles.grip}
          data-grip=""
          disabled={!editable && !overlay}
          tabIndex={overlay ? -1 : undefined}
          aria-label={`Move team ${entry.team_number}`}
          title={editable || overlay ? 'Drag, or use the arrow keys' : 'The list is locked'}
          onPointerDown={onGripDown}
          onKeyDown={onGripKey}
        >
          <span className={styles.gripDots} aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
          </span>
        </button>
      )}

      <div className={styles.cardBody}>
        <div className={styles.cardTop}>
          <span className={styles.cardNum}>{entry.team_number}</span>
          {nickname && <span className={styles.cardNick}>{nickname}</span>}
        </div>

        {matches > 0 && (
          <div className={styles.cardStats}>
            <span className={styles.statStrong}>{avg != null ? Number(avg).toFixed(1) : '—'}</span>
            <span>avg</span>
            {sd != null && <span className={styles.statV}>±{Number(sd).toFixed(1)}</span>}
          </div>
        )}

        <div className={styles.meterRow}>
          <div className={styles.meter} aria-hidden="true">
            {Array.from({ length: 10 }, (_, i) => (
              <span key={i} className={`${styles.meterSeg} ${i < matches ? styles.meterOn : ''}`} />
            ))}
          </div>
          <span className={styles.meterCount}>
            {matches} {matches === 1 ? 'match' : 'matches'}
          </span>
        </div>

        {flags.length > 0 && (
          <div className={styles.flags}>
            {flags.map(([tone, label]) => (
              <span key={label} className={`${styles.flag} ${styles[tone]}`}>
                {label}
              </span>
            ))}
          </div>
        )}

        {editing && !overlay ? (
          <div className={styles.note}>
            <textarea
              className={styles.noteInput}
              value={draft}
              maxLength={2000}
              autoFocus
              aria-label={`Note on team ${entry.team_number}`}
              placeholder="Why here? What to ask them?"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  setEditing(false)
                } else if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  commit()
                }
              }}
            />
            <div className={styles.noteActions}>
              <button type="button" className={styles.noteSave} onClick={commit}>
                Save note
              </button>
              <button type="button" className={styles.noteCancel} onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : entry.note ? (
          <div className={styles.note}>
            {editable && !overlay ? (
              <button
                type="button"
                className={styles.noteText}
                onClick={startEditing}
                title="Edit this note"
              >
                {entry.note}
              </button>
            ) : (
              <p className={styles.noteText}>{entry.note}</p>
            )}
          </div>
        ) : (
          editable &&
          !overlay && (
            <button type="button" className={styles.noteAdd} onClick={startEditing}>
              <Icon name="plus" size={13} />
              Note
            </button>
          )
        )}
      </div>
    </Tag>
  )
}

function Proposal({ proposal, entries, nicknames, tierLabel, editable, onAccept, onDismiss }) {
  // Grouped by the tier each line was read under, in the order the model gave.
  const groups = []
  for (const offer of proposal.offers) {
    let group = groups.find((g) => g.tier === offer.tier)
    if (!group) groups.push((group = { tier: offer.tier, offers: [] }))
    group.offers.push(offer)
  }
  const tierOf = (teamNumber) => entries.find((e) => e.team_number === teamNumber)?.tier

  return (
    <aside className={styles.proposal} aria-label="AI suggestion" data-lenis-prevent>
      <header className={styles.proposalHead}>
        <h3 className={styles.proposalTitle}>
          <Icon name="spark" size={16} /> AI suggestion
        </h3>
        <button type="button" className={styles.action} onClick={onDismiss}>
          Close
        </button>
      </header>

      {/* Verbatim, unparsed. The `ai` function is prompted to lead with sample
          size and to refuse to rank teams it cannot — summarising that here
          would delete the most valuable sentence on the screen. */}
      <pre className={styles.proposalAnswer}>{proposal.answer}</pre>

      {groups.length > 0 ? (
        <>
          <p className={styles.proposalNote}>
            The moves below were read out of that text line by line. Nothing is applied for you:
            accept them one at a time, after reading the line each came from.
          </p>
          <div>
            {groups.map((group) => (
              <div key={group.tier}>
                <div className={styles.offerGroup}>
                  <span className={styles.offerGroupName}>To {tierLabel(group.tier)}</span>
                  <span className={styles.offerGroupCount}>
                    {group.offers.length} {group.offers.length === 1 ? 'team' : 'teams'}
                  </span>
                </div>
                <ul className={styles.offers}>
                  {group.offers.map((o) => {
                    const from = tierOf(o.teamNumber)
                    const done = from === o.tier
                    return (
                      <li key={o.teamNumber} className={styles.offer}>
                        <div className={styles.offerMain}>
                          <span className={styles.offerTeam}>
                            {o.teamNumber}
                            {nicknames[o.teamNumber] ? ` ${nicknames[o.teamNumber]}` : ''}
                          </span>
                          {!done && from && (
                            <span className={styles.offerMove}>
                              {tierLabel(from)} → {tierLabel(o.tier)}
                            </span>
                          )}
                          <span className={styles.offerExcerpt}>{o.excerpt}</span>
                          {o.basis === 'ordinal' && (
                            <span className={styles.offerWeak}>
                              Tier matched by its position in the answer, not by name — check it.
                            </span>
                          )}
                        </div>
                        {done ? (
                          <span className={styles.offerDone}>In {tierLabel(o.tier)}</span>
                        ) : (
                          <button
                            type="button"
                            className={styles.accept}
                            onClick={() => onAccept(o)}
                            disabled={!editable}
                          >
                            Accept
                          </button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className={styles.proposalNote}>
          No tier-by-tier moves could be read out of that answer, so there is nothing to accept —
          place teams by hand from what it says.
        </p>
      )}
      {proposal.model && <span className={styles.proposalNote}>Model: {proposal.model}</span>}
    </aside>
  )
}
