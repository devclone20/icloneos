import { describe, expect, it } from 'vitest'

import { CATALOGUE_LOCALES } from './languages'
import { loadTranslations } from './locale-loader'
import type { Locale } from './types'

// K21/N5 (V3-K critic r1 m3): the iNFT Book's counts are in each locale's own grouping, never a raw number. The locale
// list is the app's own (CATALOGUE_LOCALES), so a seventh locale is checked the day it is added.
const NUMBER_TAG: Record<Locale, string> = {
  ar: 'ar-u-nu-latn',
  en: 'en-US',
  ja: 'ja-JP',
  'pt-PT': 'pt-PT',
  zh: 'zh-CN',
  'zh-hant': 'zh-TW'
}

const locales = [...CATALOGUE_LOCALES]

describe('iNFT Book counts are locale-formatted', () => {
  it('covers every locale the app ships', () => {
    expect([...locales].sort()).toEqual(Object.keys(NUMBER_TAG).sort())
    expect(locales).toHaveLength(6)
  })

  // K126 (V3-K fix critic r2 m5): every number a line carries is checked on its own, with five-digit values that every
  // shipped locale groups (pt-PT groups from five digits on). The old "total OR part" check let a line that carries
  // both pass with one of them raw.
  it.each(locales)('%s', async locale => {
    const copy = (await loadTranslations(locale)).inftBook
    const format = (value: number) => value.toLocaleString(NUMBER_TAG[locale])
    const raw = (value: number) => new RegExp(`(?<!\\d)${value}(?!\\d)`)

    for (const [total, part] of [
      [12_345, 67_890],
      [98_765, 43_210]
    ]) {
      const lines: [string, number[]][] = [
        [copy.count(total, part), [total, part]],
        [copy.confirmTitle(part), [part]],
        [copy.scanning(total), [total]],
        [copy.partial(part), [part]],
        [copy.capped(total), [total]],
        [copy.kept(part), [part]]
      ]

      for (const [line, values] of lines) {
        expect(line).toBeTypeOf('string')

        for (const value of values) {
          expect(format(value), `${locale}: ${value} must group`).not.toBe(String(value))
          expect(line, `${locale}: ${value} formatted`).toContain(format(value))
          expect(line, `${locale}: ${value} raw`).not.toMatch(raw(value))
        }
      }
    }

    // 12 000 is grouped in every shipped locale (pt-PT groups from five digits on): a raw count shows as 12000.
    expect(copy.capped(12_000)).not.toMatch(/\b12000\b/)
  })

  it('the roster refusal and failure lines exist in every locale (V3-K critic r1 m6)', async () => {
    for (const locale of locales) {
      const copy = (await loadTranslations(locale)).inftBook

      expect(copy.scanRefused, locale).toMatch(/\S/)
      expect(copy.scanFailed, locale).toMatch(/\S/)

      if (locale !== 'en') {
        expect(copy.scanRefused, locale).not.toBe('The wallet scan was refused.')
      }
    }
  })
})
