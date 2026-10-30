import { describe, expect, it } from 'vitest'

import { ar } from '@/i18n/ar'
import { en } from '@/i18n/en'
import { ja } from '@/i18n/ja'
import { ptPt } from '@/i18n/pt-PT'
import type { Locale } from '@/i18n/types'
import { zh } from '@/i18n/zh'
import { zhHant } from '@/i18n/zh-hant'

import { diagnosticsCopy } from './diagnostics-copy'

// U2-p2b-10: every HUD and Diagnostics row a person can act on carries a hint in the voice of its title, in the six
// locales, and none of the hints leans on developer words.
const BANNED = [/\bMCP\b/, /\bPATH\b/, /OKLCH/, /\bIPC\b/, /\bCDP\b/, /stdout|stderr/i]

const LOCALES: Array<[Locale, { settings: { hud: Record<string, unknown> } }]> = [
  ['en', en],
  ['ja', ja],
  ['zh', zh],
  ['zh-hant', zhHant],
  ['ar', ar],
  ['pt-PT', ptPt]
]

describe('HUD and Diagnostics rows carry hints a person understands', () => {
  it.each(LOCALES)('%s: the HUD open and rebind rows have hints', (_locale, bank) => {
    for (const key of ['openNowHint', 'rebindHint', 'openHint', 'introHint']) {
      const hint = bank.settings.hud[key]

      expect(typeof hint, key).toBe('string')
      expect((hint as string).length, key).toBeGreaterThan(10)

      for (const banned of BANNED) {
        expect(hint, key).not.toMatch(banned)
      }
    }
  })

  it.each(LOCALES.map(([locale]) => locale))(
    '%s: the Diagnostics permission, copy and logs rows have hints',
    locale => {
      const copy = diagnosticsCopy(locale)

      for (const hint of [copy.permissionHint, copy.copyHint, copy.logsHint, copy.sendHint]) {
        expect(hint.length).toBeGreaterThan(10)

        for (const banned of BANNED) {
          expect(hint).not.toMatch(banned)
        }
      }

      // FX-7: the report is saved to a file; no third party is named as a recipient any more.
      expect(copy.sendTitle).not.toMatch(/Nous/)
    }
  )
})
