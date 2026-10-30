import { describe, expect, it } from 'vitest'

import { arAgentUpdate } from '@/i18n/ar'
import { enAgentUpdate } from '@/i18n/en'
import { keybinds as enKeybinds } from '@/i18n/en/keybinds'
import { jaAgentUpdate } from '@/i18n/ja'
import { keybinds as jaKeybinds } from '@/i18n/ja/keybinds'
import { ptPtAgentUpdate } from '@/i18n/pt-PT'
import { keybinds as ptPtKeybinds } from '@/i18n/pt-PT/keybinds'
import type { Locale } from '@/i18n/types'
import { zhAgentUpdate } from '@/i18n/zh'
import { zhHantAgentUpdate } from '@/i18n/zh-hant'
import { keybinds as zhHantKeybinds } from '@/i18n/zh-hant/keybinds'
import { COMPLETION_SOUND_VARIANTS, completionSoundName } from '@/lib/completion-sound'

import { withAgentUpdateWords } from './agent-update-words'

const LOCALES: Locale[] = ['en', 'ja', 'zh', 'zh-hant', 'ar', 'pt-PT']

const BASE = {
  ar: arAgentUpdate,
  en: enAgentUpdate,
  ja: jaAgentUpdate,
  zh: zhAgentUpdate,
  'zh-hant': zhHantAgentUpdate,
  'pt-PT': ptPtAgentUpdate
}

describe('Machine words without the runtime (S27.1)', () => {
  it('the agent-update rows a person reads never name the upstream, in any locale', () => {
    for (const locale of LOCALES) {
      const copy = withAgentUpdateWords(BASE[locale], locale)

      const shown = [
        copy.latest,
        copy.offline,
        copy.unavailable,
        copy.confirmFetch,
        copy.applyErrors['origin-mismatch'],
        copy.aboutTitle,
        copy.aboutVerified('v1.2.3'),
        copy.aboutNewer('v1.2.3')
      ]

      expect(shown.filter(line => /hermes|nous/i.test(line))).toEqual([])
      expect(copy.aboutVerified('v1.2.3')).toContain('v1.2.3')
    }
  })

  it('names every completion sound in the other five locales', () => {
    for (const locale of ['ja', 'zh', 'zh-hant', 'ar', 'pt-PT'] as const) {
      for (const variant of COMPLETION_SOUND_VARIANTS) {
        expect(completionSoundName(variant, locale)).not.toBe(variant.name)
      }
    }

    expect(completionSoundName(COMPLETION_SOUND_VARIANTS[0], 'en')).toBe(COMPLETION_SOUND_VARIANTS[0].name)
  })

  it('ja, zh-hant and pt-PT name every shortcut action, never in English', () => {
    const actions = Object.entries(enKeybinds.actions)

    for (const catalogue of [jaKeybinds, zhHantKeybinds, ptPtKeybinds]) {
      for (const [id, english] of actions) {
        const name = (catalogue.actions as Record<string, string>)[id]

        expect(name, id).toBeTruthy()
        expect(name, id).not.toBe(english)
      }
    }
  })
})
