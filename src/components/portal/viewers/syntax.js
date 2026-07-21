// -----------------------------------------------------------------------------
// Minimal syntax highlighter for the portal's file viewers.
//
// SECURITY: this module never produces markup. It produces a token stream —
// `[{ t: 'kw', v: 'class' }, …]` — and CodeViewer renders each token's `v` as a
// React *text node* inside a <span>. React escapes text nodes, so there is no
// step at which file content is interpreted as HTML, and therefore no need for
// (and no reliance on) an escaping pass.
//
// That is a stronger guarantee than the escape-then-format ordering in
// lib/markdown.js, and it is deliberate: markdown has to emit real elements to
// do its job, whereas highlighting only ever needs to *classify spans of text*.
// A `.js` file containing `</script><img onerror=alert(1)>` tokenizes to plain
// text and renders as those literal characters.
//
// If you ever change this to return an HTML string, you have reintroduced the
// exact class of bug the token stream exists to make impossible.
//
// It is a scanner, not a parser: it understands comments, strings, numbers, and
// keyword lists. It does not understand scope, and it will occasionally colour
// something that is not what it claims. That is an acceptable trade for ~4 kB
// and no dependency — this is for reading a file, not for editing one.
// -----------------------------------------------------------------------------

const WORDS = {
  java:
    'abstract assert boolean break byte case catch char class const continue default do double ' +
    'else enum extends final finally float for goto if implements import instanceof int interface ' +
    'long native new package private protected public return short static strictfp super switch ' +
    'synchronized this throw throws transient try void volatile while var record yield sealed ' +
    'permits true false null',
  kotlin:
    'as break class continue do else false for fun if in interface is null object package return ' +
    'super this throw true try typealias typeof val var when while by catch constructor delegate ' +
    'dynamic field file finally get import init param property receiver set setparam value where ' +
    'abstract actual annotation companion const crossinline data enum expect external final infix ' +
    'inline inner internal lateinit noinline open operator out override private protected public ' +
    'reified sealed suspend tailrec vararg',
  javascript:
    'async await break case catch class const continue debugger default delete do else export ' +
    'extends finally for from function get if import in instanceof let new of return set static ' +
    'super switch this throw try typeof var void while with yield true false null undefined',
  typescript:
    'async await break case catch class const continue debugger declare default delete do else ' +
    'enum export extends finally for from function get if implements import in infer instanceof ' +
    'interface is keyof let namespace new of readonly return satisfies set static super switch ' +
    'this throw try type typeof var void while yield true false null undefined any string number ' +
    'boolean unknown never',
  python:
    'and as assert async await break class continue def del elif else except finally for from ' +
    'global if import in is lambda nonlocal not or pass raise return try while with yield True ' +
    'False None self match case',
  cpp:
    'alignas alignof auto bool break case catch char class const constexpr continue default delete ' +
    'do double else enum explicit export extern false float for friend goto if inline int long ' +
    'mutable namespace new noexcept nullptr operator private protected public register return ' +
    'short signed sizeof static struct switch template this throw true try typedef typename union ' +
    'unsigned using virtual void volatile while include define ifndef endif pragma',
  sql:
    'select from where insert into values update set delete create table alter drop index view ' +
    'join inner left right outer full on group by order having limit offset union all as distinct ' +
    'and or not null is in exists between like primary key foreign references default check ' +
    'constraint unique cascade returning with begin commit rollback grant revoke true false',
  css: '',
  yaml: 'true false null yes no on off',
  toml: 'true false',
  properties: '',
  shell:
    'if then else elif fi for while do done case esac function return in export local readonly ' +
    'set unset shift source echo cd exit trap',
  json: 'true false null',
  markup: '',
  markdown: '',
  text: '',
}

function wordSet(lang) {
  const src = WORDS[lang] ?? ''
  return new Set(src ? src.split(/\s+/) : [])
}

// Per-dialect comment and string syntax. `esc` is whether a backslash escapes
// the next character inside a string — it does not in TOML/properties/YAML-ish
// configs, where a Windows path in a value would otherwise swallow the closing
// quote and paint the rest of the file as a string.
const DIALECTS = {
  java: { line: ['//'], block: ['/*', '*/'], quotes: ['"', "'"], esc: true },
  kotlin: { line: ['//'], block: ['/*', '*/'], quotes: ['"', "'"], esc: true },
  javascript: { line: ['//'], block: ['/*', '*/'], quotes: ['"', "'", '`'], esc: true },
  typescript: { line: ['//'], block: ['/*', '*/'], quotes: ['"', "'", '`'], esc: true },
  cpp: { line: ['//'], block: ['/*', '*/'], quotes: ['"', "'"], esc: true },
  css: { line: [], block: ['/*', '*/'], quotes: ['"', "'"], esc: true },
  sql: { line: ['--'], block: ['/*', '*/'], quotes: ["'", '"'], esc: false },
  python: { line: ['#'], block: null, quotes: ['"', "'"], esc: true, triple: true },
  shell: { line: ['#'], block: null, quotes: ['"', "'"], esc: true },
  yaml: { line: ['#'], block: null, quotes: ['"', "'"], esc: true },
  toml: { line: ['#'], block: null, quotes: ['"', "'"], esc: false },
  properties: { line: ['#', '!'], block: null, quotes: [], esc: false },
  json: { line: [], block: null, quotes: ['"'], esc: true },
  text: { line: [], block: null, quotes: [], esc: false },
}

const IDENT_START = /[A-Za-z_$@]/
const IDENT = /[A-Za-z0-9_$]/
const DIGIT = /[0-9]/

// --- the scanner ------------------------------------------------------------

function scanCode(src, lang) {
  const d = DIALECTS[lang] ?? DIALECTS.text
  const keywords = wordSet(lang)
  const out = []
  const n = src.length
  let plain = ''
  let i = 0

  const flush = () => {
    if (plain) {
      out.push({ t: 'x', v: plain })
      plain = ''
    }
  }
  const push = (t, v) => {
    flush()
    out.push({ t, v })
  }

  while (i < n) {
    const ch = src[i]

    // Line comment.
    let matched = false
    for (const lc of d.line) {
      if (src.startsWith(lc, i)) {
        let j = src.indexOf('\n', i)
        if (j < 0) j = n
        push('c', src.slice(i, j))
        i = j
        matched = true
        break
      }
    }
    if (matched) continue

    // Block comment. An unterminated one runs to EOF rather than throwing —
    // truncated files are a real thing and must still render.
    if (d.block && src.startsWith(d.block[0], i)) {
      const close = src.indexOf(d.block[1], i + d.block[0].length)
      const end = close < 0 ? n : close + d.block[1].length
      push('c', src.slice(i, end))
      i = end
      continue
    }

    // Python triple-quoted strings, checked before the single-quote rule so the
    // opening `"""` is not consumed as an empty string followed by a quote.
    if (d.triple && (src.startsWith('"""', i) || src.startsWith("'''", i))) {
      const q = src.slice(i, i + 3)
      const close = src.indexOf(q, i + 3)
      const end = close < 0 ? n : close + 3
      push('s', src.slice(i, end))
      i = end
      continue
    }

    // String.
    if (d.quotes.includes(ch)) {
      let j = i + 1
      while (j < n) {
        if (d.esc && src[j] === '\\') {
          j += 2
          continue
        }
        if (src[j] === ch) {
          j += 1
          break
        }
        // A bare newline ends a single-line string. Without this an unbalanced
        // quote paints the remainder of the file, which is how a highlighter
        // ends up looking broken on one typo.
        if (src[j] === '\n' && ch !== '`') break
        j += 1
      }
      push('s', src.slice(i, Math.min(j, n)))
      i = Math.min(j, n)
      continue
    }

    // Number.
    if (DIGIT.test(ch)) {
      let j = i
      while (j < n && /[0-9a-fA-FxXbBoO._]/.test(src[j])) j += 1
      push('n', src.slice(i, j))
      i = j
      continue
    }

    // Identifier / keyword.
    if (IDENT_START.test(ch)) {
      let j = i + 1
      while (j < n && IDENT.test(src[j])) j += 1
      const word = src.slice(i, j)
      if (keywords.has(word)) push('k', word)
      else plain += word
      i = j
      continue
    }

    plain += ch
    i += 1
  }

  flush()
  return out
}

// --- markup (html / xml / svg) ----------------------------------------------
// Source view only. Rendering markup is HtmlViewer's job, and it only ever
// happens inside a sandboxed iframe.

function scanMarkup(src) {
  const out = []
  const n = src.length
  let plain = ''
  let i = 0

  const flush = () => {
    if (plain) {
      out.push({ t: 'x', v: plain })
      plain = ''
    }
  }
  const push = (t, v) => {
    flush()
    out.push({ t, v })
  }

  while (i < n) {
    if (src.startsWith('<!--', i)) {
      const close = src.indexOf('-->', i)
      const end = close < 0 ? n : close + 3
      push('c', src.slice(i, end))
      i = end
      continue
    }

    if (src[i] === '<') {
      let j = src.indexOf('>', i)
      if (j < 0) j = n - 1
      const tag = src.slice(i, j + 1)
      // Split the tag into name / attribute / value runs so an attribute value
      // reads differently from the element name, the way a real editor shows it.
      const parts = tag.split(/(\"[^\"]*\"|'[^']*')/)
      let first = true
      for (const part of parts) {
        if (!part) continue
        if (/^["']/.test(part)) {
          push('s', part)
        } else if (first) {
          const m = part.match(/^(<\/?[\w:.-]*)(.*)$/s)
          if (m) {
            push('k', m[1])
            if (m[2]) push('a', m[2])
          } else {
            push('k', part)
          }
          first = false
        } else {
          push('a', part)
        }
      }
      i = j + 1
      continue
    }

    plain += src[i]
    i += 1
  }

  flush()
  return out
}

// --- markdown ---------------------------------------------------------------
// Line-oriented, because that is how markdown's block syntax works. This is the
// *source* view; the rendered view goes through lib/markdown.js.

function scanMarkdown(src) {
  const out = []
  let inFence = false

  for (const line of src.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push({ t: 'c', v: line }, { t: 'x', v: '\n' })
      continue
    }
    if (inFence) {
      out.push({ t: 'x', v: line }, { t: 'x', v: '\n' })
      continue
    }
    if (/^#{1,6}\s/.test(line)) {
      out.push({ t: 'k', v: line }, { t: 'x', v: '\n' })
      continue
    }
    if (/^\s*&gt;|^\s*>/.test(line)) {
      out.push({ t: 'c', v: line }, { t: 'x', v: '\n' })
      continue
    }
    // Inline code and links, split so the delimiters keep their own colour.
    const parts = line.split(/(`[^`]*`|\[[^\]]*\]\([^)\s]*\))/)
    for (const part of parts) {
      if (!part) continue
      if (part.startsWith('`')) out.push({ t: 's', v: part })
      else if (part.startsWith('[')) out.push({ t: 'a', v: part })
      else out.push({ t: 'x', v: part })
    }
    out.push({ t: 'x', v: '\n' })
  }

  // split('\n') on a trailing newline yields a final empty segment, which the
  // loop above turns into one newline too many.
  if (out.length && out[out.length - 1].v === '\n') out.pop()
  return out
}

/**
 * Tokenize source into per-line token arrays.
 *
 * @param {string} src
 * @param {string} lang  a key of CODE_EXT's values ('java', 'python', …)
 * @returns {Array<Array<{t: string, v: string}>>} one array of tokens per line
 *
 * Token types: k=keyword s=string c=comment n=number a=attribute x=plain
 */
export function highlightLines(src, lang) {
  const text = String(src ?? '')
  let tokens
  if (lang === 'markup') tokens = scanMarkup(text)
  else if (lang === 'markdown') tokens = scanMarkdown(text)
  else tokens = scanCode(text, lang)

  // Redistribute across lines. A comment or template literal legitimately spans
  // several lines, and the renderer needs one array per visual row to be able to
  // put a line number beside it.
  const lines = [[]]
  for (const tok of tokens) {
    const segments = tok.v.split('\n')
    for (let s = 0; s < segments.length; s += 1) {
      if (s > 0) lines.push([])
      if (segments[s]) lines[lines.length - 1].push({ t: tok.t, v: segments[s] })
    }
  }
  return lines
}

// Plain fallback used above the highlight size cap: same shape, no classification,
// so the renderer does not need a second code path.
export function plainLines(src) {
  return String(src ?? '')
    .split('\n')
    .map((line) => (line ? [{ t: 'x', v: line }] : []))
}
