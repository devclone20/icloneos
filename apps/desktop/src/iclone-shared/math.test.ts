import { describe, expect, it } from 'vitest'

import { clamp } from './math'

describe('clamp', () => {
  it('limits to the bounds and keeps values inside them', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(11, 0, 10)).toBe(10)
    expect(clamp(0, 0, 0)).toBe(0)
  })

  it('returns min when the bounds cross', () => {
    expect(clamp(5, 10, 0)).toBe(10)
    expect(clamp(-50, 10, 0)).toBe(10)
  })

  it('handles infinities and NaN', () => {
    expect(clamp(Number.POSITIVE_INFINITY, 0, 1)).toBe(1)
    expect(clamp(Number.NEGATIVE_INFINITY, 0, 1)).toBe(0)
    expect(clamp(3, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY)).toBe(3)
    expect(clamp(Number.NaN, 0, 1)).toBeNaN()
  })
})
