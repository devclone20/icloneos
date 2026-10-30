import { describe, expect, it } from 'vitest'

import type { AnalyticsResponse, ContextBreakdown } from '@/types/hermes'

import {
  buildContextCard,
  contextHeadline,
  formatShare,
  formatTokens,
  sessionSpendRows,
  swatchSlot,
  todaySpend,
  utcDayKey
} from './context-rows'

// Synthetic ids on purpose: the card must not know any category by name.
const breakdown = (over: Partial<ContextBreakdown> = {}): ContextBreakdown => ({
  categories: [
    { color: 'var(--x)', id: 'alpha', label: 'Alpha rows', tokens: 3000 },
    { color: 'var(--x)', id: 'beta', label: 'Beta rows', tokens: 1000 },
    { color: 'var(--x)', id: 'gamma', label: '', tokens: 0 }
  ],
  context_max: 100_000,
  context_percent: 4,
  context_used: 4000,
  estimated_total: 4000,
  model: 'm',
  ...over
})

describe('buildContextCard', () => {
  it('keeps runtime order and labels, drops empty rows, sums to estimated_total', () => {
    const card = buildContextCard(null, breakdown())

    expect(card.rows.map(row => [row.id, row.label, row.tokens])).toEqual([
      ['alpha', 'Alpha rows', 3000],
      ['beta', 'Beta rows', 1000]
    ])
    expect(card.itemisedTotal).toBe(card.estimatedTotal)
  })

  it('puts every share of the list (rows and free space) on the context window, summing to 100 %', () => {
    const card = buildContextCard(null, breakdown())
    const shares = [...card.rows.map(row => row.share ?? 0), card.free?.share ?? 0]

    expect(card.rows.map(row => row.share)).toEqual([3, 1])
    expect(card.free).toEqual({ share: 96, tokens: 96_000 })
    expect(shares.reduce((sum, share) => sum + share, 0)).toBeCloseTo(100, 6)
  })

  it('leaves shares unknown (not 0 %) while the runtime has not reported the window', () => {
    const card = buildContextCard(null, breakdown({ context_max: 0, context_percent: 0, context_used: 0 }))

    expect(card.headline).toBeNull()
    expect(card.free).toBeNull()
    expect(card.rows.map(row => row.share)).toEqual([null, null])
    expect(formatShare(null)).toBe('')
  })

  it('splits only the used share of the bar, even when the provider measured more than the estimate', () => {
    const card = buildContextCard(null, breakdown({ context_percent: 40, context_used: 40_000 }))
    const total = card.segments.reduce((sum, segment) => sum + segment.width, 0)

    expect(total).toBeCloseTo(40, 6)
    expect(card.segments[0]?.width).toBeCloseTo(30, 6)
    expect(card.headline).toMatchObject({ free: 60_000, max: 100_000, percent: 40, used: 40_000 })
  })

  it('renders an unknown category id with its runtime label and a label-less one with its id', () => {
    const card = buildContextCard(
      null,
      breakdown({
        categories: [
          { color: '', id: 'brand_new_kind', label: 'Brand new kind', tokens: 10 },
          { color: '', id: 'nameless', label: '', tokens: 5 }
        ],
        estimated_total: 15
      })
    )

    expect(card.rows.map(row => row.label)).toEqual(['Brand new kind', 'nameless'])
  })

  it('tolerates a breakdown without categories (agent not built yet)', () => {
    const card = buildContextCard(
      null,
      breakdown({ categories: [], context_max: 0, context_percent: 0, context_used: 0, estimated_total: 0 })
    )

    expect(card).toMatchObject({ files: [], headline: null, itemisedTotal: 0, rows: [], segments: [] })
  })

  it('caps the bar at the window when used exceeds max', () => {
    const card = buildContextCard(
      { calls: 1, context_max: 10, context_used: 20, input: 0, output: 0, total: 0 },
      breakdown()
    )

    expect(card.segments.reduce((sum, segment) => sum + segment.width, 0)).toBeCloseTo(100, 6)
    expect(card.headline?.free).toBe(0)
  })

  it('passes context files through', () => {
    const files = [{ est_tokens: 12, label: 'AGENTS.md', loaded: true, path: '/p/AGENTS.md', status: 'loaded' }]

    expect(buildContextCard(null, breakdown({ context_files: files })).files).toEqual(files)
  })
})

describe('contextHeadline', () => {
  it('prefers live usage ticks verbatim, then the breakdown', () => {
    const usage = {
      calls: 2,
      context_max: 200_000,
      context_percent: 39,
      context_source: 'provider_usage',
      context_used: 78_000,
      input: 1,
      output: 1,
      total: 2
    }

    expect(contextHeadline(usage, breakdown())).toEqual({
      estimated: false,
      free: 122_000,
      max: 200_000,
      percent: 39,
      used: 78_000
    })
    expect(contextHeadline({ calls: 0, input: 0, output: 0, total: 0 }, breakdown())?.max).toBe(100_000)
    expect(contextHeadline(null, null)).toBeNull()
  })

  it('marks estimates from context_estimated, else from a non-provider context_source', () => {
    const base = { calls: 0, context_max: 10, context_used: 1, input: 0, output: 0, total: 0 }

    expect(contextHeadline({ ...base, context_estimated: true }, null)?.estimated).toBe(true)
    expect(contextHeadline({ ...base, context_source: 'local_estimate' }, null)?.estimated).toBe(true)
    expect(contextHeadline({ ...base, context_source: 'provider_usage' }, null)?.estimated).toBe(false)
    expect(contextHeadline(base, null)?.estimated).toBe(false)
  })
})

describe('formatting', () => {
  it('formats tokens compactly with ~ for estimates', () => {
    expect(formatTokens(781_100)).toBe('781.1k')
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(4200, true)).toBe('~4.2k')
    expect(formatShare(0.4)).toBe('<1%')
    expect(formatShare(0)).toBe('0%')
    expect(formatShare(49.6)).toBe('50%')
  })

  it('gives each id a stable swatch slot', () => {
    expect(swatchSlot('slot-test-a')).toBe(swatchSlot('slot-test-a'))
    expect(swatchSlot('slot-test-b')).not.toBe(swatchSlot('slot-test-a'))
  })
})

describe('spend', () => {
  it('lists only the session fields the runtime reported', () => {
    expect(sessionSpendRows(null)).toEqual([])
    expect(
      sessionSpendRows({
        cache_read: null,
        calls: 3,
        compressions: 1,
        input: 10,
        output: 20,
        reasoning: 5,
        total: 35
      }).map(row => [row.key, row.value])
    ).toEqual([
      ['input', 10],
      ['output', 20],
      ['reasoning', 5],
      ['calls', 3],
      ['compressions', 1]
    ])
  })

  it("reads today's UTC row and the background tasks, ignoring yesterday", () => {
    const now = Date.UTC(2026, 9, 18, 12)

    const analytics = {
      by_model: [],
      by_task: [
        { input_tokens: 400, output_tokens: 100, task: 'compression' },
        { input_tokens: 0, output_tokens: 0, task: 'idle' }
      ],
      daily: [
        {
          api_calls: 9,
          cache_read_tokens: 9,
          day: '2026-10-17',
          input_tokens: 9,
          output_tokens: 9,
          reasoning_tokens: 9,
          sessions: 9
        },
        {
          api_calls: 4,
          cache_read_tokens: 30,
          day: '2026-10-18',
          input_tokens: 100,
          output_tokens: 50,
          reasoning_tokens: 7,
          sessions: 2
        }
      ],
      period_days: 1
    } as unknown as AnalyticsResponse

    const today = todaySpend(analytics, now)

    expect(utcDayKey(now)).toBe('2026-10-18')
    expect(today?.rows.map(row => [row.key, row.value])).toEqual([
      ['input_tokens', 100],
      ['output_tokens', 50],
      ['reasoning_tokens', 7],
      ['cache_read_tokens', 30],
      ['api_calls', 4],
      ['sessions', 2]
    ])
    expect(today?.tasks).toEqual([{ key: 'task:compression', label: 'compression', value: 500 }])
    expect(todaySpend(null, now)).toBeNull()
  })

  it('never shows unreported spend as zeros', () => {
    const now = Date.UTC(2026, 9, 18, 12)

    const analytics = {
      by_model: [],
      by_task: [{ input_tokens: 400, output_tokens: 100, task: 'compression' }],
      daily: [{ api_calls: 9, day: '2026-10-17', input_tokens: 9 }],
      period_days: 1
    } as unknown as AnalyticsResponse

    expect(todaySpend({ ...analytics, by_task: [] }, now)).toBeNull()
    expect(todaySpend({ ...analytics, by_task: [], daily: [] }, now)).toBeNull()
    expect(todaySpend(analytics, now)).toEqual({
      rows: [],
      tasks: [{ key: 'task:compression', label: 'compression', value: 500 }]
    })

    const partial = todaySpend(
      { ...analytics, daily: [{ day: '2026-10-18', input_tokens: 12 }] } as AnalyticsResponse,
      now
    )

    expect(partial?.rows.map(row => [row.key, row.value])).toEqual([['input_tokens', 12]])
  })
})
