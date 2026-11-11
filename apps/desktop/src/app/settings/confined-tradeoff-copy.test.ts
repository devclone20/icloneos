// V3-UP r4 (UP4-3, critic r3 m1) + r5 (critic r4 m3): while the agent is confined, file copies before edits (Settings › Safety), code
// checks after edits, delegated work copies and hooks are off. The Safety switch says so, and the Containers verdicts name the
// trade-off, in all six locales. No control turns confinement off (the rail names the tab Machine), so the Safety switch points at
// no "This Mac" choice; the Containers verdict lines are pinned by their own tests.
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

const MAC = /This Mac|Este Mac|この Mac|这台 Mac|這台 Mac|هذا الـ Mac/

// Each Safety switch line says the copies are off while the agent is confined, in its own words.
const CASES = [
  ['en', fieldCopyForSchemaKey(en, 'checkpoints.enabled'), enConf, 'Off while your agent is confined'],
  ['ja', fieldCopyForSchemaKey(ja, 'checkpoints.enabled'), jaConf, 'エージェントが隔離されている間はオフです'],
  ['zh', fieldCopyForSchemaKey(zh, 'checkpoints.enabled'), zhConf, '智能体处于隔离时此项关闭'],
  ['zh-hant', fieldCopyForSchemaKey(zhHant, 'checkpoints.enabled'), zhHantConf, '智慧代理處於隔離時此項關閉'],
  ['pt-PT', fieldCopyForSchemaKey(ptPt, 'checkpoints.enabled'), ptConf, 'Desligado enquanto o agente está confinado'],
  ['ar', arLocale.settings.fieldDescriptions['checkpoints.enabled'], arConf, 'متوقف ما دام وكيلك معزولاً']
] as const

describe('confinement turns file copies off, and the copy says so', () => {
  it.each(CASES)(
    '%s: the Safety switch names the trade-off and no control that does not exist; the verdicts name the trade-off',
    (_l, hint, conf, offWhileConfined) => {
      expect(hint).toContain(offWhileConfined)
      expect(hint).not.toMatch(MAC)
      expect(conf.verdict.green.hint.length).toBeGreaterThan(conf.verdict.red.hint.length)

      // V3-UP r5 (critic r4 m3): MCP servers do not start at all while confined — the Containers pane says so
      // (they were once listed as "not confined, governed by your permission mode"), and that they run again when it is off
      for (const text of [conf.scope, conf.verdict.green.hint, conf.verdict.off.hint]) {
        expect(text).toContain('MCP')
      }

      // The owner's product name only: the user never reads the runtime's name.
      expect(conf.scope).not.toContain('Hermes')
    }
  )
})
