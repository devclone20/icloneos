#!/usr/bin/env node
// Artifact hygiene (release plan §6 R7/R11): no trace of the owner or of his usage may ship. Scans a
// packed tree (the .app, linux-unpacked, dist-web) or a finished artifact (DMG, deb, zip) for the markers in
// artifact-hygiene-markers.mjs: app.asar is read entry by entry, Mach-O code signatures are blanked first (the
// Developer ID certificate is the one identity allowed to ship). Any hit aborts the release that runs it.
//
//   node scripts/artifact-hygiene.mjs <dir|artifact>...   exit 0 = clean, 1 = hits, 2 = usage
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, inflateRawSync } from 'node:zlib'

import { BIP39_ENGLISH } from './artifact-hygiene-bip39.mjs'
import { ALLOW, BIP39_LENGTHS, MARKERS_FILE, PUBLIC_PHRASES, SHAPES } from './artifact-hygiene-markers.mjs'
import { loadPrivateMarkers } from './private-markers.mjs'
import { decodeEscapes, foldSplits, ownerNamesOf, scanSkillTree } from './skill-text-policy.mjs'
import { isMain } from './utils.mjs'

const require = createRequire(import.meta.url)
const MAX_FILE_BYTES = 1024 * 1024 * 1024
const MAX_INFLATED_BYTES = 512 * 1024 * 1024
const MAX_ARCHIVE_DEPTH = 4
const LC_CODE_SIGNATURE = 0x1d
// V8 overflows its regexp backtrack stack on one multi-megabyte run ("Maximum call stack size exceeded"), so every scan
// quantifier is bounded: long runs are matched in pieces and stitched back together (runSpans).
const TOKEN_CLASS = 'A-Za-z0-9'
const TOKEN_MIN = 8
const TOKEN_MAX = 4096
const WALLET_LEN = 42
const HEX_BODY_RE = /^(?:0x)?([0-9a-f]{40,})$/
// A seed phrase is 12+ words of 3-8 letters, each pair joined by one of the separators a phrase is written with:
// spaces, line breaks, a JS/JSON array, or '-', '|', ';', each word optionally numbered ("1. word", "2) word").
// Escaped separators ("\\n") are decoded first. Letter runs are matched in pieces of at most 64.
const LETTERS_RE = /[A-Za-z]{1,64}/g
const SEED_GAP_RE = /^(?:[ \t]*\r?\n[ \t]*|[ \t]+|["'`]?[ \t]*[,;|-][ \t\r\n]*["'`]?)(?:\d{1,2}[.)][ \t]*)?$/
const MAX_SEED_GAP = 32
// Base64 and base64url runs (data: URLs, inline source maps, JSON blobs) are decoded one layer deep and scanned, at
// most MAX_BASE64_BYTES of decoded output per buffer. '=' stays outside the class so "k=<payload>" keeps its alignment.
const BASE64_CLASS = 'A-Za-z0-9+/_-'
const BASE64_MIN = 24
// A multiple of 4, so the pieces of one run decode on the run's own alignment.
const BASE64_PIECE = 65536
const MAX_BASE64_BYTES = 8 * 1024 * 1024
const UUID_RE = /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/gi
// An agent token id only where it is written as one: "agentId: n", "agent #n", "agents/<chain>/n", "ERC-8004 ... n".
const AGENT_NUMBER_RE =
  /(?:agent[\s_-]?(?:id|token[\s_-]?id|no\.?|#)|agents\/(?:[a-z0-9-]{1,128}\/)?|erc-?8004[^\n\d]{0,24})["'`\s:=#]{0,4}(\d{3,9})(?!\d)/gi
const ID_EXTRACTORS = { 'agent-number': AGENT_NUMBER_RE, uuid: UUID_RE }
const BIP39_INDEX = new Map(BIP39_ENGLISH.map((word, index) => [word, index]))
const PUBLIC_PHRASE_DIGESTS = new Set(PUBLIC_PHRASES)
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const PIN_PATH = resolve(SCRIPTS_DIR, '..', '..', '..', 'iclone', 'RUNTIME_PIN.json')
// Compressed formats node cannot open: their bytes say nothing, so they are refused unless allowed by provenance.
const OPAQUE_MAGIC = [
  { bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], name: 'xz' },
  { bytes: [0x28, 0xb5, 0x2f, 0xfd], name: 'zstd' },
  { bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], name: '7z' },
  { bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07], name: 'rar' },
  { bytes: [0x42, 0x5a, 0x68], name: 'bzip2', at4: [0x31, 0x41, 0x59, 0x26, 0x53, 0x59] }
]
const sha256 = data => createHash('sha256').update(data).digest('hex')
// The real marker list (it matches its own regex sources) is skipped by its bytes, never by its name.
const MARKERS_SHA256 = sha256(readFileSync(join(SCRIPTS_DIR, MARKERS_FILE)))

/** The bundled runtime tarball, allowed by its RUNTIME_PIN sha256 (third-party, pinned; its test fixtures are not ours). */
export function pinnedProvenance(pinPath = PIN_PATH) {
  if (!existsSync(pinPath)) {
    return []
  }

  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))

  return /^[0-9a-f]{64}$/.test(pin.tarball_sha256 ?? '')
    ? [{ label: `hermes-agent ${String(pin.sha).slice(0, 12)} (RUNTIME_PIN.json)`, sha256: pin.tarball_sha256 }]
    : []
}

/**
 * The home folders whose own folders name a machine's layout (`~/Desktop/<project>`, `~/Developer/<checkout>`). The
 * levels below come from the checkouts' ancestors (machineLayoutNames), not from walking the Desktop: deeper folders of
 * other projects are mostly the generic names of their own trees.
 */
export const LAYOUT_FOLDERS = Object.freeze(['Desktop', 'Developer'])
const LAYOUT_NAME_MIN = 3
const LAYOUT_CORE_MIN = 4
// The product's own name is public: a folder named after it, alone or followed by generic words of four letters or
// more (`<product>-release`), is product language, not the owner's layout.
const PRODUCT_WORDS = Object.freeze([['iclone', 'os'], ['icloneos'], ['iclone']])
// A layout name's words are joined in any way a folder name is written: a space, `_ . & + -`, `\ `, `%20`; between two
// letter words also nothing (`QuartzHarbor`), never between a word and a number (`app2` is an identifier, not `app 2`).
const LAYOUT_SEPARATOR = '(?:[\\s_.&+-]|\\\\ |%20)'
// A leading ordinal ("001 - ", "12_") orders the owner's folders; the name after it is the same name.
const ORDINAL_RE = /^\d+\s*[-_.]\s*(?=\S)/

const nameWords = name =>
  name
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)

/**
 * A generic folder name, never a layout name: one word of letters (any case: `MEDIA`, `docs`, a model or product word)
 * or its Finder copy (`app 2`), a version or a number (`v1.2.3`, `2026-10`), or the product's name alone or followed by
 * generic words of ≥ 4 letters (`<product>-release`).
 */
export function isGenericFolderName(name) {
  // A Finder copy of a generic folder (`app 2`) is as generic as the folder.
  if (/^[A-Za-z]+(?: \d{1,2})?$/.test(name) || /^v?\d+(?:[._-]\d+)*$/i.test(name)) {
    return true
  }

  const words = nameWords(name).map(word => word.toLowerCase())

  return PRODUCT_WORDS.some(
    product =>
      product.every((word, i) => words[i] === word) &&
      words.slice(product.length).every(word => /^[a-z]{4,}$/.test(word))
  )
}

/** A name folded for comparison: lower case, letters and digits only, the leading ordinal dropped. */
export function foldLayoutName(name) {
  return name
    .normalize('NFKC')
    .replace(ORDINAL_RE, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

function folderNames(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name)
  } catch {
    return []
  }
}

function gitOut(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

  return result.status === 0 ? result.stdout : ''
}

/**
 * The checkouts behind the tree this script runs from, on this machine: its main checkout (a worktree's common git dir;
 * a worktree's own siblings are other worktrees, named after the work, so they are not read) and every remote that is a
 * local folder (a release clone is cloned from the main checkout). None without git (CI from a tarball).
 */
export function machineCheckouts(repoRoot = resolve(SCRIPTS_DIR, '..', '..', '..')) {
  const found = new Set()
  const common = gitOut(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()

  if (common) {
    found.add(basename(common) === '.git' ? dirname(common) : common)
  }

  for (const line of gitOut(repoRoot, ['config', '--get-regexp', '^remote\\..*\\.url$']).split('\n')) {
    const url = line
      .slice(line.indexOf(' ') + 1)
      .trim()
      .replace(/^file:\/\//, '')

    if (url.startsWith('/') && existsSync(url)) {
      found.add(url.replace(/\/\.git\/?$/, '').replace(/\/+$/, ''))
    }
  }

  return [...found]
}

/**
 * K140 r3 — the names of the owner's folder layout, read from the SCANNING machine at scan time (never written in the
 * repo): the home folder's own name, the folders of the Desktop and of the Developer folder, and every folder beside
 * each ancestor of this tree's checkouts up to the home (`ls` of every level from the Desktop down to the checkout: the
 * Desktop's project folder, the owner's other projects, the checkout's siblings with the control plane). Generic names
 * (isGenericFolderName) are left out. A machine without that layout (CI) has none.
 */
export function machineLayoutNames({ home = homedir(), checkouts = machineCheckouts() } = {}) {
  const names = new Set([basename(home)])

  for (const folder of LAYOUT_FOLDERS) {
    for (const name of folderNames(join(home, folder))) {
      names.add(name)
    }
  }

  for (const checkout of checkouts) {
    for (let dir = dirname(checkout); dir.startsWith(`${home}/`); dir = dirname(dir)) {
      for (const name of folderNames(dir)) {
        names.add(name)
      }
    }
  }

  return [...names].filter(name => name.length >= LAYOUT_NAME_MIN && !isGenericFolderName(name)).sort()
}

/**
 * Every spelling a layout name is matched in: the name itself and, when it carries an ordinal, the name after it (when
 * that is not generic). Each word is matched case-folded, in the latin1 form the scan reads UTF-8 in, and joined to the
 * next by any LAYOUT_SEPARATOR (see layoutAlternative).
 */
export function layoutSpellings(name) {
  const spellings = [name]
  const core = name.replace(ORDINAL_RE, '')

  if (core !== name && core.length >= LAYOUT_CORE_MIN && !isGenericFolderName(core)) {
    spellings.push(core)
  }

  return spellings
}

function layoutAlternative(spelling) {
  const words = nameWords(spelling)

  return words
    .map((word, i) => {
      const escaped = Buffer.from(word, 'utf8')
        .toString('latin1')
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const number = /^\p{N}+$/u.test(word) || (i > 0 && /^\p{N}+$/u.test(words[i - 1]))

      return i === 0 ? escaped : `${LAYOUT_SEPARATOR}{${number ? 1 : 0},4}${escaped}`
    })
    .join('')
}

const longestFirst = (a, b) => b.length - a.length || (a < b ? -1 : 1)

/**
 * The regex that finds any layout name of `names`, at any depth of a path or alone: a bare segment (not inside a
 * longer word), any case, any joiner between its words. `prefixed` (`{ Desktop: [names] }`) adds every folder of a
 * LAYOUT_FOLDERS folder, generic names included, wherever it is written after its folder (`Desktop/<name>`,
 * `Desktop\\<name>`). `null` when there is none.
 */
export function layoutNameRegex(names, { prefixed = {}, flags = 'gi' } = {}) {
  const bare = [...new Set(names.flatMap(layoutSpellings).map(layoutAlternative).filter(Boolean))].sort(longestFirst)
  const under = Object.entries(prefixed)
    .filter(([, children]) => children.length)
    .map(
      ([folder, children]) =>
        `${folder}[\\\\/](?:${[...new Set(children.map(layoutAlternative))].sort(longestFirst).join('|')})`
    )
  const parts = [
    ...(under.length ? [`(?<![\\p{L}\\p{N}_.-])(?:${under.join('|')})(?![\\p{L}\\p{N}_.-])`] : []),
    ...(bare.length ? [`(?<![\\p{L}\\p{N}])(?:${bare.join('|')})(?![\\p{L}\\p{N}])`] : [])
  ]

  return parts.length === 0 ? null : new RegExp(parts.join('|'), `${flags}u`)
}

/** The folders of each LAYOUT_FOLDERS folder of `home` (dot folders and names under 3 characters left out). */
export function machineLayoutChildren({ home = homedir() } = {}) {
  return Object.fromEntries(
    LAYOUT_FOLDERS.map(folder => [
      folder,
      folderNames(join(home, folder))
        .filter(name => name.length >= LAYOUT_NAME_MIN)
        .sort()
    ])
  )
}

/**
 * K140 r2/r3 — the owner's folder layout must not ship, in a skill or anywhere else: one `owner.layout` shape over
 * machineLayoutNames (read at scan time; no name in the repo). It matches each name as a bare path segment at any depth,
 * inside `join(...)` arguments and string literals, in any case and spelling; the scan also reads every text with its
 * zero-width characters and string concatenations folded away (foldSplits). Returns `[]` or `[{ id, re }]`.
 */
export function machineLayoutShapes(options = {}) {
  const re = layoutNameRegex(machineLayoutNames(options), { prefixed: machineLayoutChildren(options) })

  return re ? [{ id: 'owner.layout', re }] : []
}

// K140 r4: the text folds (escapes, zero-width characters, concatenated literals) live in skill-text-policy.mjs, shared
// with the skill-text policy; they are re-exported here for the importers of the scanner.
export { decodeEscapes, foldSplits }

/**
 * Marker tables in the form the scan uses; tests pass their own fixture markers. Every call builds its own copies
 * (the shape regexes included: a /g regex carries its lastIndex), so no scan reads or writes state another holds.
 */
export function compileMarkers({
  shapes = SHAPES,
  // Ruling 48: the owner markers are never committed. Left out, they are loaded now (private-markers.mjs): a `release`
  // scan fails closed without them; any other scan runs without them (`privateSource` null says so).
  release = false,
  privateTokens = undefined,
  privateIds = undefined,
  allow = ALLOW,
  provenance = pinnedProvenance(),
  layout = machineLayoutShapes(),
  // K140 r4: the private names a skill tree is read against (skill-text-policy machinePrivateNames); undefined = this
  // machine's, read when a skill tree is scanned.
  skillNames = undefined,
  // r5e (X1): the owner's series and delivery names for a skill tree ({ series, delivery } digest sets). Left out, they
  // come with the loaded private markers (none when the markers were given and these were not).
  ownerNames = undefined
} = {}) {
  const loaded =
    privateTokens === undefined || privateIds === undefined ? loadPrivateMarkers({ release }) : { source: 'given' }

  privateTokens ??= loaded.tokens
  privateIds ??= loaded.ids
  ownerNames ??= ownerNamesOf(loaded.names ? loaded : { names: [] })

  return {
    privateSource: loaded.source,
    skillNames,
    ownerNames,
    allow: [...allow],
    byDigest: new Map(privateTokens.map(m => [`${m.len}:${m.sha256}`, m])),
    exactLens: new Set(privateTokens.filter(m => !m.prefix).map(m => m.len)),
    idDigests: Object.fromEntries(
      Object.keys(ID_EXTRACTORS).map(kind => [
        kind,
        new Map(privateIds.filter(m => m.kind === kind).map(m => [m.sha256, m.id]))
      ])
    ),
    prefixLens: [...new Set(privateTokens.filter(m => m.prefix).map(m => m.len))],
    provenance: new Map(provenance.map(p => [p.sha256, p.label])),
    shapes: [...shapes, ...layout].map(shape => ({ ...shape, re: new RegExp(shape.re.source, shape.re.flags) }))
  }
}

let defaultMarkers = null

/** The markers of a scan that is not a release (compiled once, on first use: importing this module reads no file). */
function defaultScanMarkers() {
  defaultMarkers ??= compileMarkers()

  return defaultMarkers
}

function blankThinSignature(buf, base, end) {
  if (base + 32 > end) {
    return
  }

  const magic = buf.readUInt32LE(base)
  const header = magic === 0xfeedfacf ? 32 : magic === 0xfeedface ? 28 : 0

  if (!header) {
    return
  }

  const ncmds = buf.readUInt32LE(base + 16)
  let at = base + header

  for (let i = 0; i < ncmds && at + 16 <= end; i += 1) {
    const cmd = buf.readUInt32LE(at)
    const size = buf.readUInt32LE(at + 4)

    if (cmd === LC_CODE_SIGNATURE) {
      const from = base + buf.readUInt32LE(at + 8)

      buf.fill(0, Math.min(from, end), Math.min(from + buf.readUInt32LE(at + 12), end))
    }

    if (size < 8) {
      return
    }

    at += size
  }
}

/** Zeroes every LC_CODE_SIGNATURE blob of a thin or fat Mach-O in place; any other buffer is left as it is. */
export function blankCodeSignature(buf) {
  if (buf.length < 8) {
    return buf
  }

  const magic = buf.readUInt32BE(0)

  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const count = buf.readUInt32BE(4)
    const wide = magic === 0xcafebabf
    const entry = wide ? 32 : 20

    // cafebabe is also a Java class file, whose "count" is its version (>= 45).
    if (count < 1 || count > 20 || 8 + count * entry > buf.length) {
      return buf
    }

    for (let i = 0; i < count; i += 1) {
      const at = 8 + i * entry
      const offset = wide ? Number(buf.readBigUInt64BE(at + 8)) : buf.readUInt32BE(at + 8)
      const size = wide ? Number(buf.readBigUInt64BE(at + 16)) : buf.readUInt32BE(at + 12)

      blankThinSignature(buf, offset, Math.min(offset + size, buf.length))
    }

    return buf
  }

  blankThinSignature(buf, 0, buf.length)

  return buf
}

function tokenHit(token, cache, markers) {
  if (cache.has(token)) {
    return cache.get(token)
  }

  let hit = null
  const lower = token.toLowerCase()

  if (markers.exactLens.has(lower.length)) {
    hit = markers.byDigest.get(`${lower.length}:${sha256(lower)}`)?.id ?? null
  }

  for (const len of markers.prefixLens) {
    if (hit || lower.length < len) {
      continue
    }

    const marker = markers.byDigest.get(`${len}:${sha256(lower.slice(0, len))}`)

    hit = marker?.prefix ? marker.id : null
  }

  // A wallet also travels without 0x and zero-padded (ABI words, topics, calldata): try every 40-hex window.
  const hex = !hit && markers.exactLens.has(WALLET_LEN) ? HEX_BODY_RE.exec(lower)?.[1] : undefined

  for (let at = 0; hex && !hit && at + 40 <= hex.length; at += 1) {
    hit = markers.byDigest.get(`${WALLET_LEN}:${sha256(`0x${hex.slice(at, at + 40)}`)}`)?.id ?? null
  }

  cache.set(token, hit)

  return hit
}

function bip39Checksum(words) {
  const bits = words.map(word => BIP39_INDEX.get(word).toString(2).padStart(11, '0')).join('')
  const entropyBits = (words.length * 32 * 11) / 33
  const entropy = Buffer.alloc(entropyBits / 8)

  for (let i = 0; i < entropy.length; i += 1) {
    entropy[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2)
  }

  const checksumBits = entropyBits / 32
  const first = createHash('sha256').update(entropy).digest()[0]

  return parseInt(bits.slice(entropyBits), 2) === first >> (8 - checksumBits)
}

/**
 * A BIP-39 seed phrase: 12/15/18/21/24 words, every one in the English list, a valid checksum, and not in sorted
 * order (an excerpt of the wordlist itself passes the checksum one time in 16).
 */
export function looksLikeSeedPhrase(words) {
  const lower = words.map(word => word.toLowerCase())

  return (
    BIP39_LENGTHS.includes(lower.length) &&
    lower.every(word => BIP39_INDEX.has(word)) &&
    lower.some((word, i) => i > 0 && word < lower[i - 1]) &&
    bip39Checksum(lower)
  )
}

// The one punctuation a phrase is written with besides whitespace. Groups ("w w w, w w w") and grids (rows of
// "w,w,w") mix it with spaces and line breaks; a run that mixes two kinds ("top-left`,`left-top", "a-b|c-d") is
// identifiers, not a phrase, so a window never holds two kinds.
function punctuationOf(gap) {
  return [',', ';', '|', '-'].find(c => gap.includes(c)) ?? null
}

// Each window is O(1) until the checksum (next non-list word and next out-of-order word are precomputed), so a
// megabyte of one repeated list word stays linear.
function phraseInWords(words) {
  let hit = null
  const nextOff = new Array(words.length + 1).fill(words.length)
  const nextDrop = new Array(words.length + 1).fill(words.length)

  for (let i = words.length - 1; i >= 0; i -= 1) {
    nextOff[i] = BIP39_INDEX.has(words[i]) ? nextOff[i + 1] : i
    nextDrop[i] = i > 0 && words[i] < words[i - 1] ? i : nextDrop[i + 1]
  }

  for (let start = 0; start + BIP39_LENGTHS[0] <= words.length; start += 1) {
    for (const len of BIP39_LENGTHS) {
      const end = start + len

      if (end > nextOff[start] || nextDrop[start + 1] >= end) {
        continue
      }

      const window = words.slice(start, end)

      if (bip39Checksum(window)) {
        if (!PUBLIC_PHRASE_DIGESTS.has(sha256(window.join(' ')))) {
          return 'secret.bip39-phrase'
        }

        hit = 'secret.bip39-public-example'
      }
    }
  }

  return hit
}

// 'secret.bip39-phrase', or 'secret.bip39-public-example' for a reviewed public example (allowed only by path).
// One pass over the letter runs; on a change of punctuation kind the run restarts after the last separator of the old
// kind, so every word is checked in at most two runs.
function seedPhraseHit(text) {
  let hit = null
  let words = []
  let punct = null
  let restart = 0
  let end = -1
  const flush = () => {
    const found = words.length >= BIP39_LENGTHS[0] ? phraseInWords(words) : null

    hit = found === 'secret.bip39-phrase' ? found : (hit ?? found)
    words = []
    punct = null
    restart = 0
  }

  for (const match of text.matchAll(LETTERS_RE)) {
    if (hit === 'secret.bip39-phrase') {
      return hit
    }

    const word = match[0]
    const gapLength = match.index - end
    const gap = words.length > 0 && gapLength <= MAX_SEED_GAP ? text.slice(end, match.index) : null

    end = match.index + word.length

    // A piece glued to the previous one is the tail of a letter run longer than 64: never a word.
    if (word.length < 3 || word.length > 8 || gapLength === 0) {
      flush()
      continue
    }

    if (gap === null || !SEED_GAP_RE.test(gap)) {
      flush()
    } else {
      const kind = punctuationOf(gap)

      if (kind) {
        if (punct !== null && kind !== punct) {
          const kept = words.slice(restart)

          flush()
          words = kept
        }

        punct = kind
        restart = words.length
      }
    }

    words.push(word.toLowerCase())
  }

  flush()

  return hit
}

// Runs of `cls` at least `min` long, as [start, end]. Matched in pieces of at most `max` (see TOKEN_MAX) and stitched.
function* runSpans(text, cls, min, max) {
  const re = new RegExp(`[${cls}]{${min},${max}}`, 'g')
  const more = new RegExp(`[${cls}]{1,${max}}`, 'y')

  for (let match = re.exec(text); match; match = re.exec(text)) {
    const start = match.index
    let end = re.lastIndex
    let piece = end - start

    while (piece === max) {
      more.lastIndex = end
      piece = more.exec(text)?.[0].length ?? 0
      end += piece
    }

    re.lastIndex = end
    yield [start, end]
  }
}

// ASCII written as UTF-16 (LE or BE, either byte parity): .strings files, Windows resources, JS engine string tables.
function utf16Text(buf) {
  const runs = []
  const out = Buffer.allocUnsafe((buf.length >> 1) + 1)

  for (const [charAt, zeroAt] of [
    [0, 1],
    [1, 0]
  ]) {
    for (const parity of [0, 1]) {
      let len = 0
      let runStart = 0

      for (let i = parity; i + 1 < buf.length; i += 2) {
        const c = buf[i + charAt]

        if (buf[i + zeroAt] === 0 && ((c >= 0x20 && c <= 0x7e) || c === 0x09 || c === 0x0a || c === 0x0d)) {
          out[len] = c
          len += 1
        } else if (len - runStart >= 6) {
          out[len] = 0x0a
          len += 1
          runStart = len
        } else {
          len = runStart
        }
      }

      if (len - runStart < 6) {
        len = runStart
      }

      if (len > 0) {
        runs.push(out.toString('latin1', 0, len))
      }
    }
  }

  return runs.join('\n')
}

function shapeHit(text, re, check) {
  re.lastIndex = 0

  if (!check) {
    return re.test(text)
  }

  for (const [match] of text.matchAll(re)) {
    if (check(match)) {
      return true
    }
  }

  return false
}

function scanText(text, ids, cache, markers, budget = { left: MAX_BASE64_BYTES }) {
  scanPlainText(text, ids, cache, markers)

  const decoded = decodeEscapes(text)

  if (decoded !== text) {
    scanPlainText(decoded, ids, cache, markers)
  }

  // K140 r3: a path split by a zero-width character or across concatenated string literals is the same path.
  const folded = foldSplits(decoded)

  if (folded !== decoded) {
    scanShapes(folded, ids, markers)
  }

  scanBase64(decoded, ids, cache, markers, budget)
}

// One layer only: the decoded runs are joined (NUL keeps a token or a phrase from spanning two runs) and scanned as
// plain text and escape-decoded text, never searched for base64 again.
function scanBase64(text, ids, cache, markers, budget) {
  const chunks = []

  for (const [start, end] of runSpans(text, BASE64_CLASS, BASE64_MIN, BASE64_PIECE)) {
    if (budget.left <= 0) {
      break
    }

    const run = text.slice(start, Math.min(end, start + Math.ceil(budget.left / 3) * 4))
    const bytes = Buffer.from(run, 'base64').subarray(0, budget.left)

    budget.left -= bytes.length
    chunks.push(bytes.toString('latin1'))
  }

  if (chunks.length === 0) {
    return
  }

  const joined = chunks.join('\0')

  scanPlainText(joined, ids, cache, markers)

  const unescaped = decodeEscapes(joined)

  if (unescaped !== joined) {
    scanPlainText(unescaped, ids, cache, markers)
  }
}

function idHits(text, ids, cache, markers) {
  for (const [kind, digests] of Object.entries(markers.idDigests)) {
    if (digests.size === 0) {
      continue
    }

    for (const match of text.matchAll(ID_EXTRACTORS[kind])) {
      const value = (match[1] ?? match[0]).toLowerCase()
      const key = `${kind}:${value}`

      if (!cache.has(key)) {
        cache.set(key, digests.get(sha256(value)) ?? null)
      }

      if (cache.get(key)) {
        ids.add(cache.get(key))
      }
    }
  }
}

function scanShapes(text, ids, markers) {
  for (const { id, re, check } of markers.shapes) {
    if (!ids.has(id) && shapeHit(text, re, check)) {
      ids.add(id)
    }
  }
}

function scanPlainText(text, ids, cache, markers) {
  scanShapes(text, ids, markers)

  idHits(text, ids, cache, markers)

  const phrase = seedPhraseHit(text)

  if (phrase) {
    ids.add(phrase)
  }

  // A run longer than any token is checked in pieces that overlap by 39, so no 40-hex wallet window is lost.
  for (const [start, end] of runSpans(text, TOKEN_CLASS, TOKEN_MIN, TOKEN_MAX)) {
    for (let at = start; at < end; at += TOKEN_MAX) {
      const id = tokenHit(text.slice(Math.max(start, at - 39), Math.min(end, at + TOKEN_MAX)), cache, markers)

      if (id) {
        ids.add(id)
      }
    }
  }
}

// A squashfs image (raw, or the payload of an AppImage after its ELF runtime): compressed, so its bytes say nothing.
function isSquashfs(buf) {
  if (buf.length >= 96 && buf.toString('latin1', 0, 4) === 'hsqs') {
    return true
  }

  if (buf.length < 64 || buf.readUInt32BE(0) !== 0x7f454c46) {
    return false
  }

  // AppImage type 2 stamps "AI\x02" into the ELF identification padding.
  if (buf.toString('latin1', 8, 10) === 'AI' && buf[10] === 2) {
    return true
  }

  // Any other ELF: the squashfs, if any, starts right after the section header table.
  const le = buf[5] === 1
  const read16 = at => (le ? buf.readUInt16LE(at) : buf.readUInt16BE(at))
  const end =
    buf[4] === 2
      ? Number(le ? buf.readBigUInt64LE(0x28) : buf.readBigUInt64BE(0x28)) + read16(0x3a) * read16(0x3c)
      : (le ? buf.readUInt32LE(0x20) : buf.readUInt32BE(0x20)) + read16(0x2e) * read16(0x30)

  return end > 0 && end + 4 <= buf.length && buf.toString('latin1', end, end + 4) === 'hsqs'
}

function archiveKind(buf) {
  if (isSquashfs(buf)) {
    return 'squashfs'
  }

  if (buf.length >= 18 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return 'gzip'
  }

  if (buf.length >= 22 && buf.readUInt32BE(0) === 0x504b0304) {
    return 'zip'
  }

  if (buf.length >= 512 && buf.toString('latin1', 257, 262) === 'ustar') {
    return 'tar'
  }

  const opaque = OPAQUE_MAGIC.find(
    m =>
      buf.length >= 16 &&
      m.bytes.every((byte, i) => buf[i] === byte) &&
      (!m.at4 || m.at4.every((byte, i) => buf[4 + i] === byte))
  )

  return opaque ? `opaque:${opaque.name}` : null
}

function tarMembers(buf) {
  const members = []

  for (let at = 0; at + 512 <= buf.length;) {
    const header = buf.subarray(at, at + 512)

    if (header[0] === 0 && header.every(byte => byte === 0)) {
      break
    }

    const size = parseInt(header.toString('latin1', 124, 136).replace(/\0.*$/s, '').trim() || '0', 8)

    if (!Number.isFinite(size) || size < 0) {
      throw new Error('bad tar header')
    }

    members.push({ data: buf.subarray(at + 512, at + 512 + size), name: header.toString('latin1', 0, 100) })
    members.push({ data: header.subarray(345, 500), name: 'prefix' })
    at += 512 + Math.ceil(size / 512) * 512
  }

  return members
}

function zipMembers(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))

  if (end < 0 || end + 22 > buf.length) {
    throw new Error('no zip central directory')
  }

  const members = []
  let at = buf.readUInt32LE(end + 16)

  for (let i = 0; i < buf.readUInt16LE(end + 10); i += 1) {
    if (buf.readUInt32LE(at) !== 0x02014b50) {
      throw new Error('bad zip central directory')
    }

    const flags = buf.readUInt16LE(at + 8)
    const method = buf.readUInt16LE(at + 10)
    const size = buf.readUInt32LE(at + 20)
    const nameLen = buf.readUInt16LE(at + 28)
    const local = buf.readUInt32LE(at + 42)
    const name = buf.toString('latin1', at + 46, at + 46 + nameLen)

    if (flags & 1 || size === 0xffffffff || (method !== 0 && method !== 8)) {
      throw new Error(`zip member ${name.slice(0, 40)} is encrypted, zip64 or method ${method}`)
    }

    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(start, start + size)

    members.push({ data: method === 8 ? inflateRawSync(raw, { maxOutputLength: MAX_INFLATED_BYTES }) : raw, name })
    at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32)
  }

  return members
}

function scanArchive(buf, kind, ids, cache, markers, ctx) {
  if (kind === 'squashfs') {
    // Allowed only by provenance: an AppImage whose sha256 the caller proved was built from the tree it scanned.
    const label = markers.provenance.get(sha256(buf))

    if (label) {
      ctx.provenance.push(label)
    } else {
      ids.add('scan.opaque-archive (squashfs)')
    }

    return
  }

  if (kind === 'gzip') {
    const label = markers.provenance.get(sha256(buf))

    if (label) {
      ctx.provenance.push(label)

      return
    }

    // The header's optional FNAME/FCOMMENT fields are plain text.
    scanText(buf.toString('latin1', 0, 1024), ids, cache, markers)
  }

  if (kind.startsWith('opaque:')) {
    ids.add(`scan.opaque-archive (${kind.slice(7)})`)

    return
  }

  if (ctx.depth >= MAX_ARCHIVE_DEPTH) {
    ids.add('scan.archive-depth')

    return
  }

  try {
    const inner = { ...ctx, depth: ctx.depth + 1 }
    const members =
      kind === 'gzip'
        ? [{ data: gunzipSync(buf, { maxOutputLength: MAX_INFLATED_BYTES }), name: '' }]
        : kind === 'zip'
          ? zipMembers(buf)
          : tarMembers(buf)

    scanText(members.map(m => m.name).join('\n'), ids, cache, markers)

    for (const member of members) {
      for (const id of scanBuffer(member.data, cache, markers, inner)) {
        ids.add(id)
      }
    }
  } catch (error) {
    ids.add(`scan.archive-unreadable (${kind}: ${error.message.slice(0, 60)})`)
  }
}

/**
 * Marker ids found in one buffer (text or binary). Gzip, tar and zip are opened member by member; formats node
 * cannot open are a hit; `ctx.provenance` collects the labels of archives allowed by their pinned sha256.
 */
export function scanBuffer(buf, cache = new Map(), markers = defaultScanMarkers(), ctx = { depth: 0, provenance: [] }) {
  const ids = new Set()
  const kind = archiveKind(buf)

  if (kind) {
    scanArchive(buf, kind, ids, cache, markers, ctx)

    return [...ids]
  }

  const bytes = blankCodeSignature(Buffer.from(buf))

  const budget = { left: MAX_BASE64_BYTES }

  scanText(bytes.toString('latin1'), ids, cache, markers, budget)
  scanText(utf16Text(bytes), ids, cache, markers, budget)

  return [...ids]
}

/** Marker ids in a path name or a symlink target (names are scanned as text, decoded like file contents). */
function scanName(name, cache, markers) {
  const ids = new Set()

  scanText(name, ids, cache, markers)

  return [...ids]
}

function isMarkersFile(data) {
  return sha256(data) === MARKERS_SHA256
}

function allowed(hit, markers) {
  return markers.allow.some(rule => rule.id === hit.id && rule.path.test(hit.file))
}

function scanAsar(archive, label, hits, cache, markers) {
  const asar = require('@electron/asar')

  // asar caches a parsed header per archive path for the life of the process: an archive rebuilt at the same path
  // (a re-pack inside one make-distribution run) would be read with the old offsets. Always read the bytes on disk.
  asar.uncache(archive)

  for (const entry of asar.listPackage(archive, { isPack: false })) {
    const name = entry.replace(/^[\\/]/, '')
    const stat = asar.statFile(archive, name, false)

    for (const id of scanName(name, cache, markers)) {
      hits.push({ file: `${label}/${name}`, id })
    }

    if (stat.link) {
      for (const id of scanName(stat.link, cache, markers)) {
        hits.push({ file: `${label}/${name} -> link`, id })
      }
    }

    // Directories, links and unpacked files (walked in app.asar.unpacked) carry no bytes here.
    if (stat.files || stat.link || stat.unpacked) {
      continue
    }

    const data = asar.extractFile(archive, name)

    if (isMarkersFile(data)) {
      continue
    }

    for (const id of scanBuffer(data, cache, markers)) {
      hits.push({ file: `${label}/${name}`, id })
    }
  }
}

/** Every marker hit under `target` (a directory, a single file, or an app.asar), as { file, id }. */
export function scanTree(target, { cache = new Map(), log = console.log, markers = defaultScanMarkers() } = {}) {
  const root = resolve(target)
  const hits = []

  if (!existsSync(root)) {
    return [{ file: root, id: 'scan.missing' }]
  }

  const visit = path => {
    const stat = lstatSync(path)
    const label = relative(root, path) || basename(path)

    // Every name below the root (the root is the caller's own path) and every link target is scanned; links are
    // never followed.
    if (path !== root) {
      for (const id of scanName(relative(root, path), cache, markers)) {
        hits.push({ file: label, id })
      }
    }

    if (stat.isSymbolicLink()) {
      for (const id of scanName(readlinkSync(path), cache, markers)) {
        hits.push({ file: `${label} -> link`, id })
      }

      return
    }

    if (stat.isDirectory()) {
      // K140 r4: a shipped skill tree is also read against the skill-text policy (R4-1 paths, R4-2 the scanning
      // machine's private names): `skill.path` / `skill.private-name`, one per file line, never a value.
      if (isSkillTree(path)) {
        for (const hit of scanSkillTree(path, {
          ...(markers.skillNames ? { keys: markers.skillNames } : {}),
          ...(markers.ownerNames ? { owner: markers.ownerNames } : {})
        })) {
          hits.push({
            file: `${label === basename(path) && path === root ? '' : `${label}/`}${hit.file}:${hit.line}`,
            id: hit.id
          })
        }
      }

      for (const name of readdirSync(path)) {
        visit(join(path, name))
      }

      return
    }

    if (!stat.isFile()) {
      return
    }

    if (stat.size > MAX_FILE_BYTES) {
      hits.push({ file: label, id: 'scan.too-large' })

      return
    }

    try {
      if (path.endsWith('.asar')) {
        scanAsar(path, label, hits, cache, markers)
      }

      const ctx = { depth: 0, provenance: [] }
      const data = readFileSync(path)

      if (isMarkersFile(data)) {
        return
      }

      for (const id of scanBuffer(data, cache, markers, ctx)) {
        hits.push({ file: label, id })
      }

      for (const source of ctx.provenance) {
        log(`[artifact-hygiene] allowed by provenance: ${label} = ${source}`)
      }
    } catch (error) {
      hits.push({ file: label, id: `scan.unreadable (${error.message.slice(0, 80)})` })
    }
  }

  visit(root)

  return hits.filter(hit => !allowed(hit, markers))
}

/**
 * A shipped skill tree: the pack's `Resources/hermes-skill`, or the repo's `iclone/skills` (its catalog and the catalog
 * builder beside it).
 */
export function isSkillTree(dir) {
  return (
    basename(dir) === 'hermes-skill' ||
    (existsSync(join(dir, 'CATALOG.json')) && existsSync(join(dir, 'tools', 'build-catalog.mjs')))
  )
}

function defaultRun(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...options })

  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function unpacked(file, unpack, run, markers) {
  const dir = mkdtempSync(join(tmpdir(), 'iclone-hygiene-'))

  try {
    const problem = unpack(dir, run)

    if (problem) {
      return [{ file: basename(file), id: `scan.unpack-failed (${problem.slice(0, 80)})` }]
    }

    return scanTree(dir, { markers }).map(hit => ({ ...hit, file: `${basename(file)}/${hit.file}` }))
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}

/**
 * Scans one finished artifact by what it contains: a DMG is mounted read-only, a deb is unpacked (ar + tar), a zip
 * is expanded; anything else (web files, sums) is scanned as bytes. An AppImage (squashfs) cannot be opened here: it
 * is a hit unless `markers.provenance` holds its sha256 (make-distribution passes the AppImages the CI built from the
 * linux-unpacked tree release-linux.mjs scanned).
 */
export function scanArtifact(file, { run = defaultRun, markers = defaultScanMarkers() } = {}) {
  const path = resolve(file)

  if (lstatSync(path).isDirectory()) {
    return scanTree(path, { markers })
  }

  if (path.endsWith('.dmg')) {
    const dir = mkdtempSync(join(tmpdir(), 'iclone-hygiene-'))
    const mount = join(dir, 'mnt')

    try {
      const attach = run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, path])

      if (attach.status !== 0) {
        return [
          { file: basename(path), id: `scan.unpack-failed (${(attach.stderr || 'hdiutil attach').slice(0, 80)})` }
        ]
      }

      try {
        return scanTree(mount, { markers }).map(hit => ({ ...hit, file: `${basename(path)}/${hit.file}` }))
      } finally {
        run('hdiutil', ['detach', mount, '-force'])
      }
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  }

  if (path.endsWith('.deb')) {
    return unpacked(
      path,
      (dir, exec) => {
        const ar = exec('ar', ['-x', path], { cwd: dir })

        if (ar.status !== 0) {
          return ar.stderr || 'ar -x failed'
        }

        for (const member of readdirSync(dir).filter(name => /^(control|data)\.tar/.test(name))) {
          const tar = exec('tar', ['-xf', member], { cwd: dir })

          if (tar.status !== 0) {
            return tar.stderr || `tar -xf ${member} failed`
          }

          rmSync(join(dir, member))
        }

        return null
      },
      run,
      markers
    )
  }

  if (path.endsWith('.zip')) {
    return unpacked(
      path,
      (dir, exec) => {
        const unzip = exec('ditto', ['-x', '-k', path, dir])

        return unzip.status === 0 ? null : unzip.stderr || 'ditto -x -k failed'
      },
      run,
      markers
    )
  }

  return scanTree(path, { markers }).map(hit => ({ ...hit, file: basename(path) }))
}

/** Scans every artifact under `root` (make-distribution's assembled folder). */
export function scanDistribution(root, deps = {}) {
  const hits = []
  const visit = dir => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)

      for (const id of scanName(relative(root, path), new Map(), deps.markers ?? defaultScanMarkers())) {
        hits.push({ file: relative(root, path), id })
      }

      if (lstatSync(path).isDirectory()) {
        visit(path)
      } else {
        hits.push(
          ...scanArtifact(path, deps).map(hit => ({ ...hit, file: `${relative(root, dir) || '.'}/${hit.file}` }))
        )
      }
    }
  }

  visit(resolve(root))

  return hits
}

export function formatHits(hits, limit = 40) {
  const lines = hits.slice(0, limit).map(hit => `  ${hit.file}: ${hit.id}`)

  if (hits.length > limit) {
    lines.push(`  ... ${hits.length - limit} more`)
  }

  return lines.join('\n')
}

/** Throws (aborting the caller's release) when `hits` is not empty. */
export function assertClean(hits, what) {
  if (hits.length > 0) {
    throw new Error(`artifact hygiene: ${hits.length} marker hit(s) in ${what}; nothing ships\n${formatHits(hits)}`)
  }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2)
  const release = args.includes('--release')
  const targets = args.filter(arg => arg !== '--release')

  if (targets.length === 0) {
    console.error('usage: artifact-hygiene.mjs [--release] <dir|artifact>...')
    process.exit(2)
  }

  let markers

  try {
    markers = compileMarkers({ release })
  } catch (error) {
    console.error(error.message)
    process.exit(2)
  }

  if (!markers.privateSource) {
    console.error(
      '[artifact-hygiene] no private markers: the owner-identity markers are not checked (not a release scan)'
    )
  }

  const hits = targets.flatMap(target =>
    scanArtifact(target, { markers }).map(hit => ({ ...hit, file: `${target}: ${hit.file}` }))
  )

  if (hits.length > 0) {
    console.error(`[artifact-hygiene] ${hits.length} hit(s):\n${formatHits(hits)}`)
    process.exit(1)
  }

  console.log(`[artifact-hygiene] clean: ${targets.join(', ')}`)
}
