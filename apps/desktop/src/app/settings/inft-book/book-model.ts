/**
 * iCLONE OS — the iNFT Book's pure rules (no store, no DOM): which ids are
 * checked, what Home shows, how the Book filters and sorts. Every function
 * returns a new value and never mutates its input, so the store can hand the
 * result straight to an atom.
 */
import type { INftCardData } from '@/app/home/collections'

/** O5: the most iNFTs one Book scan holds (mirrors electron/iclone-inft-book.ts). */
export const BOOK_SCAN_CEILING = 5_000

/**
 * K65: the most pages one Book scan asks for on one chain — ceil(ceiling / 50)
 * plus 10 pages of slack (mirrors `maxPagesFor` in electron/iclone-inft-book.ts).
 * An indexer that keeps naming a next page past this is broken; the scan stops.
 */
export const BOOK_MAX_PAGES_PER_CHAIN = Math.ceil(BOOK_SCAN_CEILING / 50) + 10

/** Checking more than this many at once asks first (select-all on a large filter). */
export const CHECK_ALL_CONFIRM_ABOVE = 24

export type BookStateFilter = 'all' | 'checked' | 'unchecked'

export interface BookFilter {
  query: string
  collection: string
  chain: string
  state: BookStateFilter
}

export const NO_FILTER: BookFilter = { query: '', collection: '', chain: '', state: 'all' }

export function toggle(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter(existing => existing !== id) : [...ids, id]
}

/** Adds every id of `shown` (the filtered set), keeping the order already checked. */
export function checkAll(ids: readonly string[], shown: readonly Pick<INftCardData, 'id'>[]): string[] {
  const have = new Set(ids)

  const added = new Set(shown.map(card => card.id).filter(id => !have.has(id)))

  return [...ids, ...added]
}

/** Removes every id of `shown` (the filtered set). */
export function uncheckAll(ids: readonly string[], shown: readonly Pick<INftCardData, 'id'>[]): string[] {
  const drop = new Set(shown.map(card => card.id))

  return ids.filter(id => !drop.has(id))
}

/** How many of `shown` a select-all would newly check. */
export function newlyChecked(ids: readonly string[], shown: readonly Pick<INftCardData, 'id'>[]): number {
  const have = new Set(ids)

  return shown.reduce((count, card) => (have.has(card.id) ? count : count + 1), 0)
}

/**
 * The Home rule: the roster filtered to the checked ids, roster order kept
 * (Home applies `collectionsOrder` on top). `pinned` ids pass regardless — a
 * proven-lost iNFT carries the ownership guard's mandatory signal, which no
 * display choice may hide.
 */
export function homeCards(
  roster: readonly INftCardData[],
  checked: ReadonlySet<string>,
  pinned: ReadonlySet<string> = new Set()
): INftCardData[] {
  return roster.filter(card => checked.has(card.id) || pinned.has(card.id))
}

/** Drops checked ids no longer in the wallet. Call only after a COMPLETE scan. */
export function pruneChecked(ids: readonly string[], present: ReadonlySet<string>): string[] {
  return ids.filter(id => present.has(id))
}

/**
 * O1 (b), the first run after the upgrade: Home keeps what the owner already
 * uses — every configured iNFT plus the last one summoned — and nothing else.
 */
export function seedSelection(
  roster: readonly INftCardData[],
  configured: (card: INftCardData) => boolean,
  lastSummoned: null | string
): string[] {
  return roster.filter(card => card.id === lastSummoned || configured(card)).map(card => card.id)
}

const TOKEN_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** O5: the Book groups by collection, then token id in numeric order. */
export function sortBook(cards: readonly INftCardData[]): INftCardData[] {
  return [...cards].sort(
    (a, b) => TOKEN_COLLATOR.compare(a.collection, b.collection) || TOKEN_COLLATOR.compare(a.id, b.id)
  )
}

export function filterBook(
  cards: readonly INftCardData[],
  filter: BookFilter,
  checked: ReadonlySet<string>
): INftCardData[] {
  const query = filter.query.trim().toLowerCase()

  return cards.filter(card => {
    if (filter.collection && card.collection !== filter.collection) {
      return false
    }

    if (filter.chain && card.chain !== filter.chain) {
      return false
    }

    if (filter.state !== 'all' && checked.has(card.id) !== (filter.state === 'checked')) {
      return false
    }

    return !query || card.name.toLowerCase().includes(query) || card.collection.toLowerCase().includes(query)
  })
}

/** The distinct values a filter menu offers, sorted. */
export function facet(cards: readonly INftCardData[], pick: (card: INftCardData) => string): string[] {
  return [...new Set(cards.map(pick))].sort(TOKEN_COLLATOR.compare)
}
