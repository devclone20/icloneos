import { type Locale, useI18n } from '@/i18n'
import { arConsent } from '@/i18n/ar/consent'
import { type ConsentBank, enConsent } from '@/i18n/en/enConsent'
import { jaConsent } from '@/i18n/ja/consent'
import { ptPtConsent } from '@/i18n/pt-PT/consent'
import { zhHantConsent } from '@/i18n/zh-hant/consent'
import { zhConsent } from '@/i18n/zh/consent'

export type { ConsentBank }

// The sheet's own words in six locales (U2-p2b-01; pt-PT V3-T). The policy text stays
// English and binding; the chrome around it follows the reader's language.
const BANKS: Record<Locale, ConsentBank> = {
  ar: arConsent,
  en: enConsent,
  ja: jaConsent,
  'pt-PT': ptPtConsent,
  zh: zhConsent,
  'zh-hant': zhHantConsent
}

export const consentBankFor = (locale: Locale): ConsentBank => BANKS[locale] ?? enConsent

/** The one predicate for "the chrome is translated": the English bank defers to the policy's own §9 names and
 *  shows no English-is-binding line; every other bank names its rows itself and shows it. */
export const isTranslatedBank = (bank: ConsentBank): boolean => bank !== enConsent

export function useConsentCopy(): ConsentBank {
  return consentBankFor(useI18n().locale)
}
