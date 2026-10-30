/**
 * EconomyOS — the contract every Dock app is written against.
 *
 * One iNFT = one Virtuals agent = one isolated `acp` config dir, so every app
 * is scoped by the active iNFT's card id (`inftId`). The window (window.tsx)
 * decides WHETHER an app renders (no iNFT on stage, setup needed, live engine
 * off); an app only ever renders for a configured iNFT and reads real data.
 */

export type EconKind = 'acp' | 'bank' | 'email' | 'hyperliquid' | 'wallet'

/** `acp agent whoami --json`, reduced to what the apps show. */
export interface AgentIdentity {
  id: string
  name: string
  description: string
  imageUrl: string
  walletAddress: string
  solWalletAddress: string
  role: string
  rating: null | number
  createdAt: string
  builderCode: string
}

export interface EconAppProps {
  /** The active iNFT's card id (`chain:contract:tokenId`) — the CLI scope. */
  inftId: string
  /** `slugForInft(inftId)` — the cache/queue key and the config dir name. */
  slug: string
  identity: AgentIdentity | null
  /** Bumped by the window's refresh button; apps re-read when it changes. */
  refreshKey: number
  /** The window fills the screen — apps may widen their layout. */
  expanded: boolean
}
