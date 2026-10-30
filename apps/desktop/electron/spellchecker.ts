import { MAIN_DIALOG_LOCALE, type OfferedLocale, spellCheckerLanguage } from '../src/iclone-shared/offered-locale'

/** The slice of Electron's `Session` the spellchecker needs, so the rule can be exercised without Electron. */
export interface SpellCheckSession {
  availableSpellCheckerLanguages?: readonly string[]
  setSpellCheckerLanguages?: (languages: string[]) => void
}

/**
 * Ruling 69 (owner): seed Chromium's spellchecker with the APP's language, never Chromium's default (the
 * operating system's) — a Portuguese machine would otherwise underline correct English words in red in an
 * English-only app. On Windows and Linux Chromium downloads Hunspell dictionaries on demand and enables none without an
 * explicit language. On macOS Electron uses the native NSSpellChecker, which ignores this list and follows the
 * system's own spelling settings: the app cannot pick the language there. Returns the tag it asked for.
 */
export function configureSpellChecker(
  target: SpellCheckSession | null | undefined,
  onError: (error: unknown) => void,
  locale: OfferedLocale = MAIN_DIALOG_LOCALE
): string | null {
  if (!target || typeof target.setSpellCheckerLanguages !== 'function') {
    return null
  }

  try {
    const chosen = spellCheckerLanguage(target.availableSpellCheckerLanguages ?? [], locale)

    target.setSpellCheckerLanguages([chosen])

    return chosen
  } catch (error) {
    onError(error)

    return null
  }
}
