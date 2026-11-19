/**
 * v0.0.9 lead deviation (plan item 4, critic M1): the upstream agent-update door STAYS CLOSED for repository pins.
 * The bundled runtime is built from this repository (RUNTIME_PIN source "repo"); an "update" to the upstream tip would
 * drop the iclone core. So the agent updates only with the app: the previous runtime's sha dir stays on disk, and
 * Repair reinstalls the same pin. This pins the behaviour through main's real handlers (not the source text): the
 * check and the apply answer door-closed and touch nothing — no network, no git, no updater spawn, no marker, no
 * gesture spent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const touched = vi.hoisted(() => ({
  compat: vi.fn(),
  gate: vi.fn(),
  git: vi.fn(),
  log: vi.fn(),
  marker: vi.fn(),
  spawn: vi.fn()
}))

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent', getVersion: () => '0.0.9-test' } }))
vi.mock('../iclone-compat', () => ({
  compatGate: touched.compat,
  previewAgentTip: touched.compat,
  refreshInstallTarget: touched.compat
}))
vi.mock('../iclone-compat/store', () => ({ appendLine: touched.compat, storeRoot: () => '/nonexistent' }))
vi.mock('../iclone-runtime-location', () => ({ appRuntimeRoot: () => '/nonexistent' }))
vi.mock('../iclone-updates', () => ({ readRuntimeStatus: touched.compat }))
vi.mock('../lib/git', () => ({ runGit: touched.git }))
vi.mock('../update-marker', () => ({ updateHandoffConflict: () => null, writeUpdateMarker: touched.marker }))
vi.mock('../update-runtime-align', () => ({ gateUpdateApply: touched.gate, spawnCapped: touched.spawn }))
vi.mock('../updater-process', () => ({ observeUpdaterHandoff: touched.spawn, spawnUpdaterProcess: touched.spawn }))
vi.mock('./env', () => ({
  ACTIVE_HERMES_ROOT: '/nonexistent/runtime',
  HERMES_HOME: '/nonexistent/.hermes',
  IS_MAC: true,
  IS_PACKAGED: true,
  IS_WINDOWS: false,
  SOURCE_REPO_ROOT: '/nonexistent/repo'
}))
vi.mock('./log', () => ({ rememberLog: touched.log, updatePolicy: () => ({}) }))
vi.mock('./runtime-install-state', () => ({ managedRuntimeEnv: () => ({}) }))
vi.mock('./state', () => ({ quitState: { icloneAppUpdate: null, updateInFlight: false } }))
vi.mock('./updates', () => ({
  getOriginUrl: touched.git,
  preflightStateDb: touched.compat,
  runningAppBundle: () => null,
  UPDATE_HANDOFF_DWELL_MS: 0
}))

const fetchSpy = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('plan item 4 deviation: the agent-update door stays closed for repo pins', () => {
  it('the bundled pin is a repository pin, so the door is closed', async () => {
    const { BUNDLED_RUNTIME_PIN } = await import('../update-policy')
    const { agentUpdateDoorOpen } = await import('../agent-update')

    expect(BUNDLED_RUNTIME_PIN.source).toBe('repo')
    expect(agentUpdateDoorOpen()).toBe(false)
    expect(agentUpdateDoorOpen({ source: 'repo' })).toBe(false)
  })

  it("Check for updates answers door-closed with the bundled sha and asks nothing of the network or git", async () => {
    const { BUNDLED_RUNTIME_PIN } = await import('../update-policy')
    const { checkAgentLatestNow } = await import('./agent-update')
    const check = await checkAgentLatestNow()

    expect(check).toMatchObject({ error: 'door-closed', latest: null, updateAvailable: false })
    expect(check.verified.sha).toBe(BUNDLED_RUNTIME_PIN.sha)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(touched.git).not.toHaveBeenCalled()
    expect(touched.compat).not.toHaveBeenCalled()
  })

  it('Update (even with a well-formed request and a gesture token) is refused before any spawn, marker or gate', async () => {
    const { applyAgentUpdate } = await import('./agent-update')
    const answer = await applyAgentUpdate({ gestureToken: 'a'.repeat(64), sha: 'b'.repeat(40) })

    expect(answer).toMatchObject({ error: 'door-closed', ok: false })
    expect(touched.spawn).not.toHaveBeenCalled()
    expect(touched.marker).not.toHaveBeenCalled()
    expect(touched.gate).not.toHaveBeenCalled()
    expect(touched.git).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
