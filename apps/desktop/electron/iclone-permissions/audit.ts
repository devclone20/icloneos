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
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { redactSecrets } from '../../src/iclone-shared/redact'

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
  problem: 'anchor' | 'hash' | 'mac' | 'parse' | 'prev' | 'seq'
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

/** Walks every day file in order and checks parse, digest, MAC, link, sequence, the anchor and integrity gaps. */
export function verifyAuditChain(dir: string, options: VerifyOptions = {}): ChainReport {
  const breaks: ChainBreak[] = []
  let prev = GENESIS_SHA
  let seq = 0
  let records = 0
  let gaps = 0
  let unauthenticated = 0
  let lastFile = ''
  let lastLine = 0

  eachRecord(dir, (record, file, line) => {
    lastFile = file
    lastLine = line

    if (!record) {
      breaks.push({ file, line, problem: 'parse' })

      return
    }

    const { sha256: claimed, mac, ...body } = record

    if (digest(body) !== claimed) {
      breaks.push({ file, line, problem: 'hash' })
    }

    if (options.key) {
      if (record.kid !== options.kid) {
        unauthenticated += 1
      } else if (!sameHex(mac, hmac(options.key, claimed))) {
        breaks.push({ file, line, problem: 'mac' })
      }
    }

    if (record.prev_sha256 !== prev) {
      breaks.push({ file, line, problem: 'prev' })
    }

    if (record.seq_main !== seq + 1) {
      breaks.push({ file, line, problem: 'seq' })
    }

    if (record.kind === 'gap') {
      gaps += 1

      if (typeof record.reason === 'string' && record.reason.startsWith(INTEGRITY_PREFIX)) {
        breaks.push({ file, line, problem: 'anchor' })
      }
    }

    records += 1
    prev = claimed
    seq = record.seq_main
  })

  if (options.head && options.head.seq > seq) {
    breaks.push({ file: lastFile, line: lastLine + 1, problem: 'anchor' })
  }

  return {
    ok: breaks.length === 0 && unauthenticated === 0,
    records,
    gaps,
    unauthenticated,
    breaks,
    last: { seq, sha: prev }
  }
}

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
}

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

export function createAuditLog(options: AuditLogOptions) {
  const now = options.now ?? (() => new Date())
  const durable = options.durable ?? true
  const headFile = path.join(path.dirname(options.dir), HEAD_FILE)
  const listeners = new Set<(record: AuditRecord) => void>()
  // Per plugin source (pid + spawn key): the last src_seq recorded, seeded from the files at open.
  const lastSrcSeq = new Map<string, number>()
  const sourceKey = (pid: number, key: string | null) => `${pid}:${key ?? ''}`

  fs.mkdirSync(options.dir, { recursive: true, mode: 0o700 })

  const releaseLock = takeWriterLock(options.dir)

  eachRecord(options.dir, record => {
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

  const writeHead = (head: ChainHead) => {
    const tmp = `${headFile}.${process.pid}.tmp`
    const fd = fs.openSync(tmp, 'w', 0o600)

    try {
      fs.writeSync(fd, `${JSON.stringify({ seq: head.seq, sha: head.sha, kid: options.kid, mac: headMac(head) })}\n`)

      if (durable) {
        fs.fdatasyncSync(fd)
      }
    } finally {
      fs.closeSync(fd)
    }

    fs.renameSync(tmp, headFile)
  }

  /** Seals and appends one record after the in-memory tail; no look at the disk first. */
  const emit = (entry: AuditEntry, at: Date, seqOverride?: number): AuditRecord => {
    const file = path.join(options.dir, `${at.toISOString().slice(0, 10)}.jsonl`)
    const record = seal(entry, seqOverride ?? tail.seq + 1, tail.sha, at, options.key, options.kid)
    const fd = fs.openSync(file, 'a', 0o600)
    let identity: { size: number; ino: number }

    try {
      fs.writeSync(fd, `${JSON.stringify(record)}\n`)

      if (durable) {
        fs.fdatasyncSync(fd)
      }

      const stat = fs.fstatSync(fd)

      identity = { size: stat.size, ino: stat.ino }
    } finally {
      fs.closeSync(fd)
    }

    tail = { seq: record.seq_main, sha: record.sha256, file, ...identity }
    writeHead(tail)

    for (const listener of listeners) {
      listener(record)
    }

    return record
  }

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

    return emit(entry, at, seqOverride)
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
    onRecord(listener: (record: AuditRecord) => void): () => void {
      listeners.add(listener)

      return () => listeners.delete(listener)
    },
    verify: (): ChainReport =>
      verifyAuditChain(options.dir, { key: options.key, kid: options.kid, head: readHead().head }),
    close: releaseLock,
    dir: options.dir
  }
}

export type AuditLog = ReturnType<typeof createAuditLog>
