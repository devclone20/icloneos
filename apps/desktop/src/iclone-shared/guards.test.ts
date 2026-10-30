import { describe, expect, it } from 'vitest'

import {
  asFiniteNumber,
  asNonEmptyString,
  asRecord,
  asString,
  coerceNumber,
  coerceString,
  isFiniteNumber,
  isNonBlankString,
  isRecord,
  recordOrEmpty
} from './guards'

const NOT_RECORDS: unknown[] = [null, undefined, 0, 1, '', 'x', true, false, [], [1], () => 1, Symbol('s'), 10n]

describe('isRecord / asRecord / recordOrEmpty', () => {
  it('accepts plain, null-prototype and class objects', () => {
    const bare = Object.create(null) as Record<string, unknown>

    for (const value of [{}, { a: 1 }, bare, new Date(0), new Map()]) {
      expect(isRecord(value)).toBe(true)
      expect(asRecord(value)).toBe(value)
      expect(recordOrEmpty(value)).toBe(value)
    }
  })

  it('refuses null, arrays, functions and primitives', () => {
    for (const value of NOT_RECORDS) {
      expect(isRecord(value)).toBe(false)
      expect(asRecord(value)).toBeNull()
      expect(recordOrEmpty(value)).toEqual({})
    }
  })

  it('returns a fresh empty object each time', () => {
    expect(recordOrEmpty(null)).not.toBe(recordOrEmpty(null))
  })
})

describe('string readers', () => {
  it('asString keeps every string, the empty one included', () => {
    expect(asString('')).toBe('')
    expect(asString(' a ')).toBe(' a ')
    expect(asString(1)).toBeUndefined()
    expect(asString(new String('boxed'))).toBeUndefined()
    expect(asString(null)).toBeUndefined()
  })

  it('asNonEmptyString refuses the empty string only (whitespace is content)', () => {
    expect(asNonEmptyString('')).toBeUndefined()
    expect(asNonEmptyString(' ')).toBe(' ')
    expect(asNonEmptyString(0)).toBeUndefined()
  })

  it('isNonBlankString needs a visible character and respects maxLength', () => {
    expect(isNonBlankString('ok')).toBe(true)
    expect(isNonBlankString('  \n\t')).toBe(false)
    expect(isNonBlankString('')).toBe(false)
    expect(isNonBlankString(42)).toBe(false)
    expect(isNonBlankString('abc', 3)).toBe(true)
    expect(isNonBlankString('abcd', 3)).toBe(false)
    expect(isNonBlankString('x'.repeat(10_000))).toBe(true)
  })

  it('coerceString turns finite numbers into text and nothing else', () => {
    expect(coerceString('a')).toBe('a')
    expect(coerceString(0)).toBe('0')
    expect(coerceString(-1.5)).toBe('-1.5')
    expect(coerceString(Number.NaN)).toBeUndefined()
    expect(coerceString(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(coerceString(true)).toBeUndefined()
    expect(coerceString({ toString: () => 'x' })).toBeUndefined()
  })
})

describe('number readers', () => {
  it('isFiniteNumber / asFiniteNumber refuse NaN, infinities and numeric strings', () => {
    for (const value of [0, -0, 1.5, Number.MAX_SAFE_INTEGER]) {
      expect(isFiniteNumber(value)).toBe(true)
      expect(asFiniteNumber(value)).toBe(value)
    }

    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '1', null, 1n]) {
      expect(isFiniteNumber(value)).toBe(false)
      expect(asFiniteNumber(value)).toBeUndefined()
    }
  })

  it('coerceNumber parses non-blank numeric strings', () => {
    expect(coerceNumber(7)).toBe(7)
    expect(coerceNumber(' 12.5 ')).toBe(12.5)
    expect(coerceNumber('0x10')).toBe(16)
    expect(coerceNumber('')).toBeUndefined()
    expect(coerceNumber('   ')).toBeUndefined()
    expect(coerceNumber('12px')).toBeUndefined()
    expect(coerceNumber('Infinity')).toBeUndefined()
    expect(coerceNumber(Number.NaN)).toBeUndefined()
    expect(coerceNumber(null)).toBeUndefined()
    expect(coerceNumber([5])).toBeUndefined()
  })
})
