/** The market data module's `jobs` section — its public names are re-exported by ../market-data.ts. */
import { setEconBadge } from '../../badges'
import { bool, type Json, listAt, num, str } from '../../cli'
import { fromHexUnits, shortAddress, timeAgo, tokenAmount } from '../../format'

import { USDC_DECIMALS } from './constants'
import { finiteOrNull } from './primitives'
import type { EntryTone, JobRole, MarketJob } from './types'

// ── jobs ────────────────────────────────────────────────────────────────────

export function normalizeStatus(status: string): string {
  return status
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
}

export function statusLabel(status: string): string {
  return status ? status.replace(/_/g, ' ') : 'unknown'
}

const STATUS_TONES = new Map<string, EntryTone>([
  ['open', 'muted'],
  ['request', 'muted'],
  ['negotiation', 'muted'],
  ['budget_set', 'warn'],
  ['funded', 'tone'],
  ['transaction', 'tone'],
  ['submitted', 'warn'],
  ['evaluation', 'warn'],
  ['completed', 'up'],
  ['rejected', 'down'],
  ['expired', 'down']
])

export function jobStatusTone(status: string): EntryTone {
  return STATUS_TONES.get(status) ?? 'muted'
}

/** USDC base units (6 decimals) as a decimal string → USDC. */
export function baseUnitsToUsdc(units: string): number {
  return /^\d+$/.test(units) ? fromHexUnits(`0x${BigInt(units).toString(16)}`, USDC_DECIMALS) : 0
}

/** v2 jobs carry `budget` in USDC base units; legacy jobs (and `price`) in USDC. */
export function budgetOf(raw: Json, legacy: boolean): null | number {
  if (raw.price != null) {
    return finiteOrNull(raw.price)
  }

  const budget = raw.budget

  if (!legacy && typeof budget === 'string' && /^\d+$/.test(budget)) {
    return baseUnitsToUsdc(budget)
  }

  if (!legacy && typeof budget === 'number' && Number.isSafeInteger(budget)) {
    return baseUnitsToUsdc(String(budget))
  }

  return finiteOrNull(budget)
}

function shapeJob(raw: Json): MarketJob {
  const legacy = bool(raw, 'legacy')
  const id = str(raw, 'onChainJobId') || str(raw, 'jobId') || str(raw, 'id')
  const chainId = num(raw, 'chainId')

  return {
    key: `${chainId}:${id}:${legacy ? 'legacy' : 'v2'}`,
    id,
    chainId,
    legacy,
    status: normalizeStatus(str(raw, 'jobStatus') || str(raw, 'status') || str(raw, 'phase')),
    clientAddress: str(raw, 'clientAddress'),
    providerAddress: str(raw, 'providerAddress'),
    evaluatorAddress: str(raw, 'evaluatorAddress'),
    providerName: str(raw, 'providerName'),
    title: str(raw, 'serviceName') || str(raw, 'offeringName') || str(raw, 'description'),
    budgetUsdc: budgetOf(raw, legacy),
    createdAt: str(raw, 'createdAt'),
    expiredAt: str(raw, 'expiredAt')
  }
}

export function shapeJobs(raw: unknown): MarketJob[] {
  return listAt(raw, ['jobs', 'data'])
    .map(shapeJob)
    .filter(job => job.id)
}

export function sameAddress(a: string, b: string): boolean {
  return Boolean(a && b) && a.toLowerCase() === b.toLowerCase()
}

export function jobRole(
  job: Pick<MarketJob, 'clientAddress' | 'evaluatorAddress' | 'providerAddress'>,
  myWallet: string
): JobRole {
  if (sameAddress(job.clientAddress, myWallet)) {
    return 'client'
  }

  if (sameAddress(job.providerAddress, myWallet)) {
    return 'provider'
  }

  return sameAddress(job.evaluatorAddress, myWallet) ? 'evaluator' : ''
}

// Whose move it is: the client sets the budget and judges the delivery; the
// provider works a funded job and follows up a submitted one.
const CLIENT_TURN = new Set(['budget_set', 'evaluation'])
const PROVIDER_TURN = new Set(['funded', 'submitted'])
const DONE_STATUSES = new Set(['completed', 'expired', 'rejected'])

export function needsMyAction(
  job: Pick<MarketJob, 'clientAddress' | 'evaluatorAddress' | 'providerAddress' | 'status'>,
  myWallet: string
): boolean {
  const role = jobRole(job, myWallet)

  return (role === 'client' && CLIENT_TURN.has(job.status)) || (role === 'provider' && PROVIDER_TURN.has(job.status))
}

export function countNeedsAction(jobs: MarketJob[], myWallet: string): number {
  return myWallet ? jobs.reduce((count, job) => count + (needsMyAction(job, myWallet) ? 1 : 0), 0) : 0
}

function isDoneStatus(status: string): boolean {
  return DONE_STATUSES.has(status)
}

export type JobsTab = 'active' | 'all' | 'done' | 'needs'

const JOBS_TABS: readonly JobsTab[] = ['needs', 'active', 'done', 'all']

export function parseJobsTab(raw: null | string): JobsTab | null {
  return JOBS_TABS.find(tab => tab === raw) ?? null
}

/** One job, prepared once per answer for the list: its tab and search text. */
export interface JobRowModel {
  job: MarketJob
  role: JobRole
  needs: boolean
  done: boolean
  counterpart: { label: string; address: string }
  /** Lower-case id, title, names, addresses and status — what search reads. */
  haystack: string
}

export function jobRows(jobs: MarketJob[], myWallet: string): JobRowModel[] {
  return jobs.map(job => ({
    job,
    role: jobRole(job, myWallet),
    needs: needsMyAction(job, myWallet),
    done: isDoneStatus(job.status),
    counterpart: counterpartOf(job, myWallet),
    haystack: [
      job.id,
      `#${job.id}`,
      job.title,
      job.providerName,
      job.clientAddress,
      job.providerAddress,
      job.evaluatorAddress,
      statusLabel(job.status)
    ]
      .join(' ')
      .toLowerCase()
  }))
}

export function inJobsTab(row: Pick<JobRowModel, 'done' | 'needs'>, tab: JobsTab): boolean {
  switch (tab) {
    case 'needs':
      return row.needs

    case 'active':
      return !row.done

    case 'done':
      return row.done

    default:
      return true
  }
}

/** Every word of the query must appear somewhere in the job. */
export function matchesJob(row: Pick<JobRowModel, 'haystack'>, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)

  return words.every(word => row.haystack.includes(word))
}

/** The dock badge: jobs waiting on this iNFT. Unknown wallet → no claim. */
export function publishJobsBadge(slug: string, jobs: MarketJob[], myWallet: string): void {
  if (myWallet) {
    setEconBadge(slug, 'acp', countNeedsAction(jobs, myWallet))
  }
}

/** The other side of the job, from where I stand. */
export function counterpartOf(job: MarketJob, myWallet: string): { label: string; address: string } {
  if (jobRole(job, myWallet) === 'provider') {
    return { label: 'client', address: job.clientAddress }
  }

  return { label: 'provider', address: job.providerAddress }
}

export function usdcLabel(value: null | number): string {
  return value == null ? '—' : `${tokenAmount(value)} USDC`
}

/** The one time that matters for an active job: when it expires, else its age. */
export function jobWhen(job: Pick<MarketJob, 'createdAt' | 'expiredAt'>, now: number): string {
  const expires = Date.parse(job.expiredAt)

  if (Number.isFinite(expires)) {
    return expires > now ? `expires ${timeAgo(expires)}` : `expired ${timeAgo(expires)}`
  }

  return Number.isFinite(Date.parse(job.createdAt)) ? timeAgo(job.createdAt) : ''
}

/** Who wrote a job-room message, from where I stand. */
export function speakerOf(
  from: string,
  job: Pick<MarketJob, 'clientAddress' | 'evaluatorAddress' | 'providerAddress'>,
  myWallet: string
): string {
  if (!from) {
    return 'system'
  }

  if (sameAddress(from, myWallet)) {
    return 'you'
  }

  const role = jobRole(job, from)

  return role || shortAddress(from)
}

/** ISO text for an epoch ms, or '' when it is not a real date. */
export function isoOf(ms: null | number): string {
  const date = new Date(ms ?? NaN)

  return Number.isFinite(date.getTime()) ? date.toISOString() : ''
}
