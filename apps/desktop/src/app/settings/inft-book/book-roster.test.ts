import { describe, expect, it } from 'vitest'

import type { INftCardData } from '@/app/home/collections'

import { rosterAfterScan, rosterAfterTick } from './book-roster'

const card = (id: string, name = id): INftCardData => ({ id, name, collection: 'c', chain: 'Base', configured: false })
const ids = (cards: INftCardData[]) => cards.map(c => c.id)

describe('rosterAfterScan', () => {
  it('a complete scan replaces; the first scan stands alone either way', () => {
    expect(ids(rosterAfterScan([card('a'), card('b')], [card('b')], true))).toEqual(['b'])
    expect(ids(rosterAfterScan(null, [card('b')], false))).toEqual(['b'])
  })

  it('an incomplete scan keeps unreached cards in place, refreshes reached ones, appends new ones', () => {
    const merged = rosterAfterScan([card('a'), card('b', 'old'), card('c')], [card('b', 'new'), card('d')], false)

    expect(ids(merged)).toEqual(['a', 'b', 'c', 'd'])
    expect(merged[1]?.name).toBe('new')
  })
})

describe('rosterAfterTick', () => {
  it('only a proven gone leaves; unknown and held stay; new page-1 cards append; known ones keep the roster copy', () => {
    const next = rosterAfterTick(
      [card('a'), card('b'), card('c', 'enriched')],
      [card('c', 'raw'), card('x'), card('y')],
      {
        a: 'gone',
        b: 'unknown',
        y: 'gone'
      }
    )

    expect(ids(next)).toEqual(['b', 'c', 'x'])
    expect(next[1]?.name).toBe('enriched')
  })
})
