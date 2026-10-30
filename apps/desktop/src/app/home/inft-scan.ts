import type { INftCardData } from './collections'
import type { InftBootstrap } from './inft-bootstrap'
/**
 * iCLONE OS — renderer-side shapes for the Privy wallet iNFT scan.
 *
 * Mirrors `apps/desktop/electron/iclone-privy.ts`'s `InftScanItem` /
 * `InftScanResult` by hand (main-process types can't be imported into the
 * renderer bundle) and adapts a scan result into the `INftCardData` shape
 * `collections.tsx` already renders — so `home-view.tsx` only ever has to
 * swap `SAMPLE_CARDS` for `$inftRoster` (see `privy-session.ts`), never learn
 * a second card shape.
 */
import { shortAddress } from './lib/format'

interface InftScanItem {
  contract: string
  tokenId: string
  name: string
  image: string
  model: string
  isAgentNft: boolean
  chain: string
  backdrop: string
  bootstrap: InftBootstrap | null
}

export interface InftScanResult {
  ok: boolean
  source: 'indexer' | 'rpc' | 'none'
  agents: InftScanItem[]
  /** Every chain read to its last page (electron/iclone-privy.ts); absent = not known to be complete. */
  complete?: boolean
  /** Not complete only because a chain hit the 5 000 ceiling: the most the app reads, so it may seed O1. */
  capped?: boolean
  error?: string
}

// Friendly collection labels for the contracts electron/iclone-privy.ts
// currently trusts (`isAgentNft`) — cosmetic only; a token from a contract
// this map doesn't know is still an agent iNFT if the scan tagged it so, it
// just falls back to a shortened address instead of a name.
const KNOWN_COLLECTION_LABELS: Record<string, string> = {
  '0x3d9f35e08c41a80155353862f883f2b70119809f': 'CLONE FRAME · ATLAS',
  '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432': 'ERC-8004 · AgentIdentity',
  '0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631': 'icloneOS i01 · Studio Experimentals'
}

function collectionLabel(contract: string): string {
  return KNOWN_COLLECTION_LABELS[contract.toLowerCase()] ?? `iCLONE · ${shortAddress(contract)}`
}

/**
 * Adapt a wallet scan into the collections panel's card list. Two gates let a
 * token through: `isAgentNft` (address-based trust decided once in
 * electron/iclone-privy.ts) — OR a 3D model in the token's own metadata,
 * because the engine's job is to bring whatever performable iNFT the wallet
 * actually holds (an OpenSea-published drop the allowlist doesn't know yet is
 * still the owner's agent; the model bytes go through the sandboxed, capped
 * fetcher either way).
 *
 * `configured` starts false here — `home-view.tsx` overlays the real per-iNFT
 * Virtuals CLI state from `$acpConfigMap` when it renders the cards.
 */
export function toInftCards(result: InftScanResult | null | undefined): INftCardData[] {
  if (!result || !result.ok) {
    return []
  }

  return result.agents
    .filter(a => a.isAgentNft || a.model)
    .map((a): INftCardData => ({
      id: `${a.chain.toLowerCase()}:${a.contract.toLowerCase()}:${a.tokenId}`,
      name: a.name,
      collection: collectionLabel(a.contract),
      chain: a.chain,
      imageUrl: a.image || undefined,
      modelUrl: a.model || undefined,
      backdropColor: a.backdrop || undefined,
      configured: false,
      bootstrap: a.bootstrap ?? null
    }))
}
