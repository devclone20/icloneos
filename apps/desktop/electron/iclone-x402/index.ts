/**
 * V3-J — payments in main: the one place the module is assembled (contract §1–§4). Main only; nothing here is
 * reachable from the renderer except the seven guarded channels below, and none of them returns a key, a signature or
 * a raw mandate — only the views of `src/iclone-shared/payments.ts` (public addresses, amounts, plain constraints).
 *
 *   paths      `userData/payments/` (store.ts): settings, STOP, ledger, sealed keys, mandates
 *   keys       sealed by the OS through V3-F's `KeySealer`; no sealer (the Keychain setting is off, R2) ⇒ payments
 *              are disabled and say why — no key is created in clear
 *   client     `pay()` behind the agent's pay socket (ipc.ts, a token per Hermes spawn) — never a renderer channel
 *   doors      the spend door and the settings door are V3-F's consent sheet (`askPermission`, class `$`, scope
 *              `once` only): `true` only when the user's trusted click answered `once`; busy, withdrawn, deny or the
 *              2-min timeout is a no
 *   audit      every decision through V3-F (`recordPayment`, src `payment`)
 *
 * The owner's gestures (Settings › Economy › Payments): changing a setting, signing or revoking a mandate and clearing
 * the STOP need main's own gesture verdict for THAT sender (V3-F click lock). Signing a mandate always asks the sheet
 * (floor 5: `$` is always a question) with every term unclipped; revoking applies at once. A widening change (raise a cap, add a payee,
 * clear the stop …) also asks the sheet with every axis old → new; a lowering applies at once. Pulling the STOP needs
 * nothing: anyone may stop spending.
 */
import path from 'node:path'

import {
  checkMandateTerms,
  formatUsdc,
  mandateDoorTarget,
  PAYMENTS_SCHEMA,
  type PaymentsActionResult,
  type PaymentsChangeResult,
  type PaymentsMandateResult,
  type PaymentsMandateView,
  type PaymentsNotReady,
  type PaymentsSettingsView,
  type PaymentsStatusView,
  settingsDoorTarget,
  type SpendDoorFacts,
  spendDoorTarget
} from '../../src/iclone-shared/payments'
import { paymentsSheetCopy } from '../../src/iclone-shared/payments-sheet-copy'
import type { PermissionMode } from '../../src/iclone-shared/permissions'
import type { ConsentPermissionKey, ConsentSenderGuard } from '../iclone-consent'
import { guardedHandler } from '../iclone-consent'
import type { DoorPermission, PermissionDoorOutcome } from '../iclone-consent-door'
import { englishDisplayLanguageEverywhere } from '../iclone-display-language'
import type { KeySealer } from '../iclone-permissions/keys'

import { createX402Client, type PaymentAuditEntry, type SpendDoor, type X402Client } from './client'
import { createFacilitator, FACILITATOR_URLS } from './facilitator'
import { type PaySocketServer, setActivePaySocket, setSpawnSeed, startPaySocketServer } from './ipc'
import { loadAgentKey, loadOwnerMandateKey, NO_SEALING } from './keys'
import { createLedger, limitsViewOf, type PaymentLedger } from './ledger'
import {
  allowlistProblem,
  allowlistProblems,
  normalizeSettings,
  type SettingsDiff,
  signedToday,
  widens
} from './limits'
import { type Constraint, createMandateStore, type MandateStore, microsOfDecimal } from './mandates'
import { createSettingsDoor } from './settings-door'
import { type SheetKind, sheetRequestId } from './sheet-request'
import { createPocketSigner, type PaymentSigner } from './signer'
import {
  installerConfigTemplate,
  seedAllShippedDisabled,
  skillsSeedMarker,
  watchHermesProfiles
} from './skill-defaults'
import { changeSettings, isStopped, type PaymentPaths, paymentPaths, readSettings, setStop } from './store'
import { isMandateId, isNetwork, type Network, NETWORK_INFO } from './types'
import type { PaymentsVerbDeps } from './verb'

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void
}

/** V3-F's consent sheet, the one method payments use. */
interface DoorLike {
  askPermission: (
    slug: string,
    permission: DoorPermission,
    key: ConsentPermissionKey,
    reason: string
  ) => Promise<PermissionDoorOutcome>
}

interface PaymentsDeps {
  userDataDir: string
  /** The OS sealing (safeStorage) — null when the Keychain setting is off: payments are then disabled (R2). */
  sealer: KeySealer | null
  door: DoorLike | null
  /** The standing permission mode, shown on the sheet. */
  mode: () => PermissionMode
  /** `recordPayment` (V3-F's audit, src `payment`). */
  audit: (entry: PaymentAuditEntry) => unknown
  fetch?: typeof fetch
  /** The facilitator allowlist a p2p send settles through (tests: the loopback stub); default `FACILITATOR_URLS`. */
  facilitatorUrls?: Readonly<Partial<Record<Network, string>>>
  /** The ledger's clock (tests); default the wall clock. */
  now?: () => Date
  doorTimeoutMs?: number
}

const OWNER = 'owner'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** The window's language as its request says (its `<html lang>`, through the preload): only ever picks sheet labels. */
const localeOf = (input: unknown): unknown =>
  typeof input === 'object' && input !== null ? (input as Record<string, unknown>).locale : undefined

const SPEND_KEY: ConsentPermissionKey = 'spendTrade'

/** What a gesture-locked channel is told: did main see the user's own click for this sender? */
type GestureVerdict = boolean

interface Payments {
  paths: PaymentPaths
  ledger: PaymentLedger
  client: X402Client | null
  signer: PaymentSigner
  mandatesStore: MandateStore
  verbDeps: () => PaymentsVerbDeps
  status: (socketUp: boolean) => Omit<PaymentsStatusView, 'unprotectedProfiles'>
  /** Why the keys are unusable, in main's own words (its log only; the window gets a code), or null. */
  keysReason: string | null
  limits: () => PaymentsSettingsView
  setLimits: (input: unknown, gesture: GestureVerdict) => Promise<PaymentsChangeResult>
  mandates: () => PaymentsMandateView[]
  requestMandate: (input: unknown, gesture: GestureVerdict) => Promise<PaymentsMandateResult>
  revoke: (input: unknown, gesture: GestureVerdict) => PaymentsActionResult
  stop: (input: unknown, gesture: GestureVerdict) => Promise<PaymentsActionResult>
}

const constraintOf = <T extends Constraint['type']>(constraints: readonly Constraint[], type: T) =>
  constraints.find((entry): entry is Extract<Constraint, { type: T }> => entry.type === type) ?? null

/** The budget minus what was already closed under it, as USDC words; null when the mandate sets no budget. */
function budgetLeftOf(constraints: readonly Constraint[], usedMicros: number): string | null {
  const budget = constraintOf(constraints, 'payment.budget')
  const total = budget ? microsOfDecimal(budget.amount) : null

  return total === null ? null : formatUsdc(Math.max(0, total - Math.max(0, usedMicros)))
}

function plainMandate(constraints: readonly Constraint[]) {
  const budget = constraintOf(constraints, 'payment.budget')
  const range = constraintOf(constraints, 'payment.amount_range')
  const payees = constraintOf(constraints, 'payment.allowed_payees')

  return {
    budget: budget ? budget.amount : null,
    range: range ? { min: range.min, max: range.max } : null,
    payees: payees ? [...payees.payees] : []
  }
}

const isoOfSeconds = (seconds: number): string => {
  const date = new Date(seconds * 1000)

  return Number.isFinite(date.getTime()) ? date.toISOString() : '—'
}

const view = (settings: PaymentsSettingsView): PaymentsSettingsView => ({
  signer: settings.signer,
  network: settings.network,
  mainnetEnabled: settings.mainnetEnabled,
  perTxMicros: settings.perTxMicros,
  perDayMicros: settings.perDayMicros,
  perAgentDayMicros: settings.perAgentDayMicros,
  payees: [...settings.payees],
  origins: [...settings.origins],
  mandateStorage: settings.mandateStorage,
  v1Servers: settings.v1Servers,
  stop: settings.stop
})

function createPayments(deps: PaymentsDeps): Payments {
  const paths = paymentPaths(deps.userDataDir)
  const ledger = createLedger({ file: paths.ledger, now: deps.now })
  const signer = createPocketSigner(paths.keys, deps.sealer)
  const ownerKey = loadOwnerMandateKey(paths.keys, deps.sealer)

  const mandatesStore = createMandateStore({
    dir: paths.mandates,
    ownerKey,
    agentKey: slug => loadAgentKey(paths.keys, deps.sealer, slug),
    ledger
  })

  const sink = {
    record: (entry: PaymentAuditEntry) => {
      try {
        return deps.audit(entry)
      } catch {
        return null
      }
    }
  }

  const audit = (kind: PaymentAuditEntry['kind'], reason: string, agent = ''): void => {
    sink.record({ kind, reason, agent })
  }

  const mode = (): PermissionMode => {
    try {
      return deps.mode()
    } catch {
      return 'manual'
    }
  }

  /**
   * The sheet: `true` only for the user's `once`. Every other outcome (and any throw) is a no. An owner sheet (J4-4)
   * carries its canonical request id: the answer is audited against THAT id, never the words shown (whose labels follow
   * the window's language), so one request reads the same in the audit whatever the locale.
   */
  const ask = async (
    slug: string,
    tool: string,
    target: string,
    reason: string,
    requestId: null | string = null
  ): Promise<boolean> => {
    if (!deps.door) {
      return false
    }

    let outcome: PermissionDoorOutcome | 'error'

    try {
      outcome = await deps.door.askPermission(
        slug,
        { cls: '$', tool, target, mode: mode(), project: null, session: null, subagent: null, scopes: ['once'] },
        SPEND_KEY,
        reason
      )
    } catch {
      outcome = 'error'
    }

    if (requestId !== null) {
      audit(
        outcome === 'once' ? 'use' : 'refuse',
        `sheet ${tool} ${outcome} request=${requestId}`,
        slug === OWNER ? '' : slug
      )
    }

    return outcome === 'once'
  }

  /** An owner sheet: its words in the window's language, its answer bound to the canonical request. */
  const askOwner = (kind: SheetKind, request: unknown, target: string, reason: string): Promise<boolean> =>
    ask(OWNER, kind, target, reason, sheetRequestId(kind, request))

  const spendDoor: SpendDoor | null = deps.door
    ? request => {
        const network = isNetwork(request.network) ? request.network : null

        const facts: SpendDoorFacts = {
          agent: request.agent,
          resource: request.resource,
          payTo: request.payTo,
          micros: request.micros,
          network: request.network,
          networkLabel: network ? NETWORK_INFO[network].label : request.network,
          mandate: {
            jti: request.mandate.jti,
            expiresAt: isoOfSeconds(request.mandate.exp),
            budgetLeft: budgetLeftOf(request.mandate.constraints, request.usedMicros),
            ...plainMandate(request.mandate.constraints)
          }
        }

        return ask(request.agent, 'x402-pay', spendDoorTarget(facts), 'An x402 payment, under the mandate below')
      }
    : null

  const settingsSheet = deps.door
    ? (request: { changes: SettingsDiff['changes']; locale?: unknown }) => {
        const copy = paymentsSheetCopy(request.locale)

        return askOwner(
          'payments.settings',
          request.changes.map(({ axis, from, to }) => ({ axis, from, to })),
          settingsDoorTarget(request.changes, copy),
          copy.reasons.settings
        )
      }
    : null

  const settingsDoor = createSettingsDoor({
    paths,
    ledger,
    door: settingsSheet,
    audit: sink,
    doorTimeoutMs: deps.doorTimeoutMs
  })

  // Payments are on only when every key could be sealed by the OS (R2): never a key in clear, never half a module.
  const keysReason = signer.reason ?? ownerKey.reason
  const enabled = signer.status !== 'unavailable' && ownerKey.status !== 'unavailable'

  const client: X402Client | null = enabled
    ? createX402Client({
        settings: () => readSettings(paths),
        stopped: () => isStopped(paths),
        ledger,
        mandates: mandatesStore,
        signer,
        door: spendDoor,
        audit: sink,
        fetch: deps.fetch ?? globalThis.fetch,
        facilitator: createFacilitator({
          urls: deps.facilitatorUrls ?? FACILITATOR_URLS,
          fetch: deps.fetch ?? globalThis.fetch
        }),
        doorTimeoutMs: deps.doorTimeoutMs
      })
    : null

  const pullStop = (): boolean => {
    try {
      return setStop(paths, true, ledger)
    } catch {
      return false
    }
  }

  // The profiles half (`unprotectedProfiles`) is registerPayments': it is the one that seeds the Hermes configs.
  const status = (socketUp: boolean): Omit<PaymentsStatusView, 'unprotectedProfiles'> => {
    const settings = readSettings(paths)
    const read = ledger.read()
    const signed = limitsViewOf(read).signed
    const now = ledger.now()

    const agents = [...new Set(signed.map(row => row.agent))]
      .map(agent => ({ agent, micros: signedToday(signed, now, agent) }))
      .filter(row => row.micros > 0)

    // A code the window words in its own language (J4-5); main's own text is in its log (`registerPayments`).
    const reason: PaymentsNotReady | null = !client
      ? keysReason === NO_SEALING
        ? 'sealing_off'
        : keysReason
          ? 'keys_unavailable'
          : 'disabled'
      : !socketUp
        ? 'socket_down'
        : null

    return {
      schema: PAYMENTS_SCHEMA,
      ready: reason === null,
      reason,
      pocket: signer.address,
      network: settings.network,
      stopped: settings.stop || isStopped(paths),
      ledgerOk: read.ok,
      todayMicros: signedToday(signed, now),
      agents
    }
  }

  /**
   * What the agent's `x402-pay status` sees — ITS OWN view, folded from main's files: whether it can pay, the stop,
   * the user's caps and allowlists, what it and everyone signed today, and its own mandates with what is left of each.
   * Public addresses, amounts and plain constraints only: no key, no signature, no raw mandate, no other agent's mandate.
   */
  const agentStatus = (agent: string): object => {
    const settings = readSettings(paths)
    const read = ledger.read()
    const now = ledger.now()
    const signed = limitsViewOf(read).signed
    const used = new Map<string, number>()

    for (const row of read.records) {
      if (row.kind === 'mandate_use' && row.mandate && row.micros !== null) {
        used.set(row.mandate, (used.get(row.mandate) ?? 0) + row.micros)
      }
    }

    const seconds = Math.floor(now.getTime() / 1000)

    return {
      ready: client !== null && read.ok,
      reason: client
        ? read.ok
          ? null
          : 'the payments record does not verify'
        : (keysReason ?? 'payments are disabled'),
      stopped: settings.stop || isStopped(paths),
      network: settings.network,
      pocket: signer.address,
      caps: {
        perTx: formatUsdc(settings.perTxMicros),
        perDay: formatUsdc(settings.perDayMicros),
        perAgentDay: formatUsdc(settings.perAgentDayMicros)
      },
      today: { all: formatUsdc(signedToday(signed, now)), agent: formatUsdc(signedToday(signed, now, agent)) },
      payees: [...settings.payees],
      origins: [...settings.origins],
      mandates: mandatesStore
        .list()
        .filter(record => record.agent === agent)
        .map(record => {
          const window = constraintOf(record.constraints, 'payment.execution_date')

          return {
            jti: record.jti,
            ...plainMandate(record.constraints),
            left: budgetLeftOf(record.constraints, used.get(record.jti) ?? 0),
            from: window?.not_before ?? null,
            until: window?.not_after ?? null,
            expiresAt: isoOfSeconds(record.exp),
            revoked: record.revoked,
            usable: !record.revoked && record.exp > seconds
          }
        })
    }
  }

  const setLimits = async (input: unknown, gesture: GestureVerdict): Promise<PaymentsChangeResult> => {
    if (!gesture) {
      audit('refuse', 'setting gesture')

      return { ok: false, reason: 'gesture' }
    }

    const raw = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}

    if (typeof raw.shown !== 'object' || raw.shown === null || typeof raw.next !== 'object' || raw.next === null) {
      audit('refuse', 'setting invalid')

      return { ok: false, reason: 'invalid' }
    }

    // Compare-and-set from the PANE: the form was filled against `shown`; if what is stored moved since, nothing is
    // applied (the door's own CAS then covers the time the sheet is open).
    if (widens(normalizeSettings(raw.shown), readSettings(paths)).changes.length > 0) {
      audit('refuse', 'setting settings_moved')

      return { ok: false, reason: 'settings_moved' }
    }

    const outcome = await settingsDoor.change(raw.next, raw.locale)

    if (outcome.ok) {
      return { ok: true, settings: view(outcome.settings) }
    }

    // Which entries were refused is the user's own input, named back as data the pane words (fix Jm1, J4-5).
    return outcome.reason === 'allowlist'
      ? { ok: false, reason: outcome.reason, problems: allowlistProblems(raw.next) }
      : { ok: false, reason: outcome.reason }
  }

  const mandates = (): PaymentsMandateView[] =>
    mandatesStore.list().map(record => ({
      jti: record.jti,
      agent: record.agent,
      issuedAt: isoOfSeconds(record.iat),
      expiresAt: isoOfSeconds(record.exp),
      revoked: record.revoked,
      ...plainMandate(record.constraints)
    }))

  /**
   * The owner signs an OPEN payment mandate (contract §1.2): his click (V3-F lock) → the terms checked against the
   * allowlist and the clock → the `$` sheet with every term in plain words, unclipped → only `once` → the same checks
   * AGAIN (the allowlist or the clock may have moved while the sheet was open) → signed in main with the owner's key,
   * stored 0600 at `payments/mandates/<jti>.sdjwt`, with its `mandate_issue` row. The window gets the id, never the token.
   */
  const requestMandate = async (input: unknown, gesture: GestureVerdict): Promise<PaymentsMandateResult> => {
    if (!gesture) {
      audit('refuse', 'mandate_issue gesture')

      return { ok: false, reason: 'gesture' }
    }

    if (!client) {
      audit('refuse', 'mandate_issue not_ready')

      return { ok: false, reason: 'not_ready' }
    }

    const terms = typeof input === 'object' && input !== null ? (input as Record<string, unknown>).terms : undefined
    const settings = readSettings(paths)
    const first = checkMandateTerms(terms, settings.payees, ledger.now())

    if (!first.ok) {
      audit('refuse', `mandate_issue invalid ${first.problem}`)

      return { ok: false, reason: 'invalid' }
    }

    const checked = first.checked.terms
    const network = NETWORK_INFO[settings.network]
    const copy = paymentsSheetCopy(localeOf(input))
    // What is signed, canonically: the terms and the network. The sheet's words are only its rendering (J4-4).
    const asked = sheetRequestId('payments.mandate', { terms: checked, network: settings.network })

    if (
      !(await ask(
        OWNER,
        'payments.mandate',
        mandateDoorTarget(checked, settings, { id: settings.network, label: network.label }, copy),
        copy.reasons.mandate(checked.agent),
        asked
      ))
    ) {
      audit('refuse', 'mandate_issue door_denied', checked.agent)

      return { ok: false, reason: 'door_denied' }
    }

    // The sheet was open: the allowlist and the clock are read again, and the terms must still be exactly the shown ones.
    const at = ledger.now()
    const again = checkMandateTerms(checked, readSettings(paths).payees, at)

    if (!again.ok) {
      audit('refuse', `mandate_issue settings_moved ${again.problem}`, checked.agent)

      return { ok: false, reason: 'settings_moved' }
    }

    // The `once` is for the request it was asked on: what is signed now must be that very request.
    if (
      sheetRequestId('payments.mandate', { terms: again.checked.terms, network: readSettings(paths).network }) !== asked
    ) {
      audit('refuse', `mandate_issue settings_moved request=${asked}`, checked.agent)

      return { ok: false, reason: 'settings_moved' }
    }

    const { budget, min, max, payees, notBefore, notAfter } = again.checked.terms

    const issued = mandatesStore.issue({
      agent: checked.agent,
      expiresAt: Math.floor(again.checked.expiresMs / 1000),
      constraints: [
        { type: 'payment.budget', amount: budget, currency: 'USDC' },
        { type: 'payment.amount_range', min, max, currency: 'USDC' },
        { type: 'payment.allowed_payees', payees },
        { type: 'payment.execution_date', not_before: notBefore, not_after: notAfter }
      ]
    })

    if (!issued.ok) {
      const reason = issued.reason === 'ledger write failed' ? 'ledger' : 'not_ready'

      audit('refuse', `mandate_issue ${reason}`, checked.agent)

      return { ok: false, reason }
    }

    audit('use', `mandate_issue ${issued.record.jti}`, checked.agent)

    return { ok: true, jti: issued.record.jti }
  }

  const revoke = (input: unknown, gesture: GestureVerdict): PaymentsActionResult => {
    if (!gesture) {
      audit('refuse', 'mandate_revoke gesture')

      return { ok: false, reason: 'gesture' }
    }

    const jti = typeof input === 'object' && input !== null ? (input as Record<string, unknown>).jti : undefined

    if (!isMandateId(jti) || !mandatesStore.revoke(jti)) {
      audit('refuse', 'mandate_revoke unknown')

      return { ok: false, reason: 'unknown' }
    }

    audit('use', `mandate_revoke ${jti}`)

    return { ok: true }
  }

  const stop = async (input: unknown, gesture: GestureVerdict): Promise<PaymentsActionResult> => {
    const on = typeof input === 'object' && input !== null ? (input as Record<string, unknown>).on : undefined

    if (on === true) {
      if (!pullStop()) {
        audit('refuse', 'stop ledger')

        return { ok: false, reason: 'ledger' }
      }

      audit('use', 'stop on (owner)')

      return { ok: true }
    }

    if (on !== false) {
      return { ok: false, reason: 'invalid' }
    }

    const stopCopy = paymentsSheetCopy(localeOf(input))

    // Clearing the stop is the owner's, with his gesture AND the sheet (it widens what agents may spend).
    if (!gesture) {
      audit('refuse', 'stop gesture')

      return { ok: false, reason: 'gesture' }
    }

    const shown = readSettings(paths)
    const file = isStopped(paths)

    if (!shown.stop && !file) {
      return { ok: true }
    }

    if (
      !(await askOwner(
        'payments.stop',
        { axis: 'stop', from: true, to: false },
        settingsDoorTarget([{ axis: 'stop', from: true, to: false }], stopCopy),
        stopCopy.reasons.stop
      ))
    ) {
      audit('refuse', 'stop door_denied')

      return { ok: false, reason: 'door_denied' }
    }

    if (shown.stop) {
      const applied = changeSettings(paths, ledger, shown, { ...shown, stop: false })

      if (!applied.ok) {
        audit('refuse', `stop ${applied.code}`)

        return { ok: false, reason: applied.code }
      }
    }

    if (file && !setStop(paths, false, ledger)) {
      audit('refuse', 'stop ledger')

      return { ok: false, reason: 'ledger' }
    }

    audit('use', 'stop off (owner)')

    return { ok: true }
  }

  return {
    paths,
    ledger,
    client,
    signer,
    mandatesStore,
    verbDeps: () => ({ client, audit: sink, stop: pullStop, status: agentStatus }),
    status,
    keysReason: keysReason ?? null,
    limits: () => view(readSettings(paths)),
    setLimits,
    mandates,
    requestMandate,
    revoke,
    stop
  }
}

interface RegisterPaymentsDeps extends PaymentsDeps {
  ipcMain: IpcMainLike
  isTrustedSender: ConsentSenderGuard
  /** `<userData>/run`, shared with the acp socket. */
  socketDir: string
  /** Main's gesture verdict for this IPC sender and payload (V3-F `permissionGestureOk`). */
  gestureOk: (event: unknown, input: unknown) => boolean
  /** Tells the app windows to re-read (Settings › Economy › Payments). */
  broadcast: () => void
  log: (line: string) => void
  /** `<HERMES_HOME>`: the payment skills the app ships disabled are seeded into its `config.yaml` once (D4). */
  hermesHome?: string
  /** The active Hermes root (the installer's `--dir`): its `cli-config.yaml.example` is what a missing root config is
   *  created from, exactly as the installer's config stage would (fix m-r2-1). */
  hermesRoot?: string
}

interface RegisteredPayments {
  payments: Payments
  /** Resolves once the pay socket listens (null if it could not start: agents then have no pay env). */
  socket: Promise<PaySocketServer | null>
  /** One seed pass, as main runs right before every Hermes spawn (a no-op without a Hermes home). */
  seed: () => void
  /** V3-FX M1: the Keychain setting changed — re-read the keys with this sealer (null: payments off, sealing_off). */
  reseal: (sealer: KeySealer | null) => void
  close: () => void
}

export const PAYMENT_CHANNELS = [
  'iclone:payments:status',
  'iclone:payments:limits',
  'iclone:payments:set-limits',
  'iclone:payments:mandates',
  'iclone:payments:request-mandate',
  'iclone:payments:revoke',
  'iclone:payments:stop'
] as const

export function registerPayments(deps: RegisterPaymentsDeps): RegisteredPayments {
  // V3-FX M1: rebuilt by `reseal` when the owner turns the Keychain setting on or off; every handler below reads it
  // at call time, so the change takes effect without a restart.
  let payments = createPayments(deps)

  if (payments.keysReason) {
    deps.log(`[iclone-x402] payments not ready: ${payments.keysReason}`)
  }

  let server: PaySocketServer | null = null

  // D4: the payment skills the app ships disabled are off in every config Hermes reads — the root home's and each
  // profile's — from the first session on: seeded now, again right before every Hermes spawn (`paySpawn`) and whenever
  // a profile folder appears. A config that does not exist yet is created (fix JM1): the root's from the installer's
  // template plus that block, or left to the installer until the first spawn (fix m-r2-1); a profile's as the block.
  let stopWatchingProfiles: (() => void) | null = null
  // Fix m-r2-2 / m-r4-2: every profile Hermes could run whose config the latest seed pass could not verify (a folder
  // or config.yaml outside the Hermes home, unreadable, unwritable, a name Hermes folds onto another): shown in the
  // status, and the pay socket refuses their spawns. Refreshed by every seed pass, so a spawn sees the folder as it is.
  let unprotectedProfiles: readonly string[] = []
  // Fix m-r4-1: the profiles the latest seed pass verified, each with the identity of the folder Hermes runs it in. A
  // pay token is minted only for one of these and is bound to that folder; anything else gets no token.
  let verifiedProfiles: Readonly<Record<string, string>> = {}
  let seedPass: ((when: string) => void) | null = null

  if (deps.hermesHome) {
    const hermesHome = deps.hermesHome
    const markerFile = skillsSeedMarker(payments.paths.root)

    const seed = (when: string): void => {
      const { configs, markerError, unprotected, verified } = seedAllShippedDisabled({
        hermesHome,
        markerFile,
        now: () => payments.ledger.now(),
        template: deps.hermesRoot ? installerConfigTemplate(deps.hermesRoot) : null,
        // Only the pass right before a Hermes process starts may create the bare block: until then a missing root
        // config is the installer's to write from its template (its config stage keeps any config it finds).
        rootWithoutTemplate: when === 'spawn' ? 'create' : 'wait'
      })

      for (const result of configs) {
        if (result.created || result.seeded.length > 0 || result.skipped) {
          deps.log(
            `[iclone-x402] payment skills shipped disabled (${when}) ${path.relative(hermesHome, result.configFile) || 'config.yaml'}: ${result.created ? 'created with ' : ''}${result.seeded.join(', ') || 'none added'}${result.skipped ? ` (${result.skipped})` : ''}`
          )
        }
      }

      if (markerError) {
        deps.log(`[iclone-x402] payment skills shipped disabled (${when}): ${markerError}`)
      }

      if (unprotected.join('\n') !== unprotectedProfiles.join('\n')) {
        deps.log(
          `[iclone-x402] profiles the app could not protect, refused by the pay socket (${when}): ${unprotected.join(', ') || 'none'}`
        )
      }

      unprotectedProfiles = unprotected
      verifiedProfiles = verified

      // Ruling 69 / review r2 (R2-M5): the same passes (launch, every spawn, a new profile) set a non-English
      // `display.language` to English in every local profile's config, not only the one the window had open.
      for (const pass of englishDisplayLanguageEverywhere(hermesHome)) {
        if (pass.rewrote !== null || pass.skipped !== null) {
          deps.log(
            `[iclone-i18n] display.language (${when}) ${path.relative(hermesHome, pass.configFile) || 'config.yaml'}: ${pass.rewrote !== null ? `${pass.rewrote} -> en` : `left as is (${pass.skipped})`}`
          )
        }
      }
    }

    seedPass = seed
    seed('launch')
    setSpawnSeed(() => seed('spawn'))
    stopWatchingProfiles = watchHermesProfiles(hermesHome, () => seed('profile'))
  }

  const changed = (): void => {
    try {
      deps.broadcast()
    } catch {
      // a window that went away is not the payment's problem
    }
  }

  const socket = startPaySocketServer({
    dir: deps.socketDir,
    verb: () => payments.verbDeps(),
    audit: { record: entry => deps.audit(entry) },
    log: deps.log,
    onSettled: changed,
    bindProfile: slug => {
      if (unprotectedProfiles.includes(slug)) {
        return {
          refused: `profile ${slug}: the app could not make sure its payment skills are off (a folder or config.yaml outside the Hermes home, or one it could not read or write), so it cannot pay`
        }
      }

      const home = Object.prototype.hasOwnProperty.call(verifiedProfiles, slug) ? verifiedProfiles[slug] : undefined

      return home === undefined
        ? { refused: `profile ${slug} was not verified by the app's last check of the Hermes configs: it cannot pay` }
        : { home }
    }
  }).then(
    started => {
      server = started
      setActivePaySocket(started)
      changed()

      return started
    },
    (error: unknown) => {
      deps.log(`[iclone-x402] pay socket not started: ${error instanceof Error ? error.message : String(error)}`)

      return null
    }
  )

  const ipcMain = guardedHandler(deps.ipcMain, deps.isTrustedSender)

  const safely = async <T>(work: () => Promise<T> | T, fallback: T): Promise<T> => {
    try {
      return await work()
    } catch {
      return fallback
    }
  }

  const failed = { ok: false as const, reason: 'unknown' as const }

  ipcMain.handle('iclone:payments:status', () =>
    safely(() => ({ ...payments.status(server !== null), unprotectedProfiles: [...unprotectedProfiles] }), null)
  )
  ipcMain.handle('iclone:payments:limits', () => safely(() => payments.limits(), null))
  ipcMain.handle('iclone:payments:mandates', () => safely(() => payments.mandates(), []))
  ipcMain.handle('iclone:payments:set-limits', (event, input) =>
    safely(async () => {
      const result = await payments.setLimits(input, deps.gestureOk(event, input))

      if (!result.ok && result.reason === 'allowlist') {
        // Main's own words for the log; the window gets the same as data (J4-5).
        deps.log(
          `[iclone-x402] settings change refused: ${allowlistProblem(isRecord(input) ? input.next : null) ?? 'allowlist'}`
        )
      }

      changed()

      return result
    }, failed)
  )
  ipcMain.handle('iclone:payments:request-mandate', (event, input) =>
    safely(async () => {
      const result = await payments.requestMandate(input, deps.gestureOk(event, input))

      changed()

      return result
    }, failed)
  )
  ipcMain.handle('iclone:payments:revoke', (event, input) =>
    safely(() => {
      const result = payments.revoke(input, deps.gestureOk(event, input))

      changed()

      return result
    }, failed)
  )
  ipcMain.handle('iclone:payments:stop', (event, input) =>
    safely(async () => {
      const result = await payments.stop(input, deps.gestureOk(event, input))

      changed()

      return result
    }, failed)
  )

  return {
    get payments() {
      return payments
    },
    socket,
    seed: () => seedPass?.('spawn'),
    reseal: (sealer: KeySealer | null) => {
      payments = createPayments({ ...deps, sealer })
      deps.log(`[iclone-x402] keys re-read after the Keychain setting changed: ${payments.keysReason ?? 'ready'}`)
      changed()
    },
    close: () => {
      stopWatchingProfiles?.()
      setSpawnSeed(null)
      setActivePaySocket(null)
      server?.close()
      server = null
    }
  }
}
