/**
 * K-RT2 (ruling 36), exercised (critics' panel CRITICOS_V3RT, minor 5): someone upgrading from a release that ran a
 * runtime of its own is never asked how to set up. The first-run gate is let through to the local install, and the
 * choice screen never waits. The gate's mutation row used to prove this by reading boot-progress.ts as text.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  continueLocal: vi.fn(),
  upgrade: vi.fn(() => true),
  wait: vi.fn(async () => 'choice')
}))

vi.mock('../first-run-setup-gate', () => ({
  createFirstRunSetupGate: () => ({
    abandonForRemoteApply: vi.fn(),
    continueLocal: h.continueLocal,
    hasWaiter: () => false,
    shouldGate: () => true,
    wait: h.wait
  })
}))
vi.mock('./agent-runtime-status', () => ({
  assertAgentInstallAllowed: () => undefined,
  recordBootstrapEventForStatus: vi.fn()
}))
vi.mock('./backend-state', () => ({ progressState: { bootProgressState: { progress: 0 } } }))
vi.mock('./boot-fake', () => ({ BOOT_FAKE_MODE: false, BOOT_FAKE_STEP_MS: 0 }))
vi.mock('./env', () => ({ ACTIVE_HERMES_ROOT: '/app/runtime/hermes-agent', isRuntimeUpgradeFromLegacy: h.upgrade }))
vi.mock('./log', () => ({ rememberLog: vi.fn() }))
vi.mock('./state', () => ({ windowsState: {} }))

const { waitForFirstRunSetupChoice } = await import('./boot-progress')

const BACKEND = { args: ['serve'], bootstrap: true, command: null, kind: 'bootstrap-needed' } as never

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the first-run choice (K-RT2, ruling 36), exercised', () => {
  it('an upgrader from a runtime of their own is never asked: the gate goes on to the local install', async () => {
    h.upgrade.mockReturnValue(true)

    expect(await waitForFirstRunSetupChoice(BACKEND)).toBe('continue-local')
    expect(h.wait).not.toHaveBeenCalled()
    expect(h.continueLocal).toHaveBeenCalledTimes(1)
  })

  it('a first install with no runtime before waits for the choice', async () => {
    h.upgrade.mockReturnValue(false)

    expect(await waitForFirstRunSetupChoice(BACKEND)).toBe('choice')
    expect(h.wait).toHaveBeenCalledTimes(1)
    expect(h.continueLocal).not.toHaveBeenCalled()
  })
})
