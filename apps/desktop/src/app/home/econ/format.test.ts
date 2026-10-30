import { describe, expect, it } from 'vitest'

import { ago, briefText, number, relativeTime, signedUsd, timeAgo, usd, when } from './format'

// The machine running the app may be pt-PT, ja-JP, anything — the dock apps'
// copy is English, so their figures are too. These pin the locale, not the
// arithmetic.
describe('econ formatting is English whatever the machine locale', () => {
  it('formats money and numbers the en-US way', () => {
    expect(usd(1234.5)).toBe('$1,234.50')
    expect(usd(0.0042)).toBe('$0.0042')
    expect(number(1234567.891)).toBe('1,234,567.89')
  })

  it('reads a past moment as a compact English age', () => {
    const now = Date.parse('2026-09-26T12:00:00Z')

    expect(timeAgo(now, now)).toBe('just now')
    expect(timeAgo(now - 3_000, now)).toBe('3s ago')
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5m ago')
    expect(timeAgo(now - 2 * 3_600_000, now)).toBe('2h ago')
    expect(timeAgo(new Date(now - 3 * 86_400_000).toISOString()).endsWith('d ago')).toBe(true)
  })

  // Intentional fix of the timeAgo merge: the old email/bank relativeTime(NaN) printed "NaNs ago".
  it('reads a moment that is not a time as an em dash, through every alias', () => {
    const now = Date.parse('2026-09-26T12:00:00Z')

    expect(timeAgo(Number.NaN)).toBe('—')
    expect(relativeTime(Number.NaN, now)).toBe('—')
    expect(ago(Number.NaN, now)).toBe('—')
    expect(timeAgo('not a date', now)).toBe('—')
  })

  it('writes dates with English month names', () => {
    // Built from LOCAL time: the formatter shows the owner's local date, so a fixed UTC instant reads as
    // another day east of UTC+11.
    expect(when(new Date(2026, 8, 18, 13).toISOString())).toMatch(/Sep 18, 2026/)
    expect(when(undefined)).toBe('—')
  })
})

// Both quotings keep the exact output of the per-app helpers they replaced.
describe('briefText', () => {
  it('single: flattens control characters, swaps straight apostrophes, trims before the ellipsis', () => {
    expect(briefText("it's a\u0000 test", 40, 'single')).toBe('it’s a test')
    expect(briefText('say "hi" `now`', 40, 'single')).toBe('say "hi" `now`')
    expect(briefText('ab  cdef', 4, 'single')).toBe('ab…')
  })

  it('double: turns backticks and every double quote into an apostrophe, cuts without trimming', () => {
    expect(briefText('He said "hi" `rm`\n\t“x”  ', 120, 'double')).toBe("He said 'hi' 'rm' 'x'")
    expect(briefText("it's", 120, 'double')).toBe("it's")
    expect(briefText('a\u0000b', 120, 'double')).toBe('a\u0000b')
    expect(briefText('ab  cdef', 4, 'double')).toBe('ab …')
  })
})

describe('signedUsd (U3-p2-11)', () => {
  it('carries the currency and the sign, a flat figure included', () => {
    expect(signedUsd(0)).toBe('+$0.00')
    expect(signedUsd(12.5)).toBe('+$12.50')
    expect(signedUsd(-0.42)).toBe('−$0.42')
  })
})
