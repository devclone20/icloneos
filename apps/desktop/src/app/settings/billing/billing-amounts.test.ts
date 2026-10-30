import { describe, expect, it } from 'vitest'

import { clampAmount, EMPTY_BILLING_VALUE, formatMoney, initialAutoReloadAmount, parseAmount } from './billing-amounts'

describe('parseAmount', () => {
  it('reads numbers and "$1,234.50" text, zero and negatives included', () => {
    expect(parseAmount(12.5)).toBe(12.5)
    expect(parseAmount('$1,234.50')).toBe(1234.5)
    expect(parseAmount(' 7 ')).toBe(7)
    expect(parseAmount('0')).toBe(0)
    expect(parseAmount('-3')).toBe(-3)
    expect(parseAmount(-3)).toBe(-3)
  })

  it('refuses what is not a finite number', () => {
    expect(parseAmount(Number.NaN)).toBeNull()
    expect(parseAmount(Number.POSITIVE_INFINITY)).toBeNull()
    expect(parseAmount('abc')).toBeNull()
    expect(parseAmount(null)).toBeNull()
    expect(parseAmount(undefined)).toBeNull()
  })
})

describe('typed amounts', () => {
  it('treat text of $0 or less as no amount', () => {
    expect(clampAmount('0', { max_usd: null, min_usd: null })).toBe('')
    expect(clampAmount('-5', { max_usd: null, min_usd: null })).toBe('')
    expect(initialAutoReloadAmount('0', '$25')).toBe('25')
    expect(formatMoney('0')).toBe(EMPTY_BILLING_VALUE)
  })

  it('keep numbers as they are', () => {
    expect(formatMoney(0)).not.toBe(EMPTY_BILLING_VALUE)
    expect(clampAmount('12.345', { max_usd: '10', min_usd: '5' })).toBe('10')
  })
})

// Ruling 69: English only — a Portuguese Mac must not see '4,50 US$'.
describe('formatMoney speaks the app’s English, not the OS locale (ruling 69)', () => {
  it('writes US dollars the en-US way', () => {
    expect(formatMoney(4.5)).toBe('$4.50')
    expect(formatMoney(1200)).toBe('$1,200')
    expect(formatMoney('12.3')).toBe('$12.30')
  })
})
