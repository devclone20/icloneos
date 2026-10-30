import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { dropRetiredStorageKeys, persistStringArray, RETIRED_STORAGE_KEYS, storedStringArray } from './storage'

describe('string array storage', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('removes the key for an empty array', () => {
    window.localStorage.setItem('test.order', JSON.stringify(['a']))

    persistStringArray('test.order', [])

    expect(window.localStorage.getItem('test.order')).toBeNull()
    expect(storedStringArray('test.order')).toEqual([])
  })

  it('persists non-empty arrays', () => {
    persistStringArray('test.order', ['a', 'b'])

    expect(window.localStorage.getItem('test.order')).toBe(JSON.stringify(['a', 'b']))
    expect(storedStringArray('test.order')).toEqual(['a', 'b'])
  })
})

describe('dropRetiredStorageKeys', () => {
  // Every `hermes.desktop.pet*` key the pre-V3-E tree persisted (git grep at 282eded29f^ and the upstream import
  // 9222469d6c): the overlay pair, the roam, the floating pet's position and the generator's two.
  const PET_KEYS_ONCE_PERSISTED = [
    'hermes.desktop.pet-overlay-active.v1',
    'hermes.desktop.pet-overlay-bounds.v1',
    'hermes.desktop.pet-position.v2',
    'hermes.desktop.pet-roam.v1',
    'hermes.desktop.petgen.provider',
    'hermes.desktop.petgen.remixConfirmed'
  ]

  it('retires every pet key the old code persisted (STAGE tester 1 E-1: pet-position.v2 survived a boot)', () => {
    expect([...RETIRED_STORAGE_KEYS].sort()).toEqual([...PET_KEYS_ONCE_PERSISTED].sort())
  })

  it('removes the keys of the retired pet features and leaves every other key alone', () => {
    window.localStorage.setItem('hermes.desktop.pet-overlay-active.v1', '1')
    window.localStorage.setItem('hermes.desktop.pet-overlay-bounds.v1', '{"x":1}')
    window.localStorage.setItem('hermes.desktop.pet-position.v2', '{"x":12,"y":34}')
    window.localStorage.setItem('hermes.desktop.pet-roam.v1', 'true')
    window.localStorage.setItem('hermes.desktop.petgen.provider', 'openai')
    window.localStorage.setItem('hermes.desktop.petgen.remixConfirmed', 'true')
    window.localStorage.setItem('hermes.desktop.keep.v1', 'kept')

    dropRetiredStorageKeys()

    expect(PET_KEYS_ONCE_PERSISTED.map(key => window.localStorage.getItem(key))).toEqual(
      PET_KEYS_ONCE_PERSISTED.map(() => null)
    )
    expect(Object.keys(window.localStorage).filter(key => /pet/.test(key))).toEqual([])
    expect(window.localStorage.getItem('hermes.desktop.keep.v1')).toBe('kept')
    window.localStorage.removeItem('hermes.desktop.keep.v1')
  })
})

// K42 (V3-E N2): main.tsx calls dropRetiredStorageKeys at module top in every window, so storage that is there but
// refuses (quota, private mode) or is not there at all (a sandboxed context whose getter throws) must not break boot.
describe('dropRetiredStorageKeys when storage is unavailable', () => {
  const original = Object.getOwnPropertyDescriptor(window, 'localStorage')

  afterEach(() => {
    if (original) {
      Object.defineProperty(window, 'localStorage', original)
    }
  })

  it('reads that find every key and removals that throw do not throw; each key is still tried', () => {
    const removals: string[] = []

    const refusing = {
      getItem: () => '1',
      removeItem: (key: string) => {
        removals.push(key)

        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      },
      setItem: () => {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      }
    }

    Object.defineProperty(window, 'localStorage', { configurable: true, value: refusing })

    expect(() => dropRetiredStorageKeys()).not.toThrow()
    expect(removals).toEqual([...RETIRED_STORAGE_KEYS])
  })

  it('a localStorage getter that throws reads as absent, and nothing throws', () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new DOMException('Access is denied for this document.', 'SecurityError')
      }
    })

    expect(() => dropRetiredStorageKeys()).not.toThrow()
  })
})
