// Parameter validation for the proxies.
//
// Each of these is the only thing standing between a caller-supplied value and a
// URL signed with one of our keys, so they are strict rather than forgiving.

const scalar = (v) => typeof v === 'number' || typeof v === 'string'

export function asYear(v) {
  const n = scalar(v) ? Number(v) : NaN
  return Number.isInteger(n) && n >= 1992 && n <= 2100 ? n : null
}

export function asEventKey(v) {
  const s = scalar(v) ? String(v).trim().toLowerCase() : ''
  return /^\d{4}[a-z0-9]{1,20}$/.test(s) ? s : null
}

export function asTeamNumber(v) {
  const n = scalar(v) && String(v).trim() !== '' ? Number(v) : NaN
  return Number.isInteger(n) && n > 0 && n < 100000 ? n : null
}

export function asText(v, max) {
  const s = scalar(v) ? String(v).trim() : ''
  return s && s.length <= max ? s : null
}
