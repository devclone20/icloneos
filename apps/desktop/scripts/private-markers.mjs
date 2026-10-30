#!/usr/bin/env node
// Owner-identity markers of the release scan (ruling 48). Nothing derived from the owner's identity is committed: no
// digest of his user name, alias, first name, wallets or agent ids lives in this repo. The scan reads them, when it
// runs, from a private file outside the repo (the path in ICLONE_PRIVATE_MARKERS) and, where the file asks for it
// (`derive: true`), from this machine itself: the home folder, the login name and the global git identity.
//
// A release scan FAILS CLOSED without that file (or with a file it cannot read). A scan that is not a release (unit
// tests, a developer's look at a folder) runs without the owner markers and says so.
//
//   node scripts/private-markers.mjs check       counts only: what a release scan on this machine would load
//   node scripts/private-markers.mjs ci-secret   the self-contained JSON for the CI secret (derive: false, the
//                                                machine rows written as digests); print it into the secret, never
//                                                into a file of the repo

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { basename } from 'node:path'

import { isMain } from './utils.mjs'

export const PRIVATE_MARKERS_ENV = 'ICLONE_PRIVATE_MARKERS'

/** The rows a derived set must hold for a release scan: who the machine's owner is, in the three spellings it leaks. */
export const DERIVED_IDS = Object.freeze(['owner.user-name', 'owner.alias', 'owner.first-name'])

/** The fewest rows a release accepts from the file itself (identity rows aside): one token row and one id row. */
export const MIN_FILE_ROWS = Object.freeze({ tokens: 1, ids: 1, names: 1, identity: 1 })

const ID_RE = /^owner\.[a-z0-9]+(?:-[a-z0-9]+)*$/
const HEX64_RE = /^[0-9a-f]{64}$/
const ID_KINDS = new Set(['agent-number', 'uuid'])
// r5e (ruling 48, X1): the owner's series names and delivery-folder words, as digests (skill-text-policy ownerNameSpans).
// r5f (X2): `identity` rows are the owner's names (PORT_IDENTITY) as digests: a release reads them in prose too.
const NAME_KINDS = new Set(['series', 'delivery', 'identity'])

/**
 * The words of a name the way skill-text-policy's textWords reads text: runs of letters, digits and marks; digits apart
 * from letters; a CamelCase change splits; NFKD with marks dropped; lowercase. The digests of a name row are of these
 * words, joined by one space (or glued, for the glued spelling).
 */
export function keyWords(name) {
  const words = []

  for (const run of String(name ?? '').matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
    for (const piece of run[0].match(/\p{N}+|[\p{L}\p{M}]+/gu) ?? []) {
      const parts = /^\p{N}+$/u.test(piece)
        ? [piece]
        : piece.split(/(?<=\p{Ll})(?=\p{Lu}\p{Ll})|(?<=\p{Ll})(?=\p{Lu}{2,})/u)

      for (const part of parts) {
        const folded = part
          .normalize('NFKD')
          .replace(/\p{M}+/gu, '')
          .toLowerCase()

        if (folded) {
          words.push(folded)
        }
      }
    }
  }

  return words
}

/**
 * The name rows of one name (r5f M1): its words spaced and glued; for a series also every leading run of two words or
 * more (the short forms it is written as); for a delivery folder the word itself. Digests only.
 */
export function nameRows(kind, name) {
  if (!NAME_KINDS.has(kind)) {
    throw new Error(`unknown name kind: ${kind}`)
  }

  const words = keyWords(name)
  const keys = new Set()

  if (kind === 'delivery') {
    if (words[0]) {
      keys.add(words[0])
    }
  } else {
    const lengths =
      kind === 'series' ? words.map((_w, i) => i + 1).filter(n => n >= 2 || words.length === 1) : [words.length]

    for (const n of lengths) {
      if (n >= 1 && n <= words.length) {
        keys.add(words.slice(0, n).join(' '))
        keys.add(words.slice(0, n).join(''))
      }
    }
  }

  return [...keys].filter(Boolean).map(key => Object.freeze({ kind, sha256: sha256(key) }))
}

const sha256 = text => createHash('sha256').update(text).digest('hex')

/** The run of letters a name starts with, lowercase (`ab12cd` → `ab`): the part a path, an e-mail or a login shares. */
export function leadingLetters(value) {
  return (String(value ?? '')
    .toLowerCase()
    .match(/^[a-z]+/) ?? [''])[0]
}

function gitGlobal(key, run) {
  try {
    return String(run('git', ['config', '--global', key]) ?? '').trim()
  } catch {
    return ''
  }
}

const defaultRun = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

function dedupe(rows) {
  const seen = new Set()

  return rows.filter(row => {
    const key = `${row.id}:${row.len}:${row.sha256}`

    if (seen.has(key)) {
      return false
    }

    seen.add(key)

    return true
  })
}

/**
 * The owner markers this machine can state itself, as prefix tokens (sha256 of the leading letters, 4 or more):
 * the home folder's name and the login name (owner.user-name), the global git e-mail's local part (owner.alias) and
 * the first word of the global git name (owner.first-name). Computed when the scan runs; never written anywhere.
 */
export function machineMarkerRows({ home = homedir(), user = safeUser(), run = defaultRun } = {}) {
  const rows = []
  const add = (id, value) => {
    const letters = leadingLetters(value)

    if (letters.length >= 4) {
      rows.push({ id, len: letters.length, prefix: true, sha256: sha256(letters) })
    }
  }

  add('owner.user-name', basename(home))
  add('owner.user-name', user)
  add('owner.alias', gitGlobal('user.email', run).split('@')[0])
  add('owner.first-name', gitGlobal('user.name', run).split(/\s+/)[0])

  return dedupe(rows)
}

function safeUser() {
  try {
    return userInfo().username
  } catch {
    return ''
  }
}

/** A private markers file, validated: `{ version: 1, derive?, tokens: [{ id, len, prefix?, sha256 }], ids: [{ id, kind, sha256 }] }`. */
export function parsePrivateMarkers(text) {
  let data

  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('the private markers file is not JSON')
  }

  if (data?.version !== 1 || !Array.isArray(data.tokens) || !Array.isArray(data.ids)) {
    throw new Error('the private markers file has no version 1 { tokens, ids }')
  }

  const tokens = data.tokens.map((row, i) => {
    if (
      !ID_RE.test(row?.id ?? '') ||
      !Number.isInteger(row.len) ||
      row.len < 1 ||
      row.len > 256 ||
      !HEX64_RE.test(row.sha256 ?? '') ||
      (row.prefix !== undefined && typeof row.prefix !== 'boolean')
    ) {
      throw new Error(`the private markers file: token row ${i} is malformed`)
    }

    return Object.freeze({ id: row.id, len: row.len, prefix: row.prefix === true, sha256: row.sha256 })
  })
  const ids = data.ids.map((row, i) => {
    if (!ID_RE.test(row?.id ?? '') || !ID_KINDS.has(row.kind) || !HEX64_RE.test(row.sha256 ?? '')) {
      throw new Error(`the private markers file: id row ${i} is malformed`)
    }

    return Object.freeze({ id: row.id, kind: row.kind, sha256: row.sha256 })
  })

  if (data.names !== undefined && !Array.isArray(data.names)) {
    throw new Error('the private markers file: names is not a list')
  }

  const names = (data.names ?? []).map((row, i) => {
    if (!NAME_KINDS.has(row?.kind) || !HEX64_RE.test(row?.sha256 ?? '')) {
      throw new Error(`the private markers file: name row ${i} is malformed`)
    }

    return Object.freeze({ kind: row.kind, sha256: row.sha256 })
  })

  return { derive: data.derive === true, tokens, ids, names }
}

/**
 * The owner markers for a scan: `{ tokens, ids, source }` (`source` null when none were loaded). `release`: a missing
 * or unreadable file, an empty set, or (with `derive`) a machine that cannot state the three identity rows THROWS;
 * the message never carries a path or a value.
 */
export function loadPrivateMarkers({ env = process.env, release = false, machine = machineMarkerRows } = {}) {
  const file = env[PRIVATE_MARKERS_ENV]
  const closed = why => new Error(`[artifact-hygiene] the release scan fails closed: ${why}`)

  if (!file || !existsSync(file)) {
    if (release) {
      throw closed(`no private markers file (${PRIVATE_MARKERS_ENV} ${file ? 'names a missing file' : 'is not set'})`)
    }

    return { tokens: [], ids: [], names: [], source: null }
  }

  let text

  try {
    // r5d n3: only a regular file is read. A FIFO, a socket or a device would block the read (or never end): it is
    // refused like any unreadable file, before any open.
    if (!statSync(file).isFile()) {
      throw new Error('not a regular file')
    }

    text = readFileSync(file, 'utf8')
  } catch {
    // Never the fs message: it names the path (EACCES, EISDIR …).
    const unreadable = new Error('the private markers file cannot be read')

    throw release ? closed(unreadable.message) : unreadable
  }

  let parsed

  try {
    parsed = parsePrivateMarkers(text)
  } catch (error) {
    throw release ? closed(error.message) : error
  }

  // r5c m1: a valid but hollow file is not the owner's set. The release expects the file itself to carry at least one
  // token row beyond the identity rows (a wallet) and at least one id row; it names counts, never a value.
  const ownRows = parsed.tokens.filter(row => !DERIVED_IDS.includes(row.id)).length

  if (release && (ownRows < MIN_FILE_ROWS.tokens || parsed.ids.length < MIN_FILE_ROWS.ids)) {
    throw closed(
      `the private markers file holds ${ownRows} token row(s) beyond identity and ${parsed.ids.length} id row(s); ` +
        `a release expects at least ${MIN_FILE_ROWS.tokens} and ${MIN_FILE_ROWS.ids}`
    )
  }

  let tokens = parsed.tokens

  if (parsed.derive) {
    const mine = machine()

    if (release) {
      const missing = DERIVED_IDS.filter(id => !mine.some(row => row.id === id))

      if (missing.length) {
        throw closed(`this machine cannot state ${missing.join(', ')} (home folder, login, global git identity)`)
      }
    }

    tokens = dedupe([...mine.map(row => Object.freeze({ ...row })), ...tokens])
  }

  // r5e (X1): a release reads the owner's series and delivery names from the file too; without them it cannot see them.
  const nameCount = parsed.names.filter(row => row.kind !== 'identity').length
  const identityCount = parsed.names.length - nameCount

  if (release && nameCount < MIN_FILE_ROWS.names) {
    throw closed(
      `the private markers file holds ${nameCount} name row(s); a release expects at least ${MIN_FILE_ROWS.names}`
    )
  }

  // r5f (X2): never a release without the owner identity setting (its names, read in prose too).
  if (release && identityCount < MIN_FILE_ROWS.identity) {
    throw closed(
      `the private markers file holds ${identityCount} identity row(s): the owner identity is not set; ` +
        `a release expects at least ${MIN_FILE_ROWS.identity}`
    )
  }

  if (release && (!tokens.length || !DERIVED_IDS.every(id => tokens.some(row => row.id === id)))) {
    throw closed(`the private markers lack ${DERIVED_IDS.filter(id => !tokens.some(row => row.id === id)).join(', ')}`)
  }

  return {
    tokens: Object.freeze(tokens),
    ids: Object.freeze(parsed.ids),
    names: Object.freeze(parsed.names),
    source: parsed.derive ? 'file+machine' : 'file'
  }
}

/** The CI secret's JSON: the file's rows and this machine's, all as digests, `derive: false` (a runner is not the owner). */
export function ciSecretJson(options = {}) {
  const loaded = loadPrivateMarkers({ ...options, release: true })

  return `${JSON.stringify({ version: 1, derive: false, tokens: loaded.tokens, ids: loaded.ids, names: loaded.names })}\n`
}

if (isMain(import.meta.url)) {
  const [command] = process.argv.slice(2)

  try {
    if (command === 'check') {
      const loaded = loadPrivateMarkers({ release: true })

      console.log(
        `[private-markers] ${loaded.source}: ${loaded.tokens.length} token row(s), ${loaded.ids.length} id row(s), ` +
          `${loaded.names.length} name row(s); ` +
          `identity rows ${DERIVED_IDS.filter(id => loaded.tokens.some(row => row.id === id)).length}/${DERIVED_IDS.length}`
      )
    } else if (command === 'ci-secret') {
      process.stdout.write(ciSecretJson())
    } else if (command === 'name-rows') {
      // name-rows <series|delivery|identity> --env VAR   (comma-separated names in that variable: never on the command
      // line, never printed) → the digest rows to add to the private file.
      const [, kind, flag, variable] = process.argv.slice(2)

      if (flag !== '--env' || !variable) {
        throw new Error('usage: private-markers.mjs name-rows <kind> --env <VARIABLE>')
      }

      const names = String(process.env[variable] ?? '')
        .split(',')
        .map(name => name.trim())
        .filter(Boolean)
      const seen = new Set()
      const rows = names
        .flatMap(name => nameRows(kind, name))
        .filter(row => !seen.has(row.sha256) && seen.add(row.sha256))

      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
    } else {
      console.error('usage: private-markers.mjs check | ci-secret | name-rows <kind> --env <VARIABLE>')
      process.exit(2)
    }
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
