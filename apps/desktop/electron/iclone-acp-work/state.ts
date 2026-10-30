/**
 * V3-I — what main reads from the CLI, shaped once: `job list --json` rows and `agent whoami --json`. The CLI's field
 * names drift between builds (contract R6: `job status` is already gone in 1.0.38), so every field is read from the
 * names seen in the wild, and anything that does not parse is left null, never guessed.
 */
import { usdcToMicros, WORK_JOB_ID } from '../../src/iclone-shared/acp-work'

import type { WorkOffer } from './policy'

export interface WorkJob extends WorkOffer {
  status: string
  provider: string
  /** Something the job says was delivered (v2 `deliverable`), or null. */
  deliverable: string | null
}

/** Before a budget: the provider may still walk away with nothing owed. */
export const OFFER_STATUSES: ReadonlySet<string> = new Set(['open', 'request', 'negotiation'])
/** The client funded it: the provider owes a delivery. A drain may not stop on one of these. */
export const OWED_STATUSES: ReadonlySet<string> = new Set(['funded', 'transaction'])
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'rejected', 'expired'])

type Json = Record<string, unknown>

const asJson = (value: unknown): Json | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null

/** K28 l1: CLI text reaches the WORK tab and the ledger. Control and line characters become a space; format characters
 *  (bidi overrides and isolates, zero-width marks) are removed, so a title cannot reorder or hide what follows it. */
const plainText = (value: string): string =>
  value
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\p{Cf}/gu, '')
    .trim()

const text = (row: Json, ...keys: string[]): string => {
  for (const key of keys) {
    const value = row[key]
    const clean = typeof value === 'string' ? plainText(value) : ''

    if (clean) {
      return clean.slice(0, 300)
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value)
    }
  }

  return ''
}

export function normalizeStatus(status: string): string {
  return status
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
}

/** v2 carries `budget` in USDC base units (micro-USDC already); legacy jobs and `price` carry USDC. */
function priceMicrosOf(row: Json, legacy: boolean): number | null {
  if (row.price != null) {
    return usdcToMicros(row.price)
  }

  const budget = row.budget

  if (!legacy && typeof budget === 'string' && /^\d{1,15}$/.test(budget)) {
    return Number(budget)
  }

  if (!legacy && typeof budget === 'number' && Number.isSafeInteger(budget) && budget >= 0) {
    return budget
  }

  return usdcToMicros(budget)
}

/** A fund request / transfer the offer asks the provider to put up. Unknown shapes count as capital (fail closed). */
function capitalMicrosOf(row: Json): number {
  for (const key of ['fundRequest', 'transferAmount', 'fundTransfer', 'transfer']) {
    const value = row[key]

    if (value == null || value === '' || value === 0 || value === '0') {
      continue
    }

    const nested = asJson(value)
    const amount = usdcToMicros(nested ? (nested.amount ?? nested.transferAmount) : value)

    return amount === null ? Number.MAX_SAFE_INTEGER : amount
  }

  return 0
}

function requestBytesOf(row: Json): number {
  let bytes = 0

  for (const key of ['requirement', 'requirements', 'serviceRequirement', 'params', 'description']) {
    const value = row[key]

    if (value != null) {
      bytes += Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
    }
  }

  return bytes
}

function shapeJob(row: Json): WorkJob | null {
  const jobId = text(row, 'onChainJobId', 'jobId', 'id')
  const chainId = Number(text(row, 'chainId'))
  const legacy = row.legacy === true

  if (!WORK_JOB_ID.test(jobId) || !Number.isSafeInteger(chainId) || chainId <= 0) {
    return null
  }

  const deliverable = text(row, 'deliverable', 'deliverableUrl')

  return {
    jobId,
    chainId,
    status: normalizeStatus(text(row, 'jobStatus', 'status', 'phase')),
    title: text(row, 'offeringName', 'serviceName', 'name'),
    requester: text(row, 'clientAddress', 'client').toLowerCase(),
    provider: text(row, 'providerAddress', 'provider').toLowerCase(),
    priceMicros: priceMicrosOf(row, legacy),
    token: text(row, 'paymentToken', 'tokenSymbol', 'token') || 'USDC',
    capitalMicros: capitalMicrosOf(row),
    requestBytes: requestBytesOf(row),
    deliverable: deliverable || null
  }
}

/** `job list --json`: `{ jobs: [...] }`, `{ data: [...] }` or a bare array. */
export function parseJobList(raw: unknown): WorkJob[] | null {
  const root = asJson(raw)

  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(root?.jobs)
      ? root.jobs
      : Array.isArray(root?.data)
        ? root.data
        : null

  if (!list) {
    return null
  }

  return list.flatMap(item => {
    const row = asJson(item)
    const job = row ? shapeJob(row) : null

    return job ? [job] : []
  })
}

/** `agent whoami --json`: the active agent's EVM wallet, lower-case, or null. */
export function parseWhoami(raw: unknown): string | null {
  const root = asJson(raw)
  const agent = asJson(root?.agent) ?? root
  const wallet = agent ? text(agent, 'walletAddress', 'address', 'wallet') : ''

  return /^0x[0-9a-fA-F]{40}$/.test(wallet) ? wallet.toLowerCase() : null
}
