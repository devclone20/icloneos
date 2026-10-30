import { describe, expect, it, vi } from 'vitest'

import { applyUpdates } from './update-apply'

const m = vi.hoisted(() => ({
  quitState: { isQuittingForHandoff: false, updateInFlight: false },
  resolveUpdateScriptHandoff: vi.fn(),
  spawnUpdaterProcess: vi.fn()
}))

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent-user-data', quit: vi.fn() } }))
vi.mock('../iclone-compat', () => ({ compatGate: vi.fn(), refreshInstallTarget: vi.fn() }))
vi.mock('../iclone-compat/store', () => ({ appendLine: vi.fn(), storeRoot: vi.fn() }))
vi.mock('../update-marker', () => ({ updateHandoffConflict: () => null, writeUpdateMarker: vi.fn() }))
vi.mock('../update-policy', () => ({ BUNDLED_RUNTIME_PIN: 'pin' }))
vi.mock('../update-runtime-align', () => ({ gateUpdateApply: async () => ({ door: 'open', refusal: null }) }))
vi.mock('../updater-process', () => ({
  observeUpdaterHandoff: vi.fn(),
  resolveUpdateScriptHandoff: m.resolveUpdateScriptHandoff,
  spawnUpdaterProcess: m.spawnUpdaterProcess,
  stagedUpdaterSupportsPrewrittenMarker: vi.fn(),
  wrapHandoffForDetachedConsole: vi.fn()
}))
vi.mock('../venv-blocker-scan', () => ({
  formatBlockerMessage: vi.fn(),
  formatProbeFailedMessage: vi.fn(),
  scanVenvBlockers: async () => ({ kind: 'clear' }),
  stopSafeVenvBlockers: vi.fn()
}))
vi.mock('./backend-pool', () => ({ releaseBackendLockForUpdate: async () => ({ unlocked: true }) }))
vi.mock('./desktop-settings', () => ({ readDesktopUpdateConfig: () => ({ branch: 'main' }) }))
vi.mock('./env', () => ({
  DEFAULT_UPDATE_BRANCH: 'main',
  HERMES_HOME: '/nonexistent-hermes-home',
  IS_MAC: false,
  IS_WINDOWS: true,
  pathWithHermesManagedNode: (value: string) => value,
  resolveUpdateRoot: () => '/nonexistent-install'
}))
vi.mock('./executables', () => ({ runResolvedGit: vi.fn() }))
vi.mock('./log', () => ({ rememberLog: vi.fn(), updatePolicy: () => 'default' }))
vi.mock('./start-hermes', () => ({ startHermes: vi.fn(async () => undefined) }))
vi.mock('./state', () => ({ quitState: m.quitState }))
vi.mock('./updates', () => ({
  applyUpdatesPosixHandoff: vi.fn(),
  emitUpdateProgress: vi.fn(),
  preflightStateDb: vi.fn(),
  repairMacUpdaterHelper: vi.fn(),
  resolveHealedBranch: async (_root: string, branch: string) => branch,
  resolveUpdaterBinary: () => null,
  runningAppBundle: () => null,
  UPDATE_HANDOFF_DWELL_MS: 0
}))

describe('applyUpdates', () => {
  it('fails explicitly when neither a staged updater nor the hand-off script is left to apply with', async () => {
    // Windows CLI install: the hand-off script exists when the door is chosen and is gone by the time it is spawned.
    m.resolveUpdateScriptHandoff.mockReturnValueOnce({ scriptPath: 'update.ps1' }).mockReturnValue(null)

    await expect(applyUpdates()).rejects.toThrow(
      'No staged updater binary and no repo hand-off script to apply the update with.'
    )
    expect(m.spawnUpdaterProcess).not.toHaveBeenCalled()
    expect(m.quitState).toEqual({ isQuittingForHandoff: false, updateInFlight: false })
  })
})
