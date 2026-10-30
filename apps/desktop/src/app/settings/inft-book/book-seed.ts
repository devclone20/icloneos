/**
 * iCLONE OS — the iNFT Book's side of the wallet scan (privy-session.ts calls
 * these): the one-time upgrade seed and the "checked only" rule for what the
 * scan may do with the wallet's cards.
 *
 * O1 (b): the first scan after the upgrade keeps on Home every configured
 * iNFT (a Virtuals CLI that is set up, or a record the ownership guard keeps)
 * plus the last one summoned — computed once, written once (`seedOnce`), and
 * the Book says "we kept N on Home".
 *
 * Written once means it must be computed from the whole picture, so the
 * callers pass only the cards of a COMPLETE scan, or one CAPPED at the 5 000
 * ceiling (the Home roster's, or the Book's), and the ownership records are
 * read from main here and now — the store may not have loaded them yet. When
 * main cannot answer, nothing is written and the Home scan's retry
 * (privy-session.ts) tries again.
 */
import { $acpConfigMap, refreshAcpConfigMap } from '@/app/home/acp-setup'
import type { INftCardData } from '@/app/home/collections'
import { $ownership, ownershipForId, type OwnershipView } from '@/app/home/ownership'
import { HERMES_CHOICE, recallInftChoice } from '@/app/home/stage-store'
import { slugForInft } from '@/iclone-shared/inft-slug'

import { seedSelection } from './book-model'
import { $bookChecked, checkedSet, seedOnce, selectionFor } from './book-store'

let setupRead: Promise<void> | null = null

/**
 * One read of the cached Virtuals CLI state (`$acpConfigMap`, a disk read over IPC) at a time: the Book opening and
 * the upgrade seed share it, so opening the Book loads the set-up data once.
 */
export function refreshSetupState(): Promise<void> {
  setupRead ??= refreshAcpConfigMap().finally(() => {
    setupRead = null
  })

  return setupRead
}

/** The guard's records, by slug, as main holds them now; null = main did not answer (no seed this time). */
async function ownershipRecords(): Promise<null | Record<string, OwnershipView>> {
  const guard = typeof window === 'undefined' ? undefined : window.hermesDesktop?.icloneOwnership
  const known = $ownership.get()

  if (!guard) {
    return known
  }

  try {
    const views = await guard.list()

    return { ...known, ...Object.fromEntries(views.map(view => [view.slug, view])) }
  } catch {
    return null
  }
}

/** O1 (b): a card the owner already set up — a configured Virtuals CLI, or a record the ownership guard keeps. */
function configuredBy(
  acp: Readonly<Record<string, { configured?: boolean } | undefined>>,
  ownership: Record<string, OwnershipView>
): (card: INftCardData) => boolean {
  return card => acp[slugForInft(card.id)]?.configured === true || ownershipForId(ownership, card.id) !== null
}

function lastSummoned(): null | string {
  const remembered = recallInftChoice()

  return remembered === HERMES_CHOICE ? null : remembered
}

/**
 * The upgrade seed from a COMPLETE (or capped) scan's cards; a no-op once the wallet has a selection.
 * True when the wallet's seed question is settled (a selection exists, or there was nothing to seed from);
 * false when main could not answer, so the caller tries again.
 */
export async function seedBookSelection(address: string, cards: readonly INftCardData[]): Promise<boolean> {
  if (selectionFor($bookChecked.get(), address) || cards.length === 0) {
    return true
  }

  const [ownership] = await Promise.all([ownershipRecords(), refreshSetupState()])

  if (!ownership) {
    return false
  }

  seedOnce(address, seedSelection(cards, configuredBy($acpConfigMap.get(), ownership), lastSummoned()))

  return true
}

/**
 * Home before the wallet's seed exists (the sign-in scan was incomplete or
 * offline, and its retry has not landed): the O1 (b) set computed from the
 * roster on hand, so an upgrading owner never sees 0 of the iNFTs they set up.
 * Nothing is written; the seed itself still waits for a whole-wallet scan.
 */
export function provisionalHomeIds(
  cards: readonly INftCardData[],
  acp: Readonly<Record<string, { configured?: boolean } | undefined>>,
  ownership: Record<string, OwnershipView>
): Set<string> {
  return new Set(seedSelection(cards, configuredBy(acp, ownership), lastSummoned()))
}

/** The cards the scan may act on for Home: the checked ones, plus the one on stage (O3 keeps it there). */
export function checkedCards(
  address: string,
  cards: readonly INftCardData[],
  activeId: null | string = null
): INftCardData[] {
  const checked = checkedSet(address)

  return cards.filter(card => checked.has(card.id) || card.id === activeId)
}

/** Who sign-in may summon: the checked iNFTs. Before the wallet's first selection exists (the seed waits for a
 *  complete scan), only the last-summoned one — O1 keeps it on Home anyway, so a flapping page never costs the stage. */
export function summonableCards(address: string, cards: readonly INftCardData[]): INftCardData[] {
  if (selectionFor($bookChecked.get(), address)) {
    return checkedCards(address, cards)
  }

  const remembered = recallInftChoice()

  return cards.filter(card => card.id === remembered)
}
