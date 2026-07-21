// -----------------------------------------------------------------------------
// Minimal Markdown renderer for the knowledge base.
//
// Safe by construction: the input is HTML-escaped FIRST, then a fixed set of
// inline and block patterns is applied to the already-escaped text. There is no
// path by which author-supplied markup reaches the DOM as markup, so no
// sanitiser is needed and no `<script>`, event handler, or `javascript:` URL can
// survive. That ordering is the entire security argument — do not reverse it,
// and do not add a rule that re-emits raw input.
//
// It deliberately supports a subset: headings, bold, italic, inline code, fenced
// code, links, lists, blockquotes, and rules. Anything else renders as plain
// text rather than silently producing wrong output.
// -----------------------------------------------------------------------------

// Sentinel for the inline-code round trip. A readable placeholder like ` CODE0 `
// would be forgeable: an author typing that exact string produces a token the
// restore step then resolves against an array that never held it — yielding
// `<code>undefined</code>`, or resolving to a different span's contents. U+E000
// is a private-use codepoint with no keyboard route, and it is stripped from the
// input before parsing, so a forged token cannot exist when substitution runs.
const SENTINEL = ''

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Whitelist, not blacklist. Only http(s), mailto, and same-document/relative
// targets survive; javascript:, data:, vbscript: and anything unrecognised are
// dropped and the link renders as inert text.
function safeUrl(url) {
  const trimmed = url.trim()
  // `/` allows a same-site path but must NOT allow `//evil.com` — a protocol-
  // relative URL looks internal in the source and silently resolves offsite.
  // The backslash form matters too: browsers normalise `/\` to `//` during URL
  // parsing, so `/\evil.com` is the same bypass wearing a different hat.
  if (/^\/[/\\]/.test(trimmed)) return null
  if (/^(https?:\/\/|mailto:|#|\/)/i.test(trimmed)) return trimmed
  return null
}

function inline(text) {
  let out = text

  // Inline code first, so formatting characters inside a code span are not then
  // interpreted as formatting.
  const codes = []
  out = out.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code)
    return SENTINEL + (codes.length - 1) + SENTINEL
  })

  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    const safe = safeUrl(url)
    if (!safe) return label
    const external = /^https?:\/\//i.test(safe)
    // `safe` is already HTML-escaped (escapeHtml ran over the whole document
    // before this), so a quote inside it is &quot; and cannot close the
    // attribute. noopener is required with target=_blank — without it the
    // opened page gets a handle back to this one via window.opener.
    return `<a href="${safe}"${
      external ? ' target="_blank" rel="noopener noreferrer"' : ''
    }>${label}</a>`
  })

  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')

  out = out.replace(
    new RegExp(SENTINEL + '(\\d+)' + SENTINEL, 'g'),
    (_, i) => `<code>${codes[Number(i)]}</code>`
  )
  return out
}

export function renderMarkdown(src) {
  // Strip the sentinel from the source before anything else — this is what makes
  // the placeholder unforgeable.
  const cleaned = String(src ?? '').split(SENTINEL).join('')
  const escaped = escapeHtml(cleaned)
  const lines = escaped.split('\n')
  const html = []
  let listType = null
  let inCode = false
  let codeBuffer = []

  const closeList = () => {
    if (listType) {
      html.push(listType === 'ul' ? '</ul>' : '</ol>')
      listType = null
    }
  }

  for (const line of lines) {
    const fence = line.match(/^```(\w*)\s*$/)
    if (fence) {
      if (inCode) {
        html.push(`<pre><code>${codeBuffer.join('\n')}</code></pre>`)
        codeBuffer = []
        inCode = false
      } else {
        closeList()
        inCode = true
      }
      continue
    }
    if (inCode) {
      codeBuffer.push(line)
      continue
    }

    if (!line.trim()) {
      closeList()
      continue
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    if (heading) {
      closeList()
      const level = heading[1].length + 1 // h1 is the page title; docs start at h2
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      continue
    }

    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      closeList()
      html.push('<hr />')
      continue
    }

    // `&gt;` not `>` — escapeHtml has already run over the whole document by
    // this point, so a leading blockquote marker is no longer a bare `>`.
    // Testing for the raw character here silently disabled blockquotes entirely.
    const quote = line.match(/^&gt;\s?(.*)$/)
    if (quote) {
      closeList()
      html.push(`<blockquote>${inline(quote[1])}</blockquote>`)
      continue
    }

    const ul = line.match(/^\s*[-*]\s+(.*)$/)
    if (ul) {
      if (listType !== 'ul') {
        closeList()
        html.push('<ul>')
        listType = 'ul'
      }
      html.push(`<li>${inline(ul[1])}</li>`)
      continue
    }

    const ol = line.match(/^\s*\d+\.\s+(.*)$/)
    if (ol) {
      if (listType !== 'ol') {
        closeList()
        html.push('<ol>')
        listType = 'ol'
      }
      html.push(`<li>${inline(ol[1])}</li>`)
      continue
    }

    closeList()
    html.push(`<p>${inline(line)}</p>`)
  }

  // An unterminated fence still has to emit its content, or the tail of the
  // document silently disappears.
  if (inCode && codeBuffer.length) {
    html.push(`<pre><code>${codeBuffer.join('\n')}</code></pre>`)
  }
  closeList()

  return html.join('\n')
}
