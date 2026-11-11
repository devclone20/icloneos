import { describe, expect, test } from 'vitest'

import { PERMISSION_MODES } from '@/iclone-shared/permissions'

import { TRANSLATIONS } from './catalog'
import type { Locale } from './types'

const LOCALES = Object.keys(TRANSLATIONS) as Locale[]

// Chinese and Japanese are not written with spaces between words, so four words is bounded by characters there.
const UNSPACED: ReadonlySet<Locale> = new Set(['ja', 'zh', 'zh-hant'] as Locale[])
const UNSPACED_MAX_CHARS = 10

describe('U-1: every permission mode has a one-line short for the composer menu', () => {
  test.each(LOCALES)('%s: each short is one line of at most four words, not a sentence', locale => {
    const modes = TRANSLATIONS[locale].settings.permissions.modes

    for (const mode of PERMISSION_MODES) {
      const { short, summary } = modes[mode]

      expect(short.trim()).toBe(short)
      expect(short.length).toBeGreaterThan(0)
      expect(short).not.toMatch(/[\n.。]$/u)
      expect(short).not.toContain('\n')
      expect(short).not.toBe(summary)

      if (UNSPACED.has(locale)) {
        expect([...short].length).toBeLessThanOrEqual(UNSPACED_MAX_CHARS)
      } else {
        expect(short.split(/\s+/u).length).toBeLessThanOrEqual(4)
      }
    }
  })

  test('the five English shorts are pinned, in sentence case', () => {
    const shorts = Object.fromEntries(
      PERMISSION_MODES.map(mode => [mode, TRANSLATIONS.en.settings.permissions.modes[mode].short])
    )

    expect(shorts).toEqual({
      ignore: 'Never asks',
      manual: 'Asks before acting',
      automatic: 'Edits, runs safe commands',
      plan: 'Reads and plans',
      acceptEdits: 'Edits without asking'
    })

    for (const short of Object.values(shorts)) {
      expect(short[0]).toBe(short[0].toUpperCase())
      expect(short.slice(1)).toBe(short.slice(1).toLowerCase())
    }
  })

  test.each(LOCALES)(
    '%s: the menu names the full Settings path and keeps the Ignore note to one short line',
    locale => {
      const { menu } = TRANSLATIONS[locale].settings.permissions

      // L5-03: the scope lines carry the three-level path (Settings › Agent › Permissions), never the two-level one.
      for (const line of [menu.appliesToSession, menu.appliesToNewChat]) {
        expect(line.split('›').length).toBe(3)
      }

      // L5-01: one line in a 256px menu.
      for (const note of [menu.ignoreNote.confined, menu.ignoreNote.unconfined]) {
        expect(note).not.toContain('\n')
        expect([...note].length).toBeLessThanOrEqual(UNSPACED.has(locale) ? 28 : 56)
      }
    }
  )

  test.each(LOCALES)('%s: the shorts are five different lines', locale => {
    const modes = TRANSLATIONS[locale].settings.permissions.modes

    expect(new Set(PERMISSION_MODES.map(mode => modes[mode].short)).size).toBe(PERMISSION_MODES.length)
  })
})

describe('B2-n4 (round-1 B-n5): the pt-PT Automatic short names what it runs', () => {
  test('reads "Edita, corre comandos seguros", never the bare "corre o seguro"', () => {
    expect(TRANSLATIONS['pt-PT'].settings.permissions.modes.automatic.short).toBe('Edita, corre comandos seguros')
  })
})
