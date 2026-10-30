import type {
  AutonomyLevel,
  OfferStanding,
  WorkActionResult,
  WorkOfferView,
  WorkRowView,
  WorkStopReport
} from '../../src/iclone-shared/acp-work'
import { parseCliJson } from '../../src/iclone-shared/cli-json'
/**
 * V3-I — the watchdog: reads the iNFT's jobs (`job list`, `job history`, `agent whoami` — read verbs only, through the
 * same allowlist, lanes and expiry gate as the window's reads), records every offer it sees with the policy's verdict,
 * and acts only as far as the owner's level lets it:
 *   L0 observe — sees and ranks, never acts;
 *   L1 propose — an in-policy offer waits in the inbox for the owner's own Approve or Decline;
 *   L2 act     — quotes in-policy offers by itself (built, OFF until the owner's gesture turns it on, and folded to
 *                observe-only while Spend/trade is off).
 * A decline is final for that job at every level. Out-of-policy offers are refused with the rule named, at every
 * level, and the owner's Approve cannot override a rule.
 *
 * Every write goes through `gatedWrite`: the earn-only door (policy.ts) first, then the actor. Round 1 ships with no
 * actor (`writes: 'off'`): an approval is recorded and the quote is held, so the lab build never accepts a real job.
 */
import type { AcpRunResult } from '../iclone-acp'

import { decisionsOf, firstOf, type Ledger, type LedgerEntry, type LedgerRecord, levelOf, totalsOf } from './ledger'
import { earnOnlyArgv, evaluateOffer, type PolicyVerdict, type WorkPolicy } from './policy'
import {
  normalizeStatus,
  OFFER_STATUSES,
  OWED_STATUSES,
  parseJobList,
  parseWhoami,
  TERMINAL_STATUSES,
  type WorkJob
} from './state'

/** A write the earn-only door let through. */
export interface WorkActor {
  run(slug: string, argv: readonly string[]): Promise<{ ok: boolean; error?: string }>
}

interface WatchdogDeps {
  /** A read verb through the window's own allowlist (`job list`, `job history`, `agent whoami`). */
  read(slug: string, argv: string[]): Promise<AcpRunResult>
  /** null = writes off (round 1): approvals are recorded, quotes held. */
  actor: WorkActor | null
  ledger(slug: string): Ledger
  policy(slug: string): WorkPolicy
  spendTradeOn(): boolean
  /** One line in the V3-F-format audit chain per decision and action. */
  audit(slug: string, entry: WorkAuditEntry): void
  onChange(slug: string): void
  /** A read failed where the last one had not (one Fix entry per failure run, not one per tick). */
  onReadError?(slug: string): void
  now?: () => number
}

export interface WorkAuditEntry {
  verb: 'approve' | 'decline' | 'level' | 'quote' | 'refuse' | 'spend-refused'
  jobId: string | null
  gesture: boolean | null
  allowed: boolean
  reason: string
}

interface Snapshot {
  jobs: WorkJob[]
  wallet: string | null
  readAt: number | null
  readError: string | null
  /** Final statuses learned from `job history` for tracked jobs that left the active list. */
  closed: Map<string, WorkJob>
  paused: boolean
  polling: Promise<void> | null
}

function effectiveLevel(
  level: AutonomyLevel,
  chainOk: boolean,
  spendTradeOn: boolean
): { effective: AutonomyLevel; downgrade: 'chain-broken' | 'spend-trade-off' | null } {
  if (!chainOk) {
    return { effective: 'L0', downgrade: 'chain-broken' }
  }

  if (level === 'L2' && !spendTradeOn) {
    return { effective: 'L0', downgrade: 'spend-trade-off' }
  }

  return { effective: level, downgrade: null }
}

/** Jobs this iNFT provides; a job for another wallet is never ours to quote. */
const mine = (jobs: readonly WorkJob[], wallet: string | null) =>
  wallet ? jobs.filter(job => job.provider === wallet) : []

/** Engaged jobs (budget set and beyond, not terminal) plus approved offers: what `maxOpenJobs` counts. */
function openCount(jobs: readonly WorkJob[], decisions: ReadonlyMap<string, string>): number {
  return jobs.filter(
    job =>
      !TERMINAL_STATUSES.has(job.status) && (!OFFER_STATUSES.has(job.status) || decisions.get(job.jobId) === 'approve')
  ).length
}

const usdcText = (micros: number) => (micros / 1_000_000).toFixed(6).replace(/\.?0+$/, '')

/**
 * The single door every watchdog write goes through. Earn-only first: a refused argv is recorded as a refused spend
 * and no process is started. Then the actor; with none (round 1) the write is held.
 */
export async function gatedWrite(
  deps: Pick<WatchdogDeps, 'actor' | 'audit' | 'ledger'>,
  slug: string,
  argv: readonly string[],
  jobId: string | null
): Promise<'held' | 'refused' | 'sent' | 'failed'> {
  const earn = earnOnlyArgv(argv)
  const ledger = deps.ledger(slug)

  if (!earn) {
    ledger.append({ kind: 'spend-refused', jobId, micros: 0, note: `refused: ${argv.slice(0, 2).join(' ')}` })
    deps.audit(slug, { verb: 'spend-refused', jobId, gesture: null, allowed: false, reason: 'earn-only (D2)' })

    return 'refused'
  }

  if (!deps.actor) {
    return 'held'
  }

  const result = await deps.actor.run(slug, earn)

  return result.ok ? 'sent' : 'failed'
}

export function createWatchdog(deps: WatchdogDeps) {
  const now = deps.now ?? Date.now
  const snapshots = new Map<string, Snapshot>()

  const snap = (slug: string): Snapshot => {
    let current = snapshots.get(slug)

    if (!current) {
      current = {
        jobs: [],
        wallet: null,
        readAt: null,
        readError: null,
        closed: new Map(),
        paused: false,
        polling: null
      }
      snapshots.set(slug, current)
    }

    return current
  }

  const verdictFor = (slug: string, job: WorkJob, records: readonly LedgerRecord[]): PolicyVerdict => {
    const current = snap(slug)

    return evaluateOffer(job, deps.policy(slug), openCount(mine(current.jobs, current.wallet), decisionsOf(records)))
  }

  const append = (slug: string, entry: LedgerEntry) => deps.ledger(slug).append(entry)

  const levelState = (slug: string) => {
    const read = deps.ledger(slug).read()
    const level = levelOf(read)

    return { read, level, ...effectiveLevel(level, read.ok, deps.spendTradeOn()) }
  }

  /** Quote one approved offer at its own price. */
  const quote = async (slug: string, job: WorkJob): Promise<void> => {
    const micros = job.priceMicros ?? 0

    const argv = [
      'provider',
      'set-budget',
      '--job-id',
      job.jobId,
      '--amount',
      usdcText(micros),
      '--chain-id',
      String(job.chainId)
    ]

    const outcome = await gatedWrite(deps, slug, argv, job.jobId)

    if (outcome === 'sent') {
      append(slug, { kind: 'quote', jobId: job.jobId, chainId: job.chainId, micros })
      deps.audit(slug, {
        verb: 'quote',
        jobId: job.jobId,
        gesture: null,
        allowed: true,
        reason: `set-budget ${usdcText(micros)} USDC`
      })
    } else if (outcome !== 'refused') {
      append(slug, {
        kind: 'quote-held',
        jobId: job.jobId,
        chainId: job.chainId,
        micros,
        note: outcome === 'held' ? 'writes are off in this build' : 'the CLI refused the quote'
      })
    }
  }

  /** What one read changes in the ledger: offers seen (once each), earnings and closings of tracked jobs. */
  const fold = async (slug: string, current: Snapshot): Promise<void> => {
    const ledger = deps.ledger(slug)
    let records = ledger.read().records
    const decisions = decisionsOf(records)
    const ours = mine(current.jobs, current.wallet)

    for (const job of ours) {
      if (OFFER_STATUSES.has(job.status) && !firstOf(records, 'offer', job.jobId)) {
        const verdict = verdictFor(slug, job, records)

        ledger.append({
          kind: 'offer',
          jobId: job.jobId,
          chainId: job.chainId,
          micros: job.priceMicros,
          rule: verdict.ok ? null : verdict.rule
        })

        if (!verdict.ok) {
          deps.audit(slug, {
            verb: 'refuse',
            jobId: job.jobId,
            gesture: null,
            allowed: false,
            reason: `policy: ${verdict.rule}`
          })
        }
      }
    }

    // Tracked jobs (approved or quoted) that left the active list: ask their history once for the final status.
    const listed = new Set(current.jobs.map(job => job.jobId))

    for (const [jobId, decision] of decisions) {
      if (decision !== 'approve' || listed.has(jobId) || current.closed.has(jobId)) {
        continue
      }

      const seen = firstOf(records, 'offer', jobId)

      if (!seen?.chainId) {
        continue
      }

      const history = await deps.read(slug, [
        'job',
        'history',
        '--job-id',
        jobId,
        '--chain-id',
        String(seen.chainId),
        '--json'
      ])

      const final = history.ok ? historyJob(parseCliJson(history.stdout), jobId, seen.chainId) : null

      if (final) {
        current.closed.set(jobId, final)
      }
    }

    records = ledger.read().records

    for (const job of [...ours, ...current.closed.values()]) {
      if (job.status === 'completed' && !firstOf(records, 'earn', job.jobId)) {
        ledger.append({ kind: 'earn', jobId: job.jobId, chainId: job.chainId, micros: job.priceMicros ?? 0 })
      }
    }

    // L2: quote in-policy offers by itself — only when nothing folds it down and no drain is running.
    const { effective } = levelState(slug)

    if (effective === 'L2' && !current.paused) {
      records = ledger.read().records

      const taken = decisionsOf(records)

      for (const job of ours) {
        if (OFFER_STATUSES.has(job.status) && !taken.has(job.jobId) && verdictFor(slug, job, records).ok) {
          ledger.append({
            kind: 'approve',
            jobId: job.jobId,
            chainId: job.chainId,
            micros: job.priceMicros,
            gesture: false,
            note: 'L2 policy'
          })
          await quote(slug, job)
          records = ledger.read().records
        }
      }
    }
  }

  const poll = (slug: string): Promise<void> => {
    const current = snap(slug)

    if (current.polling) {
      return current.polling
    }

    current.polling = (async () => {
      if (!current.wallet) {
        const who = await deps.read(slug, ['agent', 'whoami', '--json'])

        current.wallet = who.ok ? parseWhoami(parseCliJson(who.stdout)) : null
      }

      const list = await deps.read(slug, ['job', 'list', '--json'])
      const jobs = list.ok ? parseJobList(parseCliJson(list.stdout)) : null

      if (jobs) {
        current.jobs = jobs
        current.readAt = now()
        current.readError = null
        await fold(slug, current)
      } else {
        const first = current.readError === null

        current.readError = list.ok ? 'unreadable job list' : (list.error ?? `exit ${list.code ?? '?'}`)

        if (first) {
          deps.onReadError?.(slug)
        }
      }
    })().finally(() => {
      current.polling = null
      deps.onChange(slug)
    })

    return current.polling
  }

  /** The honest stop report: every job still open and the client money in escrow on it. */
  const stopReport = (slug: string): WorkStopReport => {
    const open = mine(snap(slug).jobs, snap(slug).wallet).filter(job => !TERMINAL_STATUSES.has(job.status))

    return {
      ok: true,
      open: open.map(job => ({ jobId: job.jobId, status: job.status })),
      escrowMicros: open
        .filter(job => OWED_STATUSES.has(job.status))
        .reduce((sum, job) => sum + (job.priceMicros ?? 0), 0)
    }
  }

  const offerFor = (slug: string, jobId: string): WorkJob | null =>
    mine(snap(slug).jobs, snap(slug).wallet).find(job => job.jobId === jobId && OFFER_STATUSES.has(job.status)) ?? null

  return {
    poll,
    /** A drain is running: no new work is taken, by the owner's inbox or by L2. */
    pause(slug: string, paused: boolean): void {
      snap(slug).paused = paused
      deps.onChange(slug)
    },
    paused: (slug: string): boolean => snap(slug).paused,
    /** The owner's level, set only with his own gesture (main verified it). */
    setLevel(slug: string, level: AutonomyLevel, gesture: boolean): WorkActionResult {
      if (!gesture) {
        deps.audit(slug, {
          verb: 'level',
          jobId: null,
          gesture: false,
          allowed: false,
          reason: `asked for ${level} without a gesture`
        })

        return { ok: false, error: 'gesture' }
      }

      if (!append(slug, { kind: 'level', level, gesture: true })) {
        return { ok: false, error: 'state' }
      }

      deps.audit(slug, { verb: 'level', jobId: null, gesture: true, allowed: true, reason: `level ${level}` })
      deps.onChange(slug)

      return { ok: true }
    },
    async approve(slug: string, jobId: string, gesture: boolean): Promise<WorkActionResult> {
      const job = offerFor(slug, jobId)
      const { read, effective } = levelState(slug)

      const refuse = (error: 'gesture' | 'invalid' | 'policy' | 'state', reason: string): WorkActionResult => {
        deps.audit(slug, { verb: 'approve', jobId, gesture, allowed: false, reason })

        return { ok: false, error }
      }

      if (!gesture) {
        return refuse('gesture', 'no gesture')
      }

      if (!job) {
        return refuse('invalid', 'not an open offer for this iNFT')
      }

      if (effective === 'L0' || snap(slug).paused) {
        return refuse('state', effective === 'L0' ? 'observe-only' : 'draining')
      }

      if (decisionsOf(read.records).has(jobId)) {
        return refuse('state', 'already decided')
      }

      const verdict = verdictFor(slug, job, read.records)

      if (!verdict.ok) {
        deps.audit(slug, { verb: 'approve', jobId, gesture, allowed: false, reason: `policy: ${verdict.rule}` })

        return { ok: false, error: 'policy', rule: verdict.rule }
      }

      append(slug, { kind: 'approve', jobId, chainId: job.chainId, micros: job.priceMicros, gesture: true })
      deps.audit(slug, { verb: 'approve', jobId, gesture: true, allowed: true, reason: 'owner approved' })
      await quote(slug, job)
      deps.onChange(slug)

      return { ok: true }
    },
    decline(slug: string, jobId: string, gesture: boolean): WorkActionResult {
      if (!gesture) {
        deps.audit(slug, { verb: 'decline', jobId, gesture: false, allowed: false, reason: 'no gesture' })

        return { ok: false, error: 'gesture' }
      }

      const known = mine(snap(slug).jobs, snap(slug).wallet).find(job => job.jobId === jobId)

      if (!known || !OFFER_STATUSES.has(known.status)) {
        return { ok: false, error: 'invalid' }
      }

      if (decisionsOf(deps.ledger(slug).read().records).get(jobId) === 'decline') {
        return { ok: true }
      }

      append(slug, { kind: 'decline', jobId, chainId: known.chainId, gesture: true })
      deps.audit(slug, { verb: 'decline', jobId, gesture: true, allowed: true, reason: 'owner declined' })
      deps.onChange(slug)

      return { ok: true }
    },
    /** The drain's view: offers to refuse (nothing owed yet) and jobs that block the stop. */
    drainView(slug: string): { known: boolean; refuse: WorkJob[]; blocking: WorkJob[] } {
      const current = snap(slug)
      const ours = mine(current.jobs, current.wallet)

      return {
        known: current.readAt !== null && current.readError === null && current.wallet !== null,
        refuse: ours.filter(job => OFFER_STATUSES.has(job.status)),
        blocking: ours.filter(job => OWED_STATUSES.has(job.status) || job.status === 'budget_set')
      }
    },
    stopReport,
    view(slug: string) {
      const current = snap(slug)
      const { read, level, effective, downgrade } = levelState(slug)
      const ours = mine(current.jobs, current.wallet)

      return {
        level,
        effective,
        downgrade,
        writes: deps.actor ? ('on' as const) : ('off' as const),
        offers: offersView(ours, read.records, (job, records) => verdictFor(slug, job, records)),
        rows: rowsView(ours, current.closed, read.records),
        totals: { ...totalsOf(read.records), escrowMicros: stopReport(slug).escrowMicros },
        chain: {
          ok: read.ok,
          records: read.records.length,
          gaps: read.records.filter(record => record.kind === 'gap').length
        },
        readAt: current.readAt,
        readError: current.readError
      }
    }
  }
}

export type Watchdog = ReturnType<typeof createWatchdog>

/** `job history --json` -> the job with its final status, or null when the answer does not say. */
function historyJob(raw: unknown, jobId: string, chainId: number): WorkJob | null {
  const root = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null

  const job =
    root?.job && typeof root.job === 'object' ? { ...(root.job as Record<string, unknown>) } : root ? { ...root } : null

  if (!job) {
    return null
  }

  job.jobId ??= jobId
  job.chainId ??= chainId

  const parsed = parseJobList([job])?.[0] ?? null

  return parsed && parsed.status ? { ...parsed, status: normalizeStatus(parsed.status) } : null
}

function offersView(
  ours: readonly WorkJob[],
  records: readonly LedgerRecord[],
  verdict: (job: WorkJob, records: readonly LedgerRecord[]) => PolicyVerdict
): WorkOfferView[] {
  const decisions = decisionsOf(records)

  return ours
    .filter(job => OFFER_STATUSES.has(job.status))
    .map((job): WorkOfferView => {
      const decided = decisions.get(job.jobId)
      const check = verdict(job, records)
      const held = records.find(record => record.kind === 'quote-held' && record.jobId === job.jobId)

      const standing: OfferStanding =
        decided === 'decline' || decided === 'drain-refuse'
          ? 'declined'
          : decided === 'approve'
            ? 'approved'
            : check.ok
              ? 'pending'
              : 'refused'

      return {
        jobId: job.jobId,
        chainId: job.chainId,
        title: job.title,
        requester: job.requester,
        priceMicros: job.priceMicros,
        status: job.status,
        standing,
        rule: check.ok ? null : check.rule,
        note: held?.note ?? null
      }
    })
}

/** Statuses that prove a budget was set on the job (expired or rejected prove nothing about it). */
const BUDGETED_STATUSES: ReadonlySet<string> = new Set([
  'budget_set',
  'funded',
  'transaction',
  'submitted',
  'evaluation',
  'completed'
])

/** One row per job this iNFT engaged in; every hop from the records that prove it, a missing one left null. */
function rowsView(
  ours: readonly WorkJob[],
  closed: ReadonlyMap<string, WorkJob>,
  records: readonly LedgerRecord[]
): WorkRowView[] {
  const decisions = decisionsOf(records)
  const byId = new Map<string, WorkJob>()

  for (const job of ours) {
    if (!OFFER_STATUSES.has(job.status) || decisions.get(job.jobId) === 'approve') {
      byId.set(job.jobId, job)
    }
  }

  for (const [jobId, job] of closed) {
    byId.set(jobId, job)
  }

  const ids = new Set([
    ...byId.keys(),
    ...records.filter(r => r.kind === 'earn' && r.jobId).map(r => r.jobId as string)
  ])

  return [...ids].map((jobId): WorkRowView => {
    const job = byId.get(jobId) ?? null
    const offer = firstOf(records, 'offer', jobId)
    const quoted = firstOf(records, 'quote', jobId)
    const earn = firstOf(records, 'earn', jobId)
    const status = job?.status ?? (earn ? 'completed' : 'unknown')
    const delivered = job && ['submitted', 'evaluation', 'completed'].includes(job.status)

    return {
      jobId,
      chainId: job?.chainId ?? offer?.chainId ?? 0,
      title: job?.title ?? '',
      status,
      group: earn
        ? 'payments'
        : TERMINAL_STATUSES.has(status)
          ? status === 'completed'
            ? 'completed'
            : 'history'
          : 'in-flight',
      trace: {
        offer: offer?.ts ?? null,
        job: job ? jobId : null,
        budgetMicros: quoted?.micros ?? (job && BUDGETED_STATUSES.has(job.status) ? job.priceMicros : null),
        deliverable: job?.deliverable ?? (delivered ? job.status : null),
        paymentMicros: earn?.micros ?? null
      }
    }
  })
}
