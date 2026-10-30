/**
 * iCLONE OS — the iNFT Book's thumbnail cache and image-request limiter.
 *
 * CACHE RULE (contract V3-H §2.4):
 *  - key = `chain:contract:tokenId:imageUrl` (the card id already is
 *    `chain:contract:tokenId`), value = how that image ended: decoded ('ok')
 *    or unusable ('broken'). At most THUMB_CACHE_MAX entries, least recently
 *    used out first.
 *  - Rescan invalidates ONLY the ids whose `imageUrl` changed
 *    (`invalidateChanged`); an unchanged image is never fetched again while
 *    its entry lives — the card paints it straight from the decoded copy the
 *    renderer already holds.
 *  - Sign-out and an account switch drop the cache wholesale (`clearThumbs`).
 *
 * The limiter keeps at most MAX_IN_FLIGHT image requests open at once: a
 * card whose image is not cached waits for a slot before its <img> gets a
 * `src`, and gives the slot back on load, on error, or when it unmounts
 * (scrolled out of the virtual window). A fast scroll over 1 000 cards
 * therefore never opens 1 000 sockets to an IPFS gateway.
 */
import type { INftCardData } from '@/app/home/collections'

const THUMB_CACHE_MAX = 200
export const MAX_IN_FLIGHT = 8

export type ThumbOutcome = 'broken' | 'ok'

const cache = new Map<string, ThumbOutcome>()

export function thumbKey(card: Pick<INftCardData, 'id' | 'imageUrl'>): string {
  return `${card.id}:${card.imageUrl ?? ''}`
}

export function readThumb(key: string): ThumbOutcome | undefined {
  const outcome = cache.get(key)

  if (outcome !== undefined) {
    cache.delete(key)
    cache.set(key, outcome)
  }

  return outcome
}

export function rememberThumb(key: string, outcome: ThumbOutcome): void {
  cache.delete(key)
  cache.set(key, outcome)

  while (cache.size > THUMB_CACHE_MAX) {
    const oldest = cache.keys().next().value

    if (oldest === undefined) {
      break
    }

    cache.delete(oldest)
  }
}

export function thumbCacheSize(): number {
  return cache.size
}

/** Rescan: drops the entries of ids whose image URL changed; returns how many ids changed. */
export function invalidateChanged(
  before: ReadonlyMap<string, Pick<INftCardData, 'id' | 'imageUrl'>>,
  after: ReadonlyMap<string, Pick<INftCardData, 'id' | 'imageUrl'>>
): number {
  let changed = 0

  for (const [id, next] of after) {
    const previous = before.get(id)

    if (previous && previous.imageUrl !== next.imageUrl) {
      cache.delete(thumbKey(previous))
      changed += 1
    }
  }

  return changed
}

// ── the in-flight limiter ────────────────────────────────────────────────────

let inFlight = 0
const waiting: Array<() => void> = []

function grantNext(): void {
  while (inFlight < MAX_IN_FLIGHT && waiting.length > 0) {
    const grant = waiting.shift()

    if (grant) {
      inFlight += 1
      grant()
    }
  }
}

/** Asks for one request slot; `onGrant` runs when it is free. Returns the
 *  release: call it once when the request ends (or the card goes away). */
export function requestThumbSlot(onGrant: () => void): () => void {
  let granted = false
  let released = false

  const grant = () => {
    granted = true
    onGrant()
  }

  waiting.push(grant)
  grantNext()

  return () => {
    if (released) {
      return
    }

    released = true

    if (granted) {
      inFlight -= 1
      grantNext()
    } else {
      const at = waiting.indexOf(grant)

      if (at >= 0) {
        waiting.splice(at, 1)
      }
    }
  }
}

export function thumbsInFlight(): number {
  return inFlight
}

export function clearThumbs(): void {
  cache.clear()
}
