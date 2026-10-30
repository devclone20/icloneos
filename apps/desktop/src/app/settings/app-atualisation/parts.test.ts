import { describe, expect, it } from 'vitest'

import { formatDownloadSize, timeAgo } from './parts'

const NOW = Date.parse('2026-10-18T12:00:00Z')

describe('formatDownloadSize', () => {
  it('reads whole decimal megabytes, never below 1 MB', () => {
    expect(formatDownloadSize(1)).toBe('1 MB')
    expect(formatDownloadSize(500e6)).toBe('500 MB')
    expect(formatDownloadSize(999.4e6)).toBe('999 MB')
  })

  it('switches to one-decimal gigabytes at 1e9 bytes', () => {
    expect(formatDownloadSize(1e9)).toBe('1.0 GB')
    expect(formatDownloadSize(1.55e9)).toBe('1.6 GB')
  })
})

describe('timeAgo', () => {
  it('reads unusable timestamps as never', () => {
    expect(timeAgo(null, NOW)).toBe('never')
    expect(timeAgo(undefined, NOW)).toBe('never')
    expect(timeAgo('not a date', NOW)).toBe('never')
  })

  it('rounds to the nearest unit', () => {
    expect(timeAgo(NOW - 30_000, NOW)).toBe('just now')
    expect(timeAgo(NOW - 90_000, NOW)).toBe('2 min ago')
    expect(timeAgo(NOW - 2.4 * 3_600_000, NOW)).toBe('2 h ago')
    expect(timeAgo(NOW - 3 * 86_400_000, NOW)).toBe('3 d ago')
  })

  it('parses ISO strings and reads future timestamps as just now', () => {
    expect(timeAgo('2026-10-18T11:55:00Z', NOW)).toBe('5 min ago')
    expect(timeAgo(NOW + 60_000, NOW)).toBe('just now')
  })
})
