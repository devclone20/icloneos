/** The market data module's `params` section — its public names are re-exported by ../market-data.ts. */
import { readKey, writeJson } from '@/lib/storage'

import { asRecord, type Json } from '../../cli'

import { FEATURED_QUERY, PARAMS_KEY, QUERY_MAX, TOP_K, TOP_K_STEPS } from './constants'
import { BROWSE_MODES, type BrowseParams, DEFAULT_PARAMS, ONLINE_FILTERS, SORT_FIELDS } from './types'

// ── search params ───────────────────────────────────────────────────────────

/** A search box value made safe as the positional argv element: one line,
 *  bounded, and never starting with `-` (the CLI would read it as a flag). */
export function cleanQuery(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^[\s-]+/, '')
    .slice(0, QUERY_MAX)
    .trim()
}

/** A page size the app offers, whatever was stored or passed. */
export function normalizeTopK(value: unknown): number {
  return typeof value === 'number' && TOP_K_STEPS.includes(value) ? value : TOP_K
}

/** The next "Show more" page size, or null at the bridge's ceiling. */
export function nextTopK(topK: number): null | number {
  return TOP_K_STEPS.find(step => step > topK) ?? null
}

/** The featured feed (no typed query) — the one read worth a long TTL. */
export function isFeatured(params: BrowseParams): boolean {
  return !cleanQuery(params.query)
}

export function browseArgv(params: BrowseParams): string[] {
  const argv = [
    'browse',
    cleanQuery(params.query) || FEATURED_QUERY,
    '--top-k',
    String(normalizeTopK(params.topK)),
    '--online',
    params.online,
    '--mode',
    params.mode
  ]

  if (params.sortBy) {
    argv.push('--sort-by', params.sortBy)
  }

  argv.push('--json')

  return argv
}

/** Identity of one view: the argv the CLI cache keys on, plus the chain
 *  filter applied to its answer. */
export function browseKey(params: BrowseParams): string {
  return [...browseArgv(params), `chain=${params.chainId ?? ''}`].join('\u0001')
}

export function filtersDirty(params: BrowseParams): boolean {
  return (
    params.online !== DEFAULT_PARAMS.online ||
    params.mode !== DEFAULT_PARAMS.mode ||
    params.sortBy !== DEFAULT_PARAMS.sortBy ||
    params.chainId !== DEFAULT_PARAMS.chainId
  )
}

/** The same question, whatever page size — "Show more" is not a new search. */
export function sameSearch(a: BrowseParams, b: BrowseParams): boolean {
  return browseKey({ ...a, topK: TOP_K }) === browseKey({ ...b, topK: TOP_K })
}

/** Anything the owner changed — the query, a filter or the page size. */
export function paramsDirty(params: BrowseParams): boolean {
  return browseKey(params) !== browseKey(DEFAULT_PARAMS)
}

const ONLINE_VALUES = new Set<string>(ONLINE_FILTERS)
const MODE_VALUES = new Set<string>(BROWSE_MODES)
const SORT_VALUES = new Set<string>(SORT_FIELDS)

/** Stored params, trusted field by field; anything unknown falls back. */
export function parseParams(raw: null | string): BrowseParams {
  let value: Json | null = null

  try {
    value = asRecord(JSON.parse(raw ?? 'null'))
  } catch {
    value = null
  }

  if (!value) {
    return DEFAULT_PARAMS
  }

  const pick = <T extends string>(key: string, allowed: Set<string>, fallback: T): T => {
    const field = value[key]

    return typeof field === 'string' && allowed.has(field) ? (field as T) : fallback
  }

  const chainId = value.chainId

  return {
    query: typeof value.query === 'string' ? cleanQuery(value.query) : '',
    online: pick('online', ONLINE_VALUES, DEFAULT_PARAMS.online),
    mode: pick('mode', MODE_VALUES, DEFAULT_PARAMS.mode),
    sortBy: pick('sortBy', SORT_VALUES, DEFAULT_PARAMS.sortBy),
    chainId: typeof chainId === 'number' && Number.isSafeInteger(chainId) && chainId > 0 ? chainId : null,
    topK: normalizeTopK(value.topK)
  }
}

export function readParams(slug: string): BrowseParams {
  return parseParams(readKey(PARAMS_KEY + slug))
}

/** The default search is never stored — a Reset leaves nothing behind (null
 *  removes the key). Best-effort: the search itself already ran. */
export function writeParams(slug: string, params: BrowseParams): void {
  writeJson(PARAMS_KEY + slug, paramsDirty(params) ? params : null)
}
