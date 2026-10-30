/** The market data module's `slots` section — its public names are re-exported by ../market-data.ts. */
import { type AcpFailure, type AcpResult, humanizeAcpError } from '../../cli'

import { mergePages } from './offerings'
import { sameSearch } from './params'
import type { BrowsePage, BrowseParams, MarketAgent } from './types'

// ── loading state ───────────────────────────────────────────────────────────

export interface Slot<T> {
  data: null | T
  at: number
  error: AcpFailure | null
  loading: boolean
}

/** Search results remember the search they answer (the box may say more),
 *  and whether the marketplace has more for it. */
export interface BrowseSlot extends Slot<MarketAgent[]> {
  params: BrowseParams | null
  /** The CLI returned fewer than asked: "Show more" would find nothing. */
  exhausted: boolean
  /** Where each "Show more" page begins in `data`: ranking stays within a
   *  page, so the cards on screen keep their places when more arrive. */
  breaks: number[]
}

export function emptySlot<T>(): Slot<T> {
  return { data: null, at: 0, error: null, loading: false }
}

/** A finished read: new data replaces old; a failure keeps the old data. */
export function settle<T>(slot: Slot<T>, result: AcpResult<T>): Slot<T> {
  return result.ok
    ? { data: result.data, at: result.at, error: null, loading: false }
    : { ...slot, error: result, loading: false }
}

/** A finished search. A wider page of the search on screen is merged into
 *  it (`mergePages`); any other answer replaces it; a failure keeps it. */
export function settleBrowse(slot: BrowseSlot, result: AcpResult<BrowsePage>, params: BrowseParams): BrowseSlot {
  if (!result.ok) {
    return { ...slot, error: result, loading: false }
  }

  const { agents, returned } = result.data
  const settled = { at: result.at, error: null, loading: false, params, exhausted: returned < params.topK }
  const shown = slot.data

  if (shown && slot.params && sameSearch(slot.params, params) && params.topK > slot.params.topK) {
    return { ...settled, data: mergePages(shown, agents), breaks: [...slot.breaks, shown.length] }
  }

  return { ...settled, data: agents, breaks: [] }
}

export function failureText(failure: AcpFailure): string {
  // The CLI's raw "Not authenticated." is never shown: the owner signs in again from Setup.
  if (failure.kind === 'reauth-acp') {
    return 'Sign in again — the Virtuals session for this iNFT expired.'
  }

  if (failure.kind === 'reauth') {
    return 'Sign-in required — the Virtuals session for this iNFT expired.'
  }

  if (failure.kind === 'busy') {
    return 'The CLI is busy with another call — it retries on the next refresh.'
  }

  return humanizeAcpError(failure.error)
}
