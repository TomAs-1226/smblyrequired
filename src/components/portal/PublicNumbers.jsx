import p from './PublicNumbers.module.css'

// One team's public numbers on one line: EPA and its three phases from
// Statbotics, OPR from The Blue Alliance, rank and record. Used wherever a team
// is shown and our own scouting may be thin. It always names its source, and it
// renders nothing at all when there is no public row — a supplement, never a gap.

const fmt = (v) => (v == null ? null : Number(v).toFixed(1))

export default function PublicNumbers({ team, compact = false, epaOnly = false }) {
  if (!team) return null
  const { epa, record, opr } = team
  const cells = [
    ['EPA', fmt(epa?.total), true],
    ['Auto', fmt(epa?.auto)],
    ['Teleop', fmt(epa?.teleop)],
    ['End', fmt(epa?.endgame)],
    ['OPR', fmt(opr)],
    ['Rank', record?.rank != null ? `${record.rank}${record.num_teams ? ` of ${record.num_teams}` : ''}` : null],
    ['Record', record?.played ? `${record.wins}–${record.losses}${record.ties ? `–${record.ties}` : ''}` : null],
  ].filter(([, value]) => value != null)
  if (!cells.length) return null
  // Compact is for a row in a list: the headline number and where the team stands.
  // epaOnly is for a page that already shows rank, record and OPR from the field's own record.
  const PHASES = ['EPA', 'Auto', 'Teleop', 'End']
  const shown = compact
    ? [
        ...cells.filter(([label]) => label === 'EPA'),
        // On a card there is room for one line: the estimate and where the team stands.
        ...(record?.rank != null ? [['Rank', String(record.rank)]] : []),
      ]
    : epaOnly
      ? cells.filter(([label]) => PHASES.includes(label))
      : cells
  if (!shown.length) return null
  return (
    <div
      className={`${p.strip} ${compact ? p.compact : ''}`}
      title={compact ? 'Statbotics EPA and event rank: estimated from match scores, not scouted' : undefined}
    >
      <dl className={p.cells} aria-label="Public data, estimated from match scores">
        {shown.map(([label, value, lead]) => (
          <div key={label} className={`${p.cell} ${lead ? p.lead : ''}`}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {!compact && (
        <p className={p.from}>
          Statbotics{opr != null && !epaOnly ? ' · The Blue Alliance' : ''} — estimated from match scores, not scouted
        </p>
      )}
    </div>
  )
}
