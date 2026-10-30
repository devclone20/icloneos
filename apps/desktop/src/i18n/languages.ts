import { normalize } from '@/lib/text'

import type { Locale } from './types'

export const DEFAULT_LOCALE: Locale = 'en'

const LOCALE_OPTIONS = [
  {
    id: 'en',
    name: 'English',
    englishName: 'English',
    configValue: 'en'
  },
  {
    id: 'zh',
    name: '简体中文',
    englishName: 'Simplified Chinese',
    configValue: 'zh'
  },
  {
    id: 'zh-hant',
    name: '繁體中文',
    englishName: 'Traditional Chinese',
    configValue: 'zh-hant'
  },
  {
    id: 'ja',
    name: '日本語',
    englishName: 'Japanese',
    configValue: 'ja'
  },
  {
    id: 'ar',
    name: 'العربية',
    englishName: 'Arabic',
    configValue: 'ar'
  },
  {
    id: 'pt-PT',
    name: 'Português (Portugal)',
    englishName: 'Portuguese (Portugal)',
    configValue: 'pt-PT'
  }
] as const satisfies readonly { configValue: string; englishName: string; id: Locale; name: string }[]

// Ruling 59: v0.0.3 offers English and Portuguese (Portugal) only. The zh, zh-hant, ja and ar catalogues stay in the
// tree (upstream merges) but are never offered or selected; a saved or system value that resolves to one opens English.
// OWNER, 2026-10-25 (ruling 69, supersedes 61): the app ships in ENGLISH ONLY. pt-PT and every other catalogue stay
// in the tree but are never offered or selected — a saved or system value that resolves to one opens English — and the
// picker disappears while this list has a single entry. Putting a language back is G-31, last, in a future version.
export const OFFERED_LOCALES: readonly Locale[] = ['en']

/** Every catalogue in the tree, offered or not (ruling 59). Catalogue-shape tests iterate this; pickers use OFFERED_LOCALES. */
export const CATALOGUE_LOCALES: readonly Locale[] = LOCALE_OPTIONS.map(locale => locale.id)

export function isOfferedLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (OFFERED_LOCALES as readonly string[]).includes(value)
}

// `name` is the endonym (native name) shown in the picker so users recognize
// their language regardless of the current UI language. No country flags:
// languages are not countries. `englishName` is search-only (not shown) so an
// English speaker can type "japanese"/"traditional" to filter the list.
export const LOCALE_META: Partial<Record<Locale, { name: string; englishName: string }>> = Object.fromEntries(
  LOCALE_OPTIONS.filter(locale => isOfferedLocale(locale.id)).map(locale => [
    locale.id,
    { name: locale.name, englishName: locale.englishName }
  ])
)

const LOCALE_ALIASES: Record<string, Locale> = {
  en: 'en',
  'en-us': 'en',
  en_us: 'en',
  zh: 'zh',
  'zh-cn': 'zh',
  zh_cn: 'zh',
  'zh-hans': 'zh',
  zh_hans: 'zh',
  'zh-hans-cn': 'zh',
  zh_hans_cn: 'zh',
  'zh-tw': 'zh-hant',
  zh_tw: 'zh-hant',
  'zh-hk': 'zh-hant',
  zh_hk: 'zh-hant',
  'zh-mo': 'zh-hant',
  zh_mo: 'zh-hant',
  'zh-hant': 'zh-hant',
  zh_hant: 'zh-hant',
  'zh-hant-tw': 'zh-hant',
  zh_hant_tw: 'zh-hant',
  'zh-hant-hk': 'zh-hant',
  zh_hant_hk: 'zh-hant',
  ja: 'ja',
  'ja-jp': 'ja',
  ja_jp: 'ja',
  ar: 'ar',
  'ar-sa': 'ar',
  ar_sa: 'ar',
  'ar-ae': 'ar',
  ar_ae: 'ar',
  'ar-eg': 'ar',
  ar_eg: 'ar',
  arabic: 'ar',
  العربية: 'ar',
  // Portuguese has one catalogue, European Portuguese. Plain `pt` (the runtime's own catalogue code), and Brazilian or
  // any other regional Portuguese, read it rather than English — the runtime maps `pt-br` to its `pt` catalogue too.
  'pt-pt': 'pt-PT',
  pt_pt: 'pt-PT',
  pt: 'pt-PT',
  'pt-br': 'pt-PT',
  pt_br: 'pt-PT',
  portuguese: 'pt-PT',
  português: 'pt-PT',
  portugues: 'pt-PT'
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && LOCALE_OPTIONS.some(locale => locale.id === value)
}

export function normalizeLocale(value: unknown): Locale {
  if (typeof value !== 'string') {
    return DEFAULT_LOCALE
  }

  const resolved = LOCALE_ALIASES[normalize(value)]

  return resolved !== undefined && isOfferedLocale(resolved) ? resolved : DEFAULT_LOCALE
}

export function isSupportedLocaleValue(value: unknown): boolean {
  const resolved = typeof value === 'string' ? LOCALE_ALIASES[normalize(value)] : undefined

  return resolved !== undefined && isOfferedLocale(resolved)
}

export function localeConfigValue(locale: Locale): string {
  return LOCALE_OPTIONS.find(item => item.id === locale)?.configValue ?? DEFAULT_LOCALE
}
