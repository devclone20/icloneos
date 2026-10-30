import { describe, expect, it } from 'vitest'

import { enConsent, PRODUCT_NAME } from '@/i18n/en/enConsent'

import { BUNDLED_POLICY } from '../../../electron/policy-version.generated'

import { consentBankFor, isTranslatedBank } from './copy'
import { bundledPolicy } from './fixtures'
import { consentRow } from './rows'

/** Owner decision (2026-10-20): the legal document keeps its title 'icloneOS Policies & Privacy' (title, §short, §9 intro). */
const BRAND_IN_LEGAL_TEXT = 3

/** Every sentence a catalogue node can show; template functions are called with sample arguments. */
function sentences(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') {
    out.push(node)
  } else if (typeof node === 'function') {
    out.push(String((node as (...args: unknown[]) => unknown)('1.0', '9 October 2026', 2)))
  } else if (node && typeof node === 'object') {
    Object.values(node).forEach(value => sentences(value, out))
  }

  return out
}

// U1-12-p2: the sheet said "icloneOS" three times under a wordmark that reads "iclone os".
describe('consent copy brand (U1-12-p2)', () => {
  it('spells the product as the wordmark everywhere and names the pane Gateways', async () => {
    const all = sentences(enConsent)

    expect(PRODUCT_NAME).toBe('iclone os')
    expect(all.filter(line => /icloneOS/.test(line))).toEqual([])
    expect(all.filter(line => /› Gateway(?!s)/.test(line))).toEqual([])
    expect(all.some(line => line.includes(PRODUCT_NAME))).toBe(true)

    // The legal text is read from the artefact the app ships (ruling §3), never from a copy: the UI names the document
    // by that title (terms-step.test.tsx) and spells only its own prose as the wordmark. Pinned so a change is noticed.
    expect(sentences(BUNDLED_POLICY).filter(line => /icloneOS/.test(line))).toHaveLength(BRAND_IN_LEGAL_TEXT)
  })
})

// UF2C-c2-01: the Keychain effect sits beside a state pill ("Encrypted" / "Not encrypted") in Settings › Privacy,
// so neither the catalogue sentence nor the row it feeds may assert a state.
describe('consent keychain effect is state-neutral (UF2C-c2-01)', () => {
  const STATEFUL = /Not encrypted|plain text|encrypted with|without Keychain/

  it('enConsent.effect.keychain names no state', () => {
    expect(enConsent.effect.keychain).not.toMatch(STATEFUL)
  })

  it('the keychain row effect names no state', () => {
    expect(consentRow(bundledPolicy, 'keychain').effect).not.toMatch(STATEFUL)
    expect(consentRow(bundledPolicy, 'keychain').effect).toBe(enConsent.sheet.keychainChange)
  })
})

describe('isTranslatedBank', () => {
  it('is false for the English bank only (rows.ts and terms-step.tsx share this one predicate)', () => {
    expect(isTranslatedBank(enConsent)).toBe(false)
    expect(isTranslatedBank(consentBankFor('en'))).toBe(false)

    for (const locale of ['ja', 'zh', 'zh-hant', 'ar', 'pt-PT'] as const) {
      expect(isTranslatedBank(consentBankFor(locale)), locale).toBe(true)
    }
  })
})
