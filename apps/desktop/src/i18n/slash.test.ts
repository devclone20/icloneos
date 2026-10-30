import { describe, expect, it } from 'vitest'

import { ar } from './ar'
import { en } from './en'
import { ja } from './ja'
import { ptPt } from './pt-PT'
import type { SlashTranslations } from './types/slash'
import { zh } from './zh'
import { zhHant } from './zh-hant'

const LOCALES: Record<string, SlashTranslations> = {
  en: en.slash,
  zh: zh.slash,
  'zh-hant': zhHant.slash,
  ja: ja.slash,
  ar: ar.slash,
  'pt-PT': ptPt.slash
}

describe('i18n slash domain (V3-B)', () => {
  it('every locale defines every key of the domain, each as a string or a function returning a string', () => {
    const keys = Object.keys(en.slash) as (keyof SlashTranslations)[]

    for (const [locale, copy] of Object.entries(LOCALES)) {
      for (const key of keys) {
        const value = copy[key]

        expect(value, `${locale}.${key}`).toBeDefined()

        if (typeof value === 'function') {
          const out = (value as (...args: unknown[]) => string)(
            key.endsWith('Summary') ? ['a (b)', 'c (d)'] : key === 'by' ? 'Someone' : 2,
            'MIT'
          )

          expect(typeof out, `${locale}.${key}()`).toBe('string')
          expect(out.length, `${locale}.${key}()`).toBeGreaterThan(0)
        } else {
          expect(typeof value, `${locale}.${key}`).toBe('string')
          expect((value as string).length, `${locale}.${key}`).toBeGreaterThan(0)
        }
      }
    }
  })

  it('no locale falls back to English for a slash key (each one is translated, not merged from en)', () => {
    for (const [locale, copy] of Object.entries(LOCALES)) {
      if (locale === 'en') {
        continue
      }

      expect(copy.fromLibrary, locale).not.toBe(en.slash.fromLibrary)
      expect(copy.skillsEmpty, locale).not.toBe(en.slash.skillsEmpty)
    }
  })

  it('the English words carry the names they are given', () => {
    expect(en.slash.alsoKnownAs('/compact')).toBe('also /compact')
    expect(en.slash.needs('ffmpeg, MCP davinci-resolve')).toBe('needs ffmpeg, MCP davinci-resolve')
    expect(en.slash.needsSummary(['ridervoice (ffmpeg)'])).toContain('ridervoice (ffmpeg)')
    expect(en.slash.skillsFooter(1)).toContain('1 skill ')
    expect(en.slash.skillsFooter(2)).toContain('2 skills ')
    expect(en.slash.manifestProblem('schema 2 ≠ 1')).toBe('manifest.json invalid — schema 2 ≠ 1')
    expect(en.slash.manifestSummary(['hm-qa (schema 2 ≠ 1)'])).toBe(
      '1 skill carries an invalid manifest.json: hm-qa (schema 2 ≠ 1).'
    )
    expect(en.slash.by('Rodrigo Lopes', 'MIT')).toBe('by Rodrigo Lopes (MIT)')
    expect(en.slash.catalogUnavailable('/fence-me')).toContain('/fence-me was not sent')
  })
})
