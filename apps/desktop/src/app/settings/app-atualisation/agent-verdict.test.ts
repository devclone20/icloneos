import { describe, expect, it } from 'vitest'

import type { IcloneAgentUpdateCheck, IcloneRuntimeStatus, IcloneUpdatePolicyInfo } from '@/types/iclone-updates'

import { aboutAgentLine, aboutAgentTone, agentUpdateCopy, agentVerdict, installedAgent } from './agent-model'

const SHA = '1ac3f97aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function policyWithPin(sha: string): IcloneUpdatePolicyInfo {
  return { pin: { sha } } as unknown as IcloneUpdatePolicyInfo
}

function runtimeAt(sha: string): IcloneRuntimeStatus {
  return { head: { sha, date: '2026-10-06T00:00:00Z' }, branch: 'main', dirty: false } as unknown as IcloneRuntimeStatus
}

function checkWith(verifiedWithRelease: boolean): IcloneAgentUpdateCheck {
  return {
    installed: { sha: SHA, version: '0.21.5', date: null, branch: 'main', dirty: false, verifiedWithRelease }
  } as unknown as IcloneAgentUpdateCheck
}

// U5-p2b-01: Updates (pill + alert) and About read ONE verdict. For sha == pin it is never 'newer', whatever the
// compat engine cached; the flag can only qualify the verified pin.
describe('agentVerdict', () => {
  it('is verified for sha == pin and never contradicts itself under a red compat flag', () => {
    const installed = installedAgent(checkWith(true), null, null, policyWithPin(SHA))

    expect(agentVerdict(installed, false)).toBe('verified')
    expect(agentVerdict(installed, true)).toBe('verified-but-flagged')
    expect(agentVerdict(installed, true)).not.toBe('newer')
  })

  it('reads the same verdict from the local pin when no check has run yet (the About path)', () => {
    const installed = installedAgent(null, runtimeAt(SHA), '0.21.5', policyWithPin(SHA))

    expect(installed?.verifiedWithRelease).toBe(true)
    expect(agentVerdict(installed, false)).toBe('verified')
  })

  it('is newer only when the installed sha is not the pin, and unknown without an installed agent', () => {
    expect(agentVerdict(installedAgent(checkWith(false), null, null, policyWithPin(SHA)), true)).toBe('newer')
    expect(agentVerdict(installedAgent(null, null, null, policyWithPin(SHA)), true)).toBe('unknown')
  })
})

const LOCALES = ['en', 'ja', 'zh', 'zh-hant', 'ar', 'pt-PT'] as const
const RAW_KEY = /\b(RED|AMBER|GREEN|UNKNOWN)\b/

// U5-p2b-02 + lead addition (1): the pill words and About's line come from the same verdict, in every locale, and the
// engine's verdict keys never reach a sentence a person reads.
describe('one verdict, one vocabulary', () => {
  it.each(LOCALES)('%s: About says flagged exactly when Updates does (sha == pin, flag red)', locale => {
    const copy = agentUpdateCopy(locale)
    const installed = installedAgent(checkWith(true), null, '0.21.5', policyWithPin(SHA))
    const verdict = agentVerdict(installed, true)

    expect(verdict).toBe('verified-but-flagged')
    expect(aboutAgentLine(verdict, '0.21.5', copy)).toBe(copy.aboutFlagged('0.21.5'))
    expect(aboutAgentLine(agentVerdict(installed, false), '0.21.5', copy)).toBe(copy.aboutVerified('0.21.5'))
    expect(
      aboutAgentLine(
        agentVerdict(installedAgent(checkWith(false), null, '0.21.5', policyWithPin('f'.repeat(40))), false),
        '0.21.5',
        copy
      )
    ).toBe(copy.aboutNewer('0.21.5'))
  })

  it.each(LOCALES)('%s: no raw verdict key in the compatibility words or the About lines', locale => {
    const copy = agentUpdateCopy(locale)

    for (const key of ['AMBER', 'GREEN', 'RED', 'UNKNOWN'] as const) {
      expect(copy.compatibility(copy.compatibilityWords[key])).not.toMatch(RAW_KEY)
    }

    expect(copy.aboutFlagged('0.21.5')).not.toMatch(RAW_KEY)
    expect(copy.compatFlagged).not.toMatch(RAW_KEY)
  })
})

describe('About status icon follows the verdict (V3-0)', () => {
  it('a green check only for verified; the warning for flagged; nothing where nothing was verified', () => {
    expect(aboutAgentTone('verified')).toBe('verified')
    expect(aboutAgentTone('verified-but-flagged')).toBe('flagged')
    expect(aboutAgentTone('newer')).toBe('none')
    expect(aboutAgentTone('unknown')).toBe('none')
  })
})
