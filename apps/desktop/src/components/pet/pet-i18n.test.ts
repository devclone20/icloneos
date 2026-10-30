import { describe, expect, it } from 'vitest'

import { TRANSLATIONS } from '@/i18n/catalog'

/** The shape of a message tree: its keys, recursively; a function counts as a leaf. */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) {
    return 'list'
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, shape(v)])
    )
  }

  return typeof value
}

const LOCALES = ['en', 'ar', 'ja', 'zh', 'zh-hant', 'pt-PT'] as const

describe('the pet words in six locales (gate P10 i18n)', () => {
  it('every locale carries the same pet keys as English, none empty', () => {
    expect(Object.keys(TRANSLATIONS).sort()).toEqual([...LOCALES].sort())

    for (const locale of LOCALES) {
      const t = TRANSLATIONS[locale]
      expect(shape(t.settings.appearance.pet), locale).toEqual(shape(TRANSLATIONS.en.settings.appearance.pet))
      expect(shape(t.commandCenter.pets), locale).toEqual(shape(TRANSLATIONS.en.commandCenter.pets))

      for (const mood of ['run', 'review', 'failed', 'waiting'] as const) {
        expect(t.commandCenter.pets.bubble[mood].length, `${locale} ${mood}`).toBeGreaterThanOrEqual(4)
        expect(t.commandCenter.pets.bubble[mood].every(line => line.trim().length > 0)).toBe(true)
      }

      const p = t.settings.appearance.pet
      expect([p.legions.play, p.legions.death, p.legions.god]).toEqual(['Play', 'Death', 'God'])
      expect(p.noMatch('x')).toContain('x')
      expect(p.count(20)).toContain('20')
      expect(p.choose('#2')).toContain('#2')
      expect(t.commandCenter.pets.label('#2')).toContain('#2')
      // The pop-out's prompt box (r2): its name and placeholder in every locale, each its own words.
      expect(t.commandCenter.pets.promptLabel.trim().length, locale).toBeGreaterThan(0)
      expect(t.commandCenter.pets.promptPlaceholder.trim().length, locale).toBeGreaterThan(0)

      // The refusal line (r3): three reasons, each one short line in every locale, each its own words.
      for (const reason of ['command', 'noSession', 'notSent'] as const) {
        const line = t.commandCenter.pets.promptRefused[reason]
        expect(line.trim().length, `${locale} ${reason}`).toBeGreaterThan(0)
        expect(line.length, `${locale} ${reason}`).toBeLessThanOrEqual(32)

        if (locale !== 'en') {
          expect(line, `${locale} ${reason}`).not.toBe(TRANSLATIONS.en.commandCenter.pets.promptRefused[reason])
        }
      }

      // R4-F2: the app went away after handing the message on — it may have been sent: one short line, its own words.
      const maybe = t.commandCenter.pets.promptMaybeSent
      expect(maybe.trim().length, `${locale} maybe-sent`).toBeGreaterThan(0)
      expect(maybe.length, `${locale} maybe-sent`).toBeLessThanOrEqual(32)

      if (locale !== 'en') {
        expect(t.commandCenter.pets.promptLabel, locale).not.toBe(TRANSLATIONS.en.commandCenter.pets.promptLabel)
        expect(maybe, locale).not.toBe(TRANSLATIONS.en.commandCenter.pets.promptMaybeSent)
      }
    }
  })

  it('no generate, remix, petdex, install, rename, export or delete words come back', () => {
    const banned = /petdex|generat|remix|hatch|install|rename|export|delete|adopt/i

    for (const locale of LOCALES) {
      const t = TRANSLATIONS[locale]
      expect(Object.keys(t.settings.appearance.pet).filter(k => banned.test(k))).toEqual([])
      expect(Object.keys(t.commandCenter.pets).filter(k => banned.test(k))).toEqual([])
    }

    expect(JSON.stringify(TRANSLATIONS.en.settings.appearance.pet)).not.toMatch(banned)
  })
})
