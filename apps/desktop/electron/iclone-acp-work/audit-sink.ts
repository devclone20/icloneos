/**
 * V3-I — where the watchdog's decisions are audited.
 *
 * The target is V3-F's hardened audit chain (keyed, one writer, a `watchdog` source). Until V3-F exports that writer,
 * WORK keeps an interim chain in the V3-F format under `userData/acp-work/audit`. Switching is one line in main.ts:
 * pass the V3-F writer as `shared` instead of null. Nothing else in WORK changes.
 *
 * Since V3-F r3 the chain is keyed and anchored by the writer itself (`audit-head.json` beside the audit dir, MAC'd):
 * a tail cut, a missing or forged anchor is recorded by V3-F as an integrity `gap` at open and stays visible to every
 * verifier from then on. The interim sink only carries its own MAC key and reports what the writer found.
 *
 * It only OPENS an existing chain (K98 follow-up): once a chain was started here — its key, its head anchor or WORK's
 * own state is on disk — a chain that is gone is never taken as a first start. The writer opens with `expectExisting`, so the first
 * record it writes is the refusal (`audit integrity: the log and its anchor were removed`), visible to every verifier
 * from then on, and the sink reports `missing` instead of a fresh, green chain.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { type AuditLog, createAuditLog, verifyAuditChain } from '../iclone-permissions/audit'
import { writeFileAtomicSync } from '../lib/atomic-write'

import type { WorkAuditEntry } from './watchdog'

type AuditAppend = Parameters<AuditLog['append']>[0]

/** V3-F's exported writer, as WORK will call it: its own entry shape, with the `watchdog` source. */
export interface SharedAuditWriter {
  append(entry: Omit<AuditAppend, 'src'> & { src: 'watchdog' }): unknown
}

interface AuditIntegrity {
  ok: boolean
  /**
   * `truncated`: records the anchor vouched for are gone. `head`: the anchor is missing, forged or disagrees.
   * `missing`: a chain was started here (its key or anchor is on disk) and the whole log is gone.
   */
  problem: 'head' | 'missing' | 'truncated' | null
}

export interface WorkAuditSink {
  record(slug: string, entry: WorkAuditEntry): void
  integrity(): AuditIntegrity
}

const KEY_FILE = 'interim.key'
const KID = 'acp-work-interim'
const HEAD_FILE = 'audit-head.json'

/**
 * A chain was started in `dir` before: its MAC key or the writer's head anchor (beside the dir) is on disk, or WORK
 * has other state beside it (a per-iNFT ledger) — WORK opens this sink at every launch, before any ledger exists, so
 * that state means an earlier launch made the chain. Removing the audit dir AND its anchor still leaves that state.
 */
function chainExpected(dir: string): boolean {
  const work = path.dirname(dir)

  if (fs.existsSync(path.join(dir, KEY_FILE)) || fs.existsSync(path.join(work, HEAD_FILE))) {
    return true
  }

  try {
    return fs.readdirSync(work).some(name => name !== path.basename(dir) && name !== HEAD_FILE && !name.startsWith('.'))
  } catch {
    return false
  }
}

/**
 * The interim chain's own MAC key (V3-F r2+ writes nothing without one): 32 random bytes beside the chain, 0600,
 * made once. Not the permission key; it only lets the interim records carry a MAC until the shared writer is wired.
 */
export function interimAuditKey(dir: string): { key: Buffer; kid: string } {
  const file = path.join(dir, KEY_FILE)

  try {
    const key = fs.readFileSync(file)

    if (key.length === 32) {
      return { key, kid: KID }
    }
  } catch {
    // first start: made below
  }

  const key = crypto.randomBytes(32)

  writeFileAtomicSync(file, key, { mode: 0o600, dirMode: 0o700 })

  return { key, kid: KID }
}

/** One watchdog decision in the V3-F record shape (the source is set by the sink). */
function auditEntryOf(slug: string, entry: WorkAuditEntry): Omit<AuditAppend, 'src'> {
  const level = entry.verb === 'level'

  return {
    kind: level ? (entry.allowed ? 'mode_set' : 'mode_refused') : entry.allowed ? 'use' : 'refuse',
    class: entry.verb === 'spend-refused' ? '$' : entry.verb === 'quote' ? 'N' : null,
    action: {
      tool: `acp-work.${entry.verb}`,
      target: entry.jobId ? `${slug}#${entry.jobId}` : slug,
      project_root: null
    },
    agent: { inft: slug, profile: null, session_id: null, subagent_id: null, task_id: null },
    answer:
      entry.verb === 'approve' && entry.allowed ? 'once' : entry.verb === 'decline' && entry.allowed ? 'deny' : null,
    gesture: entry.gesture,
    reason: `watchdog: ${entry.reason}`
  }
}

const INTEGRITY_RE = /^audit integrity:/

/** What V3-F's writer found at open (its own `gap` records past the previous tail) and what the verifier says now. */
function integrityOf(log: AuditLog, openedAt: number): AuditIntegrity {
  const opened = log.tail(openedAt).filter(record => record.kind === 'gap' && INTEGRITY_RE.test(record.reason ?? ''))
  const report = log.verify()

  if (opened.length === 0 && report.ok) {
    return { ok: true, problem: null }
  }

  if (opened.some(record => /the log and its anchor were removed/.test(record.reason ?? ''))) {
    return { ok: false, problem: 'missing' }
  }

  // What the writer said at open names the fault; a red verifier with nothing new at open is an old, still-visible cut.
  const cut =
    opened.length > 0
      ? opened.some(record => /cut from the end/.test(record.reason ?? ''))
      : report.breaks.some(b => b.problem === 'anchor' || b.problem === 'seq')

  return { ok: false, problem: cut ? 'truncated' : 'head' }
}

function interimSink(dir: string, now?: () => Date): WorkAuditSink {
  const before = verifyAuditChain(dir).last.seq
  // Read before the key is made: on a first start nothing is expected; after it, a missing log is refused as one.
  const expectExisting = chainExpected(dir)
  const log = createAuditLog({ dir, ...interimAuditKey(dir), now, expectExisting })
  const integrity = integrityOf(log, before)

  return {
    record: (slug, entry) => void log.append({ ...auditEntryOf(slug, entry), src: 'main' }),
    integrity: () => integrity
  }
}

export function createWorkAuditSink(options: {
  dir: string
  /** V3-F's hardened writer; null keeps the interim chain. */
  shared: SharedAuditWriter | null
  now?: () => Date
}): WorkAuditSink {
  const { shared } = options

  if (shared) {
    return {
      record: (slug, entry) => void shared.append({ ...auditEntryOf(slug, entry), src: 'watchdog' }),
      integrity: () => ({ ok: true, problem: null })
    }
  }

  return interimSink(options.dir, options.now)
}
