/**
 * v0.0.9 critic m5: the iNFT ids main has itself seen in the signed-in wallet's scans (the Home roster's full scan
 * and its refresh arrivals). `iclone:acp-run` creates a per-iNFT home (`userData/inft/<slug>/acp`, a scratch dir) for
 * the id it is given; an id that is neither one of these nor an iNFT that already has a home is refused BEFORE any
 * directory is made, so a scripted caller cannot mint one stray home per invented id.
 *
 * Dependency-free (no Electron): iclone-privy.ts notes the scans, main.ts hands `has` to initIcloneAcp.
 */
import { slugForInft } from '../src/iclone-shared/inft-slug'

/** v0.0.9 critic m5: an id the window may run the CLI for — one main's scans returned, or one with a home already. */
export function acpRunInftRefusal(
  inftId: unknown,
  known: (inftId: string) => boolean,
  hasHome: (slug: string) => boolean
): null | string {
  const cleanId = typeof inftId === 'string' ? inftId.trim() : ''

  if (!cleanId) {
    return 'no iNFT given'
  }

  return known(cleanId) || hasHome(slugForInft(cleanId)) ? null : 'unknown iNFT: it is not in this wallet'
}

/** The renderer's card id for a scanned token (src/app/home/inft-scan.ts): `<chain>:<contract>:<tokenId>`, lower case. */
export function inftCardId(item: { chain?: unknown; contract?: unknown; tokenId?: unknown }): null | string {
  const { chain, contract, tokenId } = item

  if (typeof chain !== 'string' || typeof contract !== 'string' || typeof tokenId !== 'string') {
    return null
  }

  if (!chain || !contract || !tokenId) {
    return null
  }

  return `${chain.toLowerCase()}:${contract.toLowerCase()}:${tokenId}`
}

/** Upper bound on remembered ids: a wallet's roster is far smaller; the cap only bounds a pathological indexer. */
export const KNOWN_INFT_IDS_CAP = 10_000

export interface KnownInftIds {
  /** Remember every token of a scan answer (items without a usable id are ignored). */
  note: (items: readonly unknown[] | null | undefined) => void
  has: (inftId: unknown) => boolean
  /** Sign-out: the next wallet starts from its own scans. */
  clear: () => void
}

export function createKnownInftIds(cap = KNOWN_INFT_IDS_CAP): KnownInftIds {
  const ids = new Set<string>()

  return {
    note: items => {
      for (const item of items ?? []) {
        const id = item && typeof item === 'object' ? inftCardId(item as Record<string, unknown>) : null

        if (id && ids.size < cap) {
          ids.add(id)
        }
      }
    },
    has: inftId => typeof inftId === 'string' && ids.has(inftId.trim().toLowerCase()),
    clear: () => ids.clear()
  }
}

/**
 * v0.0.9 r3 (eng n2): notes are scoped to the signed-in wallet. Main scans any well-formed address the app renderer
 * sends, so "a token main has scanned" was not "a token in this wallet": a script in the app window could whitelist
 * another wallet's ids, and a scan that resolved after sign-out noted into the freshly cleared set. A scan is noted
 * only when, as it resolves, the session is signed in to THAT address and no sign-out or wallet switch happened since
 * the scan began.
 */
export interface SessionScopedInftIds extends KnownInftIds {
  /** Main learned the session: signed in to `address`, or signed out (null). */
  session: (address: null | string) => void
  /** A scan of `address` starts now; hand the token back to `noteScan`. */
  begin: (address: string) => ScanToken
  /** Note a scan's items only if it is still the signed-in wallet's scan; true when noted. */
  noteScan: (token: ScanToken, items: readonly unknown[] | null | undefined) => boolean
}

export interface ScanToken {
  readonly address: string
  readonly epoch: number
}

const addressKey = (address: unknown): null | string =>
  typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address.trim()) ? address.trim().toLowerCase() : null

export function createSessionScopedInftIds(cap = KNOWN_INFT_IDS_CAP): SessionScopedInftIds {
  const ids = createKnownInftIds(cap)
  let signedIn: null | string = null
  // Bumped by a sign-out and by a switch to another wallet (never by learning the session after a cold start).
  let epoch = 0
  // v0.0.9 r3-n6: a cold start's scans that RESOLVED before main learned any session, per address, this epoch only.
  // Learning that the session is one of those addresses notes its scan then (the reopened iNFT's acp-run is admitted
  // without waiting for a later scan); any sign-out or switch drops them with the epoch.
  let early = new Map<string, unknown[]>()

  return {
    ...ids,
    clear: () => {
      epoch += 1
      signedIn = null
      early = new Map()
      ids.clear()
    },
    session: address => {
      const next = addressKey(address)

      if (next === signedIn) {
        return
      }

      if (signedIn !== null) {
        // Out, or another wallet: whatever the old wallet's scans noted is not this session's.
        epoch += 1
        ids.clear()
      }

      const pending = signedIn === null && next ? early.get(next) : undefined

      early = new Map()
      signedIn = next

      if (pending) {
        ids.note(pending)
      }
    },
    begin: address => ({ address: addressKey(address) ?? '', epoch }),
    noteScan: (token, items) => {
      if (!token.address || token.epoch !== epoch) {
        return false
      }

      if (token.address !== signedIn) {
        // Before any session is known (a cold start), hold the answer until the session says whose it is.
        if (signedIn === null && early.size < 8) {
          early.set(token.address, [...(early.get(token.address) ?? []), ...(items ?? [])].slice(0, cap))
        }

        return false
      }

      ids.note(items)

      return true
    }
  }
}
