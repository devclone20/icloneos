/**
 * V3-I — the WORK ledger: one JSONL per iNFT under `userData/acp-work/<slug>/ledger.jsonl`, 0600, written only by
 * main, every record hash-chained to the one before it (the V3-F audit's scheme). It holds the owner's decisions
 * (level, approve, decline, online, offline) and what the watchdog did (offers it saw and the rule that refused them,
 * quotes, earnings, refused spends, drain refusals). Everything the WORK tab shows is folded from it on read: the
 * level, the declined set, the earned total. Nothing is a cached counter.
 *
 * Crash safety. Every write replaces the whole file: a temp file in the same directory, fsync, rename, fsync of the
 * directory. A kill at any instant leaves either the old file or the new one, never a half record. The head (the last
 * seq and sha) is kept beside it in `ledger.head`, written the same way, so a cut tail is detected on load (an unkeyed
 * chain alone cannot see it). A torn last line from anywhere else (an older build's append, a disk fault) is
 * recovered on load: the file is cut back to the last valid record, a `gap` record says what was lost, and the chain
 * goes on. Any other break is kept visible (the level folds to L0) until the owner's Repair archives the damaged file
 * and starts again from the last verified record, again through a `gap`. No state blocks an iNFT for good.
 *
 * A gap is a hole in what the ledger knows, so the folds read it as caution: the iNFT does not come back online by
 * itself across one, and an L2 set before one is not honoured until the owner sets it again.
 *
 * Amounts are integer micro-USDC, so a total is exact.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  type AutonomyLevel,
  isAutonomyLevel,
  isPolicyRule,
  isWorkHold,
  type PolicyRule,
  type WorkHold
} from '../../src/iclone-shared/acp-work'
import { redactSecrets } from '../../src/iclone-shared/redact'
import { isAtomicTempName, writeFileAtomicSync } from '../lib/atomic-write'

const LEDGER_KINDS = [
  'level',
  'online',
  'offline',
  'offer',
  'approve',
  'decline',
  'quote',
  'quote-held',
  'earn',
  'spend-refused',
  'drain-refuse',
  'stop',
  'fix',
  'gap'
] as const

type LedgerKind = (typeof LEDGER_KINDS)[number]

export interface LedgerRecord {
  v: 1
  seq: number
  ts: string
  kind: LedgerKind
  jobId: string | null
  chainId: number | null
  micros: number | null
  rule: PolicyRule | null
  level: AutonomyLevel | null
  gesture: boolean | null
  note: string | null
  prev: string
  sha: string
}

export type LedgerEntry = Partial<Omit<LedgerRecord, 'prev' | 'seq' | 'sha' | 'ts' | 'v'>> & { kind: LedgerKind }

const GENESIS = '0'.repeat(64)
const NOTE_MAX = 500
/** The level an iNFT starts at (D1: L0 and L1 ship on; L2 waits for the owner's own click). */
export const DEFAULT_LEVEL: AutonomyLevel = 'L1'

const sha256 = (data: string) => createHash('sha256').update(data).digest('hex')
const digest = (body: Omit<LedgerRecord, 'sha'>) => sha256(JSON.stringify(body))
const lineOf = (record: LedgerRecord) => `${JSON.stringify(record)}\n`

function seal(entry: LedgerEntry, seq: number, prev: string, at: Date): LedgerRecord {
  const body: Omit<LedgerRecord, 'sha'> = {
    v: 1,
    seq,
    ts: at.toISOString(),
    kind: entry.kind,
    jobId: entry.jobId ?? null,
    chainId: entry.chainId ?? null,
    micros: entry.micros ?? null,
    rule: entry.rule ?? null,
    level: entry.level ?? null,
    gesture: entry.gesture ?? null,
    note: entry.note == null ? null : redactSecrets(entry.note).slice(0, NOTE_MAX),
    prev
  }

  return { ...body, sha: digest(body) }
}

function isRecord(value: unknown): value is LedgerRecord {
  if (!value || typeof value !== 'object') {
    return false
  }

  const row = value as Record<string, unknown>

  return (
    row.v === 1 &&
    Number.isSafeInteger(row.seq) &&
    typeof row.sha === 'string' &&
    typeof row.prev === 'string' &&
    (LEDGER_KINDS as readonly unknown[]).includes(row.kind) &&
    (row.rule === null || isPolicyRule(row.rule)) &&
    (row.level === null || isAutonomyLevel(row.level)) &&
    (row.micros === null || Number.isSafeInteger(row.micros))
  )
}

interface LedgerHead {
  seq: number
  sha: string
}

/** `line`: a record fails its parse, digest, link or sequence. `truncated`: records the head vouches for are gone.
 *  `head`: the head names a record the file does not hold (an edit re-hashed from some point on). */
type LedgerProblem = 'head' | 'line' | 'truncated'

interface TornTail {
  bytes: number
  sha: string
}

interface LedgerRead {
  /** The verified records: all of them, or the ones before the first break. */
  records: LedgerRecord[]
  ok: boolean
  /** The 1-based line of the first break, when a line breaks the chain. */
  brokenAt: number | null
  problem: LedgerProblem | null
  /** An unterminated last line: a write cut short. Recovered on load; not a break. */
  torn: TornTail | null
}

export const headFileOf = (file: string): string => `${file}.head`

function readHead(file: string): LedgerHead | null {
  try {
    const head = JSON.parse(fs.readFileSync(headFileOf(file), 'utf8')) as Record<string, unknown> | null

    return head && Number.isSafeInteger(head.seq) && typeof head.sha === 'string'
      ? { seq: head.seq as number, sha: head.sha }
      : null
  } catch {
    return null
  }
}

/**
 * The head against the file. A head ONE record behind the file that names a record the file holds is a head write that
 * did not happen (a kill or a full disk after the ledger's rename), healed by the next write; one torn record past it
 * is that record cut short. Only one write can sit between a rename and its head write, so a head further behind means
 * records were appended without it (K28 n1: three forged, well-chained records once passed as a crash window). A file
 * that ends before the head lost records; a head naming a record the file does not hold means the file was edited.
 */
function headProblem(head: LedgerHead | null, records: readonly LedgerRecord[], torn: boolean): LedgerProblem | null {
  const last = records.length

  if (!head) {
    return last <= 1 ? null : 'head'
  }

  if (head.seq > last) {
    return torn && head.seq === last + 1 ? null : 'truncated'
  }

  const named = head.seq === 0 ? GENESIS : records[head.seq - 1].sha

  return named === head.sha && last - head.seq <= 1 ? null : 'head'
}

/** Reads and verifies the whole file against its head. Pure: a recovery is the ledger's own load, never a read. */
export function readLedger(file: string): LedgerRead {
  let text = ''

  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    text = ''
  }

  const end = text.lastIndexOf('\n') + 1
  const rest = text.slice(end)
  const torn = rest ? { bytes: Buffer.byteLength(rest), sha: sha256(rest).slice(0, 16) } : null
  const lines = end ? text.slice(0, end - 1).split('\n') : []
  const records: LedgerRecord[] = []
  let prev = GENESIS
  let brokenAt: number | null = null

  for (let index = 0; index < lines.length && brokenAt === null; index += 1) {
    let parsed: unknown = null

    try {
      parsed = JSON.parse(lines[index])
    } catch {
      parsed = null
    }

    if (!isRecord(parsed)) {
      brokenAt = index + 1

      break
    }

    const { sha, ...body } = parsed

    if (digest(body) !== sha || parsed.prev !== prev || parsed.seq !== records.length + 1) {
      brokenAt = index + 1

      break
    }

    records.push(parsed)
    prev = sha
  }

  const problem: LedgerProblem | null = brokenAt !== null ? 'line' : headProblem(readHead(file), records, torn !== null)

  return { records, ok: problem === null, brokenAt, problem, torn }
}

interface LedgerOptions {
  file: string
  now?: () => Date
  /**
   * Test seam (crash injection): runs when a replacement file is complete, just before its rename. A throw stands for
   * the process dying there: the temp file stays behind, exactly as after a kill.
   */
  beforeRename?: (temp: string, target: string) => void
}

export function createLedger(options: LedgerOptions) {
  const now = options.now ?? (() => new Date())
  const dir = path.dirname(options.file)
  const base = path.basename(options.file)
  let cache: { stamp: string; read: LedgerRead } | null = null

  // A temp file is what a kill before the rename leaves: never the ledger, always safe to drop. (Reading creates
  // nothing: the directory appears with the first write.)
  let names: string[] = []

  try {
    names = fs.readdirSync(dir)
  } catch {
    names = []
  }

  for (const name of names) {
    if (isAtomicTempName(name) && name.startsWith(`.${base}.`)) {
      fs.rmSync(path.join(dir, name), { force: true })
    }
  }

  const stamp = (): string =>
    [options.file, headFileOf(options.file)]
      .map(target => {
        try {
          const stat = fs.statSync(target)

          return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
        } catch {
          return '-'
        }
      })
      .join('|')

  const replace = (target: string, data: string) =>
    writeFileAtomicSync(target, data, { mode: 0o600, beforeRename: options.beforeRename })

  /** The records become the file, then the head follows. False when the records could not be written. */
  const commit = (records: readonly LedgerRecord[]): boolean => {
    const text = records.map(lineOf).join('')
    const last = records[records.length - 1]

    try {
      replace(options.file, text)
    } catch {
      cache = null

      return false
    }

    try {
      replace(headFileOf(options.file), JSON.stringify({ seq: last?.seq ?? 0, sha: last?.sha ?? GENESIS }))
    } catch {
      // The records are durable; a head left behind is accepted on load and rewritten by the next write.
    }

    cache = { stamp: stamp(), read: { records: [...records], ok: true, brokenAt: null, problem: null, torn: null } }

    return true
  }

  const gap = (records: readonly LedgerRecord[], note: string): LedgerRecord => {
    const tail = records[records.length - 1]

    return seal({ kind: 'gap', note }, (tail?.seq ?? 0) + 1, tail?.sha ?? GENESIS, now())
  }

  /** Writes the cut-off bytes beside the ledger (0600), so what was lost stays inspectable. Never blocks a recovery. */
  const keepAside = (label: string, data: string): string => {
    const name = `${base}.${label}-${now().toISOString().replace(/[:.]/g, '-')}`

    try {
      writeFileAtomicSync(path.join(dir, name), data, { mode: 0o600 })

      return name
    } catch {
      return 'nowhere (the copy could not be written)'
    }
  }

  /** Verified read, cached by the files' identity; a torn tail is cut back and recorded as a gap here. */
  const load = (): LedgerRead => {
    const current = stamp()

    if (cache && cache.stamp === current) {
      return cache.read
    }

    const read = readLedger(options.file)

    if (read.ok && read.torn) {
      const raw = fs.readFileSync(options.file, 'utf8')
      const aside = keepAside('torn', raw.slice(raw.lastIndexOf('\n') + 1))

      const records = [
        ...read.records,
        gap(read.records, `torn tail: ${read.torn.bytes} bytes cut (sha ${read.torn.sha}), kept in ${aside}`)
      ]

      if (commit(records) && cache) {
        return cache.read
      }
    }

    cache = { stamp: current, read }

    return read
  }

  return {
    file: options.file,
    /** Appends after the verified tail. Refuses to extend a broken chain: the break stays visible until Repair. */
    append(entry: LedgerEntry): LedgerRecord | null {
      const read = load()

      // A torn tail still here means its recovery could not be written: appending would drop it unrecorded.
      if (!read.ok || read.torn) {
        return null
      }

      const tail = read.records[read.records.length - 1]
      const record = seal(entry, (tail?.seq ?? 0) + 1, tail?.sha ?? GENESIS, now())

      return commit([...read.records, record]) ? record : null
    },
    read: load,
    /**
     * The owner's Repair: the damaged file is archived whole beside the ledger, the verified records are kept, and a
     * `gap` says what was cut and where it went. Null when there is nothing to repair (or the disk refused).
     */
    repair(): LedgerRecord | null {
      const read = load()

      if (read.ok) {
        return null
      }

      let raw = ''

      try {
        raw = fs.readFileSync(options.file, 'utf8')
      } catch {
        raw = ''
      }

      const aside = keepAside('broken', raw)
      const head = readHead(options.file)

      const where =
        read.problem === 'line'
          ? `line ${read.brokenAt ?? '?'} broke the chain`
          : read.problem === 'truncated'
            ? `records ${read.records.length + 1}..${head?.seq ?? '?'} were cut from the tail`
            : head && head.seq < read.records.length && read.records[head.seq - 1]?.sha === head.sha
              ? // K28 n2: Repair cannot know which record past the head was edited in: it says so, never launders.
                `the head vouches for records up to ${head.seq}; records ${head.seq + 1}..${read.records.length} are unverified`
              : 'the head did not match the file'

      const record = gap(read.records, `repair: ${where}; the file was kept in ${aside}`)

      return commit([...read.records, record]) ? record : null
    }
  }
}

export type Ledger = ReturnType<typeof createLedger>

// ── folds: everything the tab shows is derived from the records on read ─────────────────────────────────────────────

/**
 * The owner's last level, or the default. A broken chain folds to L0: nothing the file says is trusted. An L2 from
 * before a gap folds to the default: the owner may have lowered it in what was lost.
 */
export function levelOf(read: LedgerRead): AutonomyLevel {
  if (!read.ok) {
    return 'L0'
  }

  let afterGap = false

  for (let i = read.records.length - 1; i >= 0; i -= 1) {
    const record = read.records[i]

    if (record.kind === 'gap') {
      afterGap = true
    } else if (record.kind === 'level' && record.gesture === true && record.level) {
      return afterGap && record.level === 'L2' ? DEFAULT_LEVEL : record.level
    }
  }

  return DEFAULT_LEVEL
}

/** The last lifecycle record: did the owner put this iNFT online, take it offline, or is a gap the latest word? */
function lifecycleOf(records: readonly LedgerRecord[]): LedgerRecord | null {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const kind = records[i].kind

    if (kind === 'online' || kind === 'offline' || kind === 'gap') {
      return records[i]
    }
  }

  return null
}

/** The owner's last lifecycle intent is online (and no offline or gap since). */
export function wantsOnline(records: readonly LedgerRecord[]): boolean {
  return lifecycleOf(records)?.kind === 'online'
}

/** WORK has ever been told about this iNFT's lifecycle: from then on, only main's supervisor listens for it. */
export function workHolds(records: readonly LedgerRecord[]): boolean {
  return lifecycleOf(records) !== null
}

/** The hold recorded with the last offline (sign-out, wallet switch, ownership lost), so it outlives a restart. */
export function holdOf(records: readonly LedgerRecord[]): WorkHold | null {
  const last = lifecycleOf(records)

  return last?.kind === 'offline' && isWorkHold(last.note) ? last.note : null
}

/** Job ids by their last owner/watchdog decision. A decline is final: nothing later re-opens it. */
export function decisionsOf(records: readonly LedgerRecord[]): Map<string, 'approve' | 'decline' | 'drain-refuse'> {
  const out = new Map<string, 'approve' | 'decline' | 'drain-refuse'>()

  for (const record of records) {
    if (!record.jobId) {
      continue
    }

    if (record.kind === 'decline' || record.kind === 'drain-refuse') {
      if (out.get(record.jobId) !== 'decline') {
        out.set(record.jobId, record.kind)
      }
    } else if (record.kind === 'approve' && !out.has(record.jobId)) {
      out.set(record.jobId, 'approve')
    }
  }

  return out
}

/** The first record of a kind for a job (an offer seen, a quote sent, an earning). */
export function firstOf(records: readonly LedgerRecord[], kind: LedgerKind, jobId: string): LedgerRecord | null {
  return records.find(record => record.kind === kind && record.jobId === jobId) ?? null
}

/** Exact totals: every earning once per job; spend is always 0 under D2 (a refused spend records 0 moved). */
export function totalsOf(records: readonly LedgerRecord[]): { earnedMicros: number; spentMicros: number } {
  const earned = new Map<string, number>()

  for (const record of records) {
    if (record.kind === 'earn' && record.jobId && !earned.has(record.jobId)) {
      earned.set(record.jobId, record.micros ?? 0)
    }
  }

  return { earnedMicros: [...earned.values()].reduce((sum, micros) => sum + micros, 0), spentMicros: 0 }
}
