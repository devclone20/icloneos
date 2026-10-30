/**
 * The languages main can speak, and the ones the app offers. Ruling 69 (owner): the app ships in English
 * only, so English is the one offered language; the Portuguese (Portugal) words stay in the tree (G-31: a language
 * that returns is a one-line change to `MAIN_OFFERED_LOCALES`, not a new catalogue). Self-contained: main cannot import
 * the renderer's `@/` modules.
 */
export type OfferedLocale = 'en' | 'pt-PT'

/** Ruling 69: what the app offers today. A language returns (G-31) by being added here and to the renderer's set. */
export const MAIN_OFFERED_LOCALES: readonly OfferedLocale[] = ['en']

/**
 * The words a tag would read if every catalogue main carries were offered: every Portuguese tag (pt, pt-BR, pt_PT…)
 * reads pt-PT, anything else English. The permission copy banks key their catalogues by this, so the parity checks
 * keep seeing the Portuguese words; what reaches a user goes through `offeredLocaleFor`.
 */
export function catalogueLocaleFor(tag: string): OfferedLocale {
  const lower = tag.trim().toLowerCase()

  return lower === 'pt' || lower.startsWith('pt-') || lower.startsWith('pt_') ? 'pt-PT' : 'en'
}

/**
 * Any tag clamped to the offered set: its catalogue language when that is offered, English otherwise. With ruling 69
 * that is English for every tag — a Chinese, Japanese, Arabic or Portuguese Mac alike.
 */
export function offeredLocaleFor(tag: string, offered: readonly OfferedLocale[] = MAIN_OFFERED_LOCALES): OfferedLocale {
  const locale = catalogueLocaleFor(tag)

  return offered.includes(locale) ? locale : 'en'
}

/**
 * Ruling 61: English is the default and the priority; the operating system's language never picks the app's language.
 * The app's chosen language is saved by the renderer in the Hermes config, which main does not read, so every native
 * main-process dialog speaks the app's one offered language.
 */
export const MAIN_DIALOG_LOCALE: OfferedLocale = 'en'

/**
 * The dictionary tags Chromium accepts for each language the app can speak, best first. One entry per catalogue
 * locale, so the day a language returns (G-31) the spellchecker follows it without another decision.
 */
const SPELLCHECK_TAGS: Record<OfferedLocale, readonly string[]> = {
  en: ['en-US', 'en-GB', 'en'],
  'pt-PT': ['pt-PT', 'pt-BR', 'pt']
}

/**
 * Ruling 69: the spellchecker follows the APP's language, not the operating system's. `available` is Chromium's
 * `availableSpellCheckerLanguages`; a build that offers none of the app language's tags falls back to `en-US`, the
 * tag Chromium always has.
 */
export function spellCheckerLanguage(available: readonly string[], locale: OfferedLocale = MAIN_DIALOG_LOCALE): string {
  return SPELLCHECK_TAGS[locale].find(tag => available.includes(tag)) ?? 'en-US'
}
