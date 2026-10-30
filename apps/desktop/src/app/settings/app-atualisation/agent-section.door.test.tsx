/**
 * K-RT3 (V3-RT): in 0.0.3 the agent runtime is built from icloneOS's repository and ships inside the app, so the upstream
 * "agent latest" door is closed: no check, no update, one sentence saying why — and a persisted 0.0.2 check that named an
 * update is never offered.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { enAgentUpdate } from '@/i18n/en'
import { ptPtAgentUpdate } from '@/i18n/pt-PT/ptPtAgentUpdate'
import { AGENT_UPDATE_DOOR_OPEN } from '@/iclone-shared/update-status'
import { __resetAgentUpdate } from '@/store/agent-update'
import type { IcloneAgentUpdateCheck, IcloneRuntimeStatus } from '@/types/iclone-updates'

import { AgentUpdateSection } from './agent-section'

vi.mock('@/store/iclone-updates', () => ({
  $runtimeStatus: atom<IcloneRuntimeStatus | null>(null),
  loadRuntimeStatus: vi.fn()
}))

vi.mock('@/store/updates', () => ({
  $desktopVersion: atom({ runtimeVersion: '0.21.5' }),
  $updateOverlayTarget: atom('client'),
  $updatePolicy: atom({
    pin: { date: '2026-10-22', sha: 'a'.repeat(40), verified: 'amber:3-roots' },
    policy: 'curated'
  }),
  applyUpdates: vi.fn(),
  isCuratedPolicy: () => true,
  setUpdateOverlayOpen: vi.fn()
}))

/** What 0.0.2 persisted after a click: an update to the upstream tip, available. */
const STALE_0_0_2_CHECK: IcloneAgentUpdateCheck = {
  checkedAt: '2026-10-21T08:00:00.000Z',
  compat: { findings: [], verdict: 'GREEN' },
  error: null,
  installed: {
    branch: null,
    date: null,
    dirty: null,
    sha: 'a'.repeat(40),
    version: '0.21.5',
    verifiedWithRelease: true
  },
  latest: {
    commitsNewer: 40,
    date: '2026-10-20T00:00:00Z',
    releaseTag: 'v0.22.2',
    sha: 'b'.repeat(40),
    version: '0.22.2'
  },
  updateAvailable: true,
  verified: { sha: 'a'.repeat(40), version: '0.21.5' }
}

describe('K-RT3: Settings › Updates › Agent with the upstream door closed', () => {
  let api: Record<string, ReturnType<typeof vi.fn>>

  beforeEach(() => {
    __resetAgentUpdate()
    api = {
      apply: vi.fn(),
      check: vi.fn(),
      gesture: vi.fn(),
      lastCheck: vi.fn(async () => STALE_0_0_2_CHECK)
    }
    ;(window as unknown as { hermesDesktop: Record<string, unknown> }).hermesDesktop = { agentUpdate: api }
  })

  afterEach(() => cleanup())

  it('the door is closed in this release', () => {
    expect(AGENT_UPDATE_DOOR_OPEN).toBe(false)
  })

  it('Check is disabled, no Update is offered, the reason is said, nothing is asked of main', async () => {
    const { container } = render(<AgentUpdateSection />)

    const check = await screen.findByRole('button', { name: new RegExp(enAgentUpdate.check) })
    expect((check as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(enAgentUpdate.doorClosed)).toBeTruthy()
    expect(container.querySelector('[data-agent-update-action="update"]')).toBeNull()
    expect(container.querySelector('[data-agent-update-action="review"]')).toBeNull()
    expect(api.lastCheck).not.toHaveBeenCalled()
    expect(api.check).not.toHaveBeenCalled()
    expect(api.apply).not.toHaveBeenCalled()
  })

  it('every locale says it (pt-PT per the style brief), and a main refusal reads the same', () => {
    expect(enAgentUpdate.doorClosed).toBe('Agent updates come with app updates in this version.')
    expect(ptPtAgentUpdate.doorClosed).toBe(
      'Nesta versão, as atualizações do agente chegam com as atualizações da aplicação.'
    )
    expect(enAgentUpdate.applyErrors['door-closed']).toBe(enAgentUpdate.doorClosed)
    expect(ptPtAgentUpdate.applyErrors['door-closed']).toBe(ptPtAgentUpdate.doorClosed)
  })
})
