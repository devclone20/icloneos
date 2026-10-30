import { describe, expect, test } from 'vitest'

import { TRANSLATIONS } from './catalog'
import type { Locale } from './types'

/**
 * V3-S r3 (m-e): the permission-gate copy in every locale. The gate can be installed and still not active (disabled
 * via config, not armed), so no title may say "not installed" (round 1 m3 fixed pt-PT only; the Arabic title still
 * said it). The Open-in-terminal backstop toast is the locale's own text, never main's English reason.
 */
const INSTALLED: Record<Locale, RegExp> = {
  ar: /مثب/,
  en: /install/i,
  ja: /インストール|配置/,
  'pt-PT': /instalad/i,
  zh: /安装|就位/,
  'zh-hant': /安裝|就位/
}

const locales = Object.keys(TRANSLATIONS) as Locale[]

describe('the permission-gate copy', () => {
  test('every locale is covered', () => {
    expect(locales.sort()).toEqual((Object.keys(INSTALLED) as Locale[]).sort())
  })

  test.each(locales)('%s: the gate title says the gate is not active, never that it is not installed', locale => {
    const { gateTitle } = TRANSLATIONS[locale].boot.failure

    expect(gateTitle).not.toMatch(INSTALLED[locale])
    expect(gateTitle.length).toBeGreaterThan(5)

    if (locale !== 'en') {
      expect(gateTitle).not.toBe(TRANSLATIONS.en.boot.failure.gateTitle)
    }
  })

  test.each(locales.filter(locale => locale !== 'en'))(
    '%s: the Open-in-terminal refusal is translated, and carries no gate mark',
    locale => {
      const { openInTerminal, openInTerminalGateRefused } = TRANSLATIONS[locale].sidebar.row

      expect(openInTerminalGateRefused).not.toBe(TRANSLATIONS.en.sidebar.row.openInTerminalGateRefused)
      expect(openInTerminal).not.toBe(TRANSLATIONS.en.sidebar.row.openInTerminal)
      expect(openInTerminalGateRefused).not.toContain('[iclone-gate]')
    }
  )

  test.each(locales)(
    '%s: m-g — the unmanaged-runtime hint names the git checkout and the locale’s own Repair label',
    locale => {
      const { gateHintUnmanaged, repairInstall } = TRANSLATIONS[locale].boot.failure

      expect(gateHintUnmanaged).toContain('git')
      expect(gateHintUnmanaged).toContain('Hermes')
      expect(gateHintUnmanaged).toContain(repairInstall)
      expect(gateHintUnmanaged).not.toContain('[iclone-gate')

      if (locale !== 'en') {
        expect(gateHintUnmanaged).not.toBe(TRANSLATIONS.en.boot.failure.gateHintUnmanaged)
      }
    }
  )

  test('pt-PT: European Portuguese, formal (no gerúndio, no "você", "aplicação" not "app")', () => {
    const { gateHintUnmanaged } = TRANSLATIONS['pt-PT'].boot.failure

    expect(gateHintUnmanaged).not.toMatch(/ando\b|endo\b|indo\b|você|\bapp\b|arquivo|usuário/i)
    expect(gateHintUnmanaged).toMatch(/a sua/)
  })
})
