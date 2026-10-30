import { type Locale, useI18n } from '@/i18n'
import { arBillingSettings } from '@/i18n/ar/billingSettings'
import { type BillingSettingsCopy, enBillingSettings } from '@/i18n/en/billingSettings'
import { jaBillingSettings } from '@/i18n/ja/billingSettings'
import { ptPtBillingSettings } from '@/i18n/pt-PT/billingSettings'
import { zhHantBillingSettings } from '@/i18n/zh-hant/billingSettings'
import { zhBillingSettings } from '@/i18n/zh/billingSettings'

export type BillingCopy = BillingSettingsCopy

/** The Billing pane's words per app locale; the view-model and the pane read them through `useBillingCopy`. */
export const BILLING_COPY: Record<Locale, BillingCopy> = {
  ar: arBillingSettings,
  en: enBillingSettings,
  ja: jaBillingSettings,
  'pt-PT': ptPtBillingSettings,
  zh: zhBillingSettings,
  'zh-hant': zhHantBillingSettings
}

export function useBillingCopy(): BillingCopy {
  const { locale } = useI18n()

  return BILLING_COPY[locale] ?? enBillingSettings
}
