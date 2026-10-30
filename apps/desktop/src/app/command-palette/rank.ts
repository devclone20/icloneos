/**
 * Ranking is ours, in plain functions, so the sheet is pure keyboard/selection
 * machinery over an already-ordered list.
 *
 * AND semantics: every typed word must appear in the label or keywords. The
 * grade rewards matches on the visible label — exact > prefix > whole word >
 * word prefix > substring > scattered terms > keyword-only — so typing "tools"
 * selects the row that says Tools, not a row that hides it in keywords.
 */

import { normalize } from '@/lib/text'

import type { PaletteGroup, PaletteItem } from './types'

const scoreItem = (item: PaletteItem, needle: string): number => {
  const label = item.label.toLowerCase()
  const keys = (item.keywords ?? []).join(' ').toLowerCase()
  const terms = needle.split(/\s+/).filter(Boolean)

  if (terms.some(term => !label.includes(term) && !keys.includes(term))) {
    return 0
  }

  if (label === needle) {
    return 1
  }

  if (label.startsWith(needle)) {
    return 0.9
  }

  const words = label.split(/[^\p{L}\p{N}]+/u).filter(Boolean)

  if (words.includes(needle)) {
    return 0.85
  }

  if (words.some(word => word.startsWith(needle))) {
    return 0.8
  }

  if (label.includes(needle)) {
    return 0.7
  }

  if (terms.every(term => label.includes(term))) {
    return 0.6
  }

  // Matched only via keywords — the weakest, generic-row signal.
  return 0.4
}

/**
 * Order items within each group by score, order groups by their best item, and
 * drop everything that doesn't match. Ties keep their original order (stable
 * sort), so curated group/item ordering still breaks even scores.
 */
export const rankGroups = (groups: PaletteGroup[], search: string): PaletteGroup[] => {
  const needle = normalize(search)

  if (!needle) {
    return groups
  }

  return groups
    .map(group => {
      const scored = group.items
        .map(item => ({ item, score: scoreItem(item, needle) }))
        .filter(entry => entry.score > 0)
        .sort((a, b) => b.score - a.score)

      return { group: { ...group, items: scored.map(entry => entry.item) }, max: scored[0]?.score ?? 0 }
    })
    .filter(entry => entry.max > 0)
    .sort((a, b) => b.max - a.max)
    .map(entry => entry.group)
}

/** Every row of every group, in render order — what the arrow keys walk. */
export const flattenGroups = (groups: PaletteGroup[]): PaletteItem[] => groups.flatMap(group => group.items)

/**
 * The row's DOM id, for `aria-activedescendant`. Position-based on purpose: a
 * command id can carry a path or a branch name, and an id attribute has to be
 * both unique and selector-safe.
 */
export const optionDomId = (index: number): string => `icp-opt-${index}`
