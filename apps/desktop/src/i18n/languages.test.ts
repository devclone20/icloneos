import { describe, expect, it } from 'vitest'

import {
  CATALOGUE_LOCALES,
  DEFAULT_LOCALE,
  isLocale,
  isOfferedLocale,
  isSupportedLocaleValue,
  LOCALE_META,
  localeConfigValue,
  normalizeLocale,
  OFFERED_LOCALES
} from './languages'

describe('desktop i18n languages', () => {
  // Ruling 69 (owner, 2026-10-25, supersedes 61 and 59's two-language reading): the app ships in ENGLISH ONLY.
  // English and its aliases are the only values that resolve; every other language opens English. Offering one again
  // is G-31, a future version — these rows are the decision, not a regression.
  it('ruling 69: English and its aliases resolve, every other language opens English', () => {
    expect(normalizeLocale('en')).toBe('en')
    expect(normalizeLocale('EN-US')).toBe('en')
    expect(normalizeLocale(' en_us ')).toBe('en')
    expect(isSupportedLocaleValue('en-US')).toBe(true)

    expect(normalizeLocale('pt-PT')).toBe(DEFAULT_LOCALE)
    expect(isSupportedLocaleValue('pt-PT')).toBe(false)
  })

  it('ruling 59: a saved or system zh, zh-hant, ja or ar opens English', () => {
    for (const value of ['zh', 'zh-CN', 'zh-Hans', ' zh_hans_cn ', 'zh-Hant', 'zh-TW', 'zh_HK']) {
      expect(normalizeLocale(value), value).toBe(DEFAULT_LOCALE)
      expect(isSupportedLocaleValue(value), value).toBe(false)
    }

    for (const value of ['ja', 'ja-JP', 'ar', 'AR-SA', ' ar_eg ', 'arabic']) {
      expect(normalizeLocale(value), value).toBe(DEFAULT_LOCALE)
      expect(isSupportedLocaleValue(value), value).toBe(false)
    }
  })

  // Ruling 69: one shipped language, so the picker data holds one entry — and the catalogues stay in the tree.
  it('ruling 69: the picker data holds English alone, while every catalogue stays in the tree', () => {
    expect(Object.keys(LOCALE_META)).toEqual(['en'])
    expect([...OFFERED_LOCALES]).toEqual(['en'])
    expect(isOfferedLocale('en')).toBe(true)
    expect(isOfferedLocale('pt-PT')).toBe(false)
    expect(isOfferedLocale('ja')).toBe(false)
    // Every catalogue in the tree, offered or not: the parity and copy-bank gates iterate this list, so a catalogue
    // that stops being valid still fails even while nothing selects it.
    expect([...CATALOGUE_LOCALES]).toEqual(['en', 'zh', 'zh-hant', 'ja', 'ar', 'pt-PT'])
  })

  // Ruling 69 replaces V3-T's two-language reading: every Portuguese value — the tag, the runtime's own `pt`, a
  // Brazilian tag, the endonym — opens English. The catalogue itself stays, so G-31 can offer it again untouched.
  it('ruling 69: every Portuguese value opens English, and the pt-PT catalogue stays in the tree', () => {
    for (const value of ['pt-PT', 'PT_pt', 'pt', 'pt-BR', ' pt_br ', 'Português']) {
      expect(normalizeLocale(value), value).toBe(DEFAULT_LOCALE)
      expect(isSupportedLocaleValue(value), value).toBe(false)
    }

    expect(isLocale('pt-PT')).toBe(true)
    expect(isLocale('pt')).toBe(false)
    expect(localeConfigValue('pt-PT')).toBe('pt-PT')
  })

  it('falls back to English for empty or unsupported values', () => {
    expect(normalizeLocale(null)).toBe(DEFAULT_LOCALE)
    expect(normalizeLocale('')).toBe(DEFAULT_LOCALE)
    expect(normalizeLocale('de')).toBe(DEFAULT_LOCALE)
  })

  it('distinguishes exact locale ids from supported config aliases', () => {
    expect(isSupportedLocaleValue('en-US')).toBe(true)
    expect(isSupportedLocaleValue('de')).toBe(false)
    expect(isLocale('zh-CN')).toBe(false)
    expect(isLocale('zh')).toBe(true)
    expect(isLocale('zh-hant')).toBe(true)
    expect(isLocale('ja')).toBe(true)
    expect(isLocale('ar')).toBe(true)
  })

  it('returns the persisted config value for supported locales', () => {
    expect(localeConfigValue('en')).toBe('en')
    expect(localeConfigValue('zh')).toBe('zh')
    expect(localeConfigValue('zh-hant')).toBe('zh-hant')
    expect(localeConfigValue('ja')).toBe('ja')
    expect(localeConfigValue('ar')).toBe('ar')
  })
})
