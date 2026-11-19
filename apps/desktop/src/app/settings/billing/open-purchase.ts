/**
 * v0.0.9 r3 (eng n1, MONEY): the open purchase — one Buy whose answer was lost or unclear, so the portal may already
 * have charged it. It lives HERE, in a module store, not in the Buy row's component state: leaving Billing, closing
 * Settings or retyping the amount unmounts or resets that row, and the old `useRef` intent went with it, so the next Buy
 * minted a new Idempotency-Key and the portal charged a second time.
 *
 * Rules (each pinned in open-purchase.test.ts and charge-retry-lost-answer.test.tsx):
 * - opened by a Buy that got no definite answer (a transport error, a timeout, a retry-class or unknown refusal, a
 *   refused owner confirm): amount + key are kept;
 * - while open, every Buy of that amount reuses its key (the portal collapses it into the first charge); a Buy of ANOTHER
 *   amount is held (nothing is sent) until the owner finishes or checks the open one;
 * - cleared ONLY by a definite answer: the portal accepted the charge (it has an id), or a known refusal that says
 *   nothing was charged. A new key is minted only for a new intent after that;
 * - while open, the Buy row says so wherever it is mounted (r3-n4): coming back to Billing shows the notice again;
 * - it survives a renderer reload (r3-n5): it is kept in this window's sessionStorage, so a crash-and-reload or a window
 *   reload between the lost answer and the next Buy still reuses the key. It dies with the window;
 * - it lapses after OPEN_PURCHASE_TTL_MS (r3-n7). That window is OUR assumption (Stripe-style keys are remembered for
 *   24 h; the portal has published no retention), so a lapsed purchase is never dropped silently: the next Buy is held
 *   once with "check the portal" (nothing sent), and only the Buy after that mints a new key.
 */
import { atom } from 'nanostores'

import { ICLONE_STORAGE } from '@/app/home/lib/storage-keys'

/** Stripe-style keys are remembered for 24 h; stay well inside that (an assumption: see the header). */
export const OPEN_PURCHASE_TTL_MS = 12 * 60 * 60 * 1000

export interface OpenPurchase {
  /** The amount exactly as it was sent with this key (a retry re-sends the same string). */
  readonly amountUsd: string
  readonly idempotencyKey: string
  readonly openedAt: number
}

const STORAGE_KEY = ICLONE_STORAGE.billingOpenPurchase.key

/** A stored record, checked field by field (a hand-edited or foreign value is ignored, never sent). */
export function parseStoredPurchase(raw: null | string): null | OpenPurchase {
  if (!raw) {
    return null
  }

  try {
    const value = JSON.parse(raw) as Partial<Record<keyof OpenPurchase, unknown>>

    if (
      typeof value.amountUsd === 'string' &&
      /^\d{1,7}(\.\d{1,2})?$/.test(value.amountUsd) &&
      typeof value.idempotencyKey === 'string' &&
      /^[A-Za-z0-9-]{8,128}$/.test(value.idempotencyKey) &&
      typeof value.openedAt === 'number' &&
      Number.isFinite(value.openedAt) &&
      value.openedAt > 0
    ) {
      return { amountUsd: value.amountUsd, idempotencyKey: value.idempotencyKey, openedAt: value.openedAt }
    }
  } catch {
    // Not ours: ignored.
  }

  return null
}

function readStored(): null | OpenPurchase {
  try {
    return parseStoredPurchase(window.sessionStorage.getItem(STORAGE_KEY))
  } catch {
    return null
  }
}

function writeStored(open: null | OpenPurchase): void {
  try {
    if (open) {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(open))
    } else {
      window.sessionStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    // Storage denied: the purchase still holds for this renderer's life.
  }
}

export const $openPurchase = atom<null | OpenPurchase>(readStored())

/** An open purchase that outlived the window with no definite answer: the next Buy says "check the portal" once. */
export const $lapsedPurchase = atom<null | OpenPurchase>(null)

$openPurchase.listen(writeStored)

/** The amount as the portal reads it ("10", "10.0" and "10.00" are one purchase). */
export function purchaseAmount(amountUsd: string): string {
  const value = Number.parseFloat(amountUsd)

  return Number.isFinite(value) ? value.toFixed(2) : amountUsd.trim()
}

/** Pure: whether this record is still inside the window at `now`. */
export function isPurchaseLive(open: null | OpenPurchase, now: number = Date.now()): open is OpenPurchase {
  return open !== null && now - open.openedAt < OPEN_PURCHASE_TTL_MS
}

/** The open purchase, or null when none is open. One past the window becomes the lapsed purchase (never silent). */
export function currentOpenPurchase(now: number = Date.now()): null | OpenPurchase {
  const open = $openPurchase.get()

  if (open && !isPurchaseLive(open, now)) {
    $openPurchase.set(null)
    $lapsedPurchase.set(open)

    return null
  }

  return open
}

/** The lapsed purchase, once: the Buy that reads it is held with "check the portal"; the next one is a new purchase. */
export function takeLapsedPurchase(now: number = Date.now()): null | OpenPurchase {
  currentOpenPurchase(now)

  const lapsed = $lapsedPurchase.get()

  $lapsedPurchase.set(null)

  return lapsed
}

/** A Buy got no definite answer: keep (or keep) this purchase open under its key. */
export function openPurchase(amountUsd: string, idempotencyKey: string, now: number = Date.now()): void {
  const open = currentOpenPurchase(now)

  // A retry of the open purchase keeps its first opening time: the window counts from the first send.
  $openPurchase.set({
    amountUsd: open && open.idempotencyKey === idempotencyKey ? open.amountUsd : amountUsd,
    idempotencyKey,
    openedAt: open && open.idempotencyKey === idempotencyKey ? open.openedAt : now
  })
}

/** A definite answer (charged, or refused with nothing charged): the purchase is closed. */
export function closePurchase(idempotencyKey: string): void {
  if ($openPurchase.get()?.idempotencyKey === idempotencyKey) {
    $openPurchase.set(null)
  }
}

/** True when a Buy of `amountUsd` is the open purchase (same amount, however it is written). */
export function isSamePurchase(open: OpenPurchase, amountUsd: string): boolean {
  return purchaseAmount(open.amountUsd) === purchaseAmount(amountUsd)
}

/** Tests only: forget the purchase (memory and this window's storage). */
export function resetOpenPurchaseForTests(): void {
  $openPurchase.set(null)
  $lapsedPurchase.set(null)
}
