import { describe, expect, it } from 'vitest'

import {
  catalogueLocaleFor,
  MAIN_DIALOG_LOCALE,
  MAIN_OFFERED_LOCALES,
  offeredLocaleFor,
  spellCheckerLanguage
} from './offered-locale'
import { FUNCTION_COPY, functionCopyFor, raiseConfirmText } from './permission-function-copy'
import { ignoreConfirmCopy } from './permission-ignore-copy'

// Ruling 69 (supersedes 59): the app offers English only, so any tag clamps to English; the Portuguese catalogue stays.
describe('main-process locale: English only (ruling 69)', () => {
  const english = ignoreConfirmCopy('en-US')
  const englishFn = functionCopyFor('en-US')

  it.each(['ja-JP', 'zh-CN', 'zh-TW', 'zh-Hant-HK', 'ar-SA', 'de-DE', ''])('%s reads English', tag => {
    expect(offeredLocaleFor(tag)).toBe('en')
    expect(ignoreConfirmCopy(tag).title).toBe(english.title)
    expect(functionCopyFor(tag)).toBe(FUNCTION_COPY.en)
    expect(functionCopyFor(tag)).toBe(englishFn)
  })

  it.each(['pt-BR', 'pt-PT', 'pt', 'pt_BR', 'PT-pt'])('%s is clamped to English: Portuguese is not offered', tag => {
    expect(MAIN_OFFERED_LOCALES).toEqual(['en'])
    expect(offeredLocaleFor(tag)).toBe('en')
    expect(catalogueLocaleFor(tag)).toBe('pt-PT')
  })

  it('a language that returns (G-31) is reached by offering it, with no other change', () => {
    expect(offeredLocaleFor('pt-BR', ['en', 'pt-PT'])).toBe('pt-PT')
    expect(offeredLocaleFor('ja-JP', ['en', 'pt-PT'])).toBe('en')
  })

  it('the raise dialog text for a hidden OS language is the English text', () => {
    const request = { fn: 'payments', from: 'askAlways', to: 'ignore' } as const

    for (const tag of ['ja-JP', 'zh-CN', 'zh-TW', 'ar-SA']) {
      expect(raiseConfirmText(tag, request), tag).toEqual(raiseConfirmText('en-US', request))
    }
  })

  // Ruling 61: the OS language never picks the dialogs' language; main passes its fixed English locale.
  it('a pt-PT operating system with no saved choice gets English native dialogs', () => {
    expect(MAIN_DIALOG_LOCALE).toBe('en')
    expect(ignoreConfirmCopy(MAIN_DIALOG_LOCALE).title).toBe(ignoreConfirmCopy('en-US').title)
    expect(functionCopyFor(MAIN_DIALOG_LOCALE)).toBe(FUNCTION_COPY.en)
  })

  it('a saved Portuguese choice, once main is handed it, reads pt-PT in both dialogs', () => {
    expect(ignoreConfirmCopy('pt-PT').title).not.toBe(ignoreConfirmCopy('en').title)
    expect(functionCopyFor('pt-PT')).toBe(FUNCTION_COPY['pt-PT'])
  })
})

// Ruling 69 (owner, 2026-10-25, supersedes 61): the app ships in ENGLISH ONLY, so Chromium's spellchecker follows
// the APP's language and never the operating system's — a Portuguese Mac must not underline correct English words
// in red inside an English-only app. G-31: a returning language adds its tags and the choice follows by itself.
describe('the spellchecker speaks the app’s language, not the machine’s (ruling 69)', () => {
  it('an English-only app picks an English dictionary, whatever else the machine offers', () => {
    expect(spellCheckerLanguage(['pt-PT', 'pt-BR', 'en-US', 'en-GB'])).toBe('en-US')
    expect(spellCheckerLanguage(['pt-PT', 'en-GB', 'en'])).toBe('en-GB')
    expect(spellCheckerLanguage(['pt-PT', 'en'])).toBe('en')
    // A Portuguese machine with no English dictionary listed still gets English, never Portuguese.
    expect(spellCheckerLanguage(['pt-PT', 'pt-BR'])).toBe('en-US')
    expect(spellCheckerLanguage([])).toBe('en-US')
  })

  it('the app’s own locale is what is asked for, and a returning language carries its dictionary', () => {
    expect(spellCheckerLanguage(['pt-PT', 'en-US'])).toBe(spellCheckerLanguage(['pt-PT', 'en-US'], MAIN_DIALOG_LOCALE))
    expect(spellCheckerLanguage(['pt-PT', 'en-US'], 'pt-PT')).toBe('pt-PT')
    expect(spellCheckerLanguage(['pt-BR', 'en-US'], 'pt-PT')).toBe('pt-BR')
  })
})
