/**
 * iCLONE OS — the iNFT Book's state: what the Book scan found (`$bookItems`),
 * how far it got (`$bookScan`), and which iNFTs the owner checked for Home
 * (`$bookChecked`).
 *
 * The checked set is per wallet address (lowercase), all wallets in ONE
 * storage key (`ICLONE_STORAGE.inftBookChecked`), so an account switch is a
 * different entry of the same atom — never a moment where one wallet's set is
 * applied to another. An absent entry means "never chosen": the first scan
 * after the upgrade seeds it once (book-seed.ts), and from then on only the
 * owner (or a complete scan's prune) changes it.
 *
 * This module imports no session or Home store — privy-session.ts imports
 * it, so the reverse edge would be a cycle.
 */
import { atom } from 'nanostores'

import type { INftCardData } from '@/app/home/collections'
import { ICLONE_STORAGE } from '@/app/home/lib/storage-keys'
import { readJson, writeJson } from '@/lib/storage'

import { checkAll, pruneChecked, toggle, uncheckAll } from './book-model'
import type { InftBookCursor } from './book-types'

interface WalletSelection {
  ids: readonly string[]
  /** Set once by the upgrade seed ("we kept N on Home"); cleared by the owner's first change. */
  kept: null | number
}

type Selections = Readonly<Record<string, WalletSelection>>

const CHECKED_KEY = ICLONE_STORAGE.inftBookChecked.key
const ID_MAX = 200
const IDS_MAX = 5_000

function parseSelection(raw: unknown): null | WalletSelection {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }

  const { ids, kept } = raw as { ids?: unknown; kept?: unknown }

  if (!Array.isArray(ids)) {
    return null
  }

  return {
    ids: ids.filter((id): id is string => typeof id === 'string' && id.length <= ID_MAX).slice(0, IDS_MAX),
    kept: typeof kept === 'number' && Number.isInteger(kept) && kept >= 0 ? kept : null
  }
}

function loadSelections(): Selections {
  const stored = readJson<unknown>(CHECKED_KEY)

  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return {}
  }

  const out: Record<string, WalletSelection> = {}

  for (const [wallet, raw] of Object.entries(stored)) {
    const selection = parseSelection(raw)

    if (selection && /^0x[0-9a-f]{40}$/.test(wallet)) {
      out[wallet] = selection
    }
  }

  return out
}

export const $bookChecked = atom<Selections>(loadSelections())

const walletKey = (address: string): string => address.toLowerCase()

export function selectionFor(selections: Selections, address: null | string | undefined): null | WalletSelection {
  return address ? (selections[walletKey(address)] ?? null) : null
}

/** The checked ids for a wallet as a Set; empty when never chosen. */
export function checkedSet(address: null | string | undefined): ReadonlySet<string> {
  return new Set(selectionFor($bookChecked.get(), address)?.ids ?? [])
}

function write(address: string, next: WalletSelection): void {
  const selections = { ...$bookChecked.get(), [walletKey(address)]: next }

  $bookChecked.set(selections)
  writeJson(CHECKED_KEY, selections)
}

function change(address: string, update: (ids: readonly string[]) => string[]): void {
  write(address, { ids: update(selectionFor($bookChecked.get(), address)?.ids ?? []), kept: null })
}

export function toggleBook(address: string, id: string): void {
  change(address, ids => toggle(ids, id))
}

export function checkShown(address: string, shown: readonly Pick<INftCardData, 'id'>[]): void {
  change(address, ids => checkAll(ids, shown))
}

export function uncheckShown(address: string, shown: readonly Pick<INftCardData, 'id'>[]): void {
  change(address, ids => uncheckAll(ids, shown))
}

export function dismissKept(address: string): void {
  const current = selectionFor($bookChecked.get(), address)

  if (current && current.kept !== null) {
    write(address, { ids: current.ids, kept: null })
  }
}

/** Writes the upgrade seed exactly once per wallet; a no-op when a selection exists. */
export function seedOnce(address: string, ids: readonly string[]): void {
  if (!selectionFor($bookChecked.get(), address)) {
    write(address, { ids, kept: ids.length })
  }
}

/** After a COMPLETE scan only: checked ids the wallet no longer holds leave the set. */
export function pruneBook(address: string, present: ReadonlySet<string>): void {
  const current = selectionFor($bookChecked.get(), address)

  if (!current) {
    return
  }

  const ids = pruneChecked(current.ids, present)

  if (ids.length !== current.ids.length) {
    write(address, { ids, kept: current.kept })
  }
}

// ── the Book scan's results ──────────────────────────────────────────────────

type BookScanStatus = 'capped' | 'done' | 'idle' | 'partial' | 'scanning'

interface BookScanState {
  status: BookScanStatus
  /** The wallet these items belong to (lowercase); null before any scan. */
  address: null | string
  /** Where a retry resumes after a failed page. */
  cursor: InftBookCursor | null
  error: null | string
}

export const IDLE_SCAN: BookScanState = { status: 'idle', address: null, cursor: null, error: null }

/** Every iNFT the Book scan found, by id, in arrival order. */
export const $bookItems = atom<ReadonlyMap<string, INftCardData>>(new Map())
export const $bookScan = atom<BookScanState>(IDLE_SCAN)
