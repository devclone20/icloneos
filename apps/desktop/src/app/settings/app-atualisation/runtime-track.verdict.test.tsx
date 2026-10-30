import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Locale } from '@/i18n/types'
import { $agentCompatFlag, __resetAgentUpdate } from '@/store/agent-update'
import { $runtimeStatus } from '@/store/iclone-updates'
import { $desktopVersion, $updatePolicy, $updateStatus } from '@/store/updates'
import type { IcloneRuntimeStatus } from '@/types/iclone-updates'

import { updatesCopy } from '../machine/updates-copy'

import { agentUpdateCopy, type AgentVerdict, agentVerdictWords } from './agent-model'
import { RuntimeTrack } from './runtime-track'

const PIN = '1ac3f97fbe0958aa2743c0c26202b20b3b4e760e'
const LOCALES: Locale[] = ['en', 'ja', 'zh', 'zh-hant', 'ar', 'pt-PT']
const VERDICTS: AgentVerdict[] = ['verified', 'verified-but-flagged', 'newer', 'unknown']
const ENGINE_WORDS = /amber|green|\bred\b|roots|unverified/i

function runtimeAtPin(): IcloneRuntimeStatus {
  return {
    available: true,
    backupZip: null,
    branch: 'main',
    dirty: false,
    head: { date: '2026-10-06T10:00:00Z', sha: PIN, short: PIN.slice(0, 7), subject: 'pin' },
    readAt: new Date().toISOString(),
    receipt: null,
    rollbackClones: [],
    runtimeRoot: '/h/hermes-agent',
    shallow: false,
    updaterRoot: '/h/hermes-agent',
    updaterRootIsRuntime: true,
    version: '0.21.5'
  }
}

beforeEach(() => {
  __resetAgentUpdate()
  $agentCompatFlag.set(null)
  $desktopVersion.set({ appVersion: '0.0.3', runtimeVersion: '0.21.5' } as never)
  $updateStatus.set(null)
  $updatePolicy.set({
    align: null,
    override: null,
    packaged: true,
    pin: { date: '2026-10-06', sha: PIN, verified: 'amber:3-roots' },
    policy: 'curated',
    runtimeCheckOff: true
  })
  $runtimeStatus.set(runtimeAtPin())
})

afterEach(() => {
  cleanup()
  $runtimeStatus.set(null)
  $updatePolicy.set(null)
})

describe('runtime track — the pin line speaks the verdict, never the engine string (V3-0b item 1)', () => {
  it('shows the pinned runtime as verified with this release, without amber:3-roots', () => {
    const { container } = render(<RuntimeTrack />)

    expect(container.textContent).not.toMatch(/amber:3-roots/)
    expect(
      screen.getByText(updatesCopy('en').runtimeIsPin('1ac3f97', '2026-10-06', agentUpdateCopy('en').verified))
    ).toBeTruthy()
  })

  it('names a flagged pin with the Installed pill words', () => {
    $agentCompatFlag.set({ at: '2026-10-21T08:00:00Z', red: true, verdict: 'RED' })
    const { container } = render(<RuntimeTrack />)
    const en = agentUpdateCopy('en')

    expect(container.textContent).toContain(`${en.verified} · ${en.compatibility(en.compatibilityWords.RED)}`)
    expect(container.textContent).not.toMatch(/amber:3-roots/)
  })

  it.each(LOCALES)('every verdict has catalogue words in %s and none is an engine string', locale => {
    const copy = agentUpdateCopy(locale)

    for (const verdict of VERDICTS) {
      const words = agentVerdictWords(verdict, copy)
      const line = updatesCopy(locale).runtimeIsPin('1ac3f97', '2026-10-06', words)

      expect(words.length).toBeGreaterThan(0)
      expect(line).toContain(words)
      expect(line).not.toMatch(ENGINE_WORDS)
    }

    expect(agentVerdictWords('verified', copy)).toBe(copy.verified)
    expect(agentVerdictWords('newer', copy)).toBe(copy.newer)
  })

  it('every non-English locale translates the pin sentences', () => {
    const en = updatesCopy('en')

    for (const locale of LOCALES.filter(l => l !== 'en')) {
      expect(updatesCopy(locale).runtimeIsPin('x', 'y', 'z')).not.toBe(en.runtimeIsPin('x', 'y', 'z'))
      expect(updatesCopy(locale).runtimeOffPin('x', 'y', 'h')).not.toBe(en.runtimeOffPin('x', 'y', 'h'))
    }
  })
})
