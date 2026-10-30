/**
 * V3-J — Settings › Economy › Payments in the window's language. The words are the catalogue's `payments` domain, so
 * they travel with K99's locale chunks: English is in the boot bundle, every other locale arrives with its own chunk
 * through the locale loader, and the provider's `t` is the one source of the active language.
 */
import { useI18n } from '@/i18n'
import type { Translations } from '@/i18n/types'
import type { PaymentsTranslations } from '@/i18n/types/payments'

export function usePaymentsCopy(): PaymentsTranslations {
  return useI18n().t.payments
}

/** For the Settings rail, which hands panes the catalogue (`t`) rather than the locale. */
export function paymentsCopyFor(t: Translations): PaymentsTranslations {
  return t.payments
}
