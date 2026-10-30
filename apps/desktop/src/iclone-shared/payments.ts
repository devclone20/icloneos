/**
 * V3-J — the payments vocabulary shared by main and the window (Settings › Economy › Payments, the door sheet). Plain
 * TS: no DOM or Node imports. Main owns every decision and every secret; the window only ever sees these views, which
 * by construction carry no key, no signature and no raw mandate (only public addresses, amounts and plain constraints).
 *
 * Amounts are integer micro-USDC everywhere; `formatUsdc` / `parseUsdc` are the only conversions to and from words.
 */

import type { PaymentsSheetCopy } from './payments-sheet-copy'

export const PAYMENTS_SCHEMA = 1

/** The user's six decisions (contract §4), as main stored and normalized them. */
export interface PaymentsSettingsView {
  signer: 'agentcard' | 'pocket'
  network: string
  mainnetEnabled: boolean
  perTxMicros: number
  perDayMicros: number
  perAgentDayMicros: number
  payees: string[]
  origins: string[]
  mandateStorage: 'local' | 'local+irys'
  v1Servers: 'agentcard' | 'refuse'
  stop: boolean
}

/** Why payments are not ready (J4-5): the OS cannot seal the keys (the Keychain setting is off), a sealed key is
 *  unusable, payments are off, or the agents' pay socket is not running. */
export const PAYMENTS_NOT_READY = ['sealing_off', 'keys_unavailable', 'disabled', 'socket_down'] as const
export type PaymentsNotReady = (typeof PAYMENTS_NOT_READY)[number]

/**
 * One reason an allowlist change was refused as asked (fix Jm1, structured in J4-5 so the window words it): the list,
 * what is wrong, and — for bad entries — the entries themselves as main quoted them (the user's own input, at most five
 * shown, each at most 60 characters), printed verbatim.
 */
export interface PaymentsAllowlistProblem {
  list: 'origins' | 'payees'
  kind: 'entries' | 'not_list' | 'too_many'
  /** `too_many`: how many entries the change held. */
  count: number
  entries: string[]
  /** Bad entries beyond those shown. */
  more: number
}

export interface PaymentsStatusView {
  schema: typeof PAYMENTS_SCHEMA
  /** True when an agent can pay at all (keys sealed by the OS, the pay socket up). */
  ready: boolean
  /** Why not ready, as a code the window words in its own language (J4-5); main keeps its own text in its log. */
  reason: PaymentsNotReady | null
  /** The pocket's PUBLIC address (fund it with at most the daily cap), or null. */
  pocket: string | null
  network: string
  /** The hard stop, either half (the setting or the STOP file). */
  stopped: boolean
  /** The ledger's chain verifies (if not, every payment is refused). */
  ledgerOk: boolean
  /** Signed today (UTC), everyone and per agent. */
  todayMicros: number
  agents: { agent: string; micros: number }[]
  /** Hermes profiles whose config the latest seed pass could not verify (`default` is the root's): a folder or
   *  config.yaml outside the Hermes home, one it could not read or write, a name Hermes folds onto another. The pay
   *  socket refuses their spawns (fix m-r2-2, fail closed since m-r4-2). Profile names only. */
  unprotectedProfiles: string[]
}

export interface PaymentsMandateView {
  jti: string
  agent: string
  issuedAt: string
  expiresAt: string
  revoked: boolean
  /** Plain constraints, as USDC decimal strings and addresses (null: the mandate does not set it). */
  budget: string | null
  range: { min: string; max: string } | null
  payees: string[]
}

export const PAYMENTS_REFUSALS = [
  'allowlist',
  'door_denied',
  'gesture',
  'invalid',
  'ledger',
  'no_door',
  'not_ready',
  'settings_moved',
  'unavailable',
  'unknown'
] as const

export type PaymentsRefusal = (typeof PAYMENTS_REFUSALS)[number]

export type PaymentsChangeResult =
  | { ok: true; settings: PaymentsSettingsView }
  | { ok: false; reason: PaymentsRefusal; problems?: PaymentsAllowlistProblem[] }

export type PaymentsActionResult = { ok: true } | { ok: false; reason: PaymentsRefusal }

/**
 * What the owner asks main to sign in Settings › Economy › Payments: the terms of an OPEN payment mandate
 * (`mandate.payment.open.1`, contract §1.2), in words. Amounts are USDC decimals, payees lowercase addresses, instants
 * ISO 8601. The window only ever sends terms: main validates them again, shows them on the permission sheet and signs
 * with the owner's key after the trusted click — the window never sees the signed mandate.
 */
export interface PaymentsMandateTerms {
  agent: string
  /** The most every payment under it may add up to. */
  budget: string
  /** Each payment between `min` and `max`. */
  min: string
  max: string
  /** Who it may pay: a subset of the payee allowlist. */
  payees: string[]
  /** The execution window (`payment.execution_date`). */
  notBefore: string
  notAfter: string
  /** The mandate's own expiry (`exp`). */
  expiresAt: string
}

export type PaymentsMandateResult = { ok: true; jti: string } | { ok: false; reason: PaymentsRefusal }

/** Which part of the terms is wrong, for the pane's words (main answers `invalid`). */
export type MandateTermsProblem = 'agent' | 'amount' | 'dates' | 'payees'

/**
 * The most entries each allowlist holds — payees (the counterparties agents may pay) and origins (the sites whose
 * payment requests they may answer) — and so the most payees a mandate names (fix Jm1). Every sheet lists them in
 * full, one per line, inside its scrolling block: a bigger list is refused with the reason, never cut or dropped.
 */
export const ALLOWLIST_MAX = 50

const AGENT_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const ADDRESS_RE = /^0x[0-9a-f]{40}$/
const MANDATE_MAX_MS = 90 * 86_400_000
const DAY_MS = 86_400_000

/** The terms a new mandate starts from: the user's own caps (budget = per-agent-day, range up to per-payment), every allowlisted payee, one day. */
export function defaultMandateTerms(
  settings: Pick<PaymentsSettingsView, 'payees' | 'perAgentDayMicros' | 'perTxMicros'>,
  agent: string,
  now: Date
): PaymentsMandateTerms {
  const end = new Date(now.getTime() + DAY_MS).toISOString()

  return {
    agent,
    budget: formatUsdc(settings.perAgentDayMicros),
    min: formatUsdc(1),
    max: formatUsdc(Math.min(settings.perTxMicros, settings.perAgentDayMicros)),
    payees: [...settings.payees],
    notBefore: now.toISOString(),
    notAfter: end,
    expiresAt: end
  }
}

interface CheckedMandateTerms {
  terms: PaymentsMandateTerms
  budgetMicros: number
  minMicros: number
  maxMicros: number
  notBeforeMs: number
  notAfterMs: number
  expiresMs: number
}

/**
 * The terms, strictly, against the payee allowlist and the clock: one function for the pane (its words) and main (the
 * backstop it never skips). Amounts 0 < min ≤ max ≤ budget; payees a non-empty subset of the allowlist; the window
 * inside the mandate's life, which ends in the future and within 90 days. The answer is normalized ("2" → "2.00",
 * instants to whole seconds).
 */
export function checkMandateTerms(
  raw: unknown,
  allowlist: readonly string[],
  now: Date
): { ok: true; checked: CheckedMandateTerms } | { ok: false; problem: MandateTermsProblem } {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const text = (field: string): string => (typeof value[field] === 'string' ? (value[field] as string) : '')

  if (!AGENT_SLUG_RE.test(text('agent'))) {
    return { ok: false, problem: 'agent' }
  }

  const budgetMicros = parseUsdc(text('budget'))
  const minMicros = parseUsdc(text('min'))
  const maxMicros = parseUsdc(text('max'))

  if (
    budgetMicros === null ||
    minMicros === null ||
    maxMicros === null ||
    minMicros <= 0 ||
    minMicros > maxMicros ||
    maxMicros > budgetMicros
  ) {
    return { ok: false, problem: 'amount' }
  }

  const payees = Array.isArray(value.payees) ? value.payees : null

  if (
    !payees ||
    payees.length === 0 ||
    payees.length > ALLOWLIST_MAX ||
    !payees.every(entry => typeof entry === 'string' && ADDRESS_RE.test(entry) && allowlist.includes(entry)) ||
    new Set(payees).size !== payees.length
  ) {
    return { ok: false, problem: 'payees' }
  }

  // Whole seconds: a mandate's `exp` is in seconds, so the sheet shows exactly the instants that are signed.
  const second = (field: string) => Math.floor(Date.parse(text(field)) / 1000) * 1000
  const notBeforeMs = second('notBefore')
  const notAfterMs = second('notAfter')
  const expiresMs = second('expiresAt')
  const t = now.getTime()

  if (
    ![notBeforeMs, notAfterMs, expiresMs].every(Number.isFinite) ||
    notBeforeMs >= notAfterMs ||
    notAfterMs > expiresMs ||
    expiresMs <= t ||
    expiresMs - t > MANDATE_MAX_MS
  ) {
    return { ok: false, problem: 'dates' }
  }

  return {
    ok: true,
    checked: {
      terms: {
        agent: text('agent'),
        budget: formatUsdc(budgetMicros),
        min: formatUsdc(minMicros),
        max: formatUsdc(maxMicros),
        payees: [...(payees as string[])],
        notBefore: new Date(notBeforeMs).toISOString(),
        notAfter: new Date(notAfterMs).toISOString(),
        expiresAt: new Date(expiresMs).toISOString()
      },
      budgetMicros,
      minMicros,
      maxMicros,
      notBeforeMs,
      notAfterMs,
      expiresMs
    }
  }
}

/**
 * `window.hermesDesktop.payments` (the preload builds it). No `sign`, `pay`, `issue` or `export`: the window never
 * reaches a key, and an agent's payment never goes through the window. `requestMandate` sends TERMS only; main signs
 * after its own sheet. `setLimits`, `requestMandate`, `revoke` and `stop` must be called synchronously inside the
 * click handler of a control carrying `data-payments-confirm` (main checks the click).
 */
export interface PaymentsBridge {
  status: () => Promise<PaymentsStatusView | null>
  limits: () => Promise<PaymentsSettingsView | null>
  setLimits: (shown: PaymentsSettingsView, next: PaymentsSettingsView) => Promise<PaymentsChangeResult>
  mandates: () => Promise<PaymentsMandateView[]>
  /** Asks main to sign an open mandate with these terms: main shows them on the permission sheet first. */
  requestMandate: (terms: PaymentsMandateTerms) => Promise<PaymentsMandateResult>
  revoke: (jti: string) => Promise<PaymentsActionResult>
  stop: (on: boolean) => Promise<PaymentsActionResult>
  onChanged: (callback: () => void) => () => void
}

const MICROS_PER_USDC = 1_000_000

/** micro-USDC → "1.00", "0.5" → "0.50", "0.000001": two decimals at least, never a float artefact. */
export function formatUsdc(micros: number): string {
  if (!Number.isSafeInteger(micros) || micros < 0) {
    return '—'
  }

  const whole = Math.floor(micros / MICROS_PER_USDC)

  const fraction = String(micros % MICROS_PER_USDC)
    .padStart(6, '0')
    .replace(/0+$/, '')
    .padEnd(2, '0')

  return `${whole}.${fraction}`
}

const USDC_RE = /^(0|[1-9]\d{0,8})(?:\.(\d{1,6}))?$/

/** "1", "1.5", "0.000001" → micro-USDC; anything else (signs, exponents, 7 decimals, empty) → null. */
export function parseUsdc(text: string): number | null {
  const match = USDC_RE.exec(text.trim())

  if (!match) {
    return null
  }

  return Number(match[1]) * MICROS_PER_USDC + Number((match[2] ?? '').padEnd(6, '0'))
}

/** What the `$` door sheet shows before a payment is signed (J6): the payment, then the mandate in plain words. */
export interface SpendDoorFacts {
  agent: string
  resource: string
  payTo: string
  micros: number
  network: string
  networkLabel: string
  mandate: {
    jti: string
    expiresAt: string
    payees: string[]
    budget: string | null
    /** The budget minus what this mandate already closed (before this payment), or null without a budget. */
    budgetLeft: string | null
    range: { min: string; max: string } | null
  }
}

/** A sheet line holds at most this much of the resource URL; the rest is counted, never silently dropped. */
const RESOURCE_SHOWN_MAX = 1024

/** C0, DEL, C1, the line / paragraph separators and every bidi or invisible format mark (U+061C, U+200B–U+200F, U+202A–U+202E, U+2060–U+2069, U+FEFF). */
const unsafeOnSheet = (code: number): boolean =>
  code < 0x20 ||
  (code >= 0x7f && code <= 0x9f) ||
  code === 0x061c ||
  (code >= 0x200b && code <= 0x200f) ||
  (code >= 0x2028 && code <= 0x202e) ||
  (code >= 0x2060 && code <= 0x2069) ||
  code === 0xfeff

/**
 * One field of a sheet target, as inert text (fix JM3): every control, line-break and bidi character becomes a visible
 * `\u` escape, so no field — the agent's URL, the server's payee, a stored list entry — can add a line to the sheet,
 * reorder what is read, or hide a character. The sheet's own line breaks are the only ones it shows.
 */
export function sheetText(value: unknown): string {
  let out = ''

  for (const char of String(value)) {
    const code = char.codePointAt(0) ?? 0

    out += unsafeOnSheet(code) ? `\\u${code.toString(16).padStart(4, '0')}` : char
  }

  return out
}

const shownResource = (resource: string): string =>
  resource.length > RESOURCE_SHOWN_MAX
    ? `${sheetText(resource.slice(0, RESOURCE_SHOWN_MAX))}… (+${resource.length - RESOURCE_SHOWN_MAX} characters)`
    : sheetText(resource)

/**
 * The door sheet's literal target (shown monospace, never as instructions): one fact per line, so the amount, the
 * payee, the mandate's budget and what is left of it, its range, its expiry and its payee list are each a line a DOM
 * read can find. A `$` ask is never clipped on the sheet (completion round): every line below is on screen before the
 * trusted gesture, however long the payee list. The order is still the decision's: the payment, then the mandate.
 * The resource is the CANONICAL URL the client fetches (fix JM3); like every field it is shown escaped, as data.
 */
export function spendDoorTarget(facts: SpendDoorFacts): string {
  const m = facts.mandate

  return [
    `pay ${formatUsdc(facts.micros)} USDC → ${sheetText(facts.payTo)}`,
    `mandate budget ${m.budget === null ? '(none)' : `${sheetText(m.budget)} USDC`}`,
    `mandate budget left ${m.budgetLeft === null ? '(no budget)' : `${sheetText(m.budgetLeft)} USDC`}`,
    `mandate range ${m.range === null ? '(none)' : `${sheetText(m.range.min)} – ${sheetText(m.range.max)} USDC`}`,
    `mandate expires ${sheetText(m.expiresAt)}`,
    ...(m.payees.length
      ? [`mandate payees (${m.payees.length}):`, ...m.payees.map(payee => `  ${sheetText(payee)}`)]
      : ['mandate payees (any)']),
    `network ${sheetText(facts.networkLabel)} (${sheetText(facts.network)})`,
    `resource ${shownResource(facts.resource)}`,
    `agent ${sheetText(facts.agent)}`,
    `mandate ${sheetText(m.jti)}`
  ].join('\n')
}

/**
 * The permission sheet's literal target for signing an open mandate (`$`, never clipped): every term in plain words,
 * one per line, every payee in full on its own line, then the caps that still bind every payment under it. The labels
 * are the window's language (`copy`, J4-4); every value is printed verbatim and escaped, as before (fix JM3).
 */
export function mandateDoorTarget(
  terms: PaymentsMandateTerms,
  caps: Pick<PaymentsSettingsView, 'perAgentDayMicros' | 'perDayMicros' | 'perTxMicros'>,
  network: { id: string; label: string },
  copy: PaymentsSheetCopy
): string {
  const words = copy.mandate

  return [
    words.signFor(sheetText(terms.agent)),
    words.budget(sheetText(terms.budget)),
    words.range(sheetText(terms.min), sheetText(terms.max)),
    words.payees(terms.payees.length),
    ...terms.payees.map(payee => `  ${sheetText(payee)}`),
    words.window(sheetText(terms.notBefore), sheetText(terms.notAfter)),
    words.expires(sheetText(terms.expiresAt)),
    words.caps(formatUsdc(caps.perTxMicros), formatUsdc(caps.perDayMicros), formatUsdc(caps.perAgentDayMicros)),
    words.network(sheetText(network.label), sheetText(network.id)),
    words.revoke
  ].join('\n')
}

const CAP_AXES = new Set(['perTxMicros', 'perDayMicros', 'perAgentDayMicros'])

const valueWords = (axis: string, value: unknown): string =>
  CAP_AXES.has(axis) && typeof value === 'number' ? `${formatUsdc(value)} USDC` : sheetText(value)

const entriesOf = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : [])

/**
 * The door sheet's literal target for a widening settings change: each axis, old → new. A list (payees, origins) is
 * its counts, then each entry added (`+`) and removed (`−`) on its own line — at most ALLOWLIST_MAX each way, inside
 * the sheet's scrolling block (fix Jm1). The axis names and the words around the values are the window's language
 * (`copy`, J4-4); the values are verbatim and escaped.
 */
export function settingsDoorTarget(
  changes: readonly { axis: string; from: unknown; to: unknown }[],
  copy: PaymentsSheetCopy
): string {
  const words = copy.settings
  const axisName = (axis: string): string => (words.axes as Record<string, string | undefined>)[axis] ?? sheetText(axis)

  return changes
    .flatMap(change => {
      if (!Array.isArray(change.from) && !Array.isArray(change.to)) {
        return [
          words.change(axisName(change.axis), valueWords(change.axis, change.from), valueWords(change.axis, change.to))
        ]
      }

      const from = entriesOf(change.from)
      const to = entriesOf(change.to)

      return [
        words.listChange(axisName(change.axis), from.length, to.length),
        ...to.filter(entry => !from.includes(entry)).map(entry => `  + ${sheetText(entry)}`),
        ...from.filter(entry => !to.includes(entry)).map(entry => `  − ${sheetText(entry)}`)
      ]
    })
    .join('\n')
}
