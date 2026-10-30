import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { INftCardData } from '@/app/home/collections'

import {
  clearThumbs,
  invalidateChanged,
  MAX_IN_FLIGHT,
  readThumb,
  rememberThumb,
  requestThumbSlot,
  thumbCacheSize,
  thumbKey,
  thumbsInFlight
} from './thumb-cache'

type Thumbed = Pick<INftCardData, 'id' | 'imageUrl'>

const items = (n: number, url = (i: number) => `https://img/${i}.png`) =>
  new Map<string, Thumbed>(Array.from({ length: n }, (_, i) => [`id${i}`, { id: `id${i}`, imageUrl: url(i) }]))

beforeEach(() => clearThumbs())

describe('thumbnail cache (G7)', () => {
  it('holds at most 200 outcomes, least recently used out first', () => {
    for (let i = 0; i < 250; i++) {
      rememberThumb(`k${i}`, 'ok')
    }

    expect(thumbCacheSize()).toBe(200)
    expect(readThumb('k0')).toBeUndefined()
    expect(readThumb('k249')).toBe('ok')
  })

  it('a rescan with unchanged images invalidates nothing; 3 changed URLs invalidate exactly 3', () => {
    const before = items(100)

    for (const item of before.values()) {
      rememberThumb(thumbKey(item), 'ok')
    }

    expect(invalidateChanged(before, items(100))).toBe(0)
    expect(thumbCacheSize()).toBe(100)

    const after = items(100, i =>
      i === 3 || i === 30 || i === 60 ? `https://img/${i}-v2.png` : `https://img/${i}.png`
    )

    expect(invalidateChanged(before, after)).toBe(3)
    expect(thumbCacheSize()).toBe(97)
    // The 97 untouched cards still hit; the 3 changed ones miss and are fetched again.
    const misses = [...after.values()].filter(item => readThumb(thumbKey(item)) === undefined)

    expect(misses.map(item => item.id)).toEqual(['id3', 'id30', 'id60'])
  })

  it('sign-out / account switch clears it wholesale', () => {
    rememberThumb('a', 'ok')
    clearThumbs()
    expect(thumbCacheSize()).toBe(0)
  })
})

describe('image request limiter (G2: ≤ 8 in flight)', () => {
  it('grants 8, queues the rest, and frees a slot on release or when a waiting card leaves', () => {
    const granted = vi.fn()
    const releases = Array.from({ length: 30 }, (_, i) => requestThumbSlot(() => granted(i)))

    expect(granted).toHaveBeenCalledTimes(MAX_IN_FLIGHT)
    expect(thumbsInFlight()).toBe(8)

    // A queued card scrolled away never gets a slot.
    releases[8]?.()
    releases[0]?.()
    expect(granted).toHaveBeenLastCalledWith(9)
    expect(thumbsInFlight()).toBe(8)

    // Releasing twice is harmless.
    releases[0]?.()
    expect(thumbsInFlight()).toBe(8)

    releases.forEach(release => release())
    expect(thumbsInFlight()).toBe(0)
  })
})
