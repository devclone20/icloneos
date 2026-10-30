/**
 * V3-J — limits that exist in code (deliverable 4). Pure: a decision is a function of the request, the user's
 * settings and the ledger's rows, never of a counter. Every ceiling is the USER's number (contract §4: the six
 * decisions are per-user settings); the shipped values live in `DEFAULTS`, the one place they are written down.
 *
 * Rules, in the order they are checked (the first that fails names the refusal):
 *   stop            the hard stop (Settings › Economy › Payments or `x402-pay stop`) refuses everything
 *   ledger          a ledger whose chain does not verify refuses everything (its totals cannot be trusted)
 *   per_tx          one payment above the per-transaction cap
 *   payee           `payTo` outside the counterparty allowlist (empty allowlist ⇒ nobody is allowed)
 *   origin          the resource's origin outside the origin allowlist (same rule; a p2p send has no resource)
 *   per_day         today's signed total (UTC) plus this payment above the daily cap
 *   per_agent_day   the same, for the requesting agent alone
 *
 * "Signed" is the spend that counts: once an EIP-3009 authorization is signed the server holds it and may submit it
 * until `validBefore`, whether or not it already settled. A refused verify does not give the budget back.
 *
 * A settings value that is not a safe non-negative integer falls back to the DEFAULT for that field, never to ∞;
 * an allowlist entry that is not an address / origin is dropped when the STORED file is read; `*` is not a value (the
 * negative control of gate J3 allowlists the payee explicitly). A CHANGE is stricter (fix Jm1, `allowlistProblem`):
 * each list holds at most ALLOWLIST_MAX (50) entries, and a malformed or repeated entry refuses the whole change with
 * the entries named — nothing the user asked for is ever dropped silently.
 */
import { ALLOWLIST_MAX, type PaymentsAllowlistProblem } from '../../src/iclone-shared/payments'

import { isNetwork, type Network, normalizeAddress, originOf } from './types'

const LIMIT_RULES = ['stop', 'ledger', 'per_tx', 'payee', 'origin', 'per_day', 'per_agent_day'] as const
export type LimitRule = (typeof LIMIT_RULES)[number]

export interface PaymentSettings {
  /** D1: who signs. `pocket` = the main-process key; `agentcard` = the AgentCard USDC wallet through its CLI. */
  signer: 'agentcard' | 'pocket'
  /** D2: the network every payment must be on. */
  network: Network
  /** D6: mainnet is a switch the user flips himself; off ⇒ `eip155:8453` is refused even if `network` names it. */
  mainnetEnabled: boolean
  /** Caps, micro-USDC. */
  perTxMicros: number
  perDayMicros: number
  perAgentDayMicros: number
  /** Counterparties (`payTo`, lowercase) and resource origins (`https://host[:port]`) the agents may pay. */
  payees: string[]
  origins: string[]
  /**
   * D3: where mandates live. `local+irys` (an encrypted mirror to the iNFT's Irys archive) is the owner's choice to
   * make, but this build has no mirror: it is refused when asked for and read back as `local` (see UNAVAILABLE).
   */
  mandateStorage: 'local' | 'local+irys'
  /** D5: what to do with an x402 v1 server. `refuse` never pays; `agentcard` hands it to the AgentCard CLI. */
  v1Servers: 'agentcard' | 'refuse'
  /** D6: the hard stop. */
  stop: boolean
}

/** The shipped defaults — the one place they are written (contract §4: 1.00 / 5.00 / 2.00 USDC, nobody allowlisted). */
export const DEFAULTS: Readonly<PaymentSettings> = Object.freeze({
  signer: 'pocket',
  network: 'eip155:84532',
  mainnetEnabled: false,
  perTxMicros: 1_000_000,
  perDayMicros: 5_000_000,
  perAgentDayMicros: 2_000_000,
  payees: [],
  origins: [],
  mandateStorage: 'local',
  v1Servers: 'refuse',
  stop: false
})

const MICROS_MAX = Number.MAX_SAFE_INTEGER

const capOf = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MICROS_MAX ? value : fallback

const listOf = (value: unknown, normalize: (entry: unknown) => string | null): string[] =>
  Array.isArray(value)
    ? [...new Set(value.map(normalize).filter((entry): entry is string => entry !== null))].slice(0, ALLOWLIST_MAX)
    : []

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback

/**
 * The user's settings as stored (`userData/payments/settings.json`) → a complete, sane set. Each field is checked on
 * its own; anything malformed is that field's default. Never throws.
 */
export function normalizeSettings(raw: unknown): PaymentSettings {
  const row = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}

  return {
    signer: oneOf(row.signer, ['agentcard', 'pocket'], DEFAULTS.signer),
    network: isNetwork(row.network) ? row.network : DEFAULTS.network,
    mainnetEnabled: row.mainnetEnabled === true,
    perTxMicros: capOf(row.perTxMicros, DEFAULTS.perTxMicros),
    perDayMicros: capOf(row.perDayMicros, DEFAULTS.perDayMicros),
    perAgentDayMicros: capOf(row.perAgentDayMicros, DEFAULTS.perAgentDayMicros),
    payees: listOf(row.payees, normalizeAddress),
    origins: listOf(row.origins, originOf),
    // Only what this build can honour: a stored `local+irys` with no mirror behind it reads as what it is, `local`.
    mandateStorage: oneOf(row.mandateStorage, ['local'], DEFAULTS.mandateStorage),
    v1Servers: oneOf(row.v1Servers, ['agentcard', 'refuse'], DEFAULTS.v1Servers),
    stop: row.stop === true
  }
}

/**
 * Choices the settings type names but this build cannot honour (merge round, builder r3 item 5): asking for one is
 * refused with this reason, never stored as if it worked. The pane hides them until the feature exists.
 */
const UNAVAILABLE: Readonly<Partial<Record<keyof PaymentSettings, Readonly<Record<string, string>>>>> = {
  mandateStorage: {
    'local+irys': 'the Irys mirror of mandates is not available in this build: mandates stay on this Mac only'
  }
}

/** The reason a requested settings set asks for something this build cannot do, or null. Reads the raw request. */
export function unavailableChoice(raw: unknown): string | null {
  const row = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}

  for (const [axis, choices] of Object.entries(UNAVAILABLE)) {
    const value = row[axis]

    if (typeof value === 'string' && choices && Object.prototype.hasOwnProperty.call(choices, value)) {
      return choices[value]
    }
  }

  return null
}

const ENTRY_SHOWN_MAX = 60
const ENTRIES_SHOWN_MAX = 5

const quoted = (entry: unknown): string => {
  const text = typeof entry === 'string' ? JSON.stringify(entry) : `(${entry === null ? 'null' : typeof entry})`

  return text.length > ENTRY_SHOWN_MAX ? `${text.slice(0, ENTRY_SHOWN_MAX - 1)}…` : text
}

const ALLOWLISTS: readonly { axis: 'origins' | 'payees'; canonical: (entry: string) => string | null }[] = [
  { axis: 'payees', canonical: normalizeAddress },
  // An origin exactly as `originOf` writes it: a path, a trailing slash or a space would be widened or guessed at.
  { axis: 'origins', canonical: entry => (originOf(entry) === entry ? entry : null) }
]

/**
 * Why a requested change's allowlists are refused as asked (fix Jm1), as data the window words (J4-5); empty when
 * fine. Each list the request carries must be a list of at most ALLOWLIST_MAX entries, each an address (any case) /
 * exactly an origin, none repeated. A bad entry is named (quoted, at most five shown); nothing is ever dropped.
 */
export function allowlistProblems(raw: unknown): PaymentsAllowlistProblem[] {
  const row = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const problems: PaymentsAllowlistProblem[] = []

  for (const { axis, canonical } of ALLOWLISTS) {
    if (!Object.prototype.hasOwnProperty.call(row, axis)) {
      continue
    }

    const value = row[axis]

    if (!Array.isArray(value)) {
      problems.push({ list: axis, kind: 'not_list', count: 0, entries: [], more: 0 })

      continue
    }

    if (value.length > ALLOWLIST_MAX) {
      problems.push({ list: axis, kind: 'too_many', count: value.length, entries: [], more: 0 })

      continue
    }

    const seen = new Set<string>()
    const bad: string[] = []

    for (const entry of value) {
      const key = typeof entry === 'string' ? canonical(entry) : null

      if (key === null || seen.has(key)) {
        bad.push(quoted(entry))
      } else {
        seen.add(key)
      }
    }

    if (bad.length > 0) {
      problems.push({
        list: axis,
        kind: 'entries',
        count: value.length,
        entries: bad.slice(0, ENTRIES_SHOWN_MAX),
        more: Math.max(0, bad.length - ENTRIES_SHOWN_MAX)
      })
    }
  }

  return problems
}

/** The same, in main's own words, for its log and the settings door's detail; null when fine. */
export function allowlistProblem(raw: unknown): string | null {
  const problems = allowlistProblems(raw).map(problem =>
    problem.kind === 'not_list'
      ? `${problem.list}: not a list`
      : problem.kind === 'too_many'
        ? `${problem.list}: ${problem.count} entries, at most ${ALLOWLIST_MAX}`
        : `${problem.list}: ${problem.entries.join(', ')}${problem.more > 0 ? ` (+${problem.more} more)` : ''}`
  )

  return problems.length > 0 ? problems.join('; ') : null
}

/** The ledger rows the ceilings fold over: what was signed, by which agent, when. */
export interface SignedRow {
  ts: string
  agent: string
  micros: number
}

export interface LimitsLedgerView {
  /** False when the chain does not verify: every payment is then refused (`ledger`). */
  ok: boolean
  signed: readonly SignedRow[]
}

interface PaymentAttempt {
  agent: string
  micros: number
  payTo: string
  /** The resource URL (its origin is what the allowlist names). */
  resource: string
  /**
   * A person-to-person transfer (`x402-pay send <payee> <usdc>`): there is no resource and so no origin to allowlist.
   * Only the literal `true` skips the origin rule; every other rule — the payee allowlist first — still applies.
   */
  p2p?: true
  /** The STOP file on disk; the setting is the other half. Either refuses. */
  stopFile: boolean
}

type LimitDecision =
  { ok: true; dayMicros: number; agentDayMicros: number } | { ok: false; rule: LimitRule; detail: string }

const utcDay = (iso: string): string => iso.slice(0, 10)

/** The signed total of one UTC day, for everyone or for one agent. */
export function signedToday(rows: readonly SignedRow[], now: Date, agent?: string): number {
  const day = utcDay(now.toISOString())
  let total = 0

  for (const row of rows) {
    if (utcDay(row.ts) === day && (agent === undefined || row.agent === agent)) {
      total += row.micros
    }
  }

  return total
}

/** The decision. Pure; the caller writes it to the ledger and the audit. */
export function evaluatePayment(
  attempt: PaymentAttempt,
  settings: PaymentSettings,
  ledger: LimitsLedgerView,
  now: Date
): LimitDecision {
  if (settings.stop || attempt.stopFile) {
    return { ok: false, rule: 'stop', detail: attempt.stopFile ? 'STOP file present' : 'stop setting on' }
  }

  if (!ledger.ok) {
    return { ok: false, rule: 'ledger', detail: 'ledger chain does not verify' }
  }

  if (!Number.isSafeInteger(attempt.micros) || attempt.micros <= 0) {
    return { ok: false, rule: 'per_tx', detail: `amount ${String(attempt.micros)} is not a positive integer` }
  }

  if (attempt.micros > settings.perTxMicros) {
    return { ok: false, rule: 'per_tx', detail: `${attempt.micros} > ${settings.perTxMicros}` }
  }

  const payTo = normalizeAddress(attempt.payTo)

  if (payTo === null || !settings.payees.includes(payTo)) {
    return { ok: false, rule: 'payee', detail: `${payTo ?? 'not an address'} not allowlisted` }
  }

  const origin = attempt.p2p === true ? null : originOf(attempt.resource)

  if (attempt.p2p !== true && (origin === null || !settings.origins.includes(origin))) {
    return { ok: false, rule: 'origin', detail: `${origin ?? 'not a URL'} not allowlisted` }
  }

  const dayMicros = signedToday(ledger.signed, now)

  if (dayMicros + attempt.micros > settings.perDayMicros) {
    return { ok: false, rule: 'per_day', detail: `${dayMicros} + ${attempt.micros} > ${settings.perDayMicros}` }
  }

  const agentDayMicros = signedToday(ledger.signed, now, attempt.agent)

  if (agentDayMicros + attempt.micros > settings.perAgentDayMicros) {
    return {
      ok: false,
      rule: 'per_agent_day',
      detail: `${agentDayMicros} + ${attempt.micros} > ${settings.perAgentDayMicros}`
    }
  }

  return { ok: true, dayMicros, agentDayMicros }
}

/** The network a payment may use under these settings: mainnet only when the user flipped its switch (D6). */
export function allowedNetwork(settings: PaymentSettings): Network | null {
  if (settings.network === 'eip155:8453' && !settings.mainnetEnabled) {
    return null
  }

  return settings.network
}

type SettingAxis = keyof PaymentSettings
type SettingValue = PaymentSettings[SettingAxis]

/** One axis the user changed, for the door sheet (old → new) and the ledger's `setting` row. */
interface SettingChange {
  axis: SettingAxis
  from: SettingValue
  to: SettingValue
  /** True when this axis alone makes the change spend-class (floor 5 asks). */
  widens: boolean
  /** List axes only: what was added and removed. */
  added?: string[]
  removed?: string[]
}

export interface SettingsDiff {
  /** True when ANY axis widens: the whole change waits for the door. */
  widens: boolean
  /** Every axis that changed, in the settings' own order, widening or not. */
  changes: SettingChange[]
}

const AXES: readonly SettingAxis[] = [
  'signer',
  'network',
  'mainnetEnabled',
  'perTxMicros',
  'perDayMicros',
  'perAgentDayMicros',
  'payees',
  'origins',
  'mandateStorage',
  'v1Servers',
  'stop'
]

/** Per axis: does going from `a` to `b` widen what the agents can spend, or where the user's data goes? */
function axisWidens(axis: SettingAxis, prev: PaymentSettings, next: PaymentSettings, added: string[]): boolean {
  switch (axis) {
    case 'signer':
      return true // who holds the money changed: always the owner's call

    case 'network':
      return next.network === 'eip155:8453'

    case 'mainnetEnabled':
      return next.mainnetEnabled

    case 'perTxMicros':

    case 'perDayMicros':

    case 'perAgentDayMicros':
      return next[axis] > prev[axis]

    case 'payees':

    case 'origins':
      return added.length > 0

    case 'mandateStorage':
      return next.mandateStorage === 'local+irys'

    case 'v1Servers':
      return next.v1Servers === 'agentcard'

    case 'stop':
      return !next.stop
  }
}

/**
 * Raising a cap, widening an allowlist, enabling mainnet, changing the signer, mirroring mandates off the machine,
 * paying v1 servers or clearing the stop is itself a spend-class change: floor 5 asks, the sheet shows each axis old →
 * new, and the change is written to the ledger. Lowering is immediate. Pure: the per-axis diff and its verdict.
 */
export function widens(prev: PaymentSettings, next: PaymentSettings): SettingsDiff {
  const changes: SettingChange[] = []

  for (const axis of AXES) {
    const from = prev[axis]
    const to = next[axis]

    if (Array.isArray(from) && Array.isArray(to)) {
      const added = to.filter(entry => !from.includes(entry))
      const removed = from.filter(entry => !to.includes(entry))

      if (added.length || removed.length) {
        changes.push({
          axis,
          from: [...from],
          to: [...to],
          widens: axisWidens(axis, prev, next, added),
          added,
          removed
        })
      }
    } else if (from !== to) {
      changes.push({ axis, from, to, widens: axisWidens(axis, prev, next, []) })
    }
  }

  return { widens: changes.some(change => change.widens), changes }
}
