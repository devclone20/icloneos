/**
 * V3-G — the Containers pane's words. A domain catalogue in six files (`src/i18n/<locale>/confinement.ts`, the
 * L7i shape) picked here by the app's active locale, so no shared catalogue file is edited; the window chrome words
 * (close, expand, opacity) are the ones every Dock window already uses.
 */
import { useI18n } from '@/i18n'
import { confinement as ar } from '@/i18n/ar/confinement'
import { type ConfinementCopy, confinement as en } from '@/i18n/en/confinement'
import { confinement as ja } from '@/i18n/ja/confinement'
import { confinement as ptPt } from '@/i18n/pt-PT/confinement'
import type { Locale } from '@/i18n/types'
import { confinement as zhHant } from '@/i18n/zh-hant/confinement'
import { confinement as zh } from '@/i18n/zh/confinement'

export const CONFINEMENT_COPY: Readonly<Record<Locale, ConfinementCopy>> = {
  en,
  zh,
  'zh-hant': zhHant,
  ja,
  ar,
  'pt-PT': ptPt
}

export function useContainersCopy(): ConfinementCopy {
  return CONFINEMENT_COPY[useI18n().locale] ?? en
}
