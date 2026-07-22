// -----------------------------------------------------------------------------
// CSV export — dependency-free, RFC 4180.
//
// `toCsv` turns rows plus a column spec into a correctly-escaped CSV string;
// `downloadCsv` hands that string to the browser as a file. No library, because
// the whole job is a dozen lines of escaping and one Blob — and a dependency for
// that is a dependency to keep patched forever.
// -----------------------------------------------------------------------------

// RFC 4180 §2: a field is quoted only when it must be — when it contains a comma,
// a double quote, or a line break — and inside a quoted field every double quote
// is doubled. Getting this wrong is silent: the file still opens, the columns are
// simply shifted by one wherever a value happened to hold a comma.
function cell(value) {
  if (value == null) return ''
  // A jsonb value can itself be an object or array; JSON is a far more useful
  // cell than the "[object Object]" that String() would produce.
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * Build a CSV string.
 *
 * `columns` is an array of either a bare string (used as both the row key and
 * the header) or `{ key, header?, value? }`, where `value(row)` is an accessor
 * for cells that are not a plain property — a dynamic jsonb field, a formatted
 * date, a joined name.
 */
export function toCsv(rows, columns) {
  const cols = (columns ?? []).map((col) => (typeof col === 'string' ? { key: col } : col))
  const head = cols.map((col) => cell(col.header ?? col.key)).join(',')
  const body = (rows ?? []).map((row) =>
    cols.map((col) => cell(col.value ? col.value(row) : row?.[col.key])).join(',')
  )
  // CRLF is the line terminator RFC 4180 specifies, and the one Excel expects.
  return [head, ...body].join('\r\n')
}

/**
 * Trigger a browser download of `csvString` as `filename`.
 */
export function downloadCsv(filename, csvString) {
  // The UTF-8 BOM makes Excel read the file as UTF-8; without it any accented
  // name or non-ASCII note becomes mojibake in the one program most people open
  // a CSV in. It is a deliberate three-byte prefix, not part of the data.
  const blob = new Blob(['\uFEFF', csvString], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  // Firefox will not fire a synthetic click on an anchor that is not in the DOM.
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoke on the next tick — revoking synchronously can cancel the download
  // before the browser has finished reading the object URL.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
