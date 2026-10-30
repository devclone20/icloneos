import { describe, expect, it, vi } from 'vitest'

import { configureSpellChecker, type SpellCheckSession } from './spellchecker'

function fakeSession(available: readonly string[]) {
  const setSpellCheckerLanguages = vi.fn<(languages: string[]) => void>()
  const target: SpellCheckSession = { availableSpellCheckerLanguages: available, setSpellCheckerLanguages }

  return { setSpellCheckerLanguages, target }
}

// Ruling 69: the spellchecker follows the app's English, not the machine's language.
describe('configureSpellChecker (ruling 69)', () => {
  it('asks a Portuguese machine’s session for an English dictionary', () => {
    const { setSpellCheckerLanguages, target } = fakeSession(['pt-PT', 'pt-BR', 'en-US', 'en-GB'])

    expect(configureSpellChecker(target, () => undefined)).toBe('en-US')
    expect(setSpellCheckerLanguages).toHaveBeenCalledExactlyOnceWith(['en-US'])
  })

  it('falls back to en-US when the session lists no English dictionary', () => {
    const { setSpellCheckerLanguages, target } = fakeSession(['pt-PT'])

    configureSpellChecker(target, () => undefined)

    expect(setSpellCheckerLanguages).toHaveBeenCalledExactlyOnceWith(['en-US'])
  })

  it('reports a failing session instead of throwing, and skips a session without the API', () => {
    const onError = vi.fn()
    const boom = new Error('no dictionaries')

    const target: SpellCheckSession = {
      availableSpellCheckerLanguages: ['en-US'],
      setSpellCheckerLanguages: () => {
        throw boom
      }
    }

    expect(configureSpellChecker(target, onError)).toBeNull()
    expect(onError).toHaveBeenCalledExactlyOnceWith(boom)
    expect(configureSpellChecker({}, onError)).toBeNull()
    expect(configureSpellChecker(undefined, onError)).toBeNull()
  })
})
