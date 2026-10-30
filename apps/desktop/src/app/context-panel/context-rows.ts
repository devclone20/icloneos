/**
 * Pure view model of the context card. Every number comes from the runtime:
 * the headline is `context_used / context_max / context_percent` verbatim,
 * rows are `session.context_breakdown.categories` in runtime order with their
 * runtime labels, and the bar splits the used share by those rows. Every
 * share in the list (categories and free space) is of the context window, so
 * the column reads on one scale and sums to about 100 %.
 */

import { asFiniteNumber, isRecord } from '@/iclone-shared/guards'
import { compactNumber } from '@/lib/format'
import type { AnalyticsResponse, ContextBreakdown, ContextFileEntry, UsageStats } from '@/types/hermes'

import { CONTEXT_PANEL_COPY } from './context-panel.copy'

/** Swatch palette size (`--ic-ctx-0` … `--ic-ctx-7` in context-panel.css). */
const CONTEXT_SWATCH_COUNT = 8

// Colour follows the category id, never its position, so a row keeps its hue
// when a sibling drops to 0 tokens and the runtime omits it. First seen, first
// slot: the runtime's fixed order makes this stable for the whole app run.
const swatchSlots = new Map<string, number>()

export function swatchSlot(id: string): number {
  let slot = swatchSlots.get(id)

  if (slot === undefined) {
    slot = swatchSlots.size % CONTEXT_SWATCH_COUNT
    swatchSlots.set(id, slot)
  }

  return slot
}

export interface ContextHeadline {
  estimated: boolean
  free: number
  max: number
  percent: number
  used: number
}

interface ContextShare {
  /** Share of the context window (`context_max`), 0–100; null while the window is unknown. */
  share: null | number
  tokens: number
}

interface ContextRow extends ContextShare {
  id: string
  label: string
  slot: number
}

interface ContextSegment {
  id: string
  label: string
  slot: number
  /** Width as a percentage of the whole bar (the context window). */
  width: number
}

interface ContextCardModel {
  estimatedTotal: number
  files: ContextFileEntry[]
  /** The "Free space" row: `context_max − context_used` on the same scale as the rows. */
  free: ContextShare | null
  headline: ContextHeadline | null
  /** Σ row tokens; equals `estimatedTotal` whenever the runtime itemised the context. */
  itemisedTotal: number
  rows: ContextRow[]
  segments: ContextSegment[]
}

const finite = (value: unknown): number | undefined => asFiniteNumber(value ?? undefined)

const windowShare = (tokens: number, headline: ContextHeadline | null): null | number =>
  headline && headline.max > 0 ? (tokens / headline.max) * 100 : null

function isEstimated(source: { context_estimated?: boolean | null; context_source?: null | string }): boolean {
  if (typeof source.context_estimated === 'boolean') {
    return source.context_estimated
  }

  return (
    typeof source.context_source === 'string' &&
    source.context_source !== '' &&
    source.context_source !== 'provider_usage'
  )
}

/**
 * Live ticks (`session.usage`) are the freshest source, so the headline reads
 * them first and falls back to the last breakdown before the first turn.
 */
export function contextHeadline(
  usage: null | Partial<UsageStats> | undefined,
  breakdown: ContextBreakdown | null | undefined
): ContextHeadline | null {
  const usageMax = finite(usage?.context_max)

  const source =
    usage && usageMax && usageMax > 0 ? usage : breakdown && finite(breakdown.context_max) ? breakdown : null

  if (!source) {
    return null
  }

  const max = finite(source.context_max) ?? 0
  const used = finite(source.context_used) ?? 0

  return {
    estimated: isEstimated(source),
    free: Math.max(0, max - used),
    max,
    percent: finite(source.context_percent) ?? 0,
    used
  }
}

function categoriesOf(breakdown: ContextBreakdown | null | undefined) {
  if (!breakdown || !Array.isArray(breakdown.categories)) {
    return []
  }

  return breakdown.categories.filter(
    category => isRecord(category) && typeof category.id === 'string' && (finite(category.tokens) ?? 0) > 0
  )
}

export function buildContextCard(
  usage: null | Partial<UsageStats> | undefined,
  breakdown: ContextBreakdown | null | undefined
): ContextCardModel {
  const headline = contextHeadline(usage, breakdown)
  const categories = categoriesOf(breakdown)
  const itemisedTotal = categories.reduce((sum, category) => sum + (finite(category.tokens) ?? 0), 0)
  const estimatedTotal = finite(breakdown?.estimated_total) ?? itemisedTotal

  const rows: ContextRow[] = categories.map(category => {
    const tokens = finite(category.tokens) ?? 0

    return {
      id: category.id,
      label: typeof category.label === 'string' && category.label ? category.label : category.id,
      share: windowShare(tokens, headline),
      slot: swatchSlot(category.id),
      tokens
    }
  })

  // The used share of the window, split by each category's share of the
  // itemised total: the bar never overflows when the provider-measured
  // `context_used` differs from the local per-category estimate.
  const usedFraction = headline && headline.max > 0 ? Math.min(1, Math.max(0, headline.used / headline.max)) : 0

  const segments: ContextSegment[] = rows.map(row => ({
    id: row.id,
    label: row.label,
    slot: row.slot,
    width: itemisedTotal > 0 ? (row.tokens / itemisedTotal) * usedFraction * 100 : 0
  }))

  return {
    estimatedTotal,
    files: Array.isArray(breakdown?.context_files) ? breakdown.context_files.filter(isRecord) : [],
    free: headline ? { share: windowShare(headline.free, headline), tokens: headline.free } : null,
    headline,
    itemisedTotal,
    rows,
    segments
  }
}

/** `781.1k`, `1M`; estimated values carry a leading `~`. */
export function formatTokens(value: number, estimated = false): string {
  return `${estimated ? '~' : ''}${compactNumber(value)}`
}

export function formatShare(share: null | number): string {
  if (share === null) {
    return ''
  }

  if (share > 0 && share < 1) {
    return '<1%'
  }

  return `${Math.round(share)}%`
}

export interface SpendRow {
  key: string
  label: string
  value: number
}

type SpendKey = keyof typeof CONTEXT_PANEL_COPY.spend

const SESSION_SPEND_FIELDS = [
  'input',
  'output',
  'reasoning',
  'cache_read',
  'cache_write',
  'calls',
  'compressions'
] as const

const TODAY_SPEND_FIELDS = [
  'input_tokens',
  'output_tokens',
  'reasoning_tokens',
  'cache_read_tokens',
  'api_calls',
  'sessions'
] as const

const spendRow = (key: SpendKey, value: number): SpendRow => ({ key, label: CONTEXT_PANEL_COPY.spend[key], value })

/** Session spend rows: only the fields the runtime actually reported. */
export function sessionSpendRows(usage: null | Partial<UsageStats> | undefined): SpendRow[] {
  if (!usage) {
    return []
  }

  return SESSION_SPEND_FIELDS.flatMap(key => {
    const value = finite(usage[key])

    return value === undefined ? [] : [spendRow(key, value)]
  })
}

/** The analytics `day` key is the UTC date of the session start. */
export function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10)
}

interface TodaySpend {
  rows: SpendRow[]
  tasks: SpendRow[]
}

/**
 * Today's row of `/api/analytics/usage?days=1` (a rolling 24 h window, so
 * yesterday may be present too). Null when the runtime reported nothing for
 * today: an absent day is unknown spend, never a row of zeros.
 */
export function todaySpend(analytics: AnalyticsResponse | null | undefined, nowMs: number): TodaySpend | null {
  if (!analytics || !Array.isArray(analytics.daily)) {
    return null
  }

  const day = analytics.daily.find(entry => entry.day === utcDayKey(nowMs))

  const rows = day
    ? TODAY_SPEND_FIELDS.flatMap(key => {
        const value = finite(day[key])

        return value === undefined ? [] : [spendRow(key, value)]
      })
    : []

  const tasks = (Array.isArray(analytics.by_task) ? analytics.by_task : []).flatMap(task => {
    const value = (finite(task.input_tokens) ?? 0) + (finite(task.output_tokens) ?? 0)

    return task.task && value > 0 ? [{ key: `task:${task.task}`, label: task.task, value }] : []
  })

  return rows.length > 0 || tasks.length > 0 ? { rows, tasks } : null
}
