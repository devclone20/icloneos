import { describe, expect, it } from 'vitest'

import { ACP_WORK_COPY } from '@/app/home/econ/market/work/work-copy'

import { CATALOGUE_LOCALES } from './languages'
import type { Locale } from './types'

type Leaf = ((...args: never[]) => string) | string

function leaves(node: object, prefix = ''): Map<string, Leaf> {
  const out = new Map<string, Leaf>()

  for (const [key, value] of Object.entries(node)) {
    const at = prefix ? `${prefix}.${key}` : key

    if (typeof value === 'object' && value !== null) {
      for (const [inner, leaf] of leaves(value as object, at)) {
        out.set(inner, leaf)
      }
    } else {
      out.set(at, value as Leaf)
    }
  }

  return out
}

const render = (leaf: Leaf): string =>
  typeof leaf === 'string' ? leaf : (leaf as (...args: unknown[]) => string)(2, 'X')

const english = leaves(ACP_WORK_COPY.en)
const locales = Object.keys(ACP_WORK_COPY) as Locale[]

describe('acpWork.* copy (V3-I)', () => {
  it('has a catalogue for every app locale', () => {
    expect(locales.sort()).toEqual([...CATALOGUE_LOCALES].sort())
  })

  it.each(locales.filter(locale => locale !== 'en'))('%s has the identical key set and kinds of value', locale => {
    const theirs = leaves(ACP_WORK_COPY[locale])

    expect([...theirs.keys()].sort()).toEqual([...english.keys()].sort())

    for (const [key, leaf] of english) {
      expect({ key, kind: typeof theirs.get(key) }).toEqual({ key, kind: typeof leaf })
    }
  })

  it.each(locales)('%s: every string is non-empty and translated where English is a sentence', locale => {
    for (const [key, leaf] of leaves(ACP_WORK_COPY[locale])) {
      const text = render(leaf)

      expect({ key, empty: text.trim() === '' }).toEqual({ key, empty: false })

      if (locale !== 'en' && text.length > 12) {
        expect({ key, same: text === render(english.get(key) as Leaf) }).toEqual({ key, same: false })
      }
    }
  })
})
