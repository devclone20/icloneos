// The control that turns confinement off is real (F41): the Backends tab of Containers, and Settings. Nothing in the app
// is labelled "This Mac", so the copy may name those two and never that one. The off note says what is lost in every mode
// (S8), in every locale: it names no single mode, because no mode keeps a command in.
import { describe, expect, it } from 'vitest'

import { CONFINEMENT_COPY } from '@/app/home/containers/containers-copy'
import { FIELD_DESCRIPTIONS as en } from '@/app/settings/constants'
import { fieldCopyForSchemaKey } from '@/app/settings/field-copy'
import { ar as arLocale } from '@/i18n/ar'
import { arPermissions } from '@/i18n/ar/permissions'
import { enPermissions } from '@/i18n/en/enPermissions'
import { jaPermissions } from '@/i18n/ja/permissions'
import { fieldDescriptions as ja } from '@/i18n/ja/settingsFieldCopy'
import { ptPtPermissions } from '@/i18n/pt-PT/permissions'
import { fieldDescriptions as ptPt } from '@/i18n/pt-PT/settingsFieldCopy'
import { zhHantPermissions } from '@/i18n/zh-hant/permissions'
import { fieldDescriptions as zhHant } from '@/i18n/zh-hant/settingsFieldCopy'
import { zhPermissions } from '@/i18n/zh/permissions'
import { fieldDescriptions as zh } from '@/i18n/zh/settingsFieldCopy'

const MAC = /This Mac|Este Mac|この Mac|这台 Mac|這台 Mac|هذا الـ Mac/
// The mode names of each locale, as the old off note used them to limit what off loses.
const A_SINGLE_MODE = /Ignore permissions|Automatic|Ignorar permissões|Automático|権限を無視|自動|忽略权限|自动|忽略權限|自動|تجاهل الأذونات|تلقائي/

const CASES = [
  ['en', enPermissions.shellNote, fieldCopyForSchemaKey(en, 'checkpoints.enabled')],
  ['pt-PT', ptPtPermissions.shellNote, fieldCopyForSchemaKey(ptPt, 'checkpoints.enabled')],
  ['ja', jaPermissions.shellNote, fieldCopyForSchemaKey(ja, 'checkpoints.enabled')],
  ['zh', zhPermissions.shellNote, fieldCopyForSchemaKey(zh, 'checkpoints.enabled')],
  ['zh-hant', zhHantPermissions.shellNote, fieldCopyForSchemaKey(zhHant, 'checkpoints.enabled')],
  ['ar', arPermissions.shellNote, arLocale.settings.fieldDescriptions['checkpoints.enabled']]
] as const

describe('the confinement copy points at no control that does not exist', () => {
  it.each(CASES)('%s: the Permissions note and the Safety switch name no "This Mac"', (_locale, note, safety) => {
    expect(note.on).not.toMatch(MAC)
    expect(note.off).not.toMatch(MAC)
    expect(safety).not.toMatch(MAC)
  })

  it.each(CASES)('%s: the off and red notes name no single mode, because off loses the same in all of them', (_locale, note) => {
    expect(note.off).not.toMatch(A_SINGLE_MODE)
    expect(note.red).not.toMatch(A_SINGLE_MODE)
  })

  it('en: the control the copy names is the tab the rail shows', () => {
    expect(CONFINEMENT_COPY.en.ledger.tabs.machine).toBe('Backends')
    expect(CONFINEMENT_COPY.en.verdict.green.hint).toContain(`You can turn isolation off in ${CONFINEMENT_COPY.en.ledger.tabs.machine} or in Settings`)
  })

  it('en: the exact lines', () => {
    expect(enPermissions.shellNote.on).toBe(
      'Confinement is on, and you can turn it off. Agent commands run confined (Seatbelt) in every mode, Ignore permissions included: they write only in the project and a scratch folder, and reach the network only when the mode or a grant allows it. A shell command you approve runs once outside it.'
    )
    expect(enPermissions.shellNote.off).toBe(
      'Confinement is off: commands run as you, in every mode, and can read and change anything you can.'
    )
    expect(fieldCopyForSchemaKey(en, 'checkpoints.enabled')).toBe(
      'A copy of each file is kept before your agent changes it, so you can go back. Off while your agent is confined.'
    )
  })
})
