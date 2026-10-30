/** V3-I — the Work tab's words in the window's language (i18n domain `acpWork`, one catalogue per locale). */
import { useI18n } from '@/i18n'
import { acpWork as ar } from '@/i18n/ar/acpWork'
import { acpWork as en } from '@/i18n/en/acpWork'
import { acpWork as ja } from '@/i18n/ja/acpWork'
import { acpWork as ptPt } from '@/i18n/pt-PT/acpWork'
import type { Locale } from '@/i18n/types'
import type { AcpWorkTranslations } from '@/i18n/types/acpWork'
import { acpWork as zhHant } from '@/i18n/zh-hant/acpWork'
import { acpWork as zh } from '@/i18n/zh/acpWork'

export const ACP_WORK_COPY: Record<Locale, AcpWorkTranslations> = { en, zh, 'zh-hant': zhHant, ja, ar, 'pt-PT': ptPt }

export function useWorkCopy(): AcpWorkTranslations {
  return ACP_WORK_COPY[useI18n().locale] ?? en
}
