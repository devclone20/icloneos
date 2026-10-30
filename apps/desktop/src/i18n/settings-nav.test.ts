import { describe, expect, test } from 'vitest'

import { TRANSLATIONS } from './catalog'
import type { Locale } from './types'

/**
 * Every Settings nav row reads in the user's language (STAGE tester 1 L10N-2: "Updates" stayed an English literal
 * in 日本語 while the 35 other rows translated). The type pins the key set; this pins that no row falls back to
 * the English word, bar the proper nouns every locale spells the same.
 */
const PROPER_NOUNS = new Set(['mcp'])
/** Words a locale borrows from English as they are (V3-T: "Gateways" is the pt-PT technical term too). */
const LOANWORDS: Partial<Record<Locale, ReadonlySet<string>>> = { 'pt-PT': new Set(['gateway']) }

const english = TRANSLATIONS.en.settings.nav
const others = (Object.keys(TRANSLATIONS) as Locale[]).filter(locale => locale !== 'en')

describe('settings.nav.* rows', () => {
  test('there is a locale besides English', () => {
    expect(others.length).toBeGreaterThan(0)
  })

  test.each(others)('%s has the identical key set', locale => {
    expect(Object.keys(TRANSLATIONS[locale].settings.nav).sort()).toEqual(Object.keys(english).sort())
  })

  test.each(others)('%s translates every row instead of falling back to English', locale => {
    const local: Record<string, string> = TRANSLATIONS[locale].settings.nav

    const untranslated = Object.entries(english)
      .filter(([key]) => !PROPER_NOUNS.has(key) && !LOANWORDS[locale]?.has(key))
      .filter(([key, word]) => local[key] === word)
      .map(([key]) => key)

    expect(untranslated).toEqual([])
  })

  test('the Updates row is a translated row, not a literal (L10N-2)', () => {
    expect(TRANSLATIONS.ja.settings.nav.updates).toBe('更新')
    expect(TRANSLATIONS.zh.settings.nav.updates).toBe('更新')
    expect(TRANSLATIONS['zh-hant'].settings.nav.updates).toBe('更新')
    expect(TRANSLATIONS.ar.settings.nav.updates).toBe('التحديثات')
    expect(TRANSLATIONS['pt-PT'].settings.nav.updates).toBe('Atualizações')
  })
})
