import { describe, expect, it } from 'vitest'

import type { SessionInfo } from '@/hermes'
import { APP_INTL_LOCALE } from '@/iclone-shared/app-intl-locale'

import { actionOutcome, filterLines, filterSessions, formatTimestamp, usageBars } from './cc-model'

const session = (id: string, over: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, last_active: 0, started_at: 0, ...over }) as SessionInfo

describe('filterSessions', () => {
  it('sorts newest first by last_active, falling back to started_at', () => {
    const rows = filterSessions(
      [
        session('old', { last_active: 100 }),
        session('fresh', { last_active: 900 }),
        session('started-only', { last_active: 0, started_at: 500 })
      ],
      ''
    )

    expect(rows.map(row => row.id)).toEqual(['fresh', 'started-only', 'old'])
  })

  it('matches the id as well as the title, case-insensitively', () => {
    const rows = [session('AbC-123'), session('other', { title: 'Deploy notes' } as Partial<SessionInfo>)]

    expect(filterSessions(rows, 'abc').map(row => row.id)).toEqual(['AbC-123'])
    expect(filterSessions(rows, 'deploy').map(row => row.id)).toEqual(['other'])
    expect(filterSessions(rows, 'nothing')).toEqual([])
  })

  it('never mutates the input array', () => {
    const rows = [session('a', { last_active: 1 }), session('b', { last_active: 2 })]

    filterSessions(rows, '')
    expect(rows.map(row => row.id)).toEqual(['a', 'b'])
  })
})

describe('filterLines', () => {
  it('filters case-insensitively and returns a copy when empty', () => {
    const lines = ['INFO ready', 'ERROR broke']

    expect(filterLines(lines, 'error')).toEqual(['ERROR broke'])
    expect(filterLines(lines, '  ')).toEqual(lines)
    expect(filterLines(lines, '')).not.toBe(lines)
  })
})

describe('formatTimestamp', () => {
  it('is empty for no instant and for an unusable one', () => {
    expect(formatTimestamp(0)).toBe('')
    expect(formatTimestamp(null)).toBe('')
    expect(formatTimestamp(undefined)).toBe('')
    expect(formatTimestamp(Number.NaN)).toBe('')
  })

  it('reads epoch SECONDS, not milliseconds', () => {
    const seconds = 1_760_000_000

    expect(formatTimestamp(seconds)).toBe(
      // Ruling 69: the app's English, never the OS locale (a pt-PT Mac used to get '09/10/2025, 09:53' here).
      new Intl.DateTimeFormat(APP_INTL_LOCALE, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(seconds * 1000)
      )
    )
  })
})

describe('usageBars', () => {
  const compact = (value: number) => String(value)

  it('scales against the busiest day and keeps a sliver for any traffic', () => {
    const bars = usageBars(
      [
        { day: '2026-10-01', input_tokens: 1000, output_tokens: 0 },
        { day: '2026-10-02', input_tokens: 1, output_tokens: 500 }
      ] as Parameters<typeof usageBars>[0],
      compact
    )

    expect(bars.map(bar => [bar.inputPct, bar.outputPct])).toEqual([
      [100, 0],
      [1, 50]
    ])
    expect(bars[0]!.title).toBe('2026-10-01 · in 1000 · out 0')
  })

  it('is empty without data and never divides by zero', () => {
    expect(usageBars(undefined, compact)).toEqual([])
    expect(
      usageBars([{ day: 'd', input_tokens: 0, output_tokens: 0 }] as Parameters<typeof usageBars>[0], compact)
    ).toEqual([{ day: 'd', inputPct: 0, outputPct: 0, title: 'd · in 0 · out 0' }])
  })
})

describe('actionOutcome', () => {
  it('is running first, then exit-code truth', () => {
    expect(actionOutcome(true, 0)).toBe('running')
    expect(actionOutcome(false, 0)).toBe('done')
    expect(actionOutcome(false, 1)).toBe('failed')
    expect(actionOutcome(false, null)).toBe('failed')
    expect(actionOutcome(false, undefined)).toBe('failed')
  })
})
