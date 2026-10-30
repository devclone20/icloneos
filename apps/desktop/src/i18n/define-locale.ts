import { isRecord } from '@/iclone-shared/guards'

import { en } from './en'
import type { Translations } from './types'

type TranslationOverride<T> = T extends (...args: never[]) => string
  ? T
  : T extends readonly unknown[]
    ? T
    : T extends string
      ? string
      : T extends object
        ? { [K in keyof T]?: TranslationOverride<T[K]> }
        : T

export type TranslationOverrides = TranslationOverride<Translations>

function mergeTranslations<T>(base: T, overrides: TranslationOverride<T> | undefined): T {
  if (!isRecord(base) || !isRecord(overrides)) {
    return (overrides ?? base) as T
  }

  const result: Record<string, unknown> = { ...base }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      continue
    }

    const baseValue = result[key]
    result[key] = isRecord(baseValue) && isRecord(value) ? mergeTranslations(baseValue, value) : value
  }

  return result as T
}

/** Each defined locale's own words, before the English fallback is merged in — what the locale parity gate reads, so a
 *  key that only resolves through the fallback counts as missing rather than as translated. */
const OWN_WORDS = new WeakMap<Translations, TranslationOverrides>()

export function defineLocale(overrides: TranslationOverrides): Translations {
  const merged = mergeTranslations<Translations>(en, overrides)

  OWN_WORDS.set(merged, overrides)

  return merged
}

/** A catalogue's own words: the overrides `defineLocale` was given, or the catalogue itself when it is complete by
 *  construction (English). */
export function ownWords(translations: Translations): TranslationOverrides {
  return OWN_WORDS.get(translations) ?? translations
}
