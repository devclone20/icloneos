import { describe, expect, it } from 'vitest'

import type { ByteUnit } from './format'
import { formatBytes, formatClock, formatDurationMs, formatElapsedSeconds } from './format'

describe('formatBytes', () => {
  it('defaults: base 1024, adaptive digits, up to TB', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(15 * 1024)).toBe('15 KB')
    expect(formatBytes(5 * 1024 ** 4)).toBe('5.0 TB')
    expect(formatBytes(5000 * 1024 ** 4)).toBe('5000 TB')
  })

  it('maintenance style: fixed one digit, capped at MB', () => {
    const style = { fractionDigits: 1, maxUnit: 'MB' } as const

    expect(formatBytes(500, style)).toBe('500 B')
    expect(formatBytes(2048, style)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 ** 3, style)).toBe('5120.0 MB')
  })

  it('preview style: adaptive digits, capped at GB', () => {
    const style = { maxUnit: 'GB' } as const

    expect(formatBytes(1536, style)).toBe('1.5 KB')
    expect(formatBytes(3 * 1024 ** 4, style)).toBe('3072 GB')
  })

  it('download style: SI, MB to GB, per-unit digits (missing unit → 0)', () => {
    const style = { base: 1000, fractionDigits: { GB: 1 }, maxUnit: 'GB', minUnit: 'MB' } as const

    expect(formatBytes(Math.max(0, 1e6), style)).toBe('1 MB')
    expect(formatBytes(999.6e6, style)).toBe('1000 MB')
    expect(formatBytes(1e9, style)).toBe('1.0 GB')
    expect(formatBytes(2.45e12, style)).toBe('2450.0 GB')
  })

  it('a maxUnit below minUnit keeps minUnit', () => {
    expect(formatBytes(5 * 1024 ** 3, { maxUnit: 'KB', minUnit: 'MB' })).toBe('5120 MB')
  })

  it('hostile inputs: unknown units fall back, bad base falls back, NaN/negative pass through', () => {
    expect(formatBytes(2048, { minUnit: 'XB' as ByteUnit })).toBe('2.0 KB')
    expect(formatBytes(2048, { maxUnit: 'ZB' as ByteUnit })).toBe('2.0 KB')
    expect(formatBytes(2000, { base: 7 as 1000 })).toBe('2.0 KB')
    expect(formatBytes(Number.NaN)).toBe('NaN B')
    expect(formatBytes(-2048)).toBe('-2048 B')
  })
})

describe('formatClock', () => {
  it('M:SS under an hour, H:MM:SS from one hour on', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(65.9)).toBe('1:05')
    expect(formatClock(3599)).toBe('59:59')
    expect(formatClock(3600)).toBe('1:00:00')
    expect(formatClock(3723)).toBe('1:02:03')
  })

  it("hours: 'never' keeps counting minutes", () => {
    expect(formatClock(4504, { hours: 'never' })).toBe('75:04')
    expect(formatClock(4504, { hours: 'auto' })).toBe('1:15:04')
  })

  it('negatives read as zero', () => {
    expect(formatClock(-30)).toBe('0:00')
  })
})

describe('formatElapsedSeconds', () => {
  it('seconds under a minute, then M:SS without hours', () => {
    expect(formatElapsedSeconds(0)).toBe('0s')
    expect(formatElapsedSeconds(59.99)).toBe('59s')
    expect(formatElapsedSeconds(60)).toBe('1:00')
    expect(formatElapsedSeconds(3725)).toBe('62:05')
    expect(formatElapsedSeconds(-4)).toBe('0s')
  })
})

describe('formatDurationMs', () => {
  it('ms, then seconds with one digit, then minutes and whole seconds', () => {
    expect(formatDurationMs(0)).toBe('0 ms')
    expect(formatDurationMs(850)).toBe('850 ms')
    expect(formatDurationMs(1000)).toBe('1.0s')
    expect(formatDurationMs(4210)).toBe('4.2s')
    expect(formatDurationMs(60_000)).toBe('1m 0s')
    expect(formatDurationMs(187_400)).toBe('3m 7s')
  })

  it('carries a rounded 60th second into the minutes', () => {
    expect(formatDurationMs(119_600)).toBe('2m 0s')
  })

  it("'' for non-finite or non-number values", () => {
    for (const value of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, '1000', {}]) {
      expect(formatDurationMs(value)).toBe('')
    }
  })
})
