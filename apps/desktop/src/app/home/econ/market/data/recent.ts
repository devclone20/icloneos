/** The market data module's `recent` section — its public names are re-exported by ../market-data.ts. */
import { readKey, writeJson } from '@/lib/storage'

import { asArray, isString } from '../../cli'

import { RECENT_KEY, RECENT_MAX } from './constants'
import { cleanQuery } from './params'

// ── recent searches ─────────────────────────────────────────────────────────

export function parseRecent(raw: null | string): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]')

    return asArray(value).filter(isString).map(cleanQuery).filter(Boolean).slice(0, RECENT_MAX)
  } catch {
    return []
  }
}

export function pushRecent(list: string[], query: string): string[] {
  const clean = cleanQuery(query)

  if (!clean) {
    return list
  }

  return [clean, ...list.filter(item => item.toLowerCase() !== clean.toLowerCase())].slice(0, RECENT_MAX)
}

export function readRecent(slug: string): string[] {
  return parseRecent(readKey(RECENT_KEY + slug))
}

/** Best-effort: recents are a convenience, the search itself already ran. */
export function writeRecent(slug: string, list: string[]): void {
  writeJson(RECENT_KEY + slug, list)
}
