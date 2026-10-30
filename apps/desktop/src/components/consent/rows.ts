import { enConsent } from '@/i18n/en'

import { isTranslatedBank } from './copy'
import type { ConsentBank } from './copy'
import {
  type BundledPolicy,
  CONSENT_CAPABILITY_KEYS,
  CONSENT_DEVICE_KEYS,
  CONSENT_NEVER_USED,
  type ConsentSwitchKey
} from './types'

interface ConsentRow {
  key: ConsentSwitchKey
  name: string
  purpose: string
  effect: string
}

interface ConsentGroup {
  id: 'capabilities' | 'device'
  title: string
  hint: string
  rows: ConsentRow[]
}

/** A row's name and purpose: the policy's §9 table when it has the row, else the app's copy within the policy.
 *  A translated bank carries every row itself: the policy is English (U2-p2b-01), so its table names come last there. */
export function consentRow(policy: BundledPolicy, key: ConsentSwitchKey, bank: ConsentBank = enConsent): ConsentRow {
  const fromPolicy = policy.permissions.find(row => row.key === key)
  const own = (bank.rows as Partial<Record<ConsentSwitchKey, { name: string; purpose: string }>>)[key]
  const translated = isTranslatedBank(bank)

  return {
    key,
    name: (translated ? (own?.name ?? fromPolicy?.name) : (fromPolicy?.name ?? own?.name)) ?? key,
    purpose: (translated ? (own?.purpose ?? fromPolicy?.purpose) : (fromPolicy?.purpose ?? own?.purpose)) ?? '',
    // The Keychain row's effect must read true beside either state pill (UF2C-c2-01): the where-to-change sentence.
    effect: key === 'keychain' ? bank.sheet.keychainChange : bank.effect[key]
  }
}

/** The switches, in the order the sheet and Settings › Privacy show them. */
export function consentGroups(policy: BundledPolicy, bank: ConsentBank = enConsent): ConsentGroup[] {
  return [
    {
      id: 'capabilities',
      title: bank.groups.capabilities,
      hint: bank.groups.capabilitiesHint,
      rows: CONSENT_CAPABILITY_KEYS.map(key => consentRow(policy, key, bank))
    },
    {
      id: 'device',
      title: bank.groups.device,
      hint: bank.groups.deviceHint,
      rows: CONSENT_DEVICE_KEYS.map(key => consentRow(policy, key, bank))
    }
  ]
}

export const neverUsedRows = (bank: ConsentBank = enConsent) =>
  CONSENT_NEVER_USED.map(key => ({ key, name: bank.neverUsed[key].name, line: bank.neverUsed[key].line }))

/** The name an agent request shows ("Your agent needs Terminal commands"). */
export const permissionName = (
  policy: BundledPolicy | null | undefined,
  key: ConsentSwitchKey,
  bank: ConsentBank = enConsent
) => (policy ? consentRow(policy, key, bank).name : ((bank.rows as Record<string, { name: string }>)[key]?.name ?? key))
