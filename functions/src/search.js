// Knowledge-base search for the kb_answer task.
//
// Pure: no Firebase imports. Postgres did this with a full-text index; Firestore
// has none, and the knowledge base is a few hundred documents at most, so the
// documents are read and matched here.

// Words that carry no meaning in a question. Postgres' English search dropped
// these before matching; without that, "how do I set up the portal" would have
// to find a document containing "how", "do" and "i".
const STOP_WORDS = new Set(
  (
    'a about above after again all am an and any are as at be because been before being below between both but by ' +
    'can could did do does doing down during each few for from further had has have having he her here hers him his ' +
    'how i if in into is it its just me more most my no nor not now of off on once only or other our ours out over ' +
    'own same she should so some such than that the their theirs them then there these they this those through to ' +
    'too under until up very was we were what when where which while who whom why will with would you your yours'
  ).split(' ')
)

/** The words of a question worth searching for, lower-cased and de-duplicated. */
export function searchTerms(question) {
  const words = String(question).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  return [...new Set(words.filter((w) => !STOP_WORDS.has(w)))]
}

/**
 * The knowledge docs a question matches: every term must appear somewhere in the
 * title, category or body. The same rule the portal's own search uses. Docs that
 * match in the title come first, then the most recently edited.
 */
export function matchDocs(docs, question, cap = 6) {
  const terms = searchTerms(question)
  if (!terms.length) return []
  const time = (d) => (typeof d.updated_at?.toMillis === 'function' ? d.updated_at.toMillis() : 0)
  return docs
    .map((d) => {
      const title = String(d.title ?? '').toLowerCase()
      const text = `${title}\n${String(d.category ?? '').toLowerCase()}\n${String(d.body_md ?? '').toLowerCase()}`
      return {
        doc: d,
        hit: terms.every((t) => text.includes(t)),
        inTitle: terms.filter((t) => title.includes(t)).length,
      }
    })
    .filter((m) => m.hit)
    .sort((a, b) => b.inTitle - a.inTitle || time(b.doc) - time(a.doc))
    .slice(0, cap)
    .map((m) => m.doc)
}
