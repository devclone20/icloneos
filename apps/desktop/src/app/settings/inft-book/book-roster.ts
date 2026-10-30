/**
 * iCLONE OS — how a Home roster scan lands on the roster it replaces (pure;
 * privy-session.ts applies the result).
 *
 * - A COMPLETE full scan (every chain read to its last page) is the wallet:
 *   it replaces the roster.
 * - An incomplete one (a page failed mid-scan, the 5 000 ceiling, an indexer
 *   down and the RPC fallback used) only adds and refreshes: cards it did not
 *   reach stay, so a checked iNFT never drops off Home because page 3 flapped.
 * - The 3-minute refresh (`iclone:inft-scan-tick`) brings page 1 of each chain
 *   (new arrivals, appended) and an ownerOf verdict for the checked ids: only
 *   a proven `gone` leaves; `unknown` keeps the card.
 */
import type { INftCardData } from '@/app/home/collections'

import type { HomeTickResult } from './book-types'

export function rosterAfterScan(
  previous: readonly INftCardData[] | null,
  scanned: readonly INftCardData[],
  complete: boolean
): INftCardData[] {
  if (complete || !previous) {
    return [...scanned]
  }

  const fresh = new Map(scanned.map(card => [card.id, card]))
  const kept = previous.map(card => fresh.get(card.id) ?? card)
  const known = new Set(previous.map(card => card.id))

  return [...kept, ...scanned.filter(card => !known.has(card.id))]
}

export function rosterAfterTick(
  previous: readonly INftCardData[],
  arrivals: readonly INftCardData[],
  owners: HomeTickResult['owners']
): INftCardData[] {
  const known = new Set(previous.map(card => card.id))
  // The roster's own card wins over page 1's: its image may have been re-read on-chain.
  const added = arrivals.filter(card => !known.has(card.id) && owners[card.id] !== 'gone')

  return [...previous.filter(card => owners[card.id] !== 'gone'), ...added]
}
