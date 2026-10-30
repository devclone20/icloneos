/**
 * EconomyOS — the counts the dock tiles wear: unread mail, spend-requests
 * open, 3DS codes waiting, jobs needing attention. An app (or its prefetch)
 * publishes its own number; the dock reads the map. Keyed by iNFT slug so a
 * switch of iNFT never shows the previous one's counts.
 */
import { atom } from 'nanostores'

import type { EconKind } from './types'

type EconBadges = Partial<Record<EconKind, number>>

export const $econBadges = atom<Record<string, EconBadges>>({})

export function setEconBadge(slug: string, kind: EconKind, count: number): void {
  const all = $econBadges.get()
  const mine = all[slug] ?? {}
  const next = Math.max(0, Math.floor(count))

  if (mine[kind] === next) {
    return
  }

  $econBadges.set({ ...all, [slug]: { ...mine, [kind]: next } })
}

export function clearEconBadges(slug?: string): void {
  if (!slug) {
    $econBadges.set({})

    return
  }

  const all = { ...$econBadges.get() }

  delete all[slug]
  $econBadges.set(all)
}
