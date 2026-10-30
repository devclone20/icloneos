// V3-UP r4 (UP4-3, critic r3 m1) + r5 (critic r4 m3): while the agent is confined, file copies before edits (Settings › Safety), code
// checks after edits, delegated work copies and hooks are off. The Safety switch says so and how to get it back, and
// both sandbox choices (Confined / This Mac) name the trade-off — in all six locales.
import { describe, expect, it } from 'vitest'

import { FIELD_DESCRIPTIONS as en } from '@/app/settings/constants'
import { fieldCopyForSchemaKey } from '@/app/settings/field-copy'
import { ar as arLocale } from '@/i18n/ar'
import { confinement as arConf } from '@/i18n/ar/confinement'
import { confinement as enConf } from '@/i18n/en/confinement'
import { confinement as jaConf } from '@/i18n/ja/confinement'
import { fieldDescriptions as ja } from '@/i18n/ja/settingsFieldCopy'
import { confinement as ptConf } from '@/i18n/pt-PT/confinement'
import { fieldDescriptions as ptPt } from '@/i18n/pt-PT/settingsFieldCopy'
import { confinement as zhHantConf } from '@/i18n/zh-hant/confinement'
import { fieldDescriptions as zhHant } from '@/i18n/zh-hant/settingsFieldCopy'
import { confinement as zhConf } from '@/i18n/zh/confinement'
import { fieldDescriptions as zh } from '@/i18n/zh/settingsFieldCopy'

const CASES = [
  ['en', fieldCopyForSchemaKey(en, 'checkpoints.enabled'), enConf, 'This Mac'],
  ['ja', fieldCopyForSchemaKey(ja, 'checkpoints.enabled'), jaConf, 'この Mac'],
  ['zh', fieldCopyForSchemaKey(zh, 'checkpoints.enabled'), zhConf, '这台 Mac'],
  ['zh-hant', fieldCopyForSchemaKey(zhHant, 'checkpoints.enabled'), zhHantConf, '這台 Mac'],
  ['pt-PT', fieldCopyForSchemaKey(ptPt, 'checkpoints.enabled'), ptConf, 'Este Mac'],
  ['ar', arLocale.settings.fieldDescriptions['checkpoints.enabled'], arConf, 'هذا الـ Mac']
] as const

describe('confinement turns file copies off, and the copy says so', () => {
  it.each(CASES)(
    '%s: the Safety switch and both sandbox choices name the trade-off and the way back',
    (_l, hint, conf, mac) => {
      expect(hint).toContain(mac)
      expect(conf.verdict.green.hint).toContain(mac)
      expect(conf.verdict.off.hint).toContain(mac)
      expect(conf.verdict.green.hint.length).toBeGreaterThan(conf.verdict.red.hint.length)
      // V3-UP r5 (critic r4 m3): MCP servers do not start at all while confined — the Containers pane says so
      // (they were once listed as "not confined, governed by your permission mode"), and that This Mac brings them back
      for (const text of [conf.scope, conf.verdict.green.hint, conf.verdict.off.hint]) {
        expect(text).toContain('MCP')
      }

      expect(conf.scope).toContain('Hermes')
    }
  )
})
