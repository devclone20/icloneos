import { describe, expect, it } from 'vitest'

import { ar } from '@/i18n/ar'
import { en } from '@/i18n/en'
import { ja } from '@/i18n/ja'
import { ptPt } from '@/i18n/pt-PT'
import { zh } from '@/i18n/zh'
import { zhHant } from '@/i18n/zh-hant'

// ⌃` opens iT (shellViewHandlers → toggleItSurface), so the catalogue and the
// ⌘K row must name the product's door, not upstream's "terminal" (U2-p2-05).
// `ja` and `zh-hant` carry no keybinds domain file and inherit `en`.
describe('the ⌃` door is named iT in every locale (U2-p2-05)', () => {
  it.each([
    ['en', en],
    ['zh', zh],
    ['zh-hant', zhHant],
    ['ja', ja],
    ['ar', ar],
    ['pt-PT', ptPt]
  ])('%s', (_locale, translations) => {
    const label = translations.keybinds.actions['view.showTerminal']

    expect(label).toContain('iT')
    expect(label).not.toMatch(/terminal|终端|終端|الطرفية/i)
  })
})
