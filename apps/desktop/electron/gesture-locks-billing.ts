/**
 * F1-S (v0.0.9) — the owner-click lock on Settings › Billing › Buy credits (`billing.charge`: a charge on the owner's
 * card). Kept by the lead's decision of 17 Nov, behind this lock.
 *
 * The charge itself is a gateway RPC the renderer sends over its own WebSocket to the runtime
 * (tui_gateway/methods_session.py `billing.charge`); main is not on that path and cannot drop a frame. So the lock is:
 *
 * 1. `iclone:billing:authorize-charge` — the preload sends `{ amountUsd, idempotencyKey, gesture }` synchronously
 *    inside the click handler of the marked control (`data-billing-charge-confirm`). Main checks the V3-F rule
 *    (`gestureOk`: activation + the preload's trusted confirm on that control + real input to this window), audits the
 *    decision (`use · gesture:true` / `refuse · gesture:false`) and, only then, answers a single-use opaque owner
 *    confirm bound to exactly that amount and idempotency key, valid for `BILLING_CONFIRM_TTL_MS`.
 * 2. The app's billing api (src/app/settings/billing/api.ts) never sends `billing.charge` without that confirm, and
 *    sends it as the `owner_confirm` param.
 * 3. `consume(token, amountUsd, idempotencyKey)` — single use — is the check the RUNTIME makes before it charges
 *    (over main's authenticated permissions socket, `perm billing`; R-f1s-5).
 *
 * v0.0.9 Q (lead decision 1): every OTHER runtime billing write that charges the card or arms a charge takes the
 * same confirm, bound to `(action, subject, idempotencyKey)` instead of `(amount, key)`:
 * - `subscription-upgrade` (`subscription.upgrade`: prorate + charge + flip the plan), subject = the tier id;
 * - `subscription-change` (`subscription.change` to a tier: can replace a pending cancellation), subject = the tier id;
 * - `subscription-resume` (`subscription.resume`: re-enables the recurring spend), subject = `resume`;
 * - `auto-reload` (`billing.auto_reload` with `enabled: true`: a standing recurring charge), subject =
 *   `on|<threshold>|<top_up_amount>` (the two decimal strings the request carries).
 * Turning auto-reload off and scheduling a cancellation charge nothing and need no confirm. The renderer asks through
 * `iclone:billing:authorize-action` inside the click of a control carrying the same `data-billing-charge-confirm`.
 */
import { randomBytes } from 'node:crypto'

import { type ConsentSenderGuard, guardedHandler } from './iclone-consent'

/** One audit entry for a charge decision; the sink returns the record, or null when it could not write one. */
export type BillingChargeAuditSink = (entry: {
  kind: 'refuse' | 'use'
  reason: string
  gesture: boolean
  /** v0.0.9 r3 (eng n4): the runtime method this decision is about, so the audit names it (BILLING_AUDIT_TOOL). */
  tool: BillingAuditTool
}) => unknown

export interface BillingChargeLockDeps {
  ipcMain: Parameters<typeof guardedHandler>[0]
  isTrustedSender: ConsentSenderGuard | undefined
  /** Main's gesture verdict for this IPC sender and payload (V3-F `permissionGestureOk`). */
  gestureOk: (event: unknown, input: unknown) => boolean
  /** Absent, or unable to record: every charge is refused. */
  audit?: BillingChargeAuditSink
  now?: () => number
  ttlMs?: number
}

export type BillingChargeAuthorization = { ok: true; ownerConfirm: string } | { ok: false; error: string }

/** What one owner confirm can authorize (the runtime names the same action over `perm billing`). */
export const BILLING_ACTIONS = [
  'charge',
  'subscription-upgrade',
  'subscription-change',
  'subscription-resume',
  'auto-reload'
] as const

export type BillingAction = (typeof BILLING_ACTIONS)[number]

/** v0.0.9 r3 (eng n4): the runtime method each action authorizes, the audit's `tool` (it said billing.charge for all). */
export const BILLING_AUDIT_TOOL = {
  charge: 'billing.charge',
  'subscription-upgrade': 'subscription.upgrade',
  'subscription-change': 'subscription.change',
  'subscription-resume': 'subscription.resume',
  'auto-reload': 'billing.auto_reload'
} as const satisfies Record<BillingAction, string>

export type BillingAuditTool = (typeof BILLING_AUDIT_TOOL)[BillingAction]

/** The owner's own words for what was refused, one per action (eng n4: every refusal said "a charge ... on Buy"). */
export const BILLING_GESTURE_REFUSED: Record<BillingAction, string> = {
  charge: '[billing-charge:gesture] a charge needs your own click on Buy',
  'subscription-upgrade': '[billing-charge:gesture] a plan upgrade needs your own click on Upgrade',
  'subscription-change': '[billing-charge:gesture] a plan change needs your own click on Change plan',
  'subscription-resume': '[billing-charge:gesture] resuming your plan needs your own click on Resume',
  'auto-reload': '[billing-charge:gesture] turning on auto-reload needs your own click on Turn on'
}

/** Long enough for the request to reach the runtime (and one transport retry with the same key), short otherwise. */
export const BILLING_CONFIRM_TTL_MS = 120_000
const MAX_PENDING = 16

/** The renderer's amount (`clampAmount`: decimal dollars, ≤ 2 places) and key (`crypto.randomUUID`, or a retry's). */
const AMOUNT = /^\d{1,7}(\.\d{1,2})?$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/
/** A portal tier id (opaque, short, no separators that could fake another subject). */
const TIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const AUTO_RELOAD = /^on\|(\d{1,7}(?:\.\d{1,2})?)\|(\d{1,7}(?:\.\d{1,2})?)$/

const isAction = (value: unknown): value is BillingAction =>
  typeof value === 'string' && (BILLING_ACTIONS as readonly string[]).includes(value)

/** True when `subject` is a well-formed subject for `action` (a positive amount, a tier id, `resume`, a reload rule). */
export function validBillingSubject(action: BillingAction, subject: unknown): subject is string {
  if (typeof subject !== 'string') {
    return false
  }

  switch (action) {
    case 'charge':
      return AMOUNT.test(subject) && Number(subject) > 0

    case 'subscription-upgrade':
    case 'subscription-change':
      return TIER.test(subject)

    case 'subscription-resume':
      return subject === 'resume'

    case 'auto-reload': {
      const match = AUTO_RELOAD.exec(subject)

      return match !== null && Number(match[2]) > 0
    }
  }
}

export const BILLING_CHARGE_REFUSED = {
  gesture: BILLING_GESTURE_REFUSED.charge,
  audit: '[billing-charge:audit] the audit is not available, so nothing is charged',
  invalid: '[billing-charge:invalid] not a valid charge request'
} as const

const field = (input: unknown, key: string): unknown =>
  input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined

export function createBillingChargeLock(deps: Omit<BillingChargeLockDeps, 'ipcMain' | 'isTrustedSender'>) {
  const now = deps.now ?? Date.now
  const ttlMs = deps.ttlMs ?? BILLING_CONFIRM_TTL_MS
  /** owner confirm → what it authorizes; insertion order = age. */
  const pending = new Map<string, { action: BillingAction; subject: string; idempotencyKey: string; expires: number }>()

  const record = (entry: Parameters<BillingChargeAuditSink>[0]): boolean => {
    try {
      const written = deps.audit?.(entry)

      return written !== null && written !== undefined && written !== false
    } catch {
      return false
    }
  }

  const sweep = (at: number) => {
    for (const [token, entry] of pending) {
      if (entry.expires <= at) {
        pending.delete(token)
      }
    }

    while (pending.size > MAX_PENDING) {
      const oldest = pending.keys().next().value

      if (oldest === undefined) {
        break
      }

      pending.delete(oldest)
    }
  }

  const grant = (
    event: unknown,
    input: unknown,
    action: unknown,
    subject: unknown,
    idempotencyKey: unknown
  ): BillingChargeAuthorization => {
    if (
      !isAction(action) ||
      !validBillingSubject(action, subject) ||
      typeof idempotencyKey !== 'string' ||
      !IDEMPOTENCY_KEY.test(idempotencyKey)
    ) {
      return { ok: false, error: BILLING_CHARGE_REFUSED.invalid }
    }

    if (!deps.audit) {
      return { ok: false, error: BILLING_CHARGE_REFUSED.audit }
    }

    const tool = BILLING_AUDIT_TOOL[action]
    const what = action === 'charge' ? `${tool} $${subject}` : `${tool} ${subject}`

    if (deps.gestureOk(event, input) !== true) {
      record({ kind: 'refuse', reason: `${what}: without the owner's click`, gesture: false, tool })

      return { ok: false, error: BILLING_GESTURE_REFUSED[action] }
    }

    if (!record({ kind: 'use', reason: `${what}: on the owner's click`, gesture: true, tool })) {
      return { ok: false, error: BILLING_CHARGE_REFUSED.audit }
    }

    const at = now()
    const ownerConfirm = randomBytes(32).toString('hex')

    sweep(at)
    pending.set(ownerConfirm, { action, subject, idempotencyKey, expires: at + ttlMs })
    sweep(at)

    return { ok: true, ownerConfirm }
  }

  const spend = (ownerConfirm: unknown, action: unknown, subject: unknown, idempotencyKey: unknown): boolean => {
    if (typeof ownerConfirm !== 'string') {
      return false
    }

    const entry = pending.get(ownerConfirm)

    pending.delete(ownerConfirm)

    return (
      entry !== undefined &&
      entry.expires > now() &&
      entry.action === action &&
      entry.subject === subject &&
      entry.idempotencyKey === idempotencyKey
    )
  }

  return {
    /** `iclone:billing:authorize-charge` — `{ amountUsd, idempotencyKey, gesture }`, inside the owner's click. */
    authorize(event: unknown, input: unknown): BillingChargeAuthorization {
      return grant(event, input, 'charge', field(input, 'amountUsd'), field(input, 'idempotencyKey'))
    },

    /**
     * `iclone:billing:authorize-action` — `{ action, subject, idempotencyKey, gesture }`, inside the owner's click on
     * Upgrade / Change plan / Resume / Turn on auto-reload (or Buy, as `charge`).
     */
    authorizeAction(event: unknown, input: unknown): BillingChargeAuthorization {
      return grant(event, input, field(input, 'action'), field(input, 'subject'), field(input, 'idempotencyKey'))
    },

    /**
     * The runtime's check (single use): true only for a confirm main issued for exactly this amount and key, unexpired.
     * Whatever the answer, the confirm is spent.
     */
    consume(ownerConfirm: unknown, amountUsd: unknown, idempotencyKey: unknown): boolean {
      return spend(ownerConfirm, 'charge', amountUsd, idempotencyKey)
    },

    /** The same check for any billing action: the confirm must name exactly this action, subject and key. */
    consumeAction(ownerConfirm: unknown, action: unknown, subject: unknown, idempotencyKey: unknown): boolean {
      return spend(ownerConfirm, action, subject, idempotencyKey)
    },

    /** Test seam. */
    pendingCount(): number {
      sweep(now())

      return pending.size
    }
  }
}

export type BillingChargeLock = ReturnType<typeof createBillingChargeLock>

/**
 * Registers `iclone:billing:authorize-charge` and `iclone:billing:authorize-action` behind the app's sender guard (no
 * guard = every sender refused).
 */
export function registerBillingChargeLock(deps: BillingChargeLockDeps): BillingChargeLock {
  const lock = createBillingChargeLock(deps)
  const ipc = guardedHandler(deps.ipcMain, deps.isTrustedSender)

  ipc.handle('iclone:billing:authorize-charge', (event, input) => lock.authorize(event, input))
  ipc.handle('iclone:billing:authorize-action', (event, input) => lock.authorizeAction(event, input))

  return lock
}
