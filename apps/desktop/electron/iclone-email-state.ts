/**
 * iclone os — the owner's Email marks on disk: one file per iNFT,
 * `<userData>/inft/<slug>/email-state.json`, beside the renderer's
 * localStorage copy of the same state.
 *
 * The mail service has no delete, archive or read mark, so "Delete forever"
 * and every other mark exist only on this computer. localStorage alone is one
 * cache clear (or profile reset) away from bringing deleted mail back; this
 * file is not, and the renderer unions the two on every open.
 *
 * Pure Node (no Electron), so the tests run it against a temp dir. Writes go
 * through writeFileAtomicSync (tmp + fsync + rename, 0600) on the main thread, so every
 * write for an iNFT lands whole and in order, like the store's other files.
 * A file that does not validate is never read as absent (the renderer would
 * then overwrite its tombstones): its valid marks are salvaged, and one that
 * cannot be parsed at all is moved aside before the renderer heals the file.
 */
import { readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

import { errorMessage } from '../src/iclone-shared/errors'
import { asRecord } from '../src/iclone-shared/guards'

import { isQuietAfterDetach, isSafeSlug } from './iclone-acp-store'
import { writeFileAtomicSync } from './lib/atomic-write'

const EMAIL_STATE_FILE = 'email-state.json'
/** 5000 marks (the renderer's bound) of ~100 bytes each, with room to spare. */
export const EMAIL_STATE_MAX_BYTES = 1024 * 1024
const ID_MAX = 256
/** Every id → time set the renderer's `mailStateRecord` writes. */
const MARK_SETS = ['archived', 'trashed', 'purged', 'recovered'] as const
const KEYS = new Set<string>(['v', 'w', 'read', ...MARK_SETS])
const BAD_PREFIX = 'email-state.bad-'
/** Moved-aside files kept per iNFT (newest first). */
const BAD_KEEP = 3

type EmailStateResult = { ok: true; value: Record<string, unknown> | null } | { ok: false; error: string }

function validAt(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function validId(id: string): boolean {
  return id.length > 0 && id.length <= ID_MAX
}

function validRead(mark: unknown): boolean {
  return Array.isArray(mark) && typeof mark[0] === 'boolean' && validAt(mark[1])
}

function validEntries(value: unknown, entry: (mark: unknown) => boolean): boolean {
  if (value === undefined) {
    return true
  }

  const record = asRecord(value)

  return record !== null && Object.entries(record).every(([id, mark]) => validId(id) && entry(mark))
}

/** The renderer's `serializeMailState` shape, version 1 (`w` = written at). */
export function isEmailState(value: unknown): value is Record<string, unknown> {
  const root = asRecord(value)

  return (
    root !== null &&
    root.v === 1 &&
    Object.keys(root).every(key => KEYS.has(key)) &&
    (root.w === undefined || validAt(root.w)) &&
    validEntries(root.read, validRead) &&
    MARK_SETS.every(set => validEntries(root[set], validAt))
  )
}

export function emailStateFile(root: string, slug: string): string {
  return path.join(root, slug, EMAIL_STATE_FILE)
}

function salvageEntries(value: unknown, entry: (mark: unknown) => boolean): Record<string, unknown> {
  return Object.fromEntries(Object.entries(asRecord(value) ?? {}).filter(([id, mark]) => validId(id) && entry(mark)))
}

/**
 * Every valid mark of a stored state that is not strictly valid (an unknown
 * key, one bad value, another version): unknown keys and invalid entries are
 * dropped, every valid id → time is kept. Null only when nothing is a state.
 */
export function salvageEmailState(value: unknown): Record<string, unknown> | null {
  const root = asRecord(value)

  if (root === null || Array.isArray(value)) {
    return null
  }

  const recovered = salvageEntries(root.recovered, validAt)

  return {
    v: 1,
    ...(validAt(root.w) ? { w: root.w } : {}),
    read: salvageEntries(root.read, validRead),
    archived: salvageEntries(root.archived, validAt),
    trashed: salvageEntries(root.trashed, validAt),
    purged: salvageEntries(root.purged, validAt),
    ...(Object.keys(recovered).length === 0 ? {} : { recovered })
  }
}

function markCount(state: Record<string, unknown>): number {
  return ['read', ...MARK_SETS].reduce((sum, set) => sum + Object.keys(asRecord(state[set]) ?? {}).length, 0)
}

/** Only a missing file (or a missing iNFT dir) means "no marks yet"; any
 *  other read error is a failure, never an empty state to heal over. */
function isAbsent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code

  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** A file nothing can be salvaged from is kept beside it (newest BAD_KEEP), never overwritten. */
function moveAside(file: string, now: number): void {
  const dir = path.dirname(file)

  try {
    renameSync(file, path.join(dir, `${BAD_PREFIX}${now}.json`))

    const bad = readdirSync(dir)
      .filter(name => name.startsWith(BAD_PREFIX))
      .sort()
      .reverse()

    for (const name of bad.slice(BAD_KEEP)) {
      rmSync(path.join(dir, name), { force: true })
    }
  } catch {
    // Already gone (another read moved it): nothing is left to lose.
  }
}

export function readEmailState(root: string, slug: unknown, now = Date.now()): EmailStateResult {
  if (!isSafeSlug(slug)) {
    return { ok: false, error: 'unknown iNFT' }
  }

  const file = emailStateFile(root, slug)
  let text: string

  try {
    if (statSync(file).size > EMAIL_STATE_MAX_BYTES) {
      moveAside(file, now)

      return { ok: true, value: null }
    }

    text = readFileSync(file, 'utf8')
  } catch (error) {
    return isAbsent(error) ? { ok: true, value: null } : { ok: false, error: errorMessage(error) }
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }

  if (isEmailState(parsed)) {
    return { ok: true, value: parsed }
  }

  const salvaged = salvageEmailState(parsed)

  if (salvaged === null || markCount(salvaged) === 0) {
    moveAside(file, now)

    return { ok: true, value: null }
  }

  return { ok: true, value: salvaged }
}

export function writeEmailState(root: string, slug: unknown, value: unknown, now = Date.now()): EmailStateResult {
  if (!isSafeSlug(slug)) {
    return { ok: false, error: 'unknown iNFT' }
  }

  if (isQuietAfterDetach(slug, now)) {
    return { ok: false, error: 'this iNFT was just detached' }
  }

  if (!isEmailState(value)) {
    return { ok: false, error: 'invalid email state' }
  }

  const text = JSON.stringify(value)

  if (Buffer.byteLength(text, 'utf8') > EMAIL_STATE_MAX_BYTES) {
    return { ok: false, error: `email state is larger than ${EMAIL_STATE_MAX_BYTES / 1024} KB` }
  }

  const file = emailStateFile(root, slug)

  try {
    // Renaming over a file this process cannot read would erase marks it
    // never saw; the renderer keeps them in localStorage meanwhile.
    readFileSync(file)
  } catch (error) {
    if (!isAbsent(error)) {
      return { ok: false, error: `email state file cannot be read: ${errorMessage(error)}` }
    }
  }

  try {
    writeFileAtomicSync(file, text, { mode: 0o600 })
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }

  return { ok: true, value }
}

/** The one IPC door (`iclone:email-state`): `get` or `set`, nothing else. */
export function emailStateCall(root: string, op: unknown, slug: unknown, value?: unknown): EmailStateResult {
  if (op === 'get') {
    return readEmailState(root, slug)
  }

  return op === 'set' ? writeEmailState(root, slug, value) : { ok: false, error: 'unknown operation' }
}
