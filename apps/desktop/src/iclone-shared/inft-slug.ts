/**
 * iCLONE OS — iNFT identity slugs, shared by the electron main process and the
 * renderer (plain TS: no DOM or Node imports). Both sides key files, maps and
 * Hermes profiles by these strings, so they must never drift apart.
 */

/** Stable, filesystem-safe identity for an iNFT card id (chain:contract:tokenId). */
export function slugForInft(inftId: string): string {
  return (
    inftId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'default'
  )
}

/** A stable, valid Hermes profile/personality name for an iNFT: `inft-<contract>-<tokenId>`. */
export function profileSlugFor(contract: string, tokenId: string): string {
  const contractShort = contract.replace(/^0x/, '').slice(0, 6).toLowerCase()

  return `inft-${contractShort}-${tokenId}`
}
