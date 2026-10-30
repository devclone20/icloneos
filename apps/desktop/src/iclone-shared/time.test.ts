import { describe, expect, it } from 'vitest'

import type { AgoLabels } from './time'
import { DAY_MS, elapsedBucket, formatAgo, HOUR_MS, MINUTE_MS, SECOND_MS, toEpochMs } from './time'

const LABELS: AgoLabels = {
  days: n => `${n} d ago`,
  hours: n => `${n} h ago`,
  minutes: n => `${n} min ago`,
  now: 'just now'
}

const WITH_SECONDS: AgoLabels = { ...LABELS, now: 'now', seconds: n => `${n}s ago` }

describe('elapsedBucket', () => {
  it('picks the largest whole unit, floor by default', () => {
    expect(elapsedBucket(0)).toEqual({ unit: 'second', value: 0 })
    expect(elapsedBucket(59_999)).toEqual({ unit: 'second', value: 59 })
    expect(elapsedBucket(90 * SECOND_MS)).toEqual({ unit: 'minute', value: 1 })
    expect(elapsedBucket(HOUR_MS)).toEqual({ unit: 'hour', value: 1 })
    expect(elapsedBucket(36 * HOUR_MS)).toEqual({ unit: 'day', value: 1 })
  })

  it("'round' rounds inside the same unit thresholds", () => {
    expect(elapsedBucket(90 * SECOND_MS, 'round')).toEqual({ unit: 'minute', value: 2 })
    expect(elapsedBucket(59.6 * MINUTE_MS, 'round')).toEqual({ unit: 'minute', value: 60 })
    expect(elapsedBucket(36 * HOUR_MS, 'round')).toEqual({ unit: 'day', value: 2 })
    expect(elapsedBucket(1500, 'round')).toEqual({ unit: 'second', value: 2 })
  })

  it('negative and NaN deltas', () => {
    expect(elapsedBucket(-5 * DAY_MS)).toEqual({ unit: 'second', value: 0 })
    expect(elapsedBucket(Number.NaN).unit).toBe('second')
  })
})

describe('formatAgo', () => {
  const now = 10 * DAY_MS

  it('without a seconds label, everything under a minute is now', () => {
    expect(formatAgo(now - 59_000, LABELS, { nowMs: now })).toBe('just now')
    expect(formatAgo(now + 5000, LABELS, { nowMs: now })).toBe('just now')
  })

  it('with a seconds label, under 2 s is now', () => {
    expect(formatAgo(now - 1999, WITH_SECONDS, { nowMs: now })).toBe('now')
    expect(formatAgo(now - 2000, WITH_SECONDS, { nowMs: now })).toBe('2s ago')
  })

  it('minutes, hours and days, floor or round', () => {
    expect(formatAgo(now - 90_000, LABELS, { nowMs: now })).toBe('1 min ago')
    expect(formatAgo(now - 90_000, LABELS, { nowMs: now, rounding: 'round' })).toBe('2 min ago')
    expect(formatAgo(now - 3 * HOUR_MS, LABELS, { nowMs: now })).toBe('3 h ago')
    expect(formatAgo(now - 4 * DAY_MS, LABELS, { nowMs: now })).toBe('4 d ago')
  })

  it('defaults nowMs to the clock', () => {
    expect(formatAgo(Date.now() - 2 * DAY_MS, LABELS)).toBe('2 d ago')
  })
})

describe('toEpochMs', () => {
  it('numbers and parseable strings', () => {
    expect(toEpochMs(0)).toBe(0)
    expect(toEpochMs(1_700_000_000_000)).toBe(1_700_000_000_000)
    expect(toEpochMs('2026-10-18T00:00:00Z')).toBe(Date.UTC(2026, 9, 18))
  })

  it('null for anything unusable', () => {
    for (const value of ['', 'not a date', Number.NaN, Number.POSITIVE_INFINITY, null, undefined, new Date(0), {}]) {
      expect(toEpochMs(value)).toBeNull()
    }
  })
})
