import { describe, expect, test } from 'vitest'

import { codeAmountLabel } from '@/app/home/econ/bank/bank-data'

import { TRANSLATIONS } from './catalog'
import type { Locale } from './types'

type Leaf = ((...args: never[]) => string) | string

function leaves(node: object, prefix = ''): Map<string, Leaf> {
  const out = new Map<string, Leaf>()

  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key

    if (typeof value === 'object' && value !== null) {
      for (const [inner, leaf] of leaves(value, path)) {
        out.set(inner, leaf)
      }
    } else {
      out.set(path, value as Leaf)
    }
  }

  return out
}

// One sample per parameter: every bank formatter takes strings except codes.active.
const render = (leaf: Leaf): string =>
  typeof leaf === 'string' ? leaf : (leaf as (...args: unknown[]) => string)('A1', 'B2')

const english = leaves(TRANSLATIONS.en.bank)
const others = (Object.keys(TRANSLATIONS) as Locale[]).filter(locale => locale !== 'en')

describe('bank.* copy', () => {
  test('there is a locale besides English', () => {
    expect(others.length).toBeGreaterThan(0)
  })

  test.each(others)('%s has the identical key set, with the same kinds of value', locale => {
    const local = leaves(TRANSLATIONS[locale].bank)

    expect([...local.keys()].sort()).toEqual([...english.keys()].sort())

    for (const [path, leaf] of english) {
      expect(typeof local.get(path), path).toBe(typeof leaf)
    }
  })

  test.each(others)('%s translates every entry instead of falling back to English', locale => {
    const local = leaves(TRANSLATIONS[locale].bank)
    const untranslated = [...english].filter(([path, leaf]) => render(local.get(path) as Leaf) === render(leaf))

    expect(untranslated.map(([path]) => path)).toEqual([])
  })

  test.each(['en', ...others] as Locale[])('%s keeps exactly one {target} slot in the sign-in hints', locale => {
    const { gate } = TRANSLATIONS[locale].bank

    for (const template of [gate.linkSent, gate.linkSentCardKnown]) {
      expect(template.split('{target}')).toHaveLength(2)
    }
  })

  test.each(['en', ...others] as Locale[])('%s formatters carry every argument into the text', locale => {
    const { bank } = TRANSLATIONS[locale]

    expect(bank.stats.limitLeft('$1', '$2')).toMatch(/\$1[\s\S]*\$2|\$2[\s\S]*\$1/)
    expect(bank.requests.emptyHint('Nova', 'ACT')).toContain('Nova')
    expect(bank.requests.emptyHint('Nova', 'ACT')).toContain('ACT')
    expect(bank.codes.active(3)).toContain('3')
    expect(bank.gate.noCardHint('Nova')).toContain('Nova')
  })

  test.each(['en', ...others] as Locale[])('%s labels a 3DS code without an amount in its own words', locale => {
    const { codes } = TRANSLATIONS[locale].bank

    expect(codes.amountNotGiven.trim()).not.toBe('')
    expect(codeAmountLabel(null, codes.amountNotGiven)).toBe(codes.amountNotGiven)
    expect(codeAmountLabel(12, codes.amountNotGiven)).toBe('USD 12.00')
  })
})
