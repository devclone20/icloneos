/**
 * V3-F §5 — the audit trail: append-only JSONL, one file per UTC day under `userData/permissions/audit/`, 0600, written
 * ONLY by main, every record hash-chained to the one before it (across days) AND authenticated with the audit key
 * (keys.ts) — a writer without the key can neither edit, delete-and-rechain, nor forge a record (critic F-10).
 *
 * The chain's head (seq + sha) is anchored in `audit-head.json`, HMAC'd with the same key: a tail cut off the files
 * is a seq the anchor already passed (F-10). One writer at a time: `audit/.lock` names the owning pid (F-19).
 *
 * Every plugin source (Hermes pid + spawn key) is sequenced: a repeated `src_seq` is the same event delivered twice and
 * is recorded once; a jump writes a `gap` record first. The last seq per source is seeded from the files, so the
 * sequence survives a main restart (F-11). Integrity findings at open (cut tail, missing or forged anchor, another
 * writer's records) are `gap` records whose reason starts with `audit integrity:` and the verifier keeps them RED.
 *
 * While the log is open the in-memory tail is authoritative (T1, r3): a day file cut, replaced or deleted behind the
 * writer's back is an integrity `gap` at memory-seq+1 naming the missing records; numbering continues and the chain is
 * never re-rooted at genesis. A disk tail ahead of memory is adopted only after it chain-verifies under our key.
 *
 * Consumers read the chain's health from `state().chain` (authority.ts), which verifies against the anchored head AND
 * knows whether the key pre-existed. The bare `verifyAuditChain` on an empty directory is GREEN with 0 records: it
 * cannot tell a new log from a wiped one, so it is for tests and forensics, never for the pane (i1, r2).
 *
 * Declared limit: between `writeSync` and the `fstat` that follows it there is one syscall gap. A same-size in-place
 * edit of the day file landing exactly there is stamped as ours. No userland ordering closes it (the stat has to come
 * after the write, and it is already the very next call on the descriptor); the periodic full re-verify
 * (REVERIFY_EVERY_MS, 10 min) bounds how long it can stay unseen.
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import { redactSecrets } from '../../src/iclone-shared/redact'
import { registerTeardown } from '../teardown-registry'

import type { FunctionLevel, PermissionFunction } from './functions'
import type { ActionClass, PermissionMode } from './modes'

const AUDIT_KINDS = [
  'mode_set',
  'mode_refused',
  'grant',
  'revoke',
  'ask',
  'answer',
  'use',
  'refuse',
  'timeout',
  'gap',
  'restart',
  // V3-F2: a function's level changed, or a change was refused (no gesture, not confirmed, invalid).
  'fn_level_set',
  'fn_level_refused'
] as const

type AuditKind = (typeof AUDIT_KINDS)[number]

type AuditSource = 'confinement' | 'door' | 'install' | 'main' | 'payment' | 'plugin' | 'watchdog'
export type AuditAnswer = 'deny' | 'once' | 'project' | 'session' | 'standing' | 'timeout'

interface AuditAction {
  tool: string
  target: string
  project_root: string | null
}

export interface AuditAgent {
  inft: string | null
  profile: string | null
  session_id: string | null
  subagent_id: string | null
  task_id: string | null
}

export interface AuditRecord {
  v: 1
  id: string
  ts: string
  seq_main: number
  src: AuditSource
  src_seq: number | null
  /** The spawn key's public id: with `hermes_pid` it names one Hermes process even when a pid is reused. */
  src_key: string | null
  hermes_pid: number | null
  kind: AuditKind
  mode: PermissionMode | null
  scope: string | null
  class: ActionClass | null
  action: AuditAction | null
  agent: AuditAgent | null
  grant_id: string | null
  answer: AuditAnswer | null
  gesture: boolean | null
  reason: string | null
  /**
   * V3-F2 — present only when set: the function that decided the call or whose level changed, and the levels. A record
   * without them keeps its exact V3-F bytes, so a chain that mixes both verifies (the digest covers the parsed fields).
   */
  fn?: PermissionFunction
  level?: FunctionLevel
  prev_level?: FunctionLevel
  /** Which audit key authenticated this record (keys.ts `kid`). */
  kid: string
  prev_sha256: string
  sha256: string
  /** HMAC-SHA256 of `sha256` with the audit key. */
  mac: string
}

type AuditBody = Omit<AuditRecord, 'mac' | 'sha256'>

/** What a caller supplies; the log fills identity, order and the chain. */
type AuditEntry = Partial<
  Omit<AuditRecord, 'id' | 'kid' | 'mac' | 'prev_sha256' | 'seq_main' | 'sha256' | 'ts' | 'v'>
> & {
  kind: AuditKind
  src: AuditSource
}

const GENESIS_SHA = '0'.repeat(64)
const FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/
const TARGET_MAX = 2_000
const REASON_MAX = 500
const HEAD_FILE = 'audit-head.json'
const LOCK_FILE = '.lock'
const INTEGRITY_PREFIX = 'audit integrity:'

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const hmac = (key: Buffer, text: string) => createHmac('sha256', key).update(text).digest('hex')

function sameHex(a: unknown, b: string): boolean {
  return typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

/** The digest covers every field but `sha256` and `mac`, in the record's fixed field order. */
const digest = (record: AuditBody): string => sha256(JSON.stringify(record))

const clip = (value: string | null | undefined, max: number): string | null =>
  value == null ? null : redactSecrets(value).slice(0, max)

function seal(entry: AuditEntry, seq: number, prev: string, at: Date, key: Buffer, kid: string): AuditRecord {
  const body: AuditBody = {
    v: 1,
    id: randomUUID(),
    ts: at.toISOString(),
    seq_main: seq,
    src: entry.src,
    src_seq: entry.src_seq ?? null,
    src_key: entry.src_key ?? null,
    hermes_pid: entry.hermes_pid ?? null,
    kind: entry.kind,
    mode: entry.mode ?? null,
    scope: entry.scope ?? null,
    class: entry.class ?? null,
    action: entry.action
      ? {
          tool: clip(entry.action.tool, 200) ?? '',
          target: clip(entry.action.target, TARGET_MAX) ?? '',
          project_root: entry.action.project_root ?? null
        }
      : null,
    agent: entry.agent ?? null,
    grant_id: entry.grant_id ?? null,
    answer: entry.answer ?? null,
    gesture: entry.gesture ?? null,
    reason: clip(entry.reason, REASON_MAX),
    ...(entry.fn ? { fn: entry.fn } : {}),
    ...(entry.level ? { level: entry.level } : {}),
    ...(entry.prev_level ? { prev_level: entry.prev_level } : {}),
    kid,
    prev_sha256: prev
  }

  const sha = digest(body)

  return { ...body, sha256: sha, mac: hmac(key, sha) }
}

interface ChainBreak {
  line: number
  file: string
  /** `changing`: the files kept changing under every re-verification (permfix, L2): reported broken, not verifying. */
  problem: 'anchor' | 'changing' | 'hash' | 'mac' | 'parse' | 'prev' | 'seq'
}

interface ChainReport {
  ok: boolean
  records: number
  gaps: number
  /** Records no current key can authenticate (written under a master that is gone). */
  unauthenticated: number
  breaks: ChainBreak[]
  last: { seq: number; sha: string }
}

interface ChainHead {
  seq: number
  sha: string
}

interface VerifyOptions {
  /** With the audit key every record's MAC is checked; without it only the hash chain is. */
  key?: Buffer
  kid?: string
  /** The anchored head: a chain that ends before it was cut. */
  head?: ChainHead | null
}

function auditFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter(name => FILE_RE.test(name))
      .sort()
  } catch {
    return []
  }
}

function fileLines(file: string): string[] {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

function eachRecord(dir: string, visit: (record: AuditRecord | null, file: string, line: number) => void): void {
  for (const name of auditFiles(dir)) {
    fileLines(path.join(dir, name)).forEach((line, index) => {
      let record: AuditRecord | null

      try {
        record = JSON.parse(line) as AuditRecord
      } catch {
        record = null
      }

      visit(record, name, index + 1)
    })
  }
}

/**
 * The verifier's running state over the chain read so far, in file order. One walk serves the full verifier, the
 * startup pass that yields to the event loop, and the live log, which extends it by each record it appends (V-2): the
 * three can never disagree on what a record must be.
 */
interface ChainWalk {
  breaks: ChainBreak[]
  prev: string
  seq: number
  records: number
  gaps: number
  unauthenticated: number
  lastFile: string
  lastLine: number
}

const newWalk = (): ChainWalk => ({
  breaks: [],
  prev: GENESIS_SHA,
  seq: 0,
  records: 0,
  gaps: 0,
  unauthenticated: 0,
  lastFile: '',
  lastLine: 0
})

/** Checks one record (null: a line that does not parse) for digest, MAC, link, sequence and integrity gaps. */
function walkRecord(walk: ChainWalk, record: AuditRecord | null, file: string, line: number, options: VerifyOptions) {
  walk.lastFile = file
  walk.lastLine = line

  if (!record) {
    walk.breaks.push({ file, line, problem: 'parse' })

    return
  }

  const { sha256: claimed, mac, ...body } = record

  if (digest(body) !== claimed) {
    walk.breaks.push({ file, line, problem: 'hash' })
  }

  if (options.key) {
    if (record.kid !== options.kid) {
      walk.unauthenticated += 1
    } else if (!sameHex(mac, hmac(options.key, claimed))) {
      walk.breaks.push({ file, line, problem: 'mac' })
    }
  }

  if (record.prev_sha256 !== walk.prev) {
    walk.breaks.push({ file, line, problem: 'prev' })
  }

  if (record.seq_main !== walk.seq + 1) {
    walk.breaks.push({ file, line, problem: 'seq' })
  }

  if (record.kind === 'gap') {
    walk.gaps += 1

    if (typeof record.reason === 'string' && record.reason.startsWith(INTEGRITY_PREFIX)) {
      walk.breaks.push({ file, line, problem: 'anchor' })
    }
  }

  walk.records += 1
  walk.prev = claimed
  walk.seq = record.seq_main
}

/** The report for a walk, checked against the anchored head (a chain that ends before it was cut). */
function walkReport(walk: ChainWalk, head: ChainHead | null | undefined): ChainReport {
  const breaks =
    head && head.seq > walk.seq
      ? [...walk.breaks, { file: walk.lastFile, line: walk.lastLine + 1, problem: 'anchor' as const }]
      : [...walk.breaks]

  return {
    ok: breaks.length === 0 && walk.unauthenticated === 0,
    records: walk.records,
    gaps: walk.gaps,
    unauthenticated: walk.unauthenticated,
    breaks,
    last: { seq: walk.seq, sha: walk.prev }
  }
}

const parseRecord = (line: string): AuditRecord | null => {
  try {
    return JSON.parse(line) as AuditRecord
  } catch {
    return null
  }
}

/** Walks every day file in order and checks parse, digest, MAC, link, sequence, the anchor and integrity gaps. */
export function verifyAuditChain(dir: string, options: VerifyOptions = {}): ChainReport {
  const walk = newWalk()

  eachRecord(dir, (record, file, line) => walkRecord(walk, record, file, line, options))

  return walkReport(walk, options.head)
}

/** What a day file or the anchor was when the walk covered it. ctime moves on every write and no caller can set it. */
interface Stamp {
  size: number
  ino: number
  ctimeMs: number
  mtimeMs: number
  /**
   * Permfix (L2 minor): the volume's timestamps carry no sub-millisecond part (HFS+ 1 s, FAT/exFAT 2 s, or unknown), so
   * a same-size edit in the same tick moves nothing above. Such a stamp also holds the file's digest when it was taken,
   * compared until the tick is surely over (`settled`): an edit after that moves mtime to a later tick.
   */
  coarse?: true
  sha?: string
  at?: number
  settled?: boolean
}

/** Longer than the coarsest tick there is (FAT's 2 s): an edit after this lands in a later tick. */
const COARSE_SETTLE_MS = 2_500

const digestOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

function stampFrom(stat: fs.Stats): Stamp {
  const stamp: Stamp = { size: stat.size, ino: stat.ino, ctimeMs: stat.ctimeMs, mtimeMs: stat.mtimeMs }

  return Number.isInteger(stat.ctimeMs) && Number.isInteger(stat.mtimeMs) ? { ...stamp, coarse: true } : stamp
}

/** By path. `digest`: a coarse stamp the walk will cover also records the file's content digest. */
function stampOf(file: string, digest = false): Stamp | null {
  try {
    const stamp = stampFrom(fs.statSync(file))

    return digest && stamp.coarse ? withDigest(stamp, fs.readFileSync(file).subarray(0, stamp.size)) : stamp
  } catch {
    return null
  }
}

const withDigest = (stamp: Stamp, bytes: Buffer): Stamp => ({ ...stamp, sha: digestOf(bytes), at: Date.now() })

const sameStamp = (a: Stamp | null | undefined, b: Stamp | null | undefined): boolean =>
  a == null || b == null
    ? a == null && b == null
    : a.size === b.size && a.ino === b.ino && a.ctimeMs === b.ctimeMs && a.mtimeMs === b.mtimeMs

/** A coarse stamp's file whose content is no longer what it was (a digest it never took counts as changed). */
function contentMoved(file: string, stamp: Stamp | null | undefined): boolean {
  if (!stamp?.coarse || stamp.settled) {
    return false
  }

  let sha: string

  try {
    sha = digestOf(fs.readFileSync(file).subarray(0, stamp.size))
  } catch {
    return true
  }

  if (sha !== stamp.sha) {
    return true
  }

  if (stamp.at !== undefined && Date.now() - stamp.at > COARSE_SETTLE_MS) {
    stamp.settled = true
  }

  return false
}

/** A day file the walk covers: its stamp then, and how many non-empty lines it had (the verifier's line numbers). */
interface Covered {
  stamp: Stamp
  lines: number
}

const NEWLINE = 0x0a
/** Startup pass: records per slice between clock checks, and the work a slice may do before it yields the loop. */
const SLICE_RECORDS = 256
const SLICE_MS = 8
/** A log this small is verified in place: well inside one frame, and its report is exact the moment it is asked. */
const SYNC_VERIFY_BYTES = 1_000_000

/**
 * Walks `bytes` of one day file from `offset`, a line at a time (split on the byte 0x0a, which never occurs inside a
 * UTF-8 sequence), for at most `limit` records; returns where it stopped. Line numbers count non-empty lines, as
 * `fileLines` does.
 */
function walkBytes(
  walk: ChainWalk,
  bytes: Buffer,
  offset: number,
  name: string,
  covered: Covered,
  options: VerifyOptions,
  limit: number
): number {
  let at = offset
  let done = 0

  while (at < bytes.length && done < limit) {
    const end = bytes.indexOf(NEWLINE, at)
    const stop = end === -1 ? bytes.length : end

    if (stop > at) {
      covered.lines += 1
      walkRecord(walk, parseRecord(bytes.toString('utf8', at, stop)), name, covered.lines, options)
      done += 1
    }

    at = stop + 1
  }

  return at
}

const yieldLoop = () => new Promise<void>(resolve => setImmediate(resolve))

/**
 * Permfix (L2 medium): a re-verification the files keep making stale is restarted with a back-off, and after this many
 * restarts in a row, or this long once it was restarted, it reads broken (`changing`), not verifying.
 */
const MAX_RESTARTS = 2
const UNSTABLE_MS = 30_000
const RESTART_BACKOFF_MS = 200
const RESTART_BACKOFF_MAX_MS = 5_000
/** A settled walk that stays valid this long ends a run of restarts. */
const STABLE_MS = 2_000
/** Permfix (L2 major): a full re-verification in the background however healthy the maintained walk reads. */
const REVERIFY_EVERY_MS = 10 * 60_000

interface DiskTail extends ChainHead {
  /** The day file holding the tail and its identity at read time (`''`/`-1` at genesis). */
  file: string
  size: number
  ino: number
}

const GENESIS_TAIL: DiskTail = { seq: 0, sha: GENESIS_SHA, file: '', size: -1, ino: -1 }

function fileIdentity(file: string): { size: number; ino: number } | null {
  try {
    const stat = fs.statSync(file)

    return { size: stat.size, ino: stat.ino }
  } catch {
    return null
  }
}

/** The tail of the chain on disk: where the next record links. A torn last line (crash mid-write) is skipped. */
function chainTail(dir: string): DiskTail {
  const files = auditFiles(dir)

  for (let f = files.length - 1; f >= 0; f -= 1) {
    const file = path.join(dir, files[f])
    const lines = fileLines(file)

    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const record = JSON.parse(lines[i]) as AuditRecord

        if (typeof record.seq_main === 'number' && typeof record.sha256 === 'string') {
          const identity = fileIdentity(file) ?? { size: -1, ino: -1 }

          return { seq: record.seq_main, sha: record.sha256, file, ...identity }
        }
      } catch {
        // keep walking back
      }
    }
  }

  return GENESIS_TAIL
}

/**
 * Records on disk past `from` (T1, r3): accepted as the new tail only when every one of them parses, links from
 * `from`, numbers consecutively and carries our MAC. Anything else is not a chain this writer continues from.
 */
function verifiedAhead(dir: string, from: ChainHead, key: Buffer, kid: string): DiskTail | null {
  let tail: DiskTail = { ...from, file: '', size: -1, ino: -1 }
  let bad = false

  eachRecord(dir, (record, file) => {
    if (bad || !record || record.seq_main <= from.seq) {
      return
    }

    const { sha256: claimed, mac, ...body } = record

    if (
      record.seq_main !== tail.seq + 1 ||
      record.prev_sha256 !== tail.sha ||
      record.kid !== kid ||
      digest(body) !== claimed ||
      !sameHex(mac, hmac(key, claimed))
    ) {
      bad = true

      return
    }

    const at = path.join(dir, file)

    tail = { seq: record.seq_main, sha: claimed, file: at, ...(fileIdentity(at) ?? { size: -1, ino: -1 }) }
  })

  return bad || tail.seq === from.seq ? null : tail
}

interface AuditLogOptions {
  dir: string
  /** The audit key and its id (keys.ts). */
  key: Buffer
  kid: string
  now?: () => Date
  /** Test seam: skip the per-record fsync. */
  durable?: boolean
  /** The master key already existed (keys.ts `sealed`): an empty log with no anchor was emptied, not new. */
  expectExisting?: boolean
  /** Test seam: the period of the background full re-verification. */
  reverifyEveryMs?: number
}

/**
 * Permfix (L3-6): the logs open in this process, by real directory, and how many instances hold each. The lock file is
 * released by the last close only: a second instance can neither steal it nor let the first lose it.
 */
const openLogs = new Map<string, number>()

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** `audit/.lock` with this pid; a live other owner is refused, a dead one's lock is taken over. */
function takeWriterLock(dir: string): () => void {
  const file = path.join(dir, LOCK_FILE)

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600)

      fs.writeSync(fd, String(process.pid))
      fs.closeSync(fd)

      return () => {
        try {
          if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) {
            fs.rmSync(file, { force: true })
          }
        } catch {
          // already gone
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }

      const owner = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10)

      if (Number.isInteger(owner) && owner > 0 && owner !== process.pid && pidAlive(owner)) {
        throw new Error(`the audit log is held by another icloneOS process (pid ${owner})`)
      }

      fs.rmSync(file, { force: true })
    }
  }

  throw new Error('the audit log lock could not be taken')
}

/** Duplicate = this source already delivered that seq (a replay after a lost answer): recorded once. */
type Sourced = { duplicate: true } | { duplicate: false; record: AuditRecord }

/** The re-verify and back-off timers of every open log. Quit stops them; the log itself stays open, so a record a
 *  later teardown stop writes (an ACP work stop, a seal) still lands in the chain. */
const liveTimers = new Set<() => void>()

registerTeardown('permission audit timers', () => {
  ;[...liveTimers].forEach(stop => stop())
})

/** One mode layer's key in `lastModeSets`: the scope, and the project or session it belongs to (none for standing). */
export const modeLayerKey = (scope: 'project' | 'session' | 'standing', key: string | null): string =>
  `${scope}\u0000${key ?? ''}`

export function createAuditLog(options: AuditLogOptions) {
  const now = options.now ?? (() => new Date())
  const durable = options.durable ?? true
  const headFile = path.join(path.dirname(options.dir), HEAD_FILE)
  const listeners = new Set<(record: AuditRecord) => void>()
  // Per plugin source (pid + spawn key): the last src_seq recorded, seeded from the files at open.
  const lastSrcSeq = new Map<string, number>()
  const sourceKey = (pid: number, key: string | null) => `${pid}:${key ?? ''}`

  fs.mkdirSync(options.dir, { recursive: true, mode: 0o700 })

  const realDir = fs.realpathSync(options.dir)
  // A live other process still refuses the open (F-19); this process's own lock is kept, never removed under it.
  const releaseFile = takeWriterLock(options.dir)

  openLogs.set(realDir, (openLogs.get(realDir) ?? 0) + 1)

  const releaseLock = () => {
    const holders = (openLogs.get(realDir) ?? 1) - 1

    if (holders > 0) {
      openLogs.set(realDir, holders)
    } else {
      openLogs.delete(realDir)
      releaseFile()
    }
  }

  // CF4 (B2-m2): the newest main `mode_set` per mode layer, gathered in this same open pass, so the sealed launch's
  // check of mode.json against the audit (authority.ts) reads nothing more. Later lines override earlier ones.
  const lastModeSet = new Map<string, PermissionMode>()

  const noteModeSet = (record: AuditRecord | null) => {
    const scope = record?.scope

    if (
      record?.kind === 'mode_set' &&
      record.src === 'main' &&
      record.mode &&
      (scope === 'standing' || scope === 'project' || scope === 'session')
    ) {
      lastModeSet.set(modeLayerKey(scope, scope === 'standing' ? null : (record.reason ?? null)), record.mode)
    }
  }

  eachRecord(options.dir, record => {
    noteModeSet(record)

    if (record?.src === 'plugin' && typeof record.hermes_pid === 'number' && typeof record.src_seq === 'number') {
      const at = sourceKey(record.hermes_pid, record.src_key ?? null)

      lastSrcSeq.set(at, Math.max(lastSrcSeq.get(at) ?? 0, record.src_seq))
    }
  })

  // The in-memory tail is authoritative while the log is open (T1, r3): a disk tail BEHIND it is a cut, recorded as
  // an integrity gap at memory-seq+1; a disk tail AHEAD of it is adopted only after it chain-verifies; the chain is
  // never re-rooted at genesis while open.
  let tail: DiskTail = chainTail(options.dir)

  const headMac = (head: ChainHead) => hmac(options.key, `head\n${head.seq}\n${head.sha}`)

  const readHead = (): { head: ChainHead | null; forged: boolean } => {
    try {
      const raw = JSON.parse(fs.readFileSync(headFile, 'utf8')) as Record<string, unknown>

      if (typeof raw.seq !== 'number' || typeof raw.sha !== 'string') {
        return { head: null, forged: true }
      }

      const head = { seq: raw.seq, sha: raw.sha }

      if (raw.kid !== options.kid || !sameHex(raw.mac, headMac(head))) {
        return { head: null, forged: true }
      }

      return { head, forged: false }
    } catch {
      return { head: null, forged: false }
    }
  }

  // Durability stays synchronous on purpose: the record and then its anchor are on disk before `append` returns, so a
  // crash can never leave an anchor ahead of the records it names (a false "cut" gap) nor a record the caller was told
  // is written that is not. Two fdatasyncs per record, no directory fsync (the rename is re-done by the next record).
  const writeHead = (head: ChainHead) => {
    // Permfix (L3-6): a name no other writer can share, created exclusively, in the form the leftover sweep knows.
    const tmp = path.join(path.dirname(headFile), `.${HEAD_FILE}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
    const fd = fs.openSync(tmp, 'wx', 0o600)

    try {
      try {
        fs.writeSync(fd, `${JSON.stringify({ seq: head.seq, sha: head.sha, kid: options.kid, mac: headMac(head) })}\n`)

        if (durable) {
          fs.fdatasyncSync(fd)
        }
      } finally {
        fs.closeSync(fd)
      }

      fs.renameSync(tmp, headFile)
    } catch (error) {
      fs.rmSync(tmp, { force: true })

      throw error
    }
  }

  /*
   * V-2 — the chain's health is maintained, never recomputed on a read. `walk` is the verifier's state over exactly the
   * bytes `covered` names (each day file's stamp and line count) and the anchor stamp `headStamp`; each record this
   * writer appends extends it (emit). Anything else that touches the files — a day file edited, cut, replaced, added
   * or removed, the anchor rewritten — no longer matches its stamp, and the whole chain is verified again from disk
   * (`reverify`): in place for a small log, else by a pass that yields the event loop, during which the health reads
   * RED with `verifying`. A tamper is therefore reported exactly as the full verifier reports it, at the next read.
   */
  const verifyOptions: VerifyOptions = { key: options.key, kid: options.kid }
  let walk: ChainWalk | null = null
  let walkHead: ChainHead | null = null
  let covered = new Map<string, Covered>()
  let headStamp: Stamp | null = null
  let lastReport: ChainReport | null = null
  // The running pass, the records appended while it reads, and whether the disk moved again under it.
  let pass: Promise<void> | null = null
  let pendingDuringPass: { record: AuditRecord; name: string }[] = []
  let passStale = false
  let closed = false
  /** Quit (or close) stopped the timers: no periodic pass and no back-off restart is scheduled again. */
  let timersStopped = false
  // Permfix (L2 medium): stale passes in a row, since when the health has had no walk, and the back-off timer.
  let restarts = 0
  let verifyingSince: number | null = null
  let restartTimer: NodeJS.Timeout | null = null
  // When a pass last settled, and whether the walk it left was dropped again before it had been stable for long.
  let settledAt = 0
  let quickDrop = false
  // Off until the open-time integrity records are written: the first verification covers them from disk.
  let watching = false
  const verifiedListeners = new Set<(report: ChainReport) => void>()

  const lastCoveredName = () => {
    let last = ''

    for (const name of covered.keys()) {
      last = name > last ? name : last
    }

    return last
  }

  /** Did anything but this writer touch the log since the walk covered it? readdir + one stat per day file. */
  const diskMoved = (): boolean => {
    const names = auditFiles(options.dir)

    if (names.length !== covered.size || !sameStamp(stampOf(headFile), headStamp)) {
      return true
    }

    if (contentMoved(headFile, headStamp)) {
      return true
    }

    return names.some(name => {
      const file = path.join(options.dir, name)
      const stamp = covered.get(name)?.stamp

      return !sameStamp(stampOf(file), stamp) || contentMoved(file, stamp)
    })
  }

  const snapshot = (): { names: string[]; stamps: Map<string, Stamp>; bytes: number } => {
    const stamps = new Map<string, Stamp>()
    let bytes = 0

    for (const name of auditFiles(options.dir)) {
      const stamp = stampOf(path.join(options.dir, name), true)

      if (stamp) {
        stamps.set(name, stamp)
        bytes += stamp.size
      }
    }

    return { names: [...stamps.keys()], stamps, bytes }
  }

  const settle = (fresh: ChainWalk, freshCovered: Map<string, Covered>, head: ChainHead | null) => {
    walk = fresh
    covered = freshCovered
    walkHead = head
    lastReport = walkReport(fresh, head)
    settledAt = Date.now()

    for (const listener of verifiedListeners) {
      listener(lastReport)
    }
  }

  /** The whole chain from disk, in place: only for a log under SYNC_VERIFY_BYTES. */
  const verifyInPlace = (taken: ReturnType<typeof snapshot>, head: ChainHead | null, stamp: Stamp | null) => {
    const fresh = newWalk()
    const freshCovered = new Map<string, Covered>()

    for (const name of taken.names) {
      const stamped = taken.stamps.get(name) as Stamp
      const entry: Covered = { stamp: stamped, lines: 0 }
      let bytes: Buffer

      try {
        bytes = fs.readFileSync(path.join(options.dir, name)).subarray(0, stamped.size)
      } catch {
        bytes = Buffer.alloc(0)
      }

      walkBytes(fresh, bytes, 0, name, entry, verifyOptions, Number.POSITIVE_INFINITY)
      freshCovered.set(name, entry)
    }

    headStamp = stamp
    settle(fresh, freshCovered, head)
  }

  /**
   * The whole chain from disk without holding the loop: each file read asynchronously up to its size at the snapshot
   * (records this writer appends meanwhile are queued, not read twice), walked in slices of at most SLICE_MS.
   */
  const verifyYielding = async (
    taken: ReturnType<typeof snapshot>,
    head: ChainHead | null,
    stamp: Stamp | null,
    shadow: boolean
  ) => {
    const fresh = newWalk()
    const freshCovered = new Map<string, Covered>()

    // A shadow pass (the periodic one) leaves the maintained walk and its stamps in place: they are what it ends against.
    if (!shadow) {
      headStamp = stamp
      covered = new Map([...taken.stamps].map(([name, stamped]) => [name, { stamp: stamped, lines: 0 }]))
    }

    for (const name of taken.names) {
      const stamped = taken.stamps.get(name) as Stamp
      const entry: Covered = { stamp: stamped, lines: 0 }
      let bytes: Buffer

      try {
        bytes = (await fs.promises.readFile(path.join(options.dir, name))).subarray(0, stamped.size)
      } catch {
        bytes = Buffer.alloc(0)
      }

      let offset = 0
      let began = performance.now()

      while (offset < bytes.length) {
        offset = walkBytes(fresh, bytes, offset, name, entry, verifyOptions, SLICE_RECORDS)

        if (performance.now() - began > SLICE_MS) {
          await yieldLoop()
          began = performance.now()
        }

        if (passStale || closed) {
          return
        }
      }

      freshCovered.set(name, entry)
    }

    // The records appended during the pass follow the snapshot's bytes, in the order they were written.
    let latestHead = head

    for (const { record, name } of pendingDuringPass) {
      const entry = freshCovered.get(name) ?? { stamp: covered.get(name)?.stamp as Stamp, lines: 0 }

      entry.lines += 1
      entry.stamp = covered.get(name)?.stamp ?? entry.stamp
      walkRecord(fresh, record, name, entry.lines, verifyOptions)
      freshCovered.set(name, entry)
      latestHead = { seq: record.seq_main, sha: record.sha256 }
    }

    // The stamps after the queued appends are what this writer left; a difference now is someone else's write.
    for (const [name, entry] of freshCovered) {
      entry.stamp = covered.get(name)?.stamp ?? entry.stamp
    }

    covered = freshCovered

    if (!diskMoved()) {
      settle(fresh, freshCovered, latestHead)
    } else {
      passStale = true
    }
  }

  const startVerifying = () => {
    if (walk) {
      // A walk that stayed valid this long ends a run of restarts; one dropped sooner continues it (settle, then drop).
      if (Date.now() - settledAt < STABLE_MS) {
        quickDrop = true
      } else {
        restarts = 0
        verifyingSince = null
      }
    }

    walk = null
    verifyingSince ??= Date.now()
  }

  const backOff = () => {
    if (timersStopped) {
      return
    }

    restarts += 1
    restartTimer = setTimeout(
      () => {
        restartTimer = null

        if (!closed) {
          reverify()
        }
      },
      Math.min(RESTART_BACKOFF_MAX_MS, RESTART_BACKOFF_MS * 2 ** (restarts - 1))
    )
    restartTimer.unref?.()
  }

  /**
   * Verify the chain from disk again (startup, reconcile, a moved file). `shadow` (the periodic pass): keep reading the
   * maintained walk meanwhile, and replace it with the fresh one when the pass ends on an unmoved disk.
   */
  const reverify = (shadow = false): void => {
    if (!shadow) {
      startVerifying()
    }

    if (pass) {
      passStale ||= !shadow

      return
    }

    // Backing off after stale passes: the timer starts the next one.
    if (restartTimer) {
      return
    }

    let keep = shadow

    if (keep && (!walk || diskMoved())) {
      keep = false
      startVerifying()
    }

    const taken = snapshot()
    const stamp = stampOf(headFile, true)
    const head = readHead().head

    if (taken.bytes <= SYNC_VERIFY_BYTES) {
      quickDrop = false
      verifyInPlace(taken, head, stamp)

      return
    }

    // A pass for a walk the files moved again right after it settled waits its turn like a stale one.
    if (quickDrop && !keep) {
      quickDrop = false
      backOff()

      return
    }

    pendingDuringPass = []
    passStale = false
    pass = verifyYielding(taken, head, stamp, keep)
      .catch(() => {
        passStale = true
      })
      .finally(() => {
        pass = null
        pendingDuringPass = []

        if (passStale && !closed) {
          passStale = false
          startVerifying()
          quickDrop = false
          // L2 medium: never a busy re-read loop; the delay doubles with each stale pass in a row.
          backOff()
        }
      })
  }

  /** The files kept changing under every pass: broken, not verifying (the pane shows the warning). */
  const unstable = () =>
    !walk &&
    verifyingSince !== null &&
    (restarts > MAX_RESTARTS || (restarts > 0 && Date.now() - verifyingSince > UNSTABLE_MS))

  /**
   * Extends the maintained walk by a record this writer just appended, or starts over if the file was not ours (L2
   * major): the file as opened must be the stamp the walk covers (and, on a coarse volume, the bytes it hashed), and
   * the write must have grown that same inode by exactly the record (`consistent`, from emit).
   */
  const extendWalk = (
    record: AuditRecord,
    name: string,
    opened: Stamp,
    prefixSha: string | null,
    consistent: boolean,
    after: Stamp
  ) => {
    const entry = covered.get(name)
    const known = entry?.stamp
    const sameBytes = !known?.coarse || known.settled === true || (known.sha !== undefined && known.sha === prefixSha)

    const ours =
      consistent && (known ? sameStamp(opened, known) && sameBytes : opened.size === 0) && name >= lastCoveredName()

    if (!ours) {
      reverify()

      return
    }

    covered.set(name, { stamp: after, lines: (entry?.lines ?? 0) + 1 })
    headStamp = stampOf(headFile, true)

    if (pass) {
      pendingDuringPass.push({ record, name })
    }

    if (walk) {
      walkRecord(walk, record, name, covered.get(name)?.lines ?? 1, verifyOptions)
      walkHead = { seq: record.seq_main, sha: record.sha256 }
      lastReport = null
    }
  }

  /** Seals and appends one record after the in-memory tail; no look at the disk first. */
  const emit = (entry: AuditEntry, at: Date, seqOverride?: number): AuditRecord => {
    const name = `${at.toISOString().slice(0, 10)}.jsonl`
    const file = path.join(options.dir, name)
    const record = seal(entry, seqOverride ?? tail.seq + 1, tail.sha, at, options.key, options.kid)
    const line = Buffer.from(`${JSON.stringify(record)}\n`)
    const fd = fs.openSync(file, 'a+', 0o600)
    let opened: Stamp
    let wrote: Stamp
    let count: number
    let prefixSha: string | null = null

    try {
      opened = stampFrom(fs.fstatSync(fd))
      count = fs.writeSync(fd, line)
      // Permfix (L2 major): stamped right after the write and BEFORE the flush, on the descriptor. Another writer that
      // lands inside the flush shows below as a file that no longer matches this stamp, never as part of "ours".
      wrote = stampFrom(fs.fstatSync(fd))

      // Coarseness is per stamp (a fine volume reads back a whole millisecond now and then), so each side is judged on
      // its own: an `opened` that is coarse needs the prefix digest to match the covered stamp's digest, even when the
      // stamp the write left is fine; only a coarse `wrote` needs its own digest.
      if (opened.coarse || wrote.coarse) {
        const bytes = Buffer.alloc(wrote.coarse ? wrote.size : opened.size)

        fs.readSync(fd, bytes, 0, bytes.length, 0)
        prefixSha = digestOf(bytes.subarray(0, opened.size))

        if (wrote.coarse) {
          wrote = withDigest(wrote, bytes)
        }
      }

      if (durable) {
        fs.fdatasyncSync(fd)
      }
    } finally {
      fs.closeSync(fd)
    }

    // The flush and the close move no timestamp: the file by path must still be exactly what the write left.
    const closedStamp = stampOf(file)

    const consistent =
      count === line.length &&
      wrote.ino === opened.ino &&
      wrote.size === opened.size + count &&
      sameStamp(closedStamp, wrote) &&
      !contentMoved(file, wrote)

    const after = consistent ? wrote : (closedStamp ?? { size: -1, ino: -1, ctimeMs: -1, mtimeMs: -1 })

    tail = { seq: record.seq_main, sha: record.sha256, file, size: after.size, ino: after.ino }
    writeHead(tail)

    if (watching) {
      extendWalk(record, name, opened, prefixSha, consistent, after)
    }

    for (const listener of listeners) {
      listener(record)
    }

    return record
  }

  /** The maintained health; the stamps are checked first, so a file changed underneath is verified again. */
  const health = (): ChainReport & { verifying: boolean } => {
    if (walk && diskMoved()) {
      reverify()
    }

    if (!walk) {
      const known = lastReport ?? walkReport(newWalk(), null)

      if (unstable()) {
        const changing = { file: '', line: 0, problem: 'changing' as const }

        return { ...known, ok: false, breaks: [...known.breaks, changing], verifying: false }
      }

      return { ...known, ok: false, verifying: true }
    }

    lastReport ??= walkReport(walk, walkHead)

    return { ...lastReport, verifying: false }
  }

  const periodic = setInterval(() => {
    if (!closed && walk && !pass && !restartTimer) {
      reverify(true)
    }
  }, options.reverifyEveryMs ?? REVERIFY_EVERY_MS)

  periodic.unref?.()

  const stopTimers = () => {
    timersStopped = true
    liveTimers.delete(stopTimers)
    clearInterval(periodic)

    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
  }

  liveTimers.add(stopTimers)

  /**
   * Before each append: is the disk still where memory left it? Untouched (same file, size and inode) ⇒ nothing to
   * do. Grown by records that verify from our tail ⇒ adopt them (F-19, a writer with no lock). Anything else — the
   * file cut, replaced, deleted, or grown by records that do not verify — is a hole in the log: an integrity `gap`
   * at memory-seq+1 names the missing records, numbering continues, and the verifier stays RED (T1).
   */
  const reconcile = (at: Date) => {
    if (tail.seq === 0) {
      return
    }

    const identity = fileIdentity(tail.file)

    if (identity && identity.size === tail.size && identity.ino === tail.ino) {
      return
    }

    // The files changed underneath: whatever is decided below, the maintained health is verified again from disk.
    if (watching) {
      reverify()
    }

    const onDisk = chainTail(options.dir)

    if (onDisk.seq === tail.seq && onDisk.sha === tail.sha) {
      tail = onDisk

      return
    }

    if (onDisk.seq > tail.seq) {
      const ahead = verifiedAhead(options.dir, tail, options.key, options.kid)

      if (ahead) {
        tail = ahead

        return
      }
    }

    // Behind, replaced, or ahead with records that are not ours: the chain in memory is the chain.
    const from = onDisk.seq < tail.seq ? onDisk.seq + 1 : tail.seq

    const reason =
      onDisk.seq > tail.seq
        ? `${INTEGRITY_PREFIX} records after ${tail.seq} were added to the log by another writer and do not verify`
        : `${INTEGRITY_PREFIX} records ${from}..${tail.seq} are missing from the log`

    emit({ src: 'main', kind: 'gap', reason }, at)
  }

  const write = (entry: AuditEntry, seqOverride?: number): AuditRecord => {
    const at = now()

    reconcile(at)

    const record = emit(entry, at, seqOverride)

    noteModeSet(record)

    return record
  }

  // Open-time integrity: the anchor must exist (once there is a chain), be ours, and not be ahead of the files.
  const { head, forged } = readHead()

  if (forged) {
    write({ src: 'main', kind: 'gap', reason: `${INTEGRITY_PREFIX} the chain's head anchor was changed or forged` })
  } else if (!head && tail.seq > 0) {
    write({ src: 'main', kind: 'gap', reason: `${INTEGRITY_PREFIX} the chain's head anchor is missing` })
  } else if (!head && options.expectExisting) {
    write({ src: 'main', kind: 'gap', reason: `${INTEGRITY_PREFIX} the log and its anchor were removed` })
  } else if (head && head.seq > tail.seq) {
    // Continue numbering after the anchor, so the hole stays visible to every verifier from now on.
    write(
      {
        src: 'main',
        kind: 'gap',
        reason: `${INTEGRITY_PREFIX} records ${tail.seq + 1}..${head.seq} were cut from the end of the log`
      },
      head.seq + 1
    )
  }

  watching = true
  reverify()

  const gap = (pid: number, key: string | null, from: number, to: number, why: string) =>
    write({
      kind: 'gap',
      src: 'main',
      hermes_pid: pid,
      src_key: key,
      src_seq: to,
      reason:
        from === to
          ? `plugin event ${from} from pid ${pid} ${why}`
          : `plugin events ${from}..${to} from pid ${pid} ${why}`
    })

  return {
    /** Main's own records (mode changes, door answers, restarts). Never sequenced by source. */
    append(entry: AuditEntry): AuditRecord {
      return write(entry)
    },
    /**
     * A record that carries a plugin source sequence. A seq already recorded is a duplicate delivery (dropped); a jump
     * writes a `gap` first. Sources are keyed by pid AND spawn key, so a reused pid starts its own sequence.
     */
    appendSourced(entry: AuditEntry & { hermes_pid: number; src_seq: number }): Sourced {
      const at = sourceKey(entry.hermes_pid, entry.src_key ?? null)
      const last = lastSrcSeq.get(at) ?? 0

      if (entry.src_seq <= last) {
        return { duplicate: true }
      }

      if (entry.src_seq > last + 1) {
        gap(entry.hermes_pid, entry.src_key ?? null, last + 1, entry.src_seq - 1, 'never arrived')
      }

      lastSrcSeq.set(at, entry.src_seq)

      return { duplicate: false, record: write(entry) }
    },
    /** A heartbeat or goodbye says the source allocated up to `hi`: anything not recorded by now is a gap. */
    expectThrough(pid: number, key: string | null, hi: number): void {
      const at = sourceKey(pid, key)
      const last = lastSrcSeq.get(at) ?? 0

      if (Number.isInteger(hi) && hi > last) {
        gap(pid, key, last + 1, hi, 'were allocated but never arrived')
        lastSrcSeq.set(at, hi)
      }
    },
    /** Records after `since` (seq_main), newest last, at most `limit`. */
    tail(since = 0, limit = 200): AuditRecord[] {
      const out: AuditRecord[] = []
      const files = auditFiles(options.dir)

      for (let f = files.length - 1; f >= 0 && out.length < limit; f -= 1) {
        const lines = fileLines(path.join(options.dir, files[f]))

        for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
          try {
            const record = JSON.parse(lines[i]) as AuditRecord

            if (record.seq_main <= since) {
              return out.reverse()
            }

            out.push(record)
          } catch {
            // a torn line is the verifier's to report
          }
        }
      }

      return out.reverse()
    },
    /** The newest main `mode_set` per mode layer (`modeLayerKey`), from the open pass and every write since. */
    lastModeSets: (): ReadonlyMap<string, PermissionMode> => lastModeSet,
    onRecord(listener: (record: AuditRecord) => void): () => void {
      listeners.add(listener)

      return () => listeners.delete(listener)
    },
    /** The full verifier over the files on disk now: forensics and tests. Reads every record; never on a hot path. */
    verify: (): ChainReport =>
      verifyAuditChain(options.dir, { key: options.key, kid: options.kid, head: readHead().head }),
    /**
     * V-2 — the chain's health for `state()`: the maintained verification, RED with `verifying` while a re-verification
     * from disk is still running. Costs a readdir and one stat per day file; reads no record.
     */
    health,
    /** Resolves once the chain is verified (the startup pass, or one started by a change underneath). */
    async whenVerified(): Promise<ChainReport & { verifying: boolean }> {
      while (!walk && !closed && !timersStopped && !unstable()) {
        if (!pass && !restartTimer) {
          reverify()
        }

        if (pass) {
          await pass
        } else if (restartTimer) {
          await new Promise(resolve => setTimeout(resolve, 50))
        } else {
          break
        }
      }

      return health()
    },
    /** A re-verification from disk finished (the window re-reads: the health may have changed with no new record). */
    onVerified(listener: (report: ChainReport) => void): () => void {
      verifiedListeners.add(listener)

      return () => verifiedListeners.delete(listener)
    },
    close: () => {
      if (closed) {
        return
      }

      closed = true
      stopTimers()
      releaseLock()
    },
    dir: options.dir
  }
}

export type AuditLog = ReturnType<typeof createAuditLog>
