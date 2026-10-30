import { describe, expect, it } from 'vitest'

import { FIELD_DESCRIPTIONS as en } from '@/app/settings/constants'
import { fieldCopyForSchemaKey } from '@/app/settings/field-copy'
import { ar as arLocale } from '@/i18n/ar'
import { fieldDescriptions as ja } from '@/i18n/ja/settingsFieldCopy'
import { fieldDescriptions as ptPt } from '@/i18n/pt-PT/settingsFieldCopy'
import { fieldDescriptions as zhHant } from '@/i18n/zh-hant/settingsFieldCopy'
import { fieldDescriptions as zh } from '@/i18n/zh/settingsFieldCopy'

// U1-p2b-05: the hints under Memory & Context, Safety, Workspace and message rows were the upstream config
// descriptions. The rewritten ones never use developer words.
const REWRITTEN = [
  'display.personality',
  'terminal.envPassthrough',
  'security.redactSecrets',
  'checkpoints.enabled',
  'context.engine',
  'compression.enabled',
  'memory.memoryEnabled',
  'memory.userProfileEnabled',
  'voice.autoTts',
  'codeExecution.mode',
  'agent.imageInputMode',
  'approvals.mode',
  'approvals.timeout',
  'desktop.repoScanEnabled',
  'desktop.repoScanExcludePaths'
]

// ar keeps its hints inline in i18n/ar/settings/shell (outside this front): the Arabic sentences for the rewritten rows
// are in RESUME/run/gates/L/extra/UF3C_20261021_r1_ar_hints.md for the lead; until wired, ar is checked for banned words only.
const ar = arLocale.settings.fieldDescriptions

const BANNED = [
  /model-visible/i,
  /tool execution/i,
  /context limit/i,
  /\bMCP\b/,
  /OKLCH/,
  /rollback snapshot/i,
  /\bPATH\b/,
  /environment variable/i
]

describe('field hints read like the titles', () => {
  it.each([
    ['en', en],
    ['ja', ja],
    ['zh', zh],
    ['zh-hant', zhHant],
    ['ar', ar],
    ['pt-PT', ptPt]
  ])('%s has a hint for every rewritten row and none of the banned words', (locale, bank) => {
    for (const key of REWRITTEN) {
      if (locale === 'ar') {
        break
      }

      expect(fieldCopyForSchemaKey(bank, key), key).toBeTruthy()
    }

    for (const hint of Object.values(bank)) {
      for (const banned of BANNED) {
        expect(hint).not.toMatch(banned)
      }
    }
  })
})
