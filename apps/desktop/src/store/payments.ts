import { atom } from 'nanostores'

import type {
  PaymentsActionResult,
  PaymentsBridge,
  PaymentsChangeResult,
  PaymentsMandateResult,
  PaymentsMandateTerms,
  PaymentsMandateView,
  PaymentsSettingsView,
  PaymentsStatusView
} from '@/iclone-shared/payments'

/**
 * V3-J — the window's copy of main's payments state for Settings › Economy › Payments. Main decides and folds
 * everything from its files on every read; this store holds the last answer and asks again (every few seconds while
 * the pane is open, and whenever main announces a change). It never computes a total or a verdict itself.
 *
 * The four writes must be called synchronously inside the click handler of a `data-payments-confirm` control: the
 * bridge reads the click lock before anything awaits.
 */
interface PaymentsStore {
  status: 'error' | 'loading' | 'ready' | 'unavailable'
  state: PaymentsStatusView | null
  settings: PaymentsSettingsView | null
  mandates: PaymentsMandateView[]
}

export const $payments = atom<PaymentsStore>({ status: 'loading', state: null, settings: null, mandates: [] })

const POLL_MS = 3_000

function bridge(): PaymentsBridge | undefined {
  return (window as Window & { hermesDesktop?: { payments?: PaymentsBridge } }).hermesDesktop?.payments
}

async function loadPayments(): Promise<void> {
  const door = bridge()

  if (!door) {
    $payments.set({ status: 'unavailable', state: null, settings: null, mandates: [] })

    return
  }

  try {
    const [state, settings, mandates] = await Promise.all([door.status(), door.limits(), door.mandates()])

    $payments.set(
      state && settings ? { status: 'ready', state, settings, mandates } : { ...$payments.get(), status: 'error' }
    )
  } catch {
    $payments.set({ ...$payments.get(), status: 'error' })
  }
}

/** While the pane is open: read now, every few seconds, and on every change main announces. */
export function watchPayments(): () => void {
  const off = bridge()?.onChanged(() => void loadPayments())
  const timer = window.setInterval(() => void loadPayments(), POLL_MS)

  void loadPayments()

  return () => {
    off?.()
    window.clearInterval(timer)
  }
}

const NO_BRIDGE = { ok: false, reason: 'not_ready' } as const

async function after<T>(pending: Promise<T> | undefined, fallback: T): Promise<T> {
  let result: T

  try {
    result = pending ? await pending : fallback
  } catch {
    result = fallback
  }

  void loadPayments()

  return result
}

/** Call inside the click handler. `shown` is what the form was filled against: main refuses if it moved since. */
export function savePaymentSettings(
  shown: PaymentsSettingsView,
  next: PaymentsSettingsView
): Promise<PaymentsChangeResult> {
  return after(bridge()?.setLimits(shown, next), NO_BRIDGE)
}

/** Call inside the click handler. On is immediate; off asks on the permission sheet. */
export function setPaymentsStop(on: boolean): Promise<PaymentsActionResult> {
  return after(bridge()?.stop(on), NO_BRIDGE)
}

/** Call inside the click handler. */
export function revokePaymentMandate(jti: string): Promise<PaymentsActionResult> {
  return after(bridge()?.revoke(jti), NO_BRIDGE)
}

/** Call inside the click handler. Main shows the terms on the permission sheet and signs only after your `once`. */
export function requestPaymentMandate(terms: PaymentsMandateTerms): Promise<PaymentsMandateResult> {
  return after(bridge()?.requestMandate(terms), NO_BRIDGE)
}
