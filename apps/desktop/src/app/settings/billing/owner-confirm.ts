/**
 * F1-S (v0.0.9) — Buy credits needs the owner's own click. Before the app sends `billing.charge`, main must answer an
 * owner confirm for exactly this amount and idempotency key (electron/gesture-locks-billing.ts). The preload takes the
 * click lock only when this runs synchronously inside the click handler of a control carrying
 * `data-billing-charge-confirm` (Buy, or the outcome's Retry): a script's call, a synthetic `el.click()` or the agent
 * driving the page gets no confirm, and the app then sends no charge at all.
 *
 * No bridge (the web app, a test without one): no confirm, so nothing is charged from here.
 */

/** The app's own refusal kind when main gave no owner confirm (no real click on Buy / Retry): no charge was sent. */
export const OWNER_CONFIRM_REFUSAL = 'owner_confirm'

export type BillingOwnerConfirm = { ok: true; ownerConfirm: string } | { ok: false; error: string }

const TOKEN = /^[0-9a-f]{64}$/

function project(raw: unknown): BillingOwnerConfirm {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null

  if (record?.ok === true && typeof record.ownerConfirm === 'string' && TOKEN.test(record.ownerConfirm)) {
    return { ok: true, ownerConfirm: record.ownerConfirm }
  }

  // A refused sender gets null from main; a refusal carries its own reason.
  return { ok: false, error: typeof record?.error === 'string' ? record.error : 'refused' }
}

/** Call synchronously inside the click of a control carrying `data-billing-charge-confirm` (Resume, Change plan, auto-reload on). */
export function authorizeAction(action: string, subject: string, idempotencyKey: string): Promise<BillingOwnerConfirm> {
  const bridge = typeof window === 'undefined' ? undefined : window.hermesDesktop?.billingCharge

  if (!bridge?.authorizeAction) {
    return Promise.resolve({ ok: false, error: 'unavailable' })
  }

  try {
    return bridge
      .authorizeAction(action, subject, idempotencyKey)
      .then(project, (): BillingOwnerConfirm => ({ ok: false, error: 'transport' }))
  } catch {
    return Promise.resolve({ ok: false, error: 'transport' })
  }
}

/** Call synchronously inside the Buy / Retry click (its first statement may not follow an await). */
export function authorizeCharge(amountUsd: string, idempotencyKey: string): Promise<BillingOwnerConfirm> {
  const bridge = typeof window === 'undefined' ? undefined : window.hermesDesktop?.billingCharge

  if (!bridge) {
    return Promise.resolve({ ok: false, error: 'unavailable' })
  }

  try {
    return bridge
      .authorize(amountUsd, idempotencyKey)
      .then(project, (): BillingOwnerConfirm => ({ ok: false, error: 'transport' }))
  } catch {
    return Promise.resolve({ ok: false, error: 'transport' })
  }
}
