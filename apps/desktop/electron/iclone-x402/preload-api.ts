/**
 * V3-J — the window's `hermesDesktop.payments` (contract §5: `status | limits | mandates | revoke | stop`, plus the
 * pane's `setLimits`, `requestMandate` and a change listener). Built by the preload from `ipcRenderer`; pure here so it
 * can be tested without Electron. There is no `sign`, no `pay`, no `issue`, no `export`: the window never reaches a
 * key, and an agent's payment never goes through the window. `requestMandate` carries the owner's TERMS to main, which
 * shows them on its own permission sheet and signs there; the window gets back the new mandate's id only.
 *
 * Defence in depth: every answer from main is re-projected onto the view's own fields (`src/iclone-shared/payments`)
 * before it crosses into the page, so even a main that put something extra on a view could not hand the page a key,
 * a sealed blob, a signature or a raw mandate. Strings are bounded; anything off-shape becomes null.
 *
 * `setLimits`, `requestMandate`, `revoke` and `stop` read the click lock synchronously (`gesture()`): call them inside the click handler
 * of a control carrying `data-payments-confirm`, before any await.
 */
import {
  PAYMENTS_NOT_READY,
  PAYMENTS_REFUSALS,
  type PaymentsActionResult,
  type PaymentsAllowlistProblem,
  type PaymentsBridge,
  type PaymentsChangeResult,
  type PaymentsMandateResult,
  type PaymentsMandateTerms,
  type PaymentsMandateView,
  type PaymentsSettingsView,
  type PaymentsStatusView
} from '../../src/iclone-shared/payments'

type Invoke = (channel: string, payload?: unknown) => Promise<unknown>
type Subscribe = (channel: string, listener: () => void) => () => void

const STRING_MAX = 512
// Hermes' profile id (`hermes_cli.profiles._PROFILE_ID_RE`): only such names are shown as unprotected profiles.
const PROFILE_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const LIST_MAX = 256

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown): string | null => (typeof value === 'string' ? value.slice(0, STRING_MAX) : null)
const num = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) ? value : 0)
const bool = (value: unknown): boolean => value === true

const strs = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .slice(0, LIST_MAX)
        .map(str)
        .filter((entry): entry is string => entry !== null)
    : []

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback

export function projectStatus(value: unknown): PaymentsStatusView | null {
  if (!isRow(value) || value.schema !== 1) {
    return null
  }

  return {
    schema: 1,
    ready: bool(value.ready),
    // A code only (J4-5): a not-ready status with an unknown or missing one reads `disabled`; ready has none.
    reason: bool(value.ready) ? null : pick(value.reason, PAYMENTS_NOT_READY, 'disabled'),
    pocket: typeof value.pocket === 'string' && /^0x[0-9a-f]{40}$/.test(value.pocket) ? value.pocket : null,
    network: str(value.network) ?? '',
    stopped: bool(value.stopped),
    ledgerOk: bool(value.ledgerOk),
    todayMicros: num(value.todayMicros),
    agents: Array.isArray(value.agents)
      ? value.agents
          .slice(0, LIST_MAX)
          .filter(isRow)
          .map(row => ({ agent: str(row.agent) ?? '', micros: num(row.micros) }))
      : [],
    unprotectedProfiles: strs(value.unprotectedProfiles).filter(name => PROFILE_SLUG_RE.test(name))
  }
}

export function projectSettings(value: unknown): PaymentsSettingsView | null {
  if (!isRow(value)) {
    return null
  }

  return {
    signer: pick(value.signer, ['agentcard', 'pocket'], 'pocket'),
    network: str(value.network) ?? '',
    mainnetEnabled: bool(value.mainnetEnabled),
    perTxMicros: num(value.perTxMicros),
    perDayMicros: num(value.perDayMicros),
    perAgentDayMicros: num(value.perAgentDayMicros),
    payees: strs(value.payees),
    origins: strs(value.origins),
    mandateStorage: pick(value.mandateStorage, ['local', 'local+irys'], 'local'),
    v1Servers: pick(value.v1Servers, ['agentcard', 'refuse'], 'refuse'),
    stop: bool(value.stop)
  }
}

export function projectMandates(value: unknown): PaymentsMandateView[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .slice(0, LIST_MAX)
    .filter(isRow)
    .map(row => {
      const range = isRow(row.range) ? { min: str(row.range.min) ?? '', max: str(row.range.max) ?? '' } : null

      return {
        // A mandate id is 32 lowercase hex: nothing longer ever crosses.
        jti: typeof row.jti === 'string' && /^[0-9a-f]{32}$/.test(row.jti) ? row.jti : '',
        agent: str(row.agent) ?? '',
        issuedAt: str(row.issuedAt) ?? '',
        expiresAt: str(row.expiresAt) ?? '',
        revoked: bool(row.revoked),
        budget: str(row.budget),
        range,
        payees: strs(row.payees)
      }
    })
    .filter(view => view.jti !== '')
}

function projectAction(value: unknown): PaymentsActionResult {
  if (isRow(value) && value.ok === true) {
    return { ok: true }
  }

  return { ok: false, reason: pick(isRow(value) ? value.reason : null, PAYMENTS_REFUSALS, 'unknown') }
}

/** Main's answer to a mandate request: the new mandate's id (32 hex) and nothing else, or a known refusal. */
export function projectMandateResult(value: unknown): PaymentsMandateResult {
  if (isRow(value) && value.ok === true) {
    return typeof value.jti === 'string' && /^[0-9a-f]{32}$/.test(value.jti)
      ? { ok: true, jti: value.jti }
      : { ok: false, reason: 'unknown' }
  }

  return { ok: false, reason: pick(isRow(value) ? value.reason : null, PAYMENTS_REFUSALS, 'unknown') }
}

/** The terms the window sends, copied field by field: nothing else rides along to main. */
const termsOf = (terms: PaymentsMandateTerms): PaymentsMandateTerms => ({
  agent: String(terms.agent),
  budget: String(terms.budget),
  min: String(terms.min),
  max: String(terms.max),
  payees: Array.isArray(terms.payees) ? terms.payees.slice(0, LIST_MAX).map(String) : [],
  notBefore: String(terms.notBefore),
  notAfter: String(terms.notAfter),
  expiresAt: String(terms.expiresAt)
})

const PROBLEMS_MAX = 2
const ENTRIES_MAX = 5
const ENTRY_MAX = 64

function projectProblems(value: unknown): PaymentsAllowlistProblem[] {
  return (Array.isArray(value) ? value : [])
    .slice(0, PROBLEMS_MAX)
    .filter(isRow)
    .map(row => ({
      list: pick(row.list, ['origins', 'payees'], 'payees'),
      kind: pick(row.kind, ['entries', 'not_list', 'too_many'], 'entries'),
      count: num(row.count),
      entries: strs(row.entries)
        .slice(0, ENTRIES_MAX)
        .map(entry => entry.slice(0, ENTRY_MAX)),
      more: num(row.more)
    }))
}

function projectChange(value: unknown): PaymentsChangeResult {
  const settings = isRow(value) && value.ok === true ? projectSettings(value.settings) : null

  if (settings) {
    return { ok: true, settings }
  }

  const failed = projectAction(isRow(value) && value.ok === true ? null : value)

  if (failed.ok) {
    return { ok: false, reason: 'unknown' }
  }

  // An allowlist refusal names what is wrong as data (J4-5), the refused entries being the user's own input, bounded;
  // no other refusal carries anything, and no text of main's crosses.
  const problems = failed.reason === 'allowlist' && isRow(value) ? projectProblems(value.problems) : []

  return problems.length > 0 ? { ...failed, problems } : failed
}

/**
 * `locale`: the window's language (its `<html lang>`), sent with each request that opens an owner sheet so main can
 * write the sheet's LABELS in it (J4-4). It never decides anything: main maps it onto six known ids, else English.
 */
export function createPaymentsBridge(
  invoke: Invoke,
  gesture: () => unknown,
  subscribe: Subscribe,
  locale: () => unknown = () => undefined
): PaymentsBridge {
  const language = (): string | undefined => {
    const value = locale()

    return typeof value === 'string' && value.length <= 16 ? value : undefined
  }

  return Object.freeze({
    status: async () => projectStatus(await invoke('iclone:payments:status')),
    limits: async () => projectSettings(await invoke('iclone:payments:limits')),
    setLimits: (shown: PaymentsSettingsView, next: PaymentsSettingsView) => {
      const payload = { shown, next, gesture: gesture(), locale: language() }

      return invoke('iclone:payments:set-limits', payload).then(projectChange)
    },
    mandates: async () => projectMandates(await invoke('iclone:payments:mandates')),
    requestMandate: (terms: PaymentsMandateTerms) => {
      const payload = { terms: termsOf(terms), gesture: gesture(), locale: language() }

      return invoke('iclone:payments:request-mandate', payload).then(projectMandateResult)
    },
    revoke: (jti: string) => {
      const payload = { jti, gesture: gesture() }

      return invoke('iclone:payments:revoke', payload).then(projectAction)
    },
    stop: (on: boolean) => {
      const payload = { on: on === true, gesture: gesture(), locale: language() }

      return invoke('iclone:payments:stop', payload).then(projectAction)
    },
    onChanged: (callback: () => void) => subscribe('iclone:payments:changed', () => callback())
  })
}
