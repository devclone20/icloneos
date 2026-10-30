/**
 * Email — plain-text processing for mail bodies and list previews.
 *
 * Everything a message says reaches the screen as TEXT. An HTML-only body is
 * reduced to text here and never touches the DOM as markup. Mail is hostile
 * input, so every scan below is linear: no regex with nested or unbounded
 * backtracking runs over a body, because one crafted message must not be able
 * to freeze the renderer.
 */

export interface BodyBlock {
  /** 0 = the sender's own words; n = quoted n levels deep (`>`, `>>`…). */
  depth: number
  text: string
}

interface MailBody {
  blocks: BodyBlock[]
  /** Trailing reply history (attribution line + quotes) — folded by default. */
  quoted: BodyBlock[]
}

interface TextPiece {
  kind: 'text' | 'url'
  value: string
}

const PREVIEW_MAX = 180

const MAX_TEXT = 200_000
const MAX_HTML = 400_000
const SIGNATURE_MAX_LINES = 10

// Soft hyphens, combining grapheme joiners, zero-width and bidi marks: the
// invisible padding newsletters put in their preheaders.
const INVISIBLE = /[\u034f\u00ad\u200b-\u200f\u2060\ufeff]/g
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi
const URL_TRAILING = new Set(['.', ',', ';', ':', '!', '?', "'", '"', ']', '}', '>', '*'])
const ATTRIBUTION_LINE = /^(on|em|el|le|am)\b.{0,300}\b(wrote|escreveu|escribió|a écrit|schrieb)\s?:$/i
const ATTRIBUTION_START = /^(on|em|el|le|am)\b/i
const ATTRIBUTION_END = /\b(wrote|escreveu|escribió|a écrit|schrieb)\s?:$/i
const INLINE_ATTRIBUTION = /\bOn\s[^\n]{0,200}?\bwrote:/
const ORIGINAL_MESSAGE = /^-{2,}\s*original message\s*-{2,}$/i
const DEVICE_FOOTER = /^(sent from my .{1,40}|get outlook for .{1,30})$/i

function normalizeText(text: string): string {
  const bounded = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text

  return bounded
    .replace(INVISIBLE, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
}

// ── links ───────────────────────────────────────────────────────────────────

function countChar(text: string, char: string): number {
  let count = 0

  for (const current of text) {
    if (current === char) {
      count += 1
    }
  }

  return count
}

/** Drop the punctuation a sentence puts after a URL, keeping a `)` that
 *  closes a `(` inside it (Wikipedia-style links). */
export function trimUrl(raw: string): string {
  const opens = countChar(raw, '(')
  let closes = countChar(raw, ')')
  let end = raw.length

  while (end > 0) {
    const char = raw[end - 1]

    if (char === ')' && closes > opens) {
      closes -= 1
      end -= 1

      continue
    }

    if (!URL_TRAILING.has(char)) {
      break
    }

    end -= 1
  }

  return raw.slice(0, end)
}

/** At most `max` code points, ending in `…` when cut — never half an emoji. */
function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text
  }

  const chars: string[] = []

  for (const char of text) {
    if (chars.length === max) {
      return `${chars.slice(0, max - 1).join('')}…`
    }

    chars.push(char)
  }

  return text
}

/** `agentcard.ai/auth/verify…` — host + path, never a 300-character token. */
export function displayUrl(url: string, max = 44): string {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^www\./, '')
    const path = parsed.pathname === '/' ? '' : parsed.pathname
    const label = host + path

    if (label.length > max) {
      return truncate(label, max)
    }

    return parsed.search || parsed.hash ? `${label}${path ? '' : '/'}…` : label
  } catch {
    return truncate(url.replace(/^https?:\/\//i, ''), max)
  }
}

/** Split text into plain runs and http(s) URLs, in order. */
export function splitLinks(text: string): TextPiece[] {
  const pieces: TextPiece[] = []
  let cursor = 0

  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0
    const url = trimUrl(match[0])

    if (start < cursor || !/^https?:\/\/[^/?#]+/i.test(url)) {
      continue
    }

    if (start > cursor) {
      pieces.push({ kind: 'text', value: text.slice(cursor, start) })
    }

    pieces.push({ kind: 'url', value: url })
    cursor = start + url.length
  }

  if (cursor < text.length) {
    pieces.push({ kind: 'text', value: text.slice(cursor) })
  }

  return pieces
}

// ── HTML → text (only when a message has no text part) ──────────────────────

const DROPPED_ELEMENTS = new Set(['head', 'noscript', 'script', 'style', 'template', 'title'])
const PARAGRAPH_ENDS = new Set(['blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'table'])
const LINE_ENDS = new Set(['br', 'div', 'hr', 'ol', 'section', 'tr', 'ul'])
const TAG_NAME = /^(\/?)([a-z][a-z0-9]*)/
const ENTITY = /&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  copy: '©',
  gt: '>',
  hellip: '…',
  laquo: '«',
  ldquo: '“',
  lsquo: '‘',
  lt: '<',
  mdash: '—',
  nbsp: ' ',
  ndash: '–',
  quot: '"',
  raquo: '»',
  rdquo: '”',
  reg: '®',
  rsquo: '’',
  trade: '™'
}

function decodeEntity(entity: string, body: string): string {
  if (body[0] !== '#') {
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity
  }

  const code =
    body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)

  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
}

export function decodeEntities(text: string): string {
  return text.replace(ENTITY, (entity, body: string) => decodeEntity(entity, body))
}

function tagBreak(name: string, closing: boolean): string {
  if (name === 'br' || name === 'hr') {
    return '\n'
  }

  if (!closing && name === 'li') {
    return '\n• '
  }

  if (closing && PARAGRAPH_ENDS.has(name)) {
    return '\n\n'
  }

  return closing && LINE_ENDS.has(name) ? '\n' : ''
}

/** Reduce an HTML body to readable text in one forward pass. The result is
 *  rendered as text by React — this is extraction, not sanitising. */
export function htmlToText(html: string): string {
  const source = html.length > MAX_HTML ? html.slice(0, MAX_HTML) : html
  const lower = source.toLowerCase()
  let out = ''
  let cursor = 0

  while (cursor < source.length) {
    const open = source.indexOf('<', cursor)

    if (open < 0) {
      out += source.slice(cursor).replace(/\s+/g, ' ')

      break
    }

    out += source.slice(cursor, open).replace(/\s+/g, ' ')

    if (source.startsWith('<!--', open)) {
      const end = source.indexOf('-->', open + 4)
      cursor = end < 0 ? source.length : end + 3

      continue
    }

    const close = source.indexOf('>', open + 1)

    if (close < 0) {
      break
    }

    const tag = TAG_NAME.exec(lower.slice(open + 1, Math.min(close, open + 24)))
    const closing = tag?.[1] === '/'
    const name = tag?.[2] ?? ''

    if (name && !closing && DROPPED_ELEMENTS.has(name)) {
      const end = lower.indexOf(`</${name}`, close + 1)
      const after = end < 0 ? -1 : source.indexOf('>', end)
      cursor = after < 0 ? source.length : after + 1

      continue
    }

    out += tagBreak(name, closing)
    cursor = close + 1
  }

  // Collapse space runs first: `[ \t]*\n` over a long run (a wall of
  // `&nbsp;`) would backtrack quadratically.
  return decodeEntities(out)
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ── reply history ───────────────────────────────────────────────────────────

/** Lines at the END of `lines` that make an "On …, X wrote:" attribution
 *  (mail clients often wrap it over two lines): 0, 1 or 2. */
function trailingAttribution(lines: string[]): number {
  const last = lines.at(-1)?.trim() ?? ''

  if (ATTRIBUTION_LINE.test(last)) {
    return 1
  }

  const previous = lines.at(-2)?.trim() ?? ''

  if (ATTRIBUTION_END.test(last) && ATTRIBUTION_START.test(previous) && previous.length + last.length < 400) {
    return 2
  }

  return 0
}

function startsAttribution(lines: string[], index: number): boolean {
  const line = lines[index]?.trim() ?? ''

  if (ATTRIBUTION_LINE.test(line)) {
    return true
  }

  const next = lines[index + 1]?.trim() ?? ''

  return ATTRIBUTION_START.test(line) && ATTRIBUTION_END.test(next) && line.length + next.length < 400
}

/** Where a top-posted reply's unquoted history starts: an Outlook
 *  "-----Original Message-----" rule or a From:/Sent: header block. */
function historyStart(lines: string[]): number {
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index].trim()

    if (ORIGINAL_MESSAGE.test(line)) {
      return index
    }

    if (/^from:\s/i.test(line)) {
      const window = lines.slice(index + 1, index + 5).map(item => item.trim())

      if (window.some(item => /^(sent|date):\s/i.test(item)) && window.some(item => /^(to|subject):\s/i.test(item))) {
        return index
      }
    }
  }

  return -1
}

// ── signature + device footers ──────────────────────────────────────────────

function isQuoteLine(line: string): boolean {
  return line.trimStart().startsWith('>')
}

/** Remove an RFC 3676 signature ("-- " line and up to ten lines after it) —
 *  only when it is short, so a stray "--" never eats a message. */
export function stripSignature(lines: string[]): string[] {
  const at = lines.findIndex(line => line.trim() === '--')

  if (at <= 0) {
    return lines
  }

  let end = at + 1

  while (end < lines.length && !isQuoteLine(lines[end]) && !startsAttribution(lines, end)) {
    end += 1
  }

  return end - at <= SIGNATURE_MAX_LINES + 1 ? [...lines.slice(0, at), ...lines.slice(end)] : lines
}

function stripDeviceFooter(lines: string[]): string[] {
  let last = lines.length - 1

  while (last >= 0 && lines[last].trim() === '') {
    last -= 1
  }

  return last > 0 && DEVICE_FOOTER.test(lines[last].trim()) ? lines.slice(0, last) : lines
}

// ── quote blocks ────────────────────────────────────────────────────────────

/** `> > text` → depth 2, "text". Spaces between markers are allowed. */
export function quoteDepth(line: string): { content: string; depth: number } {
  let depth = 0
  let lastMark = -1
  let index = 0

  while (index < line.length) {
    const char = line[index]

    if (char === '>') {
      depth += 1
      lastMark = index
    } else if (char !== ' ' && char !== '\t') {
      break
    }

    index += 1
  }

  if (depth === 0) {
    return { content: line, depth }
  }

  const start = line[lastMark + 1] === ' ' ? lastMark + 2 : lastMark + 1

  return { content: line.slice(start), depth }
}

/** Trim blank lines at both ends and keep at most one between paragraphs —
 *  done on the array, because a regex over a long run of newlines backtracks. */
function tidyBlock(lines: string[]): string {
  const kept: string[] = []
  let blank = false

  for (const line of lines) {
    if (line.trim() === '') {
      blank = kept.length > 0

      continue
    }

    if (blank) {
      kept.push('')
      blank = false
    }

    kept.push(line)
  }

  return kept.join('\n')
}

/** Group lines into runs of equal quote depth. A blank line belongs to the
 *  run it sits in, so "> a\n\n> b" stays one quote. */
function toBlocks(lines: string[]): BodyBlock[] {
  const blocks: BodyBlock[] = []
  let depth = 0
  let current: string[] = []

  const flush = (blockDepth: number) => {
    const text = tidyBlock(current)

    if (text.trim()) {
      blocks.push({ depth: blockDepth, text })
    }

    current = []
  }

  for (const line of lines) {
    const parsed = line.trim() === '' ? { content: '', depth } : quoteDepth(line)

    if (parsed.depth !== depth) {
      flush(depth)
      depth = parsed.depth
    }

    current.push(parsed.content)
  }

  flush(depth)

  return blocks
}

/** Fold the reply history at the end of a message: the trailing quote blocks
 *  and the attribution line right above them. Inline quotes stay put. */
function splitQuotedTail(blocks: BodyBlock[]): { body: BodyBlock[]; tail: BodyBlock[] } {
  let index = blocks.length

  while (index > 0 && blocks[index - 1].depth > 0) {
    index -= 1
  }

  if (index === blocks.length || index === 0) {
    return { body: blocks, tail: [] }
  }

  const lines = blocks[index - 1].text.split('\n')
  const attribution = trailingAttribution(lines)
  let body = blocks.slice(0, index)
  let tail = blocks.slice(index)

  if (attribution > 0) {
    const kept = tidyBlock(lines.slice(0, -attribution))
    const moved = lines.slice(-attribution).join('\n').trim()

    tail = [{ depth: 0, text: moved }, ...tail]
    body = kept.trim() ? [...blocks.slice(0, index - 1), { depth: 0, text: kept }] : blocks.slice(0, index - 1)
  }

  return body.length > 0 ? { body, tail } : { body: blocks, tail: [] }
}

/** A text body → the blocks the reading pane renders. */
export function parseBody(text: string): MailBody {
  const lines = normalizeText(text)
    .split('\n')
    .map(line => line.trimEnd())

  const cut = historyStart(lines)
  const own = stripSignature(stripDeviceFooter(cut >= 0 ? lines.slice(0, cut) : lines))
  const history = cut >= 0 ? toBlocks(lines.slice(cut)) : []
  const { body, tail } = splitQuotedTail(toBlocks(own))
  const quoted = [...tail, ...history]

  if (body.length === 0) {
    return { blocks: quoted, quoted: [] }
  }

  return { blocks: body, quoted }
}

// ── list preview ────────────────────────────────────────────────────────────

/** One calm line for the list: the sender's new words only — no quoted
 *  history, no line breaks, URLs reduced to their host. */
export function cleanPreview(raw: string, max = PREVIEW_MAX): string {
  const lines = normalizeText(raw).split('\n')
  const kept: string[] = []

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim()

    if (index > 0 && (startsAttribution(lines, index) || ORIGINAL_MESSAGE.test(line))) {
      break
    }

    if (line && !line.startsWith('>')) {
      kept.push(line)
    }
  }

  let text = kept
    .join(' ')
    .replace(URL_PATTERN, match => {
      const url = trimUrl(match)

      return displayUrl(url) + match.slice(url.length)
    })
    .replace(/\s+/g, ' ')
    .trim()

  const inline = INLINE_ATTRIBUTION.exec(text)

  if (inline && inline.index > 0) {
    text = text.slice(0, inline.index).trim()
  }

  return truncate(text, max)
}
