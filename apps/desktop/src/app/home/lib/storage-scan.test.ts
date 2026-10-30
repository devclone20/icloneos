import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { storageKeysWithPrefix } from './storage-scan'

function useStorage(storage: () => Pick<Storage, 'key' | 'length'>) {
  vi.spyOn(window, 'localStorage', 'get').mockImplementation(storage as () => Storage)
}

describe('storageKeysWithPrefix', () => {
  beforeEach(() => window.localStorage.clear())

  afterEach(() => {
    vi.restoreAllMocks()
    window.localStorage.clear()
  })

  it('lists only the keys that start with the prefix', () => {
    window.localStorage.setItem('iclone.econ.snapshot.a', '1')
    window.localStorage.setItem('iclone.econ.other', '2')
    window.localStorage.setItem('iclone.econ.snapshot.b', '3')
    window.localStorage.setItem('x.iclone.econ.snapshot.c', '4')

    expect(storageKeysWithPrefix('iclone.econ.snapshot.').sort()).toEqual([
      'iclone.econ.snapshot.a',
      'iclone.econ.snapshot.b'
    ])
  })

  it('returns [] when nothing matches or storage is empty', () => {
    expect(storageKeysWithPrefix('iclone.')).toEqual([])
    window.localStorage.setItem('hermes-desktop-theme-v2', 'dark')
    expect(storageKeysWithPrefix('iclone.')).toEqual([])
  })

  it('returns a copy the caller can remove keys through', () => {
    for (const id of ['a', 'b', 'c', 'd']) {
      window.localStorage.setItem(`p.${id}`, id)
    }

    storageKeysWithPrefix('p.').forEach(key => window.localStorage.removeItem(key))

    expect(window.localStorage.length).toBe(0)
  })

  it('returns [] when reaching storage throws', () => {
    window.localStorage.setItem('p.a', 'a')
    useStorage(() => {
      throw new DOMException('denied', 'SecurityError')
    })

    expect(() => storageKeysWithPrefix('p.')).not.toThrow()
    expect(storageKeysWithPrefix('p.')).toEqual([])
  })

  it('returns [] when there is no window', () => {
    vi.stubGlobal('window', undefined)

    try {
      expect(storageKeysWithPrefix('p.')).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps the keys read before a mid-scan failure', () => {
    const keys = ['p.a', 'q.b', 'p.c']

    useStorage(() => ({
      length: 5,
      key: (index: number) => {
        if (index >= keys.length) {
          throw new DOMException('gone', 'InvalidStateError')
        }

        return keys[index]
      }
    }))

    expect(storageKeysWithPrefix('p.')).toEqual(['p.a', 'p.c'])
  })

  it('skips the null a shrinking storage returns for a vanished index', () => {
    useStorage(() => ({ length: 2, key: (index: number) => (index === 0 ? 'p.a' : null) }))

    expect(storageKeysWithPrefix('p.')).toEqual(['p.a'])
  })
})
