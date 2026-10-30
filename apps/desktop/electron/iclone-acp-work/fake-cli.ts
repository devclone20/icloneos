/**
 * V3-I test double: a recorded ACP marketplace for one provider wallet. Reads answer like `acp … --json`; the actor
 * applies a write's effect to the recorded jobs and counts every argv it was handed, so a gate can prove that no
 * value-moving verb ever reached a process. No real `acp`, no network, no wallet.
 */
import type { AcpRunResult } from '../iclone-acp'

import type { WorkAccount } from './ipc'
import type { WorkActor } from './watchdog'

const WALLET = '0x00000000000000000000000000000000000000aa'
const CLIENT = '0x00000000000000000000000000000000000000bb'
/** The owner's wallet, as the ownership guard tracks it. */
export const OWNER = '0x00000000000000000000000000000000000000cc'

/** iclone-acp-ipc VALUE_MOVING, as argv heads. */
const VALUE_MOVING = [
  'trade',
  'client fund',
  'client create-job',
  'client create-custom-job',
  'provider set-budget-with-fund-request',
  'wallet send-transaction',
  'wallet topup'
]

export type FakeJob = Record<string, unknown> & { jobId: string; status: string }

export function offerJob(jobId: string, extra: Record<string, unknown> = {}): FakeJob {
  return {
    jobId,
    chainId: 8453,
    status: 'open',
    clientAddress: CLIENT,
    providerAddress: WALLET,
    offeringName: 'research',
    budget: '5000000',
    ...extra
  }
}

const ok = (data: unknown): AcpRunResult => ({ ok: true, code: 0, stdout: JSON.stringify(data), stderr: '' })

export function fakeAcp(jobs: FakeJob[] = []) {
  const state = { jobs: [...jobs], closed: new Map<string, FakeJob>(), failReads: false }
  const writes: string[][] = []
  const reads: string[][] = []

  const read = (_slug: string, argv: string[]): Promise<AcpRunResult> => {
    reads.push(argv)

    if (state.failReads) {
      return Promise.resolve({ ok: false, code: 1, stdout: '', stderr: '', error: 'network down' })
    }

    const head = argv.slice(0, 2).join(' ')

    if (head === 'agent whoami') {
      return Promise.resolve(ok({ walletAddress: WALLET }))
    }

    if (head === 'job list') {
      return Promise.resolve(ok({ jobs: state.jobs }))
    }

    if (head === 'job history') {
      const id = argv[argv.indexOf('--job-id') + 1]
      const job = state.closed.get(id)

      return Promise.resolve(job ? ok({ job }) : { ok: false, code: 1, stdout: '', stderr: '', error: 'not found' })
    }

    return Promise.resolve({ ok: false, code: 1, stdout: '', stderr: '', error: 'not a read' })
  }

  const actor: WorkActor = {
    run: (_slug, argv) => {
      writes.push([...argv])

      const id = argv[argv.indexOf('--job-id') + 1]
      const job = state.jobs.find(item => item.jobId === id)

      if (job && argv[1] === 'set-budget') {
        job.status = 'budget_set'
      }

      if (job && argv[1] === 'submit') {
        job.status = 'submitted'
      }

      return Promise.resolve({ ok: true })
    }
  }

  return {
    state,
    read,
    actor,
    writes,
    reads,
    setStatus(jobId: string, status: string): void {
      const job = state.jobs.find(item => item.jobId === jobId)

      if (job) {
        job.status = status
      }
    },
    /** The job leaves the active list with this final status (only `job history` knows it now). */
    close(jobId: string, status: string): void {
      const job = state.jobs.find(item => item.jobId === jobId)

      if (job) {
        state.jobs = state.jobs.filter(item => item !== job)
        state.closed.set(jobId, { ...job, status })
      }
    },
    valueMovingWrites: (): number =>
      writes.filter(argv => VALUE_MOVING.some(head => argv.slice(0, head.split(' ').length).join(' ') === head)).length
  }
}

/**
 * The owner's account as WORK sees it: the sign-in record and the ownership guard. `hold()` keeps the next proofs in
 * flight until `release()`, so a test can look at the world while main waits on the chain.
 */
export function fakeAccount(init: { signedIn?: 'in' | 'out' | null; state?: 'held' | 'lost' | 'unknown' } = {}) {
  const live = {
    signedIn: init.signedIn === undefined ? ('in' as const) : init.signedIn,
    state: init.state ?? ('held' as const),
    wallet: OWNER as string | null,
    proofs: 0
  } as { signedIn: 'in' | 'out' | null; state: 'held' | 'lost' | 'unknown'; wallet: string | null; proofs: number }

  let gate: Promise<void> | null = null
  let open: () => void = () => undefined

  const account: WorkAccount = {
    signedIn: () => live.signedIn,
    prove: async () => {
      live.proofs += 1

      if (gate) {
        await gate
      }

      return live.state
    },
    walletOf: () => live.wallet
  }

  return {
    live,
    account,
    hold(): void {
      gate = new Promise(resolve => (open = resolve))
    },
    release(): void {
      gate = null
      open()
    }
  }
}
