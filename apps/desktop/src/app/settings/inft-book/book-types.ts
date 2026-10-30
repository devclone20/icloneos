/**
 * The `iclone:inft-book-scan` bridge shapes, mirrored by hand from
 * electron/iclone-inft-book.ts (main-process types cannot enter the renderer
 * bundle) — the same arrangement `home/inft-scan.ts` has with iclone-privy.ts.
 */
import type { InftScanResult } from '@/app/home/inft-scan'

type InftScanItem = InftScanResult['agents'][number]

export interface InftBookCursor {
  chain: string
  params: Readonly<Record<string, number | string | null>> | null
}

export interface InftBookPage {
  ok: boolean
  items: InftScanItem[]
  cursor: InftBookCursor | null
  done: boolean
  error?: string
}

/** `iclone:inft-scan-tick` — the Home roster's 3-minute refresh (electron/iclone-inft-book.ts `HomeTickResult`). */
export interface HomeTickResult {
  ok: boolean
  /** A scan was already running in main: nothing was read. */
  skipped: boolean
  /** Page 1 of every chain. */
  arrivals: InftScanItem[]
  /** Checked card id → ownerOf verdict; `unknown` keeps the card. */
  owners: Record<string, 'gone' | 'held' | 'unknown'>
  error?: string
}
