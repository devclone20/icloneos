import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { clearSnapshot, readSnapshot, SNAPSHOT_MAX_BYTES, writeSnapshot } from './snapshot'

const SLUG = 'robinhood-0x4dfb-6'

const realStorage = window.localStorage

/** Swap in a storage that refuses the next `count` writes, as a full quota does. */
function refuseWrites(count: number): void {
  let left = count

  const full: Storage = {
    get length() {
      return realStorage.length
    },
    key: index => realStorage.key(index),
    getItem: key => realStorage.getItem(key),
    setItem: (key, value) => {
      if (left > 0) {
        left -= 1

        throw new DOMException('full', 'QuotaExceededError')
      }

      realStorage.setItem(key, value)
    },
    removeItem: key => realStorage.removeItem(key),
    clear: () => realStorage.clear()
  }

  Object.defineProperty(window, 'localStorage', { value: full, configurable: true, writable: true })
}

describe('econ snapshots', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(() => {
    Object.defineProperty(window, 'localStorage', { value: realStorage, configurable: true, writable: true })
  })

  it('round-trips the shaped state with its timestamp', () => {
    writeSnapshot('email', SLUG, 1, { unread: 7, rows: [{ id: 'a' }] }, 1_700_000_000_000)

    expect(readSnapshot('email', SLUG, 1)).toEqual({ data: { unread: 7, rows: [{ id: 'a' }] }, at: 1_700_000_000_000 })
  })

  it('ignores another schema version instead of misreading it', () => {
    writeSnapshot('wallet', SLUG, 1, { total: 1 }, 1)

    expect(readSnapshot('wallet', SLUG, 2)).toBeNull()
  })

  it('keeps iNFTs and apps apart', () => {
    writeSnapshot('bank', SLUG, 1, { kind: 'ready' }, 1)
    writeSnapshot('bank', 'other-slug', 1, { kind: 'none' }, 2)

    expect(readSnapshot('bank', SLUG, 1)?.data).toEqual({ kind: 'ready' })
    expect(readSnapshot('bank', 'other-slug', 1)?.data).toEqual({ kind: 'none' })
    expect(readSnapshot('email', SLUG, 1)).toBeNull()
  })

  it('refuses to write past the size cap', () => {
    writeSnapshot('acp', SLUG, 1, { blob: 'x'.repeat(SNAPSHOT_MAX_BYTES) }, 1)

    expect(readSnapshot('acp', SLUG, 1)).toBeNull()
  })

  it('survives corrupt storage', () => {
    window.localStorage.setItem(`iclone.econ.snap.${SLUG}.hyperliquid`, '{not json')

    expect(readSnapshot('hyperliquid', SLUG, 1)).toBeNull()
  })

  it('clears one snapshot without touching the others', () => {
    writeSnapshot('email', SLUG, 1, { a: 1 }, 1)
    writeSnapshot('wallet', SLUG, 1, { b: 2 }, 1)
    clearSnapshot('email', SLUG)

    expect(readSnapshot('email', SLUG, 1)).toBeNull()
    expect(readSnapshot('wallet', SLUG, 1)?.data).toEqual({ b: 2 })
  })

  it('makes room once by evicting the other econ snapshots when the quota is full', () => {
    writeSnapshot('wallet', 'other-slug', 1, { b: 2 }, 1)
    window.localStorage.setItem('unrelated.key', 'kept')

    refuseWrites(1)
    writeSnapshot('email', SLUG, 1, { a: 1 }, 2)

    expect(readSnapshot('email', SLUG, 1)).toEqual({ data: { a: 1 }, at: 2 })
    expect(readSnapshot('wallet', 'other-slug', 1)).toBeNull()
    expect(window.localStorage.getItem('unrelated.key')).toBe('kept')
  })

  it('gives up quietly when even eviction leaves no room', () => {
    writeSnapshot('wallet', 'other-slug', 1, { b: 2 }, 1)
    refuseWrites(2)

    expect(() => writeSnapshot('email', SLUG, 1, { a: 1 }, 2)).not.toThrow()
    expect(readSnapshot('email', SLUG, 1)).toBeNull()
    expect(readSnapshot('wallet', 'other-slug', 1)).toBeNull()
  })
})
