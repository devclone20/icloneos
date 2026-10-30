/**
 * V3-I — safe offline. The protocol has no cancel verb (contract R3): a job taken cannot be un-taken. So a drain
 *   1. stops taking work (the inbox and L2 pause),
 *   2. refuses every offer that owes nothing yet (recorded once per job; no budget is ever set on it),
 *   3. waits for every job that does owe something (budget set, funded, in transaction) to reach the provider's
 *      submit or a terminal status — the agent delivers through its own door, under the V3-F modes,
 *   4. and only then stops the listener: `offline-safe`.
 * A drain that cannot finish within the owner's timeout stays `draining` and names the jobs that block it; it keeps
 * checking, and never kills a listener under a job that is half done.
 */
import type { WorkStopReport } from '../../src/iclone-shared/acp-work'

import { decisionsOf } from './ledger'
import type { Ledger } from './ledger'
import type { Supervisor } from './supervisor'
import type { Watchdog } from './watchdog'

const DRAIN_POLL_MS = 15_000
const DRAIN_TIMEOUT_MS = 30 * 60_000

interface DrainDeps {
  supervisor: Pick<Supervisor, 'draining' | 'state' | 'stopListener'>
  watchdog: Pick<Watchdog, 'drainView' | 'pause' | 'poll' | 'stopReport'>
  ledger(slug: string): Ledger
  onChange(slug: string): void
  pollMs?: number
  timeoutMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

type DrainOutcome = { state: 'draining'; blocking: string[] } | { state: 'offline-safe' }

export function createDrain(deps: DrainDeps) {
  const pollMs = deps.pollMs ?? DRAIN_POLL_MS
  const timeoutMs = deps.timeoutMs ?? DRAIN_TIMEOUT_MS
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const active = new Map<string, { startedAt: number; timer: unknown; overdue: boolean }>()

  /** One pass: refuse what owes nothing, then stop only if nothing owed is left. */
  const step = async (slug: string): Promise<DrainOutcome> => {
    await deps.watchdog.poll(slug)

    const drain = active.get(slug)

    if (!drain) {
      return { state: 'offline-safe' }
    }

    const ledger = deps.ledger(slug)
    const decisions = decisionsOf(ledger.read().records)
    const { known, refuse, blocking } = deps.watchdog.drainView(slug)

    for (const job of refuse) {
      const decided = decisions.get(job.jobId)

      if (decided !== 'decline' && decided !== 'drain-refuse') {
        ledger.append({ kind: 'drain-refuse', jobId: job.jobId, chainId: job.chainId, note: 'offline: no budget set' })
      }
    }

    // Without a job list read cleanly in this pass nothing proves the iNFT owes nothing: keep draining.
    if (known && blocking.length === 0) {
      active.delete(slug)
      deps.supervisor.stopListener(slug, 'offline-safe')
      deps.watchdog.pause(slug, false)
      deps.onChange(slug)

      return { state: 'offline-safe' }
    }

    const ids = blocking.map(job => job.jobId)

    drain.overdue = now() - drain.startedAt >= timeoutMs
    deps.supervisor.draining(slug, ids)
    drain.timer = setTimer(() => void step(slug), pollMs)
    deps.onChange(slug)

    return { state: 'draining', blocking: ids }
  }

  return {
    /** Begin (or re-check) the drain. The report says, at once, what is still open and what is in escrow. */
    async start(slug: string): Promise<{ outcome: DrainOutcome; report: WorkStopReport }> {
      const running = active.get(slug)

      if (running) {
        clearTimer(running.timer)
      } else {
        active.set(slug, { startedAt: now(), timer: null, overdue: false })
        deps.ledger(slug).append({ kind: 'offline', gesture: null })
      }

      deps.watchdog.pause(slug, true)
      deps.supervisor.draining(slug, [])

      const outcome = await step(slug)

      return { outcome, report: deps.watchdog.stopReport(slug) }
    },
    /** The owner put the iNFT back online during a drain: the drain ends, nothing was stopped. */
    cancel(slug: string): void {
      const running = active.get(slug)

      if (running) {
        clearTimer(running.timer)
        active.delete(slug)
        deps.watchdog.pause(slug, false)
      }
    },
    overdue: (slug: string): boolean => active.get(slug)?.overdue ?? false
  }
}
