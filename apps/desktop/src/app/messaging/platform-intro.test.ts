import { describe, expect, it } from 'vitest'

import type { MessagingPlatformInfo } from '@/hermes'
import { messaging as ar } from '@/i18n/ar/messaging'
import { messaging as en } from '@/i18n/en/messaging'
import { messaging as ja } from '@/i18n/ja/messaging'
import { messaging as ptPt } from '@/i18n/pt-PT/messaging'
import { messaging as zhHant } from '@/i18n/zh-hant/messaging'
import { messaging as zh } from '@/i18n/zh/messaging'

import { introCopy, summaryCopy } from './platform-intro'

const others = { ar, ja, zh, 'zh-hant': zhHant, 'pt-PT': ptPt }

const platform = (id: string) =>
  ({ description: 'Run Hermes from somewhere.', id, name: id }) as unknown as MessagingPlatformInfo

describe('messaging platform words', () => {
  it('never shows the backend description: a platform the catalogue does not know shows nothing', () => {
    expect(summaryCopy(platform('unknown_platform'), en)).toBe('')
    expect(introCopy(platform('unknown_platform'), en)).toBe('')
    expect(summaryCopy(platform('telegram'), en)).not.toMatch(/hermes/i)
  })

  it('has every summary, setup line and field label in all six locales, never English in the other five', () => {
    const m = en

    for (const [locale, t] of Object.entries(others)) {
      const o = t as typeof en

      for (const [id, text] of Object.entries(m.platformSummary)) {
        expect(o.platformSummary?.[id], `${locale} summary ${id}`).toBeTruthy()
        expect(o.platformSummary?.[id], `${locale} summary ${id}`).not.toBe(text)
      }

      for (const [id, text] of Object.entries(m.platformIntro)) {
        expect(o.platformIntro?.[id], `${locale} intro ${id}`).toBeTruthy()
        expect(o.platformIntro?.[id], `${locale} intro ${id}`).not.toBe(text)
      }

      for (const key of Object.keys(m.fieldCopy)) {
        expect(o.fieldCopy?.[key]?.label, `${locale} label ${key}`).toBeTruthy()
      }
    }
  })

  it('no sentence names the runtime or a command', () => {
    for (const t of [en, ...Object.values(others)]) {
      const words = [...Object.values(t?.platformSummary ?? {}), ...Object.values(t?.platformIntro ?? {})]

      expect(words.filter(text => /hermes|gateway setup/i.test(text ?? ''))).toEqual([])
    }
  })
})

describe('messaging field words (ruling S27.4, critic r3 IA-r3-T1)', () => {
  const VERB = /^(Paste|Enter|Choose|Set|Turn|Allow|Use|Let|Format|React|Start|Share|Accept)\b/
  const keys = Object.keys(en.fieldCopy)

  it('titles every field with one sentence that starts with what to do, and keeps the noun for notices', () => {
    expect(keys.length).toBeGreaterThan(100)

    for (const key of keys) {
      const { label, name } = en.fieldCopy[key]
      expect(label, key).toMatch(VERB)
      expect(label, key).not.toMatch(/[:.]$|hermes|gateway/i)
      expect(name, key).toBeTruthy()
    }
  })

  it('has every field title and noun in all six locales, never the English one', () => {
    for (const [locale, m] of Object.entries(others)) {
      expect(m?.fieldFallbackLabel, locale).not.toBe(en.fieldFallbackLabel)

      for (const key of keys) {
        const words = m?.fieldCopy?.[key]
        expect(words?.label, `${locale} ${key}`).toBeTruthy()
        expect(words?.name, `${locale} ${key}`).toBeTruthy()
        expect(words?.label, `${locale} ${key}`).not.toBe(en.fieldCopy[key].label)
      }
    }
  })
})
