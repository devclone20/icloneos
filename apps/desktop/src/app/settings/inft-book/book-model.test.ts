import { describe, expect, it } from 'vitest'

import type { INftCardData } from '@/app/home/collections'
import { toInftCards } from '@/app/home/inft-scan'

import { fixtureId, fixtureItem } from './book-fixture'
import {
  checkAll,
  facet,
  filterBook,
  homeCards,
  newlyChecked,
  NO_FILTER,
  pruneChecked,
  seedSelection,
  sortBook,
  toggle,
  uncheckAll
} from './book-model'

const wallet: INftCardData[] = toInftCards({
  ok: true,
  source: 'indexer',
  agents: Array.from({ length: 1_000 }, (_, i) => fixtureItem(i))
})

describe('the Home rule (G4): Home lists exactly the k checked of 1 000', () => {
  it.each([0, 1, 24, 200])('k = %i', k => {
    const checked = new Set(Array.from({ length: k }, (_, i) => fixtureId(i * 4)))
    const home = homeCards(wallet, checked)

    expect(home).toHaveLength(k)
    expect(home.every(card => checked.has(card.id))).toBe(true)
    // Roster (scan) order is kept; Home layers collectionsOrder on top.
    expect(home.map(card => card.id)).toEqual(wallet.filter(card => checked.has(card.id)).map(card => card.id))
  })

  it('a proven-lost iNFT stays on Home unchecked (the ownership signal is never hidden)', () => {
    expect(homeCards(wallet, new Set(), new Set([fixtureId(9)])).map(card => card.id)).toEqual([fixtureId(9)])
  })
})

describe('selection', () => {
  it('toggle adds then removes one id and nothing else', () => {
    expect(toggle(['a', 'b'], 'c')).toEqual(['a', 'b', 'c'])
    expect(toggle(['a', 'b', 'c'], 'b')).toEqual(['a', 'c'])
  })

  it('check-all and uncheck-all act on the FILTERED set only', () => {
    const shown = [{ id: 'b' }, { id: 'c' }, { id: 'c' }]

    expect(checkAll(['a', 'b'], shown)).toEqual(['a', 'b', 'c'])
    expect(uncheckAll(['a', 'b', 'c', 'd'], shown)).toEqual(['a', 'd'])
    expect(newlyChecked(['a', 'b'], shown)).toBe(2)
  })

  it('prune keeps only ids still in the wallet', () => {
    expect(pruneChecked(['a', 'gone', 'b'], new Set(['a', 'b']))).toEqual(['a', 'b'])
  })

  it('O1 (b): the upgrade seed is configured + last summoned, nothing else', () => {
    const configured = (card: INftCardData) => card.id === fixtureId(3) || card.id === fixtureId(500)

    expect(seedSelection(wallet, configured, fixtureId(7))).toEqual([fixtureId(3), fixtureId(7), fixtureId(500)])
    expect(seedSelection(wallet, () => false, null)).toEqual([])
  })
})

describe('the Book list', () => {
  it('sorts by collection, then token id numerically', () => {
    const cards = [
      { ...wallet[10]!, collection: 'B' },
      { ...wallet[9]!, collection: 'A' },
      { ...wallet[1]!, collection: 'A' }
    ]

    expect(sortBook(cards).map(card => card.id)).toEqual([fixtureId(1), fixtureId(9), fixtureId(10)])
  })

  it('filters by text, collection, chain and checked state', () => {
    const checked = new Set([fixtureId(0), fixtureId(1)])

    expect(filterBook(wallet, { ...NO_FILTER, query: '#1000' }, checked)).toHaveLength(1)
    expect(filterBook(wallet, { ...NO_FILTER, state: 'checked' }, checked)).toHaveLength(2)
    expect(filterBook(wallet, { ...NO_FILTER, state: 'unchecked' }, checked)).toHaveLength(998)
    expect(filterBook(wallet, { ...NO_FILTER, chain: 'Robinhood' }, checked)).toHaveLength(0)
    expect(facet(wallet, card => card.collection)).toEqual(['CLONE FRAME · ATLAS'])
  })
})
