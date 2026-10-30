/**
 * iCLONE OS — the iNFT Book's paged wallet scan (renderer driver).
 *
 * Asks main for one page at a time (`iclonePrivy.bookScan`, cursor in →
 * cursor out) and merges each page into `$bookItems` as it lands, so the
 * first cards paint while the rest of the wallet is still being read.
 *
 * - Every scan takes a ticket; a page that lands after a newer scan started,
 *   a sign-out or an account switch is dropped (0 items written).
 * - A page that fails for good (main already retried it 3× with backoff)
 *   leaves the pages before it in place and parks its cursor in `$bookScan`:
 *   "loaded N of ? — retry" resumes from exactly there.
 * - The 5 000 ceiling ends the scan as `capped` (said in the Book), never as
 *   `done`: a capped scan never prunes, but it seeds O1 — it is the most the
 *   app will ever read of that wallet.
 * - Only a COMPLETE scan prunes checked ids the wallet no longer holds; the
 *   Home roster's own ids count as held (its RPC fallback can see agents an
 *   indexer outage hides).
 * - Rescan invalidates the thumbnail cache only for ids whose image changed;
 *   sign-out and account switch clear it wholesale (thumb-cache.ts).
 */
import type { INftCardData } from '@/app/home/collections'
import { toInftCards } from '@/app/home/inft-scan'
import { $ownership, ownershipForId } from '@/app/home/ownership'
import { $inftRoster, $privySession } from '@/app/home/privy-session'

import { BOOK_MAX_PAGES_PER_CHAIN, BOOK_SCAN_CEILING } from './book-model'
import { seedBookSelection } from './book-seed'
import { $bookItems, $bookScan, IDLE_SCAN, pruneBook } from './book-store'
import type { InftBookCursor, InftBookPage } from './book-types'
import { clearThumbs, invalidateChanged } from './thumb-cache'

type BookScanBridge = (address: string, cursor: InftBookCursor | null) => Promise<InftBookPage>

function bookScanBridge(): BookScanBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.hermesDesktop?.iclonePrivy?.bookScan
}

let ticket = 0

function current(mine: number, address: string): boolean {
  return mine === ticket && $privySession.get().address?.toLowerCase() === address
}

function rosterCards(): INftCardData[] {
  // A proven-lost iNFT on the roster is the ownership guard's signal card, not
  // a wallet item: it never enters the Book.
  const ownership = $ownership.get()

  return $inftRoster.get().filter(card => ownershipForId(ownership, card.id)?.state !== 'lost')
}

/** Same chain and same page params: the indexer named the page it just served. */
function sameCursor(a: InftBookCursor | null, b: InftBookCursor | null): boolean {
  if (!a || !b) {
    return a === b
  }

  if (a.chain !== b.chain || !a.params || !b.params) {
    return a.chain === b.chain && a.params === b.params
  }

  const left = a.params
  const right = b.params
  const keys = Object.keys(left)

  return (
    keys.length === Object.keys(right).length &&
    keys.every(key => Object.hasOwn(right, key) && left[key] === right[key])
  )
}

/** K21: a refused sender gets `null` from main, not a page — read it as a failed page, never a TypeError. */
function asPage(raw: unknown, cursor: InftBookCursor | null): InftBookPage {
  if (typeof raw === 'object' && raw !== null && typeof (raw as InftBookPage).ok === 'boolean') {
    const page = raw as InftBookPage

    return Array.isArray(page.items) ? page : { ...page, items: [] }
  }

  return { ok: false, items: [], cursor, done: false, error: 'refused' }
}

async function readPages(
  mine: number,
  address: string,
  from: InftBookCursor | null,
  before: ReadonlyMap<string, INftCardData>
): Promise<void> {
  const bridge = bookScanBridge()

  if (!bridge) {
    $bookScan.set({ status: 'partial', address, cursor: from, error: 'unavailable' })

    return
  }

  let cursor = from
  // K65: pages asked for on the chain being read; a new chain starts at 0.
  let chainPages = 0

  for (;;) {
    if (chainPages >= BOOK_MAX_PAGES_PER_CHAIN) {
      $bookScan.set({ status: 'partial', address, cursor, error: 'page cap' })

      return
    }

    const raw: unknown = await bridge(address, cursor).catch(() => null)

    if (!current(mine, address)) {
      return
    }

    const page = asPage(raw, cursor)

    chainPages += 1

    const merged = new Map($bookItems.get())
    const roster = new Set(rosterCards().map(card => card.id))
    // K71: a card the ceiling turned away means this wallet holds more than the Book read.
    let dropped = false

    for (const card of toInftCards({ ok: true, source: 'indexer', agents: page.items })) {
      if (merged.size >= BOOK_SCAN_CEILING && !merged.has(card.id)) {
        dropped = true

        break
      }

      // The roster's card wins: its image was re-read on-chain, the indexer's may be a stale cache.
      if (!roster.has(card.id)) {
        merged.set(card.id, card)
      }
    }

    if (page.ok || page.items.length > 0) {
      invalidateChanged(before, merged)
      $bookItems.set(merged)
    }

    if (!page.ok) {
      $bookScan.set({ status: 'partial', address, cursor: page.cursor ?? cursor, error: page.error ?? 'page failed' })

      return
    }

    const complete = page.done || !page.cursor

    if (complete || merged.size >= BOOK_SCAN_CEILING) {
      // The ceiling stopped a wallet with more: the Book says it shows the first BOOK_SCAN_CEILING.
      const done = complete && !dropped

      $bookScan.set({ status: done ? 'done' : 'capped', address, cursor: null, error: null })

      if (done) {
        pruneBook(address, new Set([...merged.keys(), ...rosterCards().map(card => card.id)]))
      }

      // O1: a complete Book scan is the whole wallet, and a capped one the most the app reads of it — either may seed.
      await seedBookSelection(address, [...merged.values()])

      return
    }

    // K65: main already refuses a repeated cursor; the renderer does not trust that alone.
    if (sameCursor(page.cursor, cursor)) {
      $bookScan.set({ status: 'partial', address, cursor, error: 'cursor repeated' })

      return
    }

    if (cursor && page.cursor && page.cursor.chain !== cursor.chain) {
      chainPages = 0
    }

    cursor = page.cursor
    $bookScan.set({ status: 'scanning', address, cursor, error: null })
  }
}

/** A fresh scan of the signed-in wallet (the Book opening, or Rescan). */
export function startBookScan(): Promise<void> {
  const address = $privySession.get().address?.toLowerCase()

  if (!address) {
    resetBook()

    return Promise.resolve()
  }

  const mine = ++ticket
  const before = $bookScan.get().address === address ? $bookItems.get() : new Map<string, INftCardData>()

  // The roster is already in hand: the Book shows it at once, and the pages
  // fill in around it.
  $bookItems.set(new Map(rosterCards().map(card => [card.id, card])))
  $bookScan.set({ status: 'scanning', address, cursor: null, error: null })

  return readPages(mine, address, null, before)
}

/** Resumes a stopped scan from the page that failed; the pages before it stay. */
export function retryBookScan(): Promise<void> {
  const state = $bookScan.get()
  const address = $privySession.get().address?.toLowerCase()

  if (state.status !== 'partial' || !address || state.address !== address) {
    return startBookScan()
  }

  const mine = ++ticket

  $bookScan.set({ ...state, status: 'scanning', error: null })

  return readPages(mine, address, state.cursor, $bookItems.get())
}

function resetBook(): void {
  ticket += 1
  $bookItems.set(new Map())
  $bookScan.set(IDLE_SCAN)
  clearThumbs()
}

// Sign-out or a different wallet: the old wallet's pages must not land and its
// thumbnails must not be served to the new one.
let lastAddress = $privySession.get().address?.toLowerCase() ?? null

$privySession.subscribe(session => {
  const address = session.address?.toLowerCase() ?? null

  if (address !== lastAddress) {
    lastAddress = address
    resetBook()
  }
})
