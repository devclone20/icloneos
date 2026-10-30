/**
 * V3-I — the written policy and the earn-only gate. Pure: no I/O, no clock.
 *
 * An offer is untrusted input (contract R5): it is read as data only — numbers, addresses, a class name, sizes — and
 * nothing in it is executed or interpreted. Every rule fails closed: a price the job does not state never passes the
 * floor, an unknown token is a forbidden token.
 *
 * D2 (owner): earn-only. The watchdog never spends, hires or tops up. `earnOnlyArgv` is the one door a
 * watchdog write goes through, and it admits exactly two provider verbs without a transfer; everything that moves
 * this iNFT's value is refused here, before any process exists, whatever the consent switches say.
 */
import { type PolicyRule, WORK_JOB_ID } from '../../src/iclone-shared/acp-work'

export interface WorkPolicy {
  /** The lowest fee worth taking, micro-USDC. */
  minPriceMicros: number
  /** Offering names the iNFT takes; empty = any class not denied. */
  allowedClasses: string[]
  deniedClasses: string[]
  /** Requesters (client wallets, lower-case). A non-empty allowlist makes every other requester unknown. */
  requesterAllow: string[]
  requesterDeny: string[]
  allowedTokens: string[]
  allowedChains: number[]
  maxOpenJobs: number
  /** The largest request the iNFT reads, bytes (requirement text + params). */
  maxRequestBytes: number
}

/** D3 is open: a conservative default until the owner writes his own. */
export const DEFAULT_POLICY: Readonly<WorkPolicy> = Object.freeze({
  minPriceMicros: 1_000_000,
  allowedClasses: [],
  deniedClasses: [],
  requesterAllow: [],
  requesterDeny: [],
  allowedTokens: ['USDC'],
  allowedChains: [8453],
  maxOpenJobs: 3,
  maxRequestBytes: 16_384
})

/** An offer as the watchdog reads it from `job list`: data only. */
export interface WorkOffer {
  jobId: string
  chainId: number
  title: string
  requester: string
  priceMicros: number | null
  token: string
  /** Capital the offer asks this iNFT to put up (a fund request / transfer), micro-units; 0 when none. */
  capitalMicros: number
  requestBytes: number
}

export type PolicyVerdict = { ok: true } | { ok: false; rule: PolicyRule }

const lower = (list: readonly string[]) => list.map(item => item.trim().toLowerCase())

/** The rules in a fixed order, so the named rule is stable for one offer. */
export function evaluateOffer(offer: WorkOffer, policy: WorkPolicy, openJobs: number): PolicyVerdict {
  const requester = offer.requester.toLowerCase()
  const cls = offer.title.trim().toLowerCase()

  if (offer.capitalMicros !== 0) {
    return { ok: false, rule: 'spend' }
  }

  if (!lower(policy.allowedTokens).includes(offer.token.trim().toLowerCase())) {
    return { ok: false, rule: 'token' }
  }

  if (!policy.allowedChains.includes(offer.chainId)) {
    return { ok: false, rule: 'chain' }
  }

  if (lower(policy.requesterDeny).includes(requester)) {
    return { ok: false, rule: 'requester-denied' }
  }

  if (!requester || (policy.requesterAllow.length > 0 && !lower(policy.requesterAllow).includes(requester))) {
    return { ok: false, rule: 'requester-unknown' }
  }

  if (
    lower(policy.deniedClasses).includes(cls) ||
    (policy.allowedClasses.length > 0 && !lower(policy.allowedClasses).includes(cls))
  ) {
    return { ok: false, rule: 'class' }
  }

  if (offer.priceMicros === null || offer.priceMicros < policy.minPriceMicros) {
    return { ok: false, rule: 'price-floor' }
  }

  if (openJobs >= policy.maxOpenJobs) {
    return { ok: false, rule: 'open-cap' }
  }

  if (offer.requestBytes > policy.maxRequestBytes) {
    return { ok: false, rule: 'oversize' }
  }

  return { ok: true }
}

/** The CLI verbs that move this iNFT's value (iclone-acp-ipc VALUE_MOVING) plus the ones that hire or pay. */
const SPEND_HEADS = [
  'trade',
  'client',
  'wallet',
  'provider set-budget-with-fund-request',
  'subscription',
  'card'
] as const

const TRANSFER_FLAGS = ['--transfer-amount', '--transfer-token']

/** The only writes a watchdog may issue: quote a fee, deliver work. Both earn; neither carries a transfer. */
type EarnArgv =
  | ['provider', 'set-budget', '--job-id', string, '--amount', string, '--chain-id', string]
  | ['provider', 'submit', '--job-id', string, '--deliverable', string, '--chain-id', string]

/** The earn-only door. Returns the argv untouched when it earns, or null — the caller records a refused spend. */
export function earnOnlyArgv(argv: readonly string[]): EarnArgv | null {
  const head = argv.slice(0, 2).join(' ')

  if (SPEND_HEADS.some(spend => head === spend || argv[0] === spend)) {
    return null
  }

  if (argv.some(arg => TRANSFER_FLAGS.includes(arg.split('=')[0]) || arg === '--dry-run')) {
    return null
  }

  const [, , jobFlag, jobId, valueFlag, value, chainFlag, chainId] = argv

  if (argv.length !== 8 || jobFlag !== '--job-id' || chainFlag !== '--chain-id') {
    return null
  }

  if (!WORK_JOB_ID.test(jobId) || !/^\d{1,10}$/.test(chainId)) {
    return null
  }

  if (head === 'provider set-budget' && valueFlag === '--amount' && /^\d{1,12}(\.\d{1,6})?$/.test(value)) {
    return ['provider', 'set-budget', '--job-id', jobId, '--amount', value, '--chain-id', chainId]
  }

  if (head === 'provider submit' && valueFlag === '--deliverable' && value.length > 0 && value.length <= 20_000) {
    return ['provider', 'submit', '--job-id', jobId, '--deliverable', value, '--chain-id', chainId]
  }

  return null
}

/** D2 earn-only: compiled in, not a setting. The caps exist so lifting D2 later is a number, not a rewrite. */
export const EARN_ONLY = true

interface SpendFacts {
  amountMicros: number
  perJobCapMicros: number
  perDayCapMicros: number
  spentTodayMicros: number
  earnOnly: boolean
}

/** May this spend happen? With EARN_ONLY nothing above zero ever passes. */
export function spendAllowed(facts: SpendFacts): boolean {
  if (facts.amountMicros <= 0) {
    return true
  }

  if (facts.earnOnly) {
    return false
  }

  return (
    facts.amountMicros <= facts.perJobCapMicros && facts.spentTodayMicros + facts.amountMicros <= facts.perDayCapMicros
  )
}
