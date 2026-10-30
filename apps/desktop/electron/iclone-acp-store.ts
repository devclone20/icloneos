/**
 * iclone os — the per-iNFT files the main process owns (pure Node; no
 * Electron, so tests run it against a temp dir).
 *
 * Owner rule 14: every per-iNFT file (status.json, the kv files, the agent
 * registry, the stage) is written atomically — tmp + rename in the same
 * directory, so a crash leaves the old file or the new one, never half of
 * one — and validated when read: a file that does not parse into the
 * expected shape reads as absent, never as a wrong answer.
 */
import { readFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

import { asRecord } from '../src/iclone-shared/guards'
import { redactDeep } from '../src/iclone-shared/redact'

import { writeFileAtomicSync } from './lib/atomic-write'

/** The shapes `slugForInft` produces: no dots, no separators. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/

export function isSafeSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && SLUG.test(slug)
}

/** Write `data` to `file` through a sibling tmp file and one rename (lib/atomic-write); owner-only by default. */
export function writeFileAtomic(file: string, data: string, mode = 0o600): void {
  writeFileAtomicSync(file, data, { mode, dirMode: 0o700 })
}

/** A JSON file that validates, or null (missing, unreadable, malformed, wrong shape). */
export function readJsonValidated<T>(file: string, valid: (value: unknown) => value is T): T | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))

    return valid(value) ? value : null
  } catch {
    return null
  }
}

/** The fields every consumer of a persisted status relies on. */
export function isPersistedStatus(
  value: unknown
): value is { slug: string; checkedAt: number } & Record<string, unknown> {
  const record = asRecord(value)

  return Boolean(
    record &&
    typeof record.slug === 'string' &&
    typeof record.checkedAt === 'number' &&
    Number.isFinite(record.checkedAt) &&
    typeof record.cli === 'boolean' &&
    typeof record.authenticated === 'boolean' &&
    typeof record.cardReady === 'boolean' &&
    typeof record.configured === 'boolean'
  )
}

// ── per-iNFT key-value files (notes, card-signup) ───────────────────────────

const INFT_KV_KEYS = ['notes', 'card-signup'] as const
type InftKvKey = (typeof INFT_KV_KEYS)[number]

export const KV_MAX_BYTES = 64 * 1024
const NOTE_MAX_CHARS = 8 * 1024

function isKvKey(key: unknown): key is InftKvKey {
  return typeof key === 'string' && (INFT_KV_KEYS as readonly string[]).includes(key)
}

/** `{ [stepKey]: { text, updatedAt } }` with bounded text. */
function validNotes(value: unknown): value is Record<string, { text: string; updatedAt: number }> {
  const record = asRecord(value)

  return Boolean(
    record &&
    Object.entries(record).every(([key, entry]) => {
      const note = asRecord(entry)

      return (
        /^[a-z0-9-]{1,32}$/.test(key) &&
        typeof note?.text === 'string' &&
        note.text.length <= NOTE_MAX_CHARS &&
        typeof note.updatedAt === 'number'
      )
    })
  )
}

function validSignup(value: unknown): value is Record<string, unknown> {
  const record = asRecord(value)

  return Boolean(
    record && typeof record.phase === 'string' && (record.state === undefined || typeof record.state === 'string')
  )
}

const KV_VALID: Record<InftKvKey, (value: unknown) => value is Record<string, unknown>> = {
  notes: validNotes,
  'card-signup': validSignup
}

export type KvResult =
  { ok: true; value: Record<string, unknown> | null; masked?: boolean } | { ok: false; error: string }

function kvFile(root: string, slug: string, key: InftKvKey): string {
  return path.join(root, slug, `${key}.json`)
}

export function readInftKv(root: string, slug: unknown, key: unknown): KvResult {
  if (!isSafeSlug(slug) || !isKvKey(key)) {
    return { ok: false, error: 'unknown iNFT or key' }
  }

  return { ok: true, value: readJsonValidated(kvFile(root, slug, key), KV_VALID[key]) }
}

/** Longer than the 90 s card-call timeout: a late answer for a detached iNFT never re-creates its dir. */
export const DETACH_QUIET_MS = 120_000

const detachedAt = new Map<string, number>()

/** True while a detach of `slug` is this recent: late writes must not re-create its dir. */
export function isQuietAfterDetach(slug: string, now = Date.now()): boolean {
  return now - (detachedAt.get(slug) ?? Number.NEGATIVE_INFINITY) < DETACH_QUIET_MS
}

/** Every string leaf is redacted BEFORE the bytes reach the disk. */
export function writeInftKv(root: string, slug: unknown, key: unknown, value: unknown, now = Date.now()): KvResult {
  if (!isSafeSlug(slug) || !isKvKey(key)) {
    return { ok: false, error: 'unknown iNFT or key' }
  }

  if (now - (detachedAt.get(slug) ?? Number.NEGATIVE_INFINITY) < DETACH_QUIET_MS) {
    return { ok: false, error: 'this iNFT was just detached' }
  }

  const { value: clean, masked } = redactDeep(value)

  if (!KV_VALID[key](clean)) {
    return { ok: false, error: `invalid ${key} value` }
  }

  const text = JSON.stringify(clean)

  if (Buffer.byteLength(text, 'utf8') > KV_MAX_BYTES) {
    return { ok: false, error: `${key} is larger than ${KV_MAX_BYTES / 1024} KB` }
  }

  try {
    writeFileAtomic(kvFile(root, slug, key), text)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  return { ok: true, value: clean, masked }
}

export function deleteInftKv(root: string, slug: unknown, key: unknown): KvResult {
  if (!isSafeSlug(slug) || !isKvKey(key)) {
    return { ok: false, error: 'unknown iNFT or key' }
  }

  rmSync(kvFile(root, slug, key), { force: true })

  return { ok: true, value: null }
}

// ── detach ──────────────────────────────────────────────────────────────────

export const DETACH_KEPT = [
  'Virtuals sign-in tokens in the macOS keychain (service acp-auth) — shared by every iNFT of the same owner wallet',
  'the signer key held by acp-cli-signer',
  'the Virtuals agent itself (bound to your wallet, not to the token)'
]

/** Remove one iNFT's whole local setup dir and its CLI scratch dir. Never the
 *  keychain: its tokens are keyed by the owner wallet, so deleting them would
 *  sign out every iNFT of that owner. */
export function removeInftDirs(
  root: string,
  tmpRoot: string,
  slug: unknown,
  now = Date.now()
): { ok: boolean; removed: string[]; error?: string } {
  if (!isSafeSlug(slug)) {
    return { ok: false, removed: [], error: 'unknown iNFT' }
  }

  detachedAt.set(slug, now)

  const removed: string[] = []

  for (const dir of [path.join(root, slug), path.join(tmpRoot, slug)]) {
    let exists = false

    try {
      exists = statSync(dir).isDirectory()
    } catch {
      exists = false
    }

    if (exists) {
      rmSync(dir, { recursive: true, force: true })
      removed.push(dir)
    }
  }

  return { ok: true, removed }
}

// ── main's card signup hold ─────────────────────────────────────────────────

/** The service's answer to an iNFT's last signup, kept so an app restart inside the hold still refuses. */
interface StoredCardHold {
  until: number
  rateLimited: boolean
  httpStatus?: number
  /** When that signup ended: the card re-read is due from here once the hold is over. */
  endedAt: number
}

const CARD_HOLD_FILE = 'card-hold.json'

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

function validCardHold(value: unknown): value is StoredCardHold {
  const record = asRecord(value)

  return Boolean(
    record &&
    isTime(record.until) &&
    isTime(record.endedAt) &&
    record.endedAt <= record.until &&
    typeof record.rateLimited === 'boolean' &&
    (record.httpStatus === undefined ||
      (Number.isInteger(record.httpStatus) && Number(record.httpStatus) >= 400 && Number(record.httpStatus) <= 599))
  )
}

/** The recorded hold, expired or not; null when missing, malformed, or longer than `maxMs` from its
 *  signup or from `now` (a record no answer of the service could have produced). */
export function readCardHold(root: string, slug: unknown, now: number, maxMs: number): StoredCardHold | null {
  if (!isSafeSlug(slug)) {
    return null
  }

  const hold = readJsonValidated(path.join(root, slug, CARD_HOLD_FILE), validCardHold)

  return hold && hold.until - hold.endedAt <= maxMs && hold.until - now <= maxMs ? hold : null
}

/** Atomic like every per-iNFT file; a just-detached iNFT takes no late write (its dir stays gone). */
export function writeCardHold(root: string, slug: unknown, hold: StoredCardHold, now = Date.now()): boolean {
  if (
    !isSafeSlug(slug) ||
    !validCardHold(hold) ||
    now - (detachedAt.get(slug) ?? Number.NEGATIVE_INFINITY) < DETACH_QUIET_MS
  ) {
    return false
  }

  try {
    writeFileAtomic(path.join(root, slug, CARD_HOLD_FILE), JSON.stringify(hold))

    return true
  } catch {
    return false
  }
}

export function deleteCardHold(root: string, slug: unknown): void {
  if (isSafeSlug(slug)) {
    rmSync(path.join(root, slug, CARD_HOLD_FILE), { force: true })
  }
}

// ── main's one-key card records: the re-read due mark and the last sign-in send ──

const CARD_RECORD_MAX_BYTES = 1024

/** A per-iNFT record holding one time, `{ [key]: ms }`; null when missing, oversized or malformed. A stamp
 *  in the future (a clock set back) is the reader's to clamp. */
function readTimeRecord(root: string, slug: unknown, file: string, key: string): null | number {
  if (!isSafeSlug(slug)) {
    return null
  }

  const at = path.join(root, slug, file)

  try {
    if (statSync(at).size > CARD_RECORD_MAX_BYTES) {
      return null
    }
  } catch {
    return null
  }

  const valid = (value: unknown): value is Record<string, number> => {
    const record = asRecord(value)

    return Boolean(record && Object.keys(record).length === 1 && isTime(record[key]))
  }

  return readJsonValidated(at, valid)?.[key] ?? null
}

/** Atomic and 0600; a just-detached iNFT takes no late write (its dir stays gone). */
function writeTimeRecord(root: string, slug: unknown, file: string, key: string, at: number, now: number): boolean {
  if (!isSafeSlug(slug) || !isTime(at) || now - (detachedAt.get(slug) ?? Number.NEGATIVE_INFINITY) < DETACH_QUIET_MS) {
    return false
  }

  try {
    writeFileAtomic(path.join(root, slug, file), JSON.stringify({ [key]: at }))

    return true
  } catch {
    return false
  }
}

function deleteRecord(root: string, slug: unknown, file: string): void {
  if (isSafeSlug(slug)) {
    rmSync(path.join(root, slug, file), { force: true })
  }
}

/** A signup was sent (or is being sent) after the last card answer: written before the send, so a
 *  restart after a quit mid-signup or a signup without an answer still re-reads the card instead of
 *  serving the cached pre-signup "none". */
interface StoredCardDue {
  /** When that signup started (before the send) or ended (after it): only a card read that began
   *  at or after it settles the mark. */
  since: number
}

const CARD_DUE_FILE = 'card-due.json'

/** The recorded due mark; a stamp ahead of the clock only ever forces one more card read, never fewer. */
export function readCardDue(root: string, slug: unknown): StoredCardDue | null {
  const since = readTimeRecord(root, slug, CARD_DUE_FILE, 'since')

  return since === null ? null : { since }
}

export function writeCardDue(root: string, slug: unknown, due: StoredCardDue, now = Date.now()): boolean {
  return writeTimeRecord(root, slug, CARD_DUE_FILE, 'since', due.since, now)
}

export function deleteCardDue(root: string, slug: unknown): void {
  deleteRecord(root, slug, CARD_DUE_FILE)
}

/** When the iNFT's last `card signup` left or answered: the one-minute resend wait counts from it, across a
 *  window reopen and an app restart. */
const CARD_SENT_FILE = 'card-sent.json'

export function readCardSent(root: string, slug: unknown): null | number {
  return readTimeRecord(root, slug, CARD_SENT_FILE, 'at')
}

export function writeCardSent(root: string, slug: unknown, at: number, now = Date.now()): boolean {
  return writeTimeRecord(root, slug, CARD_SENT_FILE, 'at', at, now)
}

export function deleteCardSent(root: string, slug: unknown): void {
  deleteRecord(root, slug, CARD_SENT_FILE)
}

// ── ~/.iclone-os/inft.tsv: one registry, many instances ─────────────────────

/** One `inft.tsv` row (the wrapper matches `--inft` on token, slug, profile, name). */
export interface RegistryRow {
  token: string
  slug: string
  configDir: string
  name: string
  profile: string
}

/** The rows of an `inft.tsv` text; comments, blanks and short lines are skipped. */
export function parseInftRegistry(text: string): RegistryRow[] {
  const rows: RegistryRow[] = []

  for (const line of text.split('\n')) {
    const [token, slug, configDir, name, profile] = line.split('\t')

    if (!line.startsWith('#') && /^\d{1,12}$/.test(token ?? '') && isSafeSlug(slug) && configDir && profile) {
      rows.push({ token, slug, configDir, name: name ?? '', profile })
    }
  }

  return rows
}

/**
 * The registry every running instance shares, merged BY TOKEN: this
 * instance's rows (those under `myRoot`, its own userData/inft) replace its
 * old ones and win for their tokens; another instance's rows stay while
 * their iNFT dir still exists — a second instance never empties the first
 * one's registry, and a detached iNFT never lingers.
 */
export function mergeInftRegistry(
  existing: readonly RegistryRow[],
  mine: readonly RegistryRow[],
  myRoot: string,
  exists: (dir: string) => boolean
): RegistryRow[] {
  const tokens = new Set(mine.map(row => row.token))
  const inside = (dir: string) => path.resolve(dir).startsWith(path.resolve(myRoot) + path.sep)

  const foreign = existing.filter(
    row => !tokens.has(row.token) && !inside(row.configDir) && exists(path.dirname(row.configDir))
  )

  return [...mine, ...foreign]
}
