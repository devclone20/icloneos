/**
 * V3-S r4 (lead ruling 36): when a checkout chosen with the dev-backend setting runs instead of the app's own runtime,
 * Settings › Updates › Agent says "unmanaged runtime" — with an existing pill tone (design freeze), in every locale.
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { arAgentUpdate } from '@/i18n/ar/arAgentUpdate'
import { enAgentUpdate } from '@/i18n/en'
import { jaAgentUpdate } from '@/i18n/ja/jaAgentUpdate'
import { ptPtAgentUpdate } from '@/i18n/pt-PT/ptPtAgentUpdate'
import { zhHantAgentUpdate } from '@/i18n/zh-hant/zhHantAgentUpdate'
import { zhAgentUpdate } from '@/i18n/zh/zhAgentUpdate'
import { __resetAgentUpdate } from '@/store/agent-update'
import { $runtimeStatus } from '@/store/iclone-updates'
import type { IcloneRuntimeStatus } from '@/types/iclone-updates'

import { AgentUpdateSection } from './agent-section'

vi.mock('@/store/iclone-updates', () => ({
  $runtimeStatus: atom<IcloneRuntimeStatus | null>(null),
  loadRuntimeStatus: vi.fn()
}))

vi.mock('@/store/updates', () => ({
  $desktopVersion: atom({ runtimeVersion: '0.21.5' }),
  $updateOverlayTarget: atom('client'),
  $updatePolicy: atom(null),
  applyUpdates: vi.fn(),
  isCuratedPolicy: () => true,
  setUpdateOverlayOpen: vi.fn()
}))

const status = (unmanaged: boolean): IcloneRuntimeStatus =>
  ({
    available: true,
    backupZip: null,
    branch: 'main',
    dirty: false,
    head: { date: '2026-10-06T10:00:00Z', sha: 'a'.repeat(40), short: 'aaaaaaa', subject: 'x' },
    readAt: '2026-10-22T06:00:00Z',
    receipt: null,
    rollbackClones: [],
    runtimeRoot: '/h/.hermes/hermes-agent',
    shallow: false,
    unmanaged,
    updaterRoot: '/src/hermes',
    updaterRootIsRuntime: false,
    version: '0.21.5'
  }) as IcloneRuntimeStatus

describe('Settings › Updates › Agent — unmanaged runtime (ruling 36)', () => {
  beforeEach(() => {
    __resetAgentUpdate()
    ;(window as unknown as { hermesDesktop: Record<string, unknown> }).hermesDesktop = {
      agentUpdate: { lastCheck: vi.fn(async () => null) }
    }
  })

  afterEach(() => {
    cleanup()
    Reflect.deleteProperty(window, 'hermesDesktop')
  })

  it('labels a dev-backend checkout with an existing amber pill, and nothing for the app’s own runtime', async () => {
    $runtimeStatus.set(status(true))
    const { container, unmount } = render(<AgentUpdateSection />)
    await act(async () => undefined)

    const pill = screen.getByText(enAgentUpdate.unmanagedRuntime)

    expect(pill.closest('[data-agent-pill]')?.getAttribute('data-agent-pill')).toBe('AMBER')
    unmount()

    $runtimeStatus.set(status(false))
    render(<AgentUpdateSection />)
    await act(async () => undefined)

    expect(screen.queryByText(enAgentUpdate.unmanagedRuntime)).toBeNull()
    expect(container).toBeTruthy()
  })

  it('every locale names it, short, in its own words (pt-PT: European Portuguese)', () => {
    const all = {
      ar: arAgentUpdate.unmanagedRuntime,
      en: enAgentUpdate.unmanagedRuntime,
      ja: jaAgentUpdate.unmanagedRuntime,
      'pt-PT': ptPtAgentUpdate.unmanagedRuntime,
      zh: zhAgentUpdate.unmanagedRuntime,
      'zh-hant': zhHantAgentUpdate.unmanagedRuntime
    }

    expect(all['pt-PT']).toBe('Runtime não gerido')
    expect(new Set(Object.values(all)).size).toBe(6)

    for (const text of Object.values(all)) {
      expect(text.length).toBeGreaterThan(3)
      expect(text.length).toBeLessThanOrEqual(24)
    }
  })
})
