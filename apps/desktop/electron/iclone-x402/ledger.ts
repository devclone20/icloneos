/**
 * V3-J — the payment ledger: one JSONL under `userData/payments/ledger.jsonl`, 0600, written only by main, every row
 * hash-chained to the one before it and the head (last seq + sha) kept beside it — the scheme of V3-I's WORK ledger
 * (`iclone-acp-work/ledger.ts`), kept format-compatible so the WORK tab can fold `kind:"payment"` rows from it at
 * the merge. It holds EVERY decision: a refusal and the rule that made it, a signature (the spend that counts), what
 * the server answered, a mandate's issue / use / revoke, a settings change, the stop.
 *
 * The daily ceilings in `limits.ts` are folded from these rows on every read — nothing is a cached counter — so a
 * chain that does not verify refuses every payment (`limits` rule `ledger`) until the owner repairs it.
 *
 * Every write replaces the whole file atomically (temp + fsync + rename, `writeFileAtomicSync`), so a kill leaves
 * the old file or the new one, never a half row.
 *
 * Timestamps only move forward (I7): `append` refuses a row whose instant is earlier than the last row's `ts` (a stale
 * issued instant, or a wall clock stepped back: the write fails closed until the clock passes the last row), and
 * `readLedger` calls a chain whose `ts` goes backwards broken. A UTC day's spend can never be moved into an earlier day.
 *
 * What is scrubbed, exactly (r3 I6):
 *   - identity fields (`agent`, `mandate`, `transactionId`, `payTo`, `network`) are validated by shape and stored RAW,
 *     never redacted (the caps compare them by equality); a malformed one refuses the append;
 *   - `nonce` / `transaction` are kept only as `0x` + 64 hex (anything else is null);
 *   - `resource` passes the shared redactor (`redactSecrets`, hex64 on);
 *   - `note` (free text) passes `scrubNote`: the shared redactor, then every run of 16+ hex digits (`0x` optional, any
 *     case) and every base64/base64url run of 20+ characters that mixes digits and letters. That masks a 32-byte key
 *     in hex whole, in halves, thirds or quarters (each run ≥ 16 digits), written as one decimal number, and in base64
 *     or base64url (of its bytes or of its hex) whole or halved.
 *   - NOT masked, by construction: key material cut into pieces shorter than those runs — hex in groups of 8 split by
 *     spaces, hex in fifths (13 digits), base64 in thirds (15 characters), spread over one or several notes — or
 *     percent-encoded (`%61%62…`). The guarantee is that no writer puts key material in a note (the signer's error is
 *     the fixed note `sign failed`; every other note is our own text, an origin or a facilitator reason); the scrubber
 *     is the second line, not the first.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { redactSecrets } from '../../src/iclone-shared/redact'
import { isAtomicTempName, writeFileAtomicSync } from '../lib/atomic-write'

import type { LimitRule } from './limits'
import type { LimitsLedgerView, SignedRow } from './limits'
import { isAgentSlug, isMandateId, isNetwork, normalizeAddress } from './types'

const LEDGER_KINDS = [
  'refuse',
  'allow',
  'signed',
  'settled',
  'pending',
  'failed',
  'earned',
  'claim',
  'mandate_issue',
  'mandate_use',
  'mandate_revoke',
  'setting',
  'stop',
  'gap'
] as const

type LedgerKind = (typeof LEDGER_KINDS)[number]

/** Why a payment was refused: a limit rule, or one of the client's own reasons. */
export type RefuseReason =
  | LimitRule
  | 'agent'
  | 'cross_origin_redirect'
  | 'door_denied'
  | 'duplicate'
  | 'facilitator'
  | 'internal'
  | 'mandate_invalid'
  | 'network'
  | 'no_door'
  | 'no_mandate'
  | 'not_x402'
  | 'payload'
  | 'signer_unavailable'
  | 'unsupported_version'

interface LedgerRecord {
  v: 1
  seq: number
  ts: string
  kind: LedgerKind
  agent: string | null
  resource: string | null
  payTo: string | null
  network: string | null
  micros: number | null
  rule: RefuseReason | null
  /** The open mandate's id (a hash of the SD-JWT, never the token) and the closed one's `transaction_id`. */
  mandate: string | null
  transactionId: string | null
  /** The EIP-3009 nonce of a signature; the chain transaction once the server answered. */
  nonce: string | null
  transaction: string | null
  note: string | null
  prev: string
  sha: string
}

type LedgerEntry = Partial<Omit<LedgerRecord, 'prev' | 'seq' | 'sha' | 'ts' | 'v'>> & { kind: LedgerKind }

const GENESIS = '0'.repeat(64)
const NOTE_MAX = 500
const ROW_MAX = 8 * 1024

const sha256 = (data: string) => createHash('sha256').update(data).digest('hex')
const digest = (body: Omit<LedgerRecord, 'sha'>) => sha256(JSON.stringify(body))
const lineOf = (record: LedgerRecord) => `${JSON.stringify(record)}\n`

const str = (value: unknown, max = NOTE_MAX): string | null =>
  typeof value === 'string' ? redactSecrets(value, { hex64: true }).slice(0, max) : null

const INVALID = Symbol('invalid identity field')

/**
 * An identity field: absent ⇒ null, the right shape ⇒ the value RAW, anything else ⇒ the row is refused. Never
 * redacted: the caps and the mandate budget compare these by equality, and a redactor rewrites legal values.
 */
const ident = (value: unknown, valid: (value: unknown) => boolean): string | null | typeof INVALID =>
  value === undefined || value === null ? null : valid(value) ? (value as string) : INVALID

const isPayee = (value: unknown): boolean => typeof value === 'string' && normalizeAddress(value) === value

/** 16+ hex digits, with or without `0x`: a key, a half key, a quarter key. Nonces and hashes have their own fields. */
const HEX_RUN = /(?:0x)?[0-9a-fA-F]{16,}/g
/** 20+ base64 / base64url characters holding a digit and a letter: a key's bytes (32 → 43–44 chars) or a part of them. */
const B64_RUN = /[A-Za-z0-9+/_-]{20,}={0,2}/g

/**
 * A note is free text, so it is scrubbed harder than a field: the shared redactor (bearer tokens, JWTs, PEM, seed
 * words, `0x`-hex64), then any run of 16+ hex digits (bare hex64, either half of one, its upper case), then any
 * base64-alphabet run of 20+ characters that mixes digits and letters (base64 / base64url of the key bytes or of
 * its hex). A note never needs either: amounts, addresses, nonces and transactions live in their own fields.
 * Shorter fragments and percent-encoding are not masked (the file header lists them; `ledger.test.ts` › "I6" pins it).
 */
const scrubNote = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null
  }

  return redactSecrets(value, { hex64: true })
    .replace(HEX_RUN, '[redacted-hex]')
    .replace(B64_RUN, run => (/\d/.test(run) && /[A-Za-z]/.test(run) ? '[redacted-b64]' : run))
    .slice(0, NOTE_MAX)
}

/** A nonce or a chain transaction is public and has a key's shape: scrubbed of everything but hex64. */
const hash = (value: unknown, max: number): string | null =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value) ? value.slice(0, max) : null

/** The row, or null when an identity field has the wrong shape (the append is refused; the caller refuses the payment). */
function seal(entry: LedgerEntry, seq: number, prev: string, at: Date): LedgerRecord | null {
  const agent = ident(entry.agent, isAgentSlug)
  const payTo = ident(entry.payTo, isPayee)
  const network = ident(entry.network, isNetwork)
  const mandate = ident(entry.mandate, isMandateId)
  const transactionId = ident(entry.transactionId, isMandateId)

  if (
    agent === INVALID ||
    payTo === INVALID ||
    network === INVALID ||
    mandate === INVALID ||
    transactionId === INVALID
  ) {
    return null
  }

  const body: Omit<LedgerRecord, 'sha'> = {
    v: 1,
    seq,
    ts: at.toISOString(),
    kind: entry.kind,
    agent,
    resource: str(entry.resource, 2048),
    payTo,
    network,
    micros: Number.isSafeInteger(entry.micros) ? (entry.micros as number) : null,
    rule: entry.rule ?? null,
    mandate,
    transactionId,
    nonce: hash(entry.nonce, 66),
    transaction: hash(entry.transaction, 66),
    note: scrubNote(entry.note),
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
    typeof row.ts === 'string' &&
    (LEDGER_KINDS as readonly unknown[]).includes(row.kind) &&
    (row.micros === null || Number.isSafeInteger(row.micros)) &&
    (row.agent === null || typeof row.agent === 'string')
  )
}

interface LedgerHead {
  seq: number
  sha: string
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

const writeHead = (file: string, head: LedgerHead): void =>
  writeFileAtomicSync(headFileOf(file), JSON.stringify(head), { mode: 0o600, dirMode: 0o700 })

type LedgerProblem = 'head' | 'line' | 'truncated'

interface LedgerRead {
  records: LedgerRecord[]
  ok: boolean
  brokenAt: number | null
  problem: LedgerProblem | null
}

/**
 * The head against the records. The head exists from before the first row (a genesis head, seq 0, is written ahead of
 * it), so a missing head with ANY row is a problem — a file cut to one row with its head deleted is not a fresh ledger.
 * A head that lags the file (a crash between the row and the head write) is fine; one ahead of it is `truncated`.
 */
function headProblem(head: LedgerHead | null, records: readonly LedgerRecord[]): LedgerProblem | null {
  const last = records.length

  if (!head) {
    return last === 0 ? null : 'head'
  }

  if (head.seq > last) {
    return 'truncated'
  }

  const named = head.seq === 0 ? GENESIS : records[head.seq - 1].sha

  return named === head.sha ? null : 'head'
}

/** Reads and verifies the whole chain against its head. Pure. */
export function readLedger(file: string): LedgerRead {
  let text = ''

  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    text = ''
  }

  const lines = text.length ? text.replace(/\n$/, '').split('\n') : []
  const records: LedgerRecord[] = []
  let prev = GENESIS
  let lastMs = -Infinity
  let brokenAt: number | null = null

  for (let index = 0; index < lines.length; index += 1) {
    let parsed: unknown = null

    try {
      parsed = lines[index].length <= ROW_MAX ? JSON.parse(lines[index]) : null
    } catch {
      parsed = null
    }

    if (!isRecord(parsed)) {
      brokenAt = index + 1

      break
    }

    const { sha, ...body } = parsed
    const ms = Date.parse(parsed.ts)

    // A row older than the one before it is not a row this ledger wrote (append refuses it): the chain is broken.
    if (
      digest(body) !== sha ||
      parsed.prev !== prev ||
      parsed.seq !== records.length + 1 ||
      !Number.isFinite(ms) ||
      ms < lastMs
    ) {
      brokenAt = index + 1

      break
    }

    lastMs = ms

    records.push(parsed)
    prev = sha
  }

  const problem: LedgerProblem | null = brokenAt !== null ? 'line' : headProblem(readHead(file), records)

  return { records, ok: problem === null, brokenAt, problem }
}

/** The rows the ceilings fold over: every signature, by agent and time. A broken chain folds to `ok:false`. */
export function limitsViewOf(read: LedgerRead): LimitsLedgerView {
  const signed: SignedRow[] = []

  for (const row of read.records) {
    if (row.kind === 'signed' && row.micros !== null && row.agent !== null) {
      signed.push({ ts: row.ts, agent: row.agent, micros: row.micros })
    }
  }

  return { ok: read.ok, signed }
}

export interface PaymentLedger {
  readonly file: string
  /**
   * The ONE clock of payments: the client has none of its own and reads this one, so the instant a ceiling is checked
   * at and the instant its row is sealed with come from the same source (default: the wall clock, `Date.now`).
   */
  now: () => Date
  /**
   * The sealed row, or null when the chain does not verify, an identity field is malformed or the write failed (the
   * caller refuses). `at` seals the row with an instant already read from THIS ledger's `now()` (the one the gates
   * were evaluated at); any other Date — a foreign clock's, or an issued one modified since — refuses the append.
   */
  append: (entry: LedgerEntry, at?: Date) => LedgerRecord | null
  read: () => LedgerRead
  limitsView: () => LimitsLedgerView
}

interface LedgerOptions {
  file: string
  now?: () => Date
}

export function createLedger(options: LedgerOptions): PaymentLedger {
  const clock = options.now ?? (() => new Date(Date.now()))
  /** Every instant this ledger handed out, by object, with the value it had: only these may seal a row. */
  const issued = new WeakMap<Date, number>()

  const now = (): Date => {
    const instant = new Date(clock().getTime())

    issued.set(instant, instant.getTime())

    return instant
  }

  const dir = path.dirname(options.file)
  const base = path.basename(options.file)

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

  const read = () => readLedger(options.file)

  const append = (entry: LedgerEntry, at?: Date): LedgerRecord | null => {
    if (at !== undefined && issued.get(at) !== at.getTime()) {
      return null
    }

    const current = read()

    if (!current.ok) {
      return null
    }

    if (current.records.length === 0 && readHead(options.file) === null) {
      // The genesis head goes down before the first row: from then on a missing head is always a problem.
      try {
        writeHead(options.file, { seq: 0, sha: GENESIS })
      } catch {
        return null
      }
    }

    const last = current.records[current.records.length - 1]
    const instant = at ?? now()

    // Timestamps only move forward (r3 I7): a row is never sealed earlier than the one before it, so an instant issued
    // before another row was written, or a wall clock stepped back, cannot backdate spend into an earlier UTC day.
    if (last && instant.getTime() < Date.parse(last.ts)) {
      return null
    }

    const record = seal(entry, current.records.length + 1, last?.sha ?? GENESIS, instant)

    if (!record) {
      return null
    }

    const text = current.records.map(lineOf).join('') + lineOf(record)

    try {
      writeFileAtomicSync(options.file, text, { mode: 0o600, dirMode: 0o700 })
    } catch {
      return null
    }

    try {
      writeHead(options.file, { seq: record.seq, sha: record.sha })
    } catch {
      // The row is durable; a head left behind is caught on the next read as `head` and the owner repairs it.
    }

    return record
  }

  return { file: options.file, now, append, read, limitsView: () => limitsViewOf(read()) }
}
