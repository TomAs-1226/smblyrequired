// -----------------------------------------------------------------------------
// Archive readers: ZIP via HTTP range requests, TAR(.GZ) via a bounded stream.
//
// The point of this module is that listing a season archive must not cost the
// download of a season archive. A ZIP keeps its table of contents (the "central
// directory") at the *end* of the file, so two small range requests — one for
// the last 64 kB to find the directory, one for the directory itself — are
// enough to name every entry inside 400 MB without pulling 400 MB.
//
// GZIP has no index. A .tar.gz genuinely has to be decompressed from the start,
// so that path streams instead, with hard caps and an abort: the reader stops
// pulling bytes the moment a limit is hit, rather than discovering afterwards
// that it inflated a 10 GB bomb into a browser tab.
//
// fflate is import()-ed by the caller, not statically imported here, so neither
// it nor this parser lands in a chunk anyone loads by accident.
// -----------------------------------------------------------------------------

export const LIMITS = {
  // How many entries are listed before the UI says it truncated. A season
  // archive of a robot codebase is a few thousand files; past this the list
  // stops being something a human scans anyway.
  ENTRIES: 1500,
  // Largest single entry decompressed for preview. Also the bound passed to
  // fflate's output buffer, so a lying header cannot overrun it.
  PREVIEW: 2 * 1024 * 1024,
  // Total inflated bytes tolerated on the streaming (tar) path before abort.
  STREAM_TOTAL: 64 * 1024 * 1024,
  // Compressed size past which the streaming path is refused outright — there
  // is no index to shortcut, so listing means downloading, and at some size
  // that is simply the wrong thing to do on venue wifi.
  STREAM_DOWNLOAD: 60 * 1024 * 1024,
  // Small text entries are kept in memory during the single tar pass so that
  // previewing one does not re-download the whole archive.
  CACHE_ENTRY: 256 * 1024,
  CACHE_TOTAL: 8 * 1024 * 1024,
}

const ZIP_EOCD = 0x06054b50
const ZIP64_LOCATOR = 0x07064b50
const ZIP64_EOCD = 0x06064b50
const ZIP_CD_ENTRY = 0x02014b50

// --- range helpers -----------------------------------------------------------

function totalFromContentRange(header) {
  const m = /\/(\d+)\s*$/.exec(header ?? '')
  return m ? Number(m[1]) : null
}

async function fetchRange(url, range, signal) {
  const res = await fetch(url, { headers: { Range: range }, signal })
  if (!res.ok) throw new Error(`The storage server said ${res.status}.`)
  const buf = new Uint8Array(await res.arrayBuffer())
  return {
    buf,
    partial: res.status === 206,
    total: totalFromContentRange(res.headers.get('Content-Range')),
  }
}

// One byte, purely to learn whether the server honours Range at all. Without
// this probe a server that ignores the header answers the *suffix* request with
// the entire object, and we would have downloaded the 400 MB we were avoiding.
export async function probeRange(url, signal) {
  const res = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal })
  if (!res.ok) throw new Error(`The storage server said ${res.status}.`)
  // Drain so the connection can be reused rather than left dangling.
  await res.arrayBuffer()
  return {
    supported: res.status === 206,
    total: totalFromContentRange(res.headers.get('Content-Range')),
  }
}

function dv(buf) {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
}

function u64(view, at) {
  // Sizes beyond 2^53 are not representable and also not real here; Number()
  // is safe for anything a school team will ever store.
  return Number(view.getBigUint64(at, true))
}

// --- ZIP ---------------------------------------------------------------------

function findEOCD(buf) {
  const view = dv(buf)
  // The EOCD is 22 bytes plus a variable comment, so scan backwards for it.
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === ZIP_EOCD) return i
  }
  return -1
}

/**
 * List a ZIP's entries using range requests only.
 * @returns {{entries: Array, truncated: boolean, total: number, method: string}}
 */
export async function listZip(url, signal) {
  const probe = await probeRange(url, signal)
  if (!probe.supported) {
    const err = new Error('RANGE_UNSUPPORTED')
    err.code = 'RANGE_UNSUPPORTED'
    throw err
  }

  const total = probe.total
  // 64 kB covers the EOCD plus any sane archive comment and the ZIP64 locator.
  const tailLen = Math.min(65536, total ?? 65536)
  const tailStart = Math.max(0, (total ?? tailLen) - tailLen)
  const tail = await fetchRange(url, `bytes=${tailStart}-`, signal)

  const eocdAt = findEOCD(tail.buf)
  if (eocdAt < 0) {
    const err = new Error('NOT_A_ZIP')
    err.code = 'NOT_A_ZIP'
    throw err
  }

  const view = dv(tail.buf)
  let entryCount = view.getUint16(eocdAt + 10, true)
  let cdSize = view.getUint32(eocdAt + 12, true)
  let cdOffset = view.getUint32(eocdAt + 16, true)

  // ZIP64: the 32-bit fields saturate and the real values live in a separate
  // record pointed at by a locator sitting immediately before the EOCD.
  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locAt = eocdAt - 20
    if (locAt >= 0 && view.getUint32(locAt, true) === ZIP64_LOCATOR) {
      const z64At = u64(view, locAt + 8)
      const z64 = await fetchRange(url, `bytes=${z64At}-${z64At + 55}`, signal)
      const z64v = dv(z64.buf)
      if (z64v.getUint32(0, true) === ZIP64_EOCD) {
        entryCount = u64(z64v, 32)
        cdSize = u64(z64v, 40)
        cdOffset = u64(z64v, 48)
      }
    }
  }

  // The directory may already be inside the tail we fetched; reuse it if so.
  let cd
  if (cdOffset >= tailStart && cdOffset + cdSize <= tailStart + tail.buf.length) {
    cd = tail.buf.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize)
  } else {
    cd = (await fetchRange(url, `bytes=${cdOffset}-${cdOffset + cdSize - 1}`, signal)).buf
  }

  const entries = []
  const cdv = dv(cd)
  const decoder = new TextDecoder()
  let p = 0
  let truncated = false

  while (p + 46 <= cd.length) {
    if (cdv.getUint32(p, true) !== ZIP_CD_ENTRY) break

    const flags = cdv.getUint16(p + 8, true)
    const method = cdv.getUint16(p + 10, true)
    let compressed = cdv.getUint32(p + 20, true)
    let uncompressed = cdv.getUint32(p + 24, true)
    const nameLen = cdv.getUint16(p + 28, true)
    const extraLen = cdv.getUint16(p + 30, true)
    const commentLen = cdv.getUint16(p + 32, true)
    let localOffset = cdv.getUint32(p + 42, true)

    const nameBytes = cd.subarray(p + 46, p + 46 + nameLen)
    // Bit 11 promises UTF-8. Without it the spec says CP437, but every modern
    // producer writes UTF-8 anyway, and mislabelling a name is cosmetic.
    const name = decoder.decode(nameBytes)

    // ZIP64 extended information lives in the extra field and supplies whichever
    // of the saturated values were too large for their 32-bit slots. Order is
    // positional — only the saturated ones are present.
    if (uncompressed === 0xffffffff || compressed === 0xffffffff || localOffset === 0xffffffff) {
      const exStart = p + 46 + nameLen
      let q = exStart
      while (q + 4 <= exStart + extraLen) {
        const id = cdv.getUint16(q, true)
        const size = cdv.getUint16(q + 2, true)
        if (id === 0x0001) {
          let r = q + 4
          if (uncompressed === 0xffffffff) {
            uncompressed = u64(cdv, r)
            r += 8
          }
          if (compressed === 0xffffffff) {
            compressed = u64(cdv, r)
            r += 8
          }
          if (localOffset === 0xffffffff) {
            localOffset = u64(cdv, r)
          }
          break
        }
        q += 4 + size
      }
    }

    p += 46 + nameLen + extraLen + commentLen

    // Directory markers carry no content and only pad the list.
    if (name.endsWith('/')) continue

    if (entries.length >= LIMITS.ENTRIES) {
      truncated = true
      break
    }

    entries.push({
      name,
      size: uncompressed,
      compressed,
      method,
      localOffset,
      // Bit 0 is the encryption flag; an encrypted entry cannot be previewed.
      encrypted: (flags & 0x1) === 1,
    })
  }

  return { entries, truncated, total: total ?? 0, declared: entryCount, method: 'range' }
}

/**
 * Fetch and decompress a single ZIP entry, bounded by LIMITS.PREVIEW.
 * @returns {Uint8Array}
 */
export async function readZipEntry(url, entry, fflate, signal) {
  if (entry.encrypted) throw new Error('That entry is encrypted, so it cannot be previewed.')
  if (entry.size > LIMITS.PREVIEW) {
    const err = new Error('TOO_BIG')
    err.code = 'TOO_BIG'
    throw err
  }

  // The local header repeats the name and extra fields, and its lengths do not
  // have to match the central directory's — so read it rather than assuming.
  const head = await fetchRange(
    url,
    `bytes=${entry.localOffset}-${entry.localOffset + 29}`,
    signal
  )
  const hv = dv(head.buf)
  const nameLen = hv.getUint16(26, true)
  const extraLen = hv.getUint16(28, true)
  const dataStart = entry.localOffset + 30 + nameLen + extraLen
  if (entry.compressed === 0) return new Uint8Array(0)

  const body = await fetchRange(
    url,
    `bytes=${dataStart}-${dataStart + entry.compressed - 1}`,
    signal
  )

  if (entry.method === 0) return body.buf.subarray(0, Math.min(entry.size, LIMITS.PREVIEW))
  if (entry.method !== 8) {
    throw new Error(`That entry uses compression method ${entry.method}, which the viewer can't read.`)
  }

  // Handing fflate a pre-sized output buffer means a header that lies about its
  // uncompressed size cannot make the decompressor allocate past the cap.
  const out = new Uint8Array(entry.size)
  return fflate.inflateSync(body.buf, { out })
}

// --- TAR ---------------------------------------------------------------------

function octal(bytes) {
  let s = ''
  for (const b of bytes) {
    if (b === 0 || b === 32) break
    s += String.fromCharCode(b)
  }
  const n = parseInt(s, 8)
  return Number.isFinite(n) ? n : 0
}

function cstr(bytes) {
  let end = bytes.indexOf(0)
  if (end < 0) end = bytes.length
  return new TextDecoder().decode(bytes.subarray(0, end))
}

// Incremental 512-block TAR reader. Fed by the gunzip stream (or the raw body
// for a plain .tar) and stopped from the outside once a cap trips.
class TarReader {
  constructor(onEntry) {
    this.onEntry = onEntry
    this.buf = new Uint8Array(0)
    this.need = 512
    this.mode = 'header'
    this.pending = null
    this.remaining = 0
    this.chunks = null
    this.longName = null
    this.done = false
  }

  push(chunk) {
    if (this.done) return
    const next = new Uint8Array(this.buf.length + chunk.length)
    next.set(this.buf)
    next.set(chunk, this.buf.length)
    this.buf = next
    this.drain()
  }

  drain() {
    while (!this.done) {
      if (this.mode === 'header') {
        if (this.buf.length < 512) return
        const block = this.buf.subarray(0, 512)
        this.buf = this.buf.subarray(512)

        // Two consecutive zero blocks terminate the archive; one is enough of a
        // signal here, since nothing valid follows.
        if (block.every((b) => b === 0)) {
          this.done = true
          return
        }

        const name = cstr(block.subarray(0, 100))
        const prefix = cstr(block.subarray(345, 500))
        const size = octal(block.subarray(124, 136))
        const type = String.fromCharCode(block[156] || 48)
        const full = this.longName ?? (prefix ? `${prefix}/${name}` : name)
        this.longName = null

        this.pending = { name: full, size, type }
        this.remaining = size
        this.chunks = []
        this.mode = size > 0 ? 'body' : 'header'
        if (this.mode === 'header') this.emit()
        continue
      }

      // body — consume whatever has arrived and wait for the rest.
      const take = Math.min(this.buf.length, this.remaining)
      if (take > 0) {
        this.chunks.push(this.buf.subarray(0, take))
        this.buf = this.buf.subarray(take)
        this.remaining -= take
      }
      if (this.remaining > 0) return

      // Skip the padding up to the next 512 boundary.
      const pad = (512 - (this.pending.size % 512)) % 512
      if (this.buf.length < pad) return
      this.buf = this.buf.subarray(pad)
      this.emit()
      this.mode = 'header'
    }
  }

  emit() {
    const entry = this.pending
    this.pending = null
    const chunks = this.chunks ?? []
    this.chunks = null

    // GNU long-name header: its payload is the name of the *next* entry.
    if (entry.type === 'L') {
      this.longName = cstr(concat(chunks))
      return
    }
    // pax / global headers and directories are structure, not content. A NUL
    // typeflag was already normalised to '0' when the header was read, so
    // regular files are the only thing that should reach the list.
    if (entry.type !== '0') return

    this.onEntry(entry, chunks)
  }
}

function concat(chunks) {
  let len = 0
  for (const c of chunks) len += c.length
  const out = new Uint8Array(len)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

/**
 * Stream a .tar / .tar.gz, listing entries and caching small text ones.
 * @returns {{entries, truncated, aborted, cache: Map<string, Uint8Array>}}
 */
export async function listTar(url, { gzip, byteSize, isTextLike }, fflate, signal) {
  if (byteSize != null && byteSize > LIMITS.STREAM_DOWNLOAD) {
    const err = new Error('STREAM_TOO_BIG')
    err.code = 'STREAM_TOO_BIG'
    throw err
  }

  const controller = new AbortController()
  // Chain the caller's signal so closing the viewer stops the download too.
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true })

  const res = await fetch(url, { signal: controller.signal })
  if (!res.ok) throw new Error(`The storage server said ${res.status}.`)
  if (!res.body) throw new Error('This browser cannot stream that archive.')

  const entries = []
  const cache = new Map()
  let inflated = 0
  let cached = 0
  let truncated = false
  let aborted = false

  const reader = new TarReader((entry, chunks) => {
    if (entries.length >= LIMITS.ENTRIES) {
      truncated = true
      controller.abort()
      return
    }
    entries.push({ name: entry.name, size: entry.size })
    if (
      entry.size > 0 &&
      entry.size <= LIMITS.CACHE_ENTRY &&
      cached + entry.size <= LIMITS.CACHE_TOTAL &&
      isTextLike(entry.name)
    ) {
      cache.set(entry.name, concat(chunks))
      cached += entry.size
    }
  })

  const feed = (chunk) => {
    inflated += chunk.length
    if (inflated > LIMITS.STREAM_TOTAL) {
      // A ratio this extreme is the signature of a decompression bomb. Stop
      // pulling bytes rather than finding out how much further it goes.
      aborted = true
      controller.abort()
      return
    }
    reader.push(chunk)
    if (reader.done) controller.abort()
  }

  const gunzip = gzip ? new fflate.Gunzip((chunk) => feed(chunk)) : null

  try {
    const body = res.body.getReader()
    for (;;) {
      const { done, value } = await body.read()
      if (done) break
      if (gunzip) gunzip.push(value, false)
      else feed(value)
      if (reader.done || aborted || truncated) break
    }
    if (gunzip && !aborted && !truncated && !reader.done) gunzip.push(new Uint8Array(0), true)
  } catch (err) {
    // An abort we asked for is the success path for the caps above.
    if (err?.name !== 'AbortError') throw err
  }

  return { entries, truncated, aborted, cache, method: gzip ? 'stream-gzip' : 'stream' }
}
