import { describe, expect, it } from 'vitest'

import { parseTextSize, scaledFontPx, TEXT_SCALE, TEXT_SIZE_COPY, TEXT_SIZE_WORDS, TEXT_SIZES } from './text-size'

describe('text size', () => {
  it('offers half, default and double, in that order', () => {
    expect(TEXT_SIZES.map(size => TEXT_SCALE[size])).toEqual([0.85, 1, 2])
    expect(TEXT_SIZES.map(size => TEXT_SIZE_COPY.labels[size])).toEqual(['Small 85 %', 'Default', 'Large 2×'])
  })

  it.each([
    ['small', 'small'],
    ['large', 'large'],
    ['default', 'default'],
    [null, 'default'],
    ['huge', 'default'],
    [2, 'default']
  ])('parses %j as %s', (raw, size) => {
    expect(parseTextSize(raw)).toBe(size)
  })

  it('scales an inline pixel size through the root variable', () => {
    expect(scaledFontPx(11)).toBe('max(min(11px, 10px), calc(11px * var(--ic-text-scale, 1)))')
  })

  it('keeps a rem length in rem so it tracks the root size', () => {
    expect(scaledFontPx('0.5625rem')).toBe('calc(0.5625rem * var(--ic-text-scale, 1))')
    expect(scaledFontPx('0.7rem')).toBe('calc(0.7rem * var(--ic-text-scale, 1))')
  })
})

describe('text size words', () => {
  it('names every size in all six locales, and the other five never in English', () => {
    for (const [locale, words] of Object.entries(TEXT_SIZE_WORDS)) {
      expect(TEXT_SIZES.every(size => words.labels[size].length > 0)).toBe(true)

      if (locale !== 'en') {
        expect(words.description).not.toBe(TEXT_SIZE_WORDS.en.description)
        expect(words.title).not.toBe(TEXT_SIZE_WORDS.en.title)
        expect(TEXT_SIZES.map(size => words.labels[size])).not.toContain('Default')
      }
    }
  })
})
