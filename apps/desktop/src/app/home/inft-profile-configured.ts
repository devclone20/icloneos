import type { InftAcpStatus } from './acp-setup'

/** Whether the active iNFT's App may open: the live config-map probe first, the
 *  roster card (rebuilt on every scan, which can be partial) only as fallback,
 *  so a flaky rescan never flips an open App to "not configured". */
export function activeInftConfigured(
  slug: string | undefined,
  configMap: Readonly<Record<string, InftAcpStatus>>,
  card: { configured?: boolean } | undefined
): boolean {
  if (!slug) {
    return false
  }

  return configMap[slug]?.configured ?? card?.configured ?? false
}
