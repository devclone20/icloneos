/**
 * The active iNFT on the stage — selected from the collection (or the
 * composer pill), cleared with its ✕. Kept tiny and separate: the Dock apps
 * key their per-iNFT CLI scope off `$activeInft`, and the persona switch
 * (inft-profile.ts) is the one door that writes here.
 *
 * The last summoned card id persists (localStorage) so the engine re-presents
 * the owner's CHOSEN iNFT on the next sign-in, not just the first scanned one.
 */
import { atom } from 'nanostores'

import { readKey, writeKey } from '@/lib/storage'

import { publishStage } from './acp-setup'
import { ICLONE_STORAGE } from './lib/storage-keys'

const CHOICE_KEY = ICLONE_STORAGE.stageLastInft.key
/** Stored in place of a card id when the owner chose Hermes over any iNFT. */
export const HERMES_CHOICE = 'hermes'

interface ActiveInft {
  id: string
  name: string
  modelUrl: string
}

export const $activeInft = atom<ActiveInft | null>(null)

export function summonInft(next: ActiveInft) {
  $activeInft.set(next)
  publishStage(next.id)

  writeKey(CHOICE_KEY, next.id)
}

export function dismissInft() {
  $activeInft.set(null)
  publishStage(null)
}

/** Remember that the owner explicitly returned to Hermes. Removing the key
 *  was not enough: the next sign-in read "nothing remembered" and presented
 *  the first iNFT anyway. The stage ✕ (dismissInft) keeps the choice; only a
 *  real deselect records this. */
export function clearInftChoice(): void {
  writeKey(CHOICE_KEY, HERMES_CHOICE)
}

/** The card id the owner last summoned, or null. */
export function recallInftChoice(): string | null {
  return readKey(CHOICE_KEY)
}
