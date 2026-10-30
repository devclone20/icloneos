/**
 * iCLONE OS — the renderer's view of the ownership guard (R9). The main
 * process (electron/iclone-ownership.ts) proves held / unknown / lost; this
 * store only mirrors its records so every surface that names an iNFT can show
 * the mandatory "iNFT Deactivated" signal the moment a loss is proven.
 */
import { atom } from 'nanostores'

import { APP_INTL_LOCALE } from '@/iclone-shared/app-intl-locale'
import { slugForInft } from '@/iclone-shared/inft-slug'

import type { INftCardData } from './collections'

type OwnershipState = 'held' | 'unknown' | 'lost'
export type OwnerChoice = 'delete' | 'archive-local' | 'archive-github' | 'keep' | 'later'

interface OwnershipVerification {
  source: 'indexer' | 'chain' | 'logs'
  ok: boolean
  heldByWallet: boolean | null
  holder: string | null
  block: number | null
  txHash: string | null
  detail: string
  at: number
}

interface OwnershipTransfer {
  txHash: string
  block: number
  from: string
  to: string
  timestamp: number
  explorerUrl: string
}

export interface OwnershipView {
  slug: string
  inftId: string
  tokenId: string
  chain: string
  contract: string
  name: string
  image: string | null
  profileSlug: string
  state: OwnershipState
  pending: boolean
  checkedAt: number | null
  provenAt: number | null
  deadlineAt: number | null
  daysLeft: number | null
  deactivated: boolean
  deactivationComplete?: boolean
  pendingSteps?: DeactivationStepName[]
  transfer: OwnershipTransfer | null
  verifications: OwnershipVerification[]
  choice: { kind: OwnerChoice; at: number; archive: string | null } | null
  presale: { at: number; archive: string | null; detachedAt?: number | null } | null
  deactivation: {
    appliedAt: number
    by: 'owner' | 'timer'
    steps: { step: string; ok: boolean; detail: string }[]
    complete?: boolean
    attempts?: number
    firstAt?: number
  } | null
  history: { at: number; state: OwnershipState; note: string }[]
  /** The agent's Virtuals name before the door renamed it — offered back on return. */
  originalAgentName?: string | null
  /** Loss cycles closed by a return of the token. */
  pastCycles?: number
  supportUrl: string
}

interface OwnershipBridgeItem {
  id: string
  chain: string
  contract: string
  tokenId: string
  name: string
  image: string | null
  configured: boolean
}

export const DEACTIVATED_LABEL = 'iNFT Deactivated'

type DeactivationStepName = 'onchain' | 'virtuals' | 'prompt'

const STEP_LABEL: Record<DeactivationStepName, string> = {
  onchain: 'on-chain agentStatus',
  virtuals: 'Virtuals agent name',
  prompt: 'agent prompt'
}

/** slug → the main process's latest record. */
export const $ownership = atom<Record<string, OwnershipView>>({})

function bridge() {
  return typeof window === 'undefined' ? undefined : window.hermesDesktop?.icloneOwnership
}

export function applyViews(views: OwnershipView[]): void {
  if (views.length === 0) {
    return
  }

  const next = { ...$ownership.get() }

  for (const v of views) {
    next[v.slug] = v
  }

  $ownership.set(next)
}

export function ownershipForId(
  map: Record<string, OwnershipView>,
  inftId: string | null | undefined
): OwnershipView | null {
  return inftId ? (map[slugForInft(inftId)] ?? null) : null
}

export function isDeactivated(view: OwnershipView | null | undefined): boolean {
  return view?.state === 'lost'
}

/** "automatic deactivation in N days" — or what already happened. */
export function deactivationCountdown(view: OwnershipView): string {
  if (view.deactivation) {
    const pending = view.pendingSteps ?? []

    if (view.deactivationComplete === true && pending.length === 0) {
      return `Deactivated everywhere on ${new Date(view.deactivation.appliedAt).toLocaleDateString(APP_INTL_LOCALE)}`
    }

    const failed = (pending.length > 0 ? pending : (['virtuals'] as DeactivationStepName[]))
      .map(step => STEP_LABEL[step] ?? step)
      .join(', ')

    return `Deactivation in progress — still pending: ${failed} (retried every hour)`
  }

  if (view.daysLeft === null) {
    return ''
  }

  return view.daysLeft <= 0
    ? 'Automatic deactivation is due now'
    : `Automatic deactivation in ${view.daysLeft} day${view.daysLeft === 1 ? '' : 's'}`
}

export function shortAddress(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a
}

/** Lost iNFTs are gone from the wallet scan — they stay visible as cards so
 *  the signal is never hidden. No model: the 3D body belongs to the new holder. */
export function withDeactivatedCards(cards: INftCardData[], map: Record<string, OwnershipView>): INftCardData[] {
  const present = new Set(cards.map(c => slugForInft(c.id)))

  const ghosts = Object.values(map)
    .filter(v => v.state === 'lost' && !present.has(v.slug))
    .map((v): INftCardData => ({
      id: v.inftId,
      name: v.name,
      collection: `#${v.tokenId}`,
      chain: v.chain,
      imageUrl: v.image ?? undefined,
      configured: false,
      bootstrap: null
    }))

  return ghosts.length ? [...cards, ...ghosts] : cards
}

export function bridgeItems(cards: INftCardData[]): OwnershipBridgeItem[] {
  return cards.flatMap(card => {
    const [chain, contract, tokenId] = card.id.split(':')

    if (!chain || !contract || !tokenId) {
      return []
    }

    return [
      {
        id: card.id,
        chain: card.chain,
        contract,
        tokenId,
        name: card.name,
        image: card.imageUrl ?? null,
        configured: card.configured
      }
    ]
  })
}

/** After every wallet scan. Never throws; a failure leaves the store as is. */
export async function observeOwnership(wallet: string, cards: INftCardData[]): Promise<void> {
  const b = bridge()

  if (!b) {
    return
  }

  try {
    applyViews(await b.observe(wallet, bridgeItems(cards)))
  } catch {
    // the guard retries on the next scan
  }
}

let unsubscribe: (() => void) | null = null

/** Loads the records once and follows the main process's pushes. */
export function startOwnershipSync(): void {
  const b = bridge()

  if (!b || unsubscribe) {
    return
  }

  unsubscribe = b.onChanged(view => applyViews([view]))
  void b
    .list()
    .then(applyViews)
    .catch(() => undefined)
}
