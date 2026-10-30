/**
 * V3-I — the WORK vocabulary shared by main (electron/iclone-acp-work) and the window (ACP Market › Work). Plain TS:
 * no DOM or Node imports. Main owns the listener, the policy, the ledger and every decision; the window reads these
 * shapes and asks main to act on the owner's own click.
 */

/** L0 observe · L1 the owner approves each job · L2 acts inside the written policy. L3 (hire/spend) is not built. */
export const AUTONOMY_LEVELS = ['L0', 'L1', 'L2'] as const
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number]

export const SUPERVISOR_STATES = ['offline', 'starting', 'online', 'draining', 'offline-safe', 'failed'] as const
export type SupervisorState = (typeof SUPERVISOR_STATES)[number]

/** Why an offer is outside the written policy. `spend` = the offer needs capital from this iNFT (earn-only, D2). */
const POLICY_RULES = [
  'spend',
  'token',
  'chain',
  'requester-denied',
  'requester-unknown',
  'class',
  'price-floor',
  'open-cap',
  'oversize'
] as const

export type PolicyRule = (typeof POLICY_RULES)[number]

/** Where an offer stands in the inbox, folded from the ledger and the last job list. */
export type OfferStanding = 'approved' | 'declined' | 'pending' | 'refused' | 'seen'

export interface WorkOfferView {
  jobId: string
  chainId: number
  title: string
  requester: string
  /** Micro-USDC, exact; null when the job does not say. */
  priceMicros: number | null
  status: string
  standing: OfferStanding
  rule: PolicyRule | null
  /** Why an approved quote was not sent (round 1: the write verbs are off in the build). */
  note: string | null
}

/** One hop of the offer -> job -> budget -> deliverable -> payment trace; `null` is a gap, never filled in. */
export interface WorkTrace {
  offer: string | null
  job: string | null
  budgetMicros: number | null
  deliverable: string | null
  paymentMicros: number | null
}

export type WorkRowGroup = 'completed' | 'history' | 'in-flight' | 'payments'

export interface WorkRowView {
  jobId: string
  chainId: number
  title: string
  status: string
  group: WorkRowGroup
  trace: WorkTrace
}

/** What failed (doctor style): the cause, what was tried, and the state after. Words live in the catalogues. */
export type WorkFixCause = 'listener-exited' | 'needs-sign-in' | 'owner-reboot' | 'read-failed' | 'tools-missing'
export type WorkFixAction =
  'restart-backoff' | 'restarted' | 'stopped-for-sign-in' | 'retry-next-poll' | 'stopped-for-tools'

export interface WorkFixView {
  id: string
  at: string
  cause: WorkFixCause
  tried: WorkFixAction
  now: SupervisorState
}

/**
 * Why WORK holds an iNFT offline whatever the owner last asked: the account signed out, the wallet changed, the
 * ownership guard proved the iNFT left the wallet, or (after a restart) the fresh proof has not answered yet.
 */
const WORK_HOLDS = ['signed-out', 'wallet-switch', 'ownership-lost', 'ownership-unverified'] as const
export type WorkHold = (typeof WORK_HOLDS)[number]

export const isWorkHold = (value: unknown): value is WorkHold =>
  typeof value === 'string' && (WORK_HOLDS as readonly string[]).includes(value)

export interface WorkView {
  slug: string
  state: SupervisorState
  /** Set while WORK holds this iNFT offline for a reason the owner did not choose here. */
  hold: WorkHold | null
  /** The job ids a drain is still waiting on (a funded job owes a delivery). */
  blocking: string[]
  /** Server-side market presence. `unverified` until a lab run settles the live-stream hypothesis (V3I contract §0). */
  presence: 'unverified'
  level: AutonomyLevel
  /** The level the watchdog actually acts at; lower than `level` when a downgrade applies. */
  effective: AutonomyLevel
  downgrade: 'chain-broken' | 'spend-trade-off' | null
  /** Round 1: approved quotes are recorded, never sent (no real job is accepted from the lab build). */
  writes: 'off' | 'on'
  offers: WorkOfferView[]
  rows: WorkRowView[]
  totals: { earnedMicros: number; spentMicros: number; escrowMicros: number }
  fixes: WorkFixView[]
  /** `gaps`: interrupted writes or repairs, each one a recorded gap in the chain. Broken: the Repair action shows. */
  chain: { ok: boolean; records: number; gaps: number }
  readAt: number | null
  readError: string | null
}

export type WorkActionError = 'busy' | 'gesture' | 'invalid' | 'ownership' | 'policy' | 'sign-in' | 'state' | 'tools'

export type WorkActionResult = { ok: true } | { ok: false; error: WorkActionError; rule?: PolicyRule }

export interface WorkStopReport {
  ok: true
  /** Jobs still open when the watchdog stopped: nothing is dropped silently. */
  open: Array<{ jobId: string; status: string }>
  /** Client money held in escrow on jobs this iNFT still owes (earn-only: this iNFT locks none of its own). */
  escrowMicros: number
}

export const WORK_SLUG = /^[a-z0-9-]{1,80}$/
export const WORK_JOB_ID = /^[0-9A-Za-z_-]{1,80}$/

export const isAutonomyLevel = (value: unknown): value is AutonomyLevel =>
  typeof value === 'string' && (AUTONOMY_LEVELS as readonly string[]).includes(value)

export const isPolicyRule = (value: unknown): value is PolicyRule =>
  typeof value === 'string' && (POLICY_RULES as readonly string[]).includes(value)

/** USDC has 6 decimals: an exact integer of micro-USDC from a decimal string or number, or null. */
export function usdcToMicros(value: unknown): number | null {
  const text = typeof value === 'number' && Number.isFinite(value) ? value.toFixed(6) : value

  if (typeof text !== 'string' || !/^\d{1,12}(\.\d{1,18})?$/.test(text.trim())) {
    return null
  }

  const [whole, fraction = ''] = text.trim().split('.')

  return Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0').slice(0, 6))
}
