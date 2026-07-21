import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../../Icon'
import { useAuth } from '../../../lib/auth'
import { supabase } from '../../../lib/supabase'
import { listEvents, teamStats, askAi } from '../../../lib/scoutingApi'
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
// -----------------------------------------------------------------------------

const DEFAULT_TIERS = [
  { key: 's', label: 'S' },
  { key: 'a', label: 'A' },
  { key: 'b', label: 'B' },
  { key: 'c', label: 'C' },
  { key: 'unranked', label: 'Unranked' },
]

export default function PickList() {
  const { atLeast } = useAuth()
  const canEdit = atLeast('lead')

  const [eventKey, setEventKey] = useState(() => localStorage.getItem('frc5805.event') ?? '')
  const [events, setEvents] = useState([])
  const [list, setList] = useState(null)
  const [entries, setEntries] = useState([])
  const [stats, setStats] = useState({})
  const [coverage, setCoverage] = useState(null)
  const [state, setState] = useState({ loading: true, error: null })
  const [announce, setAnnounce] = useState('')
  const [drag, setDrag] = useState(null)
  const [proposal, setProposal] = useState(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState(null)
  const boardRef = useRef(null)

  const tiers = list?.tiers?.length ? list.tiers : DEFAULT_TIERS

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

    const [{ data: lists }, { data: st }, cov] = await Promise.all([
      supabase.from('picklists').select('*').eq('event_key', eventKey).order('updated_at', { ascending: false }).limit(1),
      teamStats(eventKey),
      supabase.from('event_scout_coverage').select('*').eq('event_key', eventKey).maybeSingle(),
    ])

    setStats(Object.fromEntries((st ?? []).map((s) => [s.team_number, s])))
    setCoverage(cov?.data ?? null)

    let current = lists?.[0] ?? null

    // Create on first visit rather than showing an empty-state button. The list
    // is the point of the screen, and one fewer click at 4pm on a Saturday is
    // worth more than the tidiness of an explicit "create" step.
    if (!current && canEdit) {
      const { data: made, error } = await supabase
        .from('picklists')
        .insert({ event_key: eventKey, name: 'Pick list' })
        .select()
        .single()
      if (error) {
        setState({ loading: false, error: error.message })
        return
      }
      current = made
    }
    if (!current) {
      setState({ loading: false, error: null })
      setList(null)
      return
    }

    const { data: rows } = await supabase
      .from('picklist_entries')
      .select('*')
      .eq('picklist_id', current.id)

    // Seed from the roster on first open so the board starts populated rather
    // than making someone add sixty teams by hand.
    let seeded = rows ?? []
    if (!seeded.length && canEdit) {
      const { data: teamRows } = await supabase
        .from('event_teams')
        .select('team_number')
        .eq('event_key', eventKey)
        .order('team_number')
      if (teamRows?.length) {
        const payload = teamRows.map((t, i) => ({
          picklist_id: current.id,
          team_number: t.team_number,
          tier: 'unranked',
          position: (i + 1) * 10,
        }))
        const { data: inserted } = await supabase.from('picklist_entries').insert(payload).select()
        seeded = inserted ?? []
      }
    }

    setList(current)
    setEntries(seeded)
    setState({ loading: false, error: null })
  }, [eventKey, canEdit])

  useEffect(() => {
    load()
  }, [load])

  const byTier = useMemo(() => {
    const out = {}
    for (const t of tiers) out[t.key] = sortEntries(entries.filter((e) => e.tier === t.key))
    return out
  }, [entries, tiers])

  // --- moving -----------------------------------------------------------------

  async function move(entry, toTier, toIndex) {
    if (!canEdit || list?.is_locked) return

    const siblings = sortEntries(
      entries.filter((e) => e.tier === toTier && e.id !== entry.id)
    )
    const plan = planMove(siblings, entry, toIndex)

    // Optimistic. The board must respond to the finger immediately; a drag that
    // waits on a round trip feels broken on a venue network.
    const optimistic = plan.respace
      ? entries.map((e) => {
          const r = plan.rows.find((x) => x.id === e.id)
          return r ? { ...e, tier: toTier, position: r.position } : e
        })
      : entries.map((e) => (e.id === entry.id ? { ...e, tier: toTier, position: plan.position } : e))
    setEntries(optimistic)

    const { index, size } = locate(optimistic, toTier, entry.id)
    const tierLabel = tiers.find((t) => t.key === toTier)?.label ?? toTier
    setAnnounce(`Team ${entry.team_number} moved to ${tierLabel}, position ${index + 1} of ${size}`)

    const { error } = plan.respace
      ? await supabase.from('picklist_entries').upsert(
          plan.rows.map((r) => ({ ...r, tier: toTier })),
          { onConflict: 'id' }
        )
      : await supabase
          .from('picklist_entries')
          .update({ tier: toTier, position: plan.position })
          .eq('id', entry.id)

    if (error) {
      // Locked lists are rejected by a trigger (migration 0006). Say which,
      // rather than a generic failure — the fix is different for each.
      setState((s) => ({
        ...s,
        error: /locked/i.test(error.message)
          ? 'This list is locked. Unlock it to make changes.'
          : error.message,
      }))
      load()
    }
  }

  // --- pointer drag ------------------------------------------------------------

  function onPointerDown(e, entry) {
    if (!canEdit || list?.is_locked) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({ entry, x: e.clientX, y: e.clientY, over: null, moved: false })
  }

  function onPointerMove(e) {
    if (!drag) return
    const moved = drag.moved || Math.abs(e.clientY - drag.y) + Math.abs(e.clientX - drag.x) > 6
    // elementFromPoint rather than tracking rects: tiers scroll independently and
    // cached geometry goes stale the moment one does.
    const el = document.elementFromPoint(e.clientX, e.clientY)
    const lane = el?.closest('[data-tier]')
    const card = el?.closest('[data-entry]')
    setDrag({
      ...drag,
      moved,
      x: e.clientX,
      y: e.clientY,
      over: lane ? { tier: lane.dataset.tier, beforeId: card?.dataset.entry ?? null } : null,
    })
  }

  function onPointerUp() {
    if (!drag) return
    const d = drag
    setDrag(null)
    if (!d.moved || !d.over) return

    const lane = sortEntries(entries.filter((x) => x.tier === d.over.tier && x.id !== d.entry.id))
    const idx = d.over.beforeId ? lane.findIndex((x) => x.id === d.over.beforeId) : lane.length
    move(d.entry, d.over.tier, idx < 0 ? lane.length : idx)
  }

  // --- keyboard ----------------------------------------------------------------

  function onKeyDown(e, entry) {
    if (!canEdit || list?.is_locked) return
    const tierIdx = tiers.findIndex((t) => t.key === entry.tier)
    const lane = byTier[entry.tier] ?? []
    const pos = lane.findIndex((x) => x.id === entry.id)

    if (e.key === 'ArrowUp' && pos > 0) {
      e.preventDefault()
      move(entry, entry.tier, pos - 1)
    } else if (e.key === 'ArrowDown' && pos < lane.length - 1) {
      e.preventDefault()
      move(entry, entry.tier, pos + 1)
    } else if (e.key === 'ArrowLeft' && tierIdx > 0) {
      e.preventDefault()
      move(entry, tiers[tierIdx - 1].key, 0)
    } else if (e.key === 'ArrowRight' && tierIdx < tiers.length - 1) {
      e.preventDefault()
      move(entry, tiers[tierIdx + 1].key, 0)
    }
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
      offers: parseProposal(answer, tiers, entries.map((e) => e.team_number)),
      model: data?.model,
    })
  }

  async function acceptOffer(offer) {
    const entry = entries.find((e) => e.team_number === offer.team)
    if (!entry) return
    const lane = sortEntries(entries.filter((x) => x.tier === offer.tier && x.id !== entry.id))
    await move(entry, offer.tier, lane.length)
    setProposal((p) =>
      p ? { ...p, offers: p.offers.filter((o) => o.team !== offer.team) } : p
    )
  }

  async function toggleLock() {
    if (!list) return
    const next = !list.is_locked
    const { data, error } = await supabase
      .from('picklists')
      .update({
        is_locked: next,
        locked_at: next ? new Date().toISOString() : null,
      })
      .eq('id', list.id)
      .select()
      .single()
    if (!error) setList(data)
  }

  // --- render ------------------------------------------------------------------

  if (state.loading) return <Loading rows={5} label="Loading pick list" />
  if (state.error) return <ErrorState error={state.error} onRetry={load} />

  if (!eventKey) {
    return (
      <div className={portal.stack}>
        <EventPicker events={events} value={eventKey} onChange={setEventKey} />
        <Empty icon="bars" title="Pick an event">
          The pick list is per event — choose one and the board loads with every team on it.
        </Empty>
      </div>
    )
  }

  if (!list) {
    return (
      <div className={portal.stack}>
        <EventPicker events={events} value={eventKey} onChange={setEventKey} />
        <Empty icon="bars" title="No pick list for this event">
          A lead or mentor needs to open this first — the board is created on their first visit.
        </Empty>
      </div>
    )
  }

  return (
    <div className={portal.stack}>
      <EventPicker events={events} value={eventKey} onChange={setEventKey} />

      {coverage && !coverage.fully_covered && (
        /* A warning, not a block. A strategy group with four teams unscouted
           still has to build a list; they just need to know which four. */
        <p className={styles.coverageWarn}>
          <Icon name="alert" size={15} />
          {coverage.teams_scouted} of {coverage.teams_at_event} teams scouted —{' '}
          <strong>{coverage.teams_unscouted}</strong> have no match data. Cards for those teams
          are marked; treat their placement as a guess.
        </p>
      )}

      <div className={styles.toolbar}>
        <span className={styles.listName}>{list.name}</span>
        {list.is_locked && (
          <span className={styles.lockedChip}>
            <Icon name="alert" size={13} /> Locked
          </span>
        )}
        {canEdit && (
          <>
            <button type="button" className={styles.toolBtn} onClick={suggest} disabled={aiBusy}>
              {aiBusy ? <span className={portal.spinnerSm} aria-hidden="true" /> : <Icon name="spark" size={15} />}
              Ask AI
            </button>
            <button type="button" className={styles.toolBtn} onClick={toggleLock}>
              {list.is_locked ? 'Unlock' : 'Lock'}
            </button>
          </>
        )}
      </div>

      {aiError && <p className={styles.aiError}>{aiError}</p>}

      {proposal && (
        <Proposal
          proposal={proposal}
          tiers={tiers}
          onAccept={acceptOffer}
          onDismiss={() => setProposal(null)}
        />
      )}

      {/* Live region for keyboard moves — a screen reader user gets the same
          "3rd of 9 in A" a sighted user reads off the board. */}
      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>

      <div className={styles.board} ref={boardRef} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        {tiers.map((t) => (
          <section
            key={t.key}
            className={`${styles.tier} ${drag?.over?.tier === t.key ? styles.tierOver : ''}`}
            data-tier={t.key}
          >
            <header className={styles.tierHead}>
              <span className={`${styles.tierBadge} ${styles[`tier_${t.key}`] ?? ''}`}>{t.label}</span>
              <span className={styles.tierCount}>{byTier[t.key]?.length ?? 0}</span>
            </header>
            <ul className={styles.lane}>
              {(byTier[t.key] ?? []).map((entry) => (
                <TeamCard
                  key={entry.id}
                  entry={entry}
                  stat={stats[entry.team_number]}
                  dragging={drag?.entry?.id === entry.id}
                  editable={canEdit && !list.is_locked}
                  onPointerDown={(e) => onPointerDown(e, entry)}
                  onKeyDown={(e) => onKeyDown(e, entry)}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}

function EventPicker({ events, value, onChange }) {
  return (
    <select className={portal.input} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Select an event…</option>
      {events.map((e) => (
        <option key={e.key} value={e.key}>
          {e.short_name || e.name}
        </option>
      ))}
    </select>
  )
}

function TeamCard({ entry, stat, dragging, editable, onPointerDown, onKeyDown }) {
  const matches = stat?.matches_scouted ?? 0
  const avg = stat?.avg_score
  const sd = stat?.score_stddev

  // Thin data must not look like thick data. A team with one match and a team
  // with twelve rendered identically is how a bad pick gets made confidently.
  const confidence = matches === 0 ? 'none' : matches < 3 ? 'thin' : matches < 6 ? 'some' : 'good'

  return (
    <li
      className={`${styles.card} ${dragging ? styles.cardDragging : ''} ${styles[`conf_${confidence}`]}`}
      data-entry={entry.id}
      tabIndex={editable ? 0 : -1}
      role={editable ? 'button' : undefined}
      aria-label={`Team ${entry.team_number}, ${matches} matches scouted`}
      onPointerDown={editable ? onPointerDown : undefined}
      onKeyDown={editable ? onKeyDown : undefined}
    >
      <span className={styles.cardTeam}>{entry.team_number}</span>
      <span className={styles.cardStats}>
        {matches === 0 ? (
          <span className={styles.noData}>no data</span>
        ) : (
          <>
            <span className={styles.cardAvg}>{avg != null ? Number(avg).toFixed(1) : '—'}</span>
            {sd != null && <span className={styles.cardSd}>±{Number(sd).toFixed(1)}</span>}
            <span className={styles.cardN}>{matches}m</span>
          </>
        )}
      </span>
      {entry.overrides_ai && (
        <span className={styles.overrideDot} title="Placed against the AI's suggestion" />
      )}
    </li>
  )
}

function Proposal({ proposal, tiers, onAccept, onDismiss }) {
  return (
    <aside className={styles.proposal}>
      <header className={styles.proposalHead}>
        <h3 className={styles.proposalTitle}>
          <Icon name="spark" size={16} /> AI suggestion
        </h3>
        <button type="button" className={styles.toolBtn} onClick={onDismiss}>
          <Icon name="close" size={14} />
        </button>
      </header>

      {/* Verbatim, unparsed. The edge function is prompted to lead with sample
          size and to refuse to rank teams it cannot — summarising that here
          would delete the most valuable sentence on the screen. */}
      <div className={styles.proposalBody}>
        {proposal.answer.split('\n').map((line, i) => (
          <p key={i}>{line}</p>
        ))}
      </div>

      {proposal.offers.length > 0 && (
        <>
          <span className={styles.offersLabel}>
            Suggested moves — accept individually, after reading the line it came from
          </span>
          <ul className={styles.offers}>
            {proposal.offers.map((o) => (
              <li key={o.team} className={styles.offer}>
                <span className={styles.offerTeam}>{o.team}</span>
                <span className={styles.offerArrow}>→</span>
                <span className={styles.offerTier}>
                  {tiers.find((t) => t.key === o.tier)?.label ?? o.tier}
                </span>
                <span className={styles.offerSource}>{o.source}</span>
                <button type="button" className={styles.acceptBtn} onClick={() => onAccept(o)}>
                  Accept
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {proposal.model && <span className={styles.proposalModel}>{proposal.model}</span>}
    </aside>
  )
}
