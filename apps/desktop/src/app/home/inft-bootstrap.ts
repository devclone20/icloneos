/**
 * iCLONE OS — shared iNFT profile shapes (renderer side).
 *
 * Mirrors `electron/iclone-profile.ts`'s types by hand (main-process types
 * can't be imported into the renderer bundle). `InftBootstrap` is the
 * on-chain `agent_bootstrap` block; `ResolvedInftProfile` is what the profile
 * engine resolves from it — one soul per iNFT.
 */

export interface InftBootstrap {
  version: number
  protocol: string
  repo: string
  genesis: string
  soul_sha256: string
  identity_sha256: string
  manifest: string
  byok: boolean
}

export interface ResolvedInftProfile {
  slug: string
  name: string
  soulMd: string
  identity: Record<string, unknown> | null
  source: 'genesis' | 'repo' | 'none'
  identityVerified: boolean
  soulVerified: boolean
  error?: string
}

/** The minimal slice of a scan item the profile engine needs. Both the raw
 *  scan item and a rendered card can feed this. */
export interface InftProfileSource {
  contract: string
  tokenId: string
  name: string
  bootstrap: InftBootstrap | null
}
