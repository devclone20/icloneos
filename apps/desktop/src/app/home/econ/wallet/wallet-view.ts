/**
 * EconomyOS — Wallet · the owner's view choices (which chain is selected,
 * whether empty balances show), kept per iNFT in local storage. A convenience
 * only: storage may be missing or full, and the wallet renders the same
 * without it.
 */
import { readJson, writeJson } from '@/lib/storage'

import { ICLONE_STORAGE } from '../../lib/storage-keys'

const PREFIX = ICLONE_STORAGE.econWalletView.key

export interface WalletView {
  selectedChain: string | null
  showEmpty: boolean
}

export const DEFAULT_WALLET_VIEW: WalletView = { selectedChain: null, showEmpty: false }

export function readWalletView(slug: string): WalletView {
  const parsed = readJson<Partial<Record<keyof WalletView, unknown>>>(PREFIX + slug)

  if (!parsed) {
    return DEFAULT_WALLET_VIEW
  }

  return {
    selectedChain: typeof parsed.selectedChain === 'string' && parsed.selectedChain ? parsed.selectedChain : null,
    showEmpty: parsed.showEmpty === true
  }
}

/** Best-effort: when storage is full or unavailable the session keeps the choice in state. */
export function writeWalletView(slug: string, view: WalletView): void {
  writeJson(PREFIX + slug, view)
}

/** An empty link renders no `href` at all, never one that reloads the page. */
export function hrefOrUndefined(url: string): string | undefined {
  return url || undefined
}
