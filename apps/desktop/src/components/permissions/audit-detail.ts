/**
 * V3-T3 — the detail of one audit record in the reader's words. Main's log line (`reason`) is English by design: it is
 * hash-chained, written once, and read by forensics and the agent, never by the owner. So the window never prints it.
 * It says the record from its own fields (target, function, levels, scope, answer, pid, source) and, where only the
 * log line knows what happened, maps main's fixed formats to a reason code. A line no rule knows still reads in the
 * reader's words (a generic phrase for its kind), never in English.
 *
 * The only free text shown is data the owner gave or the agent acted on: an action's target (a path, a command, a job)
 * and the project folder or chat a mode was set for.
 */
import type { PermissionsCopy } from '@/i18n/en/enPermissions'
import { type AuditRecordView, isFunctionLevel, isPermissionFunction } from '@/iclone-shared/permissions'

type Copy = PermissionsCopy
type PaymentCode = keyof Copy['audit']['details']['payment']

const SCOPES = ['session', 'project', 'standing'] as const
type GrantScope = (typeof SCOPES)[number]

const isScope = (value: unknown): value is GrantScope =>
  typeof value === 'string' && (SCOPES as readonly string[]).includes(value)

/** The Hermes process a record names, or null: main omits the pid it does not know, and so does the row. */
const pidOf = (record: AuditRecordView): string | null =>
  typeof record.hermes_pid === 'number' && record.hermes_pid > 0 ? String(record.hermes_pid) : null

/**
 * A payment record's reason is a code, written by `electron/iclone-x402`: the client's RefuseReason / LimitRule codes
 * and gap codes (`client.ts`, `server.ts`), the owner's own actions as `<verb> <detail>` (`index.ts`: `stop on|off
 * (owner)`, `mandate_issue <jti>`, `mandate_revoke <jti>`, their refusals `<verb> <why>`), the settings door
 * (`setting <axes>` / `setting <refusal>`), the agents' verb (`stop on`) and the socket (`socket|spawn <why>`).
 * Money first: a row after the signature that the ledger could not take is NOT a failed payment (money may have moved).
 */
const PAYMENT_CODES: Readonly<Record<string, PaymentCode>> = {
  settled: 'settled',
  settlement_pending: 'pending',
  // After the signature: the outcome stands, only the ledger row is missing (client.ts / server.ts `outcome`).
  ledger_write_failed: 'unrecorded',
  // A signature may have left, or the facilitator gave no verdict: never "did not complete".
  settlement_unknown: 'uncertain',
  internal: 'uncertain',
  earn_internal: 'uncertain',
  // The facilitator or the signer said no: nothing moved.
  sign_failed: 'failed',
  settlement_failed: 'failed',
  stop: 'stopped',
  ledger: 'ledger',
  per_tx: 'limit',
  per_day: 'limit',
  per_agent_day: 'limit',
  payee: 'payee',
  origin: 'payee',
  cross_origin_redirect: 'payee',
  no_mandate: 'mandate',
  mandate_invalid: 'mandate',
  door_denied: 'denied',
  // `agent` is "the agent is not a profile slug" (client.ts), not a payee.
  agent: 'service',
  no_door: 'service',
  not_ready: 'service',
  usage: 'service',
  signer_unavailable: 'service',
  not_x402: 'service',
  payload: 'service',
  unsupported_version: 'service',
  network: 'service',
  facilitator: 'service',
  duplicate: 'service'
}

/** The owner's own actions (`index.ts`, `settings-door.ts`): what the use did, and the fallback for a refusal. */
const OWNER_VERBS: Readonly<Record<string, { use: (rest: string) => PaymentCode; refused: PaymentCode }>> = {
  stop: { use: rest => (rest.startsWith('off') ? 'stopOff' : 'stopped'), refused: 'stopped' },
  mandate_issue: { use: () => 'mandateIssued', refused: 'mandateChange' },
  mandate_revoke: { use: () => 'mandateRevoked', refused: 'mandateChange' },
  setting: { use: () => 'setting', refused: 'setting' }
}

function paymentDetail(record: AuditRecordView, copy: Copy): string {
  const payment = copy.audit.details.payment
  const code = (record.reason ?? '').trim()

  // `internal` after a signature is a gap (outcome unknown); as a refusal (verb.ts) nothing was attempted.
  if (code === 'internal' && record.kind !== 'gap') {
    return payment.service
  }

  const known = PAYMENT_CODES[code]

  if (known) {
    return payment[known]
  }

  const [verb = '', ...words] = code.split(' ')
  const rest = words.join(' ')
  const owner = OWNER_VERBS[verb]

  if (owner && rest) {
    if (record.kind === 'use') {
      return payment[owner.use(rest)]
    }

    // A refusal of the owner's action names why: no click, the sheet's "no", the ledger, else the action itself.
    const why = words[0] ?? ''

    if (why === 'gesture') {
      return copy.audit.details.noGesture
    }

    if (why === 'door_denied' || why === 'ledger') {
      return payment[why === 'ledger' ? 'ledger' : 'denied']
    }

    return payment[owner.refused]
  }

  if (verb === 'socket' || verb === 'spawn') {
    return payment.service
  }

  return payment[record.kind === 'gap' ? 'uncertain' : 'other']
}

/** A `gap` record: what was not recorded, or why the chain cannot be trusted. */
function gapDetail(record: AuditRecordView, copy: Copy): string {
  const reason = record.reason ?? ''
  const details = copy.audit.details

  if (record.src === 'payment') {
    return paymentDetail(record, copy)
  }

  if (/^audit integrity:/.test(reason)) {
    return copy.audit.chainBroken
  }

  if (/^the audit key could not be sealed/.test(reason)) {
    return copy.enforcement.degraded
  }

  if (/never attested/.test(reason)) {
    return details.gateNotStarted(pidOf(record))
  }

  if (/stopped answering/.test(reason)) {
    return details.gateStopped(pidOf(record))
  }

  const unverified = /^(\d+) .* could not be verified/.exec(reason)

  if (unverified) {
    return details.unverified(Number(unverified[1]))
  }

  const events = /^plugin events? (\d+)(?:\.\.(\d+))? from pid/.exec(reason)

  if (events) {
    const from = Number(events[1])
    const to = events[2] ? Number(events[2]) : from

    return details.missedEvents(Math.max(1, to - from + 1))
  }

  // confinement/refusal-audit.ts: "confinement: <n> more refusal(s) in one minute, kept in the refusal log only"
  const burst = /^confinement: (\d+) more/.exec(reason)

  if (burst) {
    return details.confinementBurst(Number(burst[1]))
  }

  return details.gap
}

/** Why a mode change, a level change or a revoke was refused, from main's fixed messages (authority.ts). */
function refusedDetail(record: AuditRecordView, copy: Copy): string {
  const reason = record.reason ?? ''
  const details = copy.audit.details

  if (/standing default/.test(reason)) {
    return details.standingIgnore
  }

  if (/not confirmed/.test(reason)) {
    return details.notConfirmed
  }

  // A level raise (authority.ts `setFunctionLevel`): the keychain cannot seal the policy, or the level moved meanwhile.
  if (/keychain/.test(reason)) {
    return copy.enforcement.degraded
  }

  if (/changed while/.test(reason)) {
    return details.raced
  }

  if (record.gesture === false || /without a gesture|own click/.test(reason)) {
    return details.noGesture
  }

  return details.invalid
}

/** A record kind's label; a kind a later front adds reads as a generic "permission record", never its raw code. */
export const auditKindLabel = (copy: Copy, kind: string): string =>
  (Object.hasOwn(copy.audit.kinds, kind) ? copy.audit.kinds[kind] : undefined) ?? copy.audit.otherKind

/**
 * A row's title. An `answer` the owner never gave (main denied it because too many asks were waiting, or the agent
 * withdrew it) is titled by what happened — refused, or no answer — not "You answered".
 */
export function auditTitle(copy: Copy, record: AuditRecordView): string {
  if (record.kind === 'answer' && record.reason) {
    if (/too many/.test(record.reason)) {
      return auditKindLabel(copy, 'refuse')
    }

    if (record.reason === 'withdrawn') {
      return auditKindLabel(copy, 'timeout')
    }
  }

  return auditKindLabel(copy, record.kind)
}

const joined = (...parts: (string | null | undefined)[]): string | undefined =>
  parts.filter((part): part is string => !!part).join(' · ') || undefined

export function describeAuditRecord(record: AuditRecordView, copy: Copy): string | undefined {
  // What the agent acted on (a path, a command, `slug#job`): data, shown as it is.
  if (record.action?.target) {
    return record.action.target
  }

  const fc = copy.functions
  const details = copy.audit.details
  const fn = isPermissionFunction(record.fn) ? fc.functions[record.fn].name : null
  const scope = isScope(record.scope) ? copy.grants.scope[record.scope] : null

  switch (record.kind) {
    case 'fn_level_set':
    case 'fn_level_refused': {
      if (!fn || !isFunctionLevel(record.level)) {
        return fn ?? (record.kind === 'fn_level_refused' ? refusedDetail(record, copy) : undefined)
      }

      const to = fc.levels[record.level].name

      const change = isFunctionLevel(record.prev_level)
        ? fc.change(fn, fc.levels[record.prev_level].name, to)
        : fc.levelAria(fn, to)

      // A refused change says why (no click, not confirmed, keychain, changed meanwhile).
      return record.kind === 'fn_level_refused' ? joined(change, refusedDetail(record, copy)) : change
    }

    case 'grant':

    case 'revoke':
      return fn ? fc.grantFor(fn) : (scope ?? undefined)

    // The project folder the mode was set for is the owner's own data; a chat's key is an opaque session id, so a
    // chat-scoped row says the scope alone.
    case 'mode_set':
      return joined(scope, record.scope === 'project' ? record.reason : null)

    case 'mode_refused':
      return refusedDetail(record, copy)
    case 'answer': {
      if (record.reason && /too many/.test(record.reason)) {
        return details.busy
      }

      if (record.reason === 'withdrawn') {
        return details.withdrawn
      }

      if (record.answer === 'deny') {
        return details.denied
      }

      const answer = record.answer as keyof Copy['ask']['scopes'] | null

      return answer && answer in copy.ask.scopes ? copy.ask.scopes[answer] : undefined
    }

    case 'gap':
      return gapDetail(record, copy)

    case 'use':

    case 'refuse':

    case 'ask':

    case 'timeout':
      return record.src === 'payment' && record.reason ? paymentDetail(record, copy) : undefined

    // `restart` and anything a later front adds: the title says it; main's log line stays in the log.
    default:
      return undefined
  }
}
