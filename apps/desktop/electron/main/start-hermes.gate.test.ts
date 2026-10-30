/**
 * V3-S (K139, r2 M1): the primary backend spawn goes through `prepareHermesSpawn`. A refused gate means no spawn at
 * all, a latched local failure and an `[iclone-gate]` boot error; a passing gate runs before the spawn, and the spawn
 * carries exactly what it returned (lock/confinement/cache env, the fd-3 stdio, attach). Every collaborator is a stub.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  attach: vi.fn(),
  backendEnv: {} as Record<string, string>,
  bootState: {} as Record<string, unknown>,
  consent: {} as Record<string, string>,
  gate: vi.fn(),
  paySpawn: vi.fn(),
  progress: vi.fn(),
  spawn: vi.fn()
}))

vi.mock('node:child_process', () => ({ spawn: h.spawn }))
vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent-user-data' } }))
vi.mock('../backend-claim', () => ({ createBackendOutputTail: () => ({ attach: vi.fn(), describe: () => '' }) }))
vi.mock('../backend-health', () => ({ isReauthRequiredError: () => false }))
vi.mock('../backend-ready', () => ({ waitForDashboardPortAnnouncement: vi.fn() }))
vi.mock('../dashboard-token', () => ({ adoptServedDashboardToken: vi.fn() }))
vi.mock('../gateway-ws-probe', () => ({ probeGatewayWebSocket: vi.fn() }))
vi.mock('../iclone-compat', () => ({ icloneCompatGuard: vi.fn() }))
vi.mock('../iclone-consent', () => ({ consentEnv: () => h.consent }))
vi.mock('../iclone-x402/ipc', () => ({
  paySpawn: (slug: null | string) => {
    h.paySpawn(slug)

    return { attach: vi.fn(), env: { ICLONE_PAY_SOCKET: '/ud/pay.sock', ICLONE_PAY_TOKEN_FILE: '/ud/pay/t' } }
  }
}))
vi.mock('../parent-process-identity', () => ({ parentWatchdogEnv: () => ({}) }))
vi.mock('../primary-backend-startup', () => ({
  createPrimaryRemoteConnection: vi.fn(),
  FirstRunSetupResetError: class FirstRunSetupResetError extends Error {},
  runPrimaryBackendStartup: async () => ({
    kind: 'local',
    backend: {
      args: ['-m', 'hermes_cli.main', 'serve'],
      command: '/managed/venv/bin/python',
      env: h.backendEnv,
      kind: 'python',
      label: 'Hermes at /managed',
      root: '/managed',
      shell: false
    }
  })
}))
vi.mock('../shell-path', () => ({ ensureLoginShellPath: async () => ({ applied: false, reason: 'unchanged' }) }))
vi.mock('../wsl-path-bridge', () => ({ setActiveGatewayProfile: vi.fn(), setWslBridgeProfileState: vi.fn() }))
vi.mock('./backend', () => ({
  claimBackendChild: vi.fn(),
  primaryBackendIsRemote: () => false,
  primaryProfileKey: () => 'default',
  stopBackendChild: vi.fn(),
  waitForBackendExit: async () => undefined
}))
vi.mock('./backend-ownership', () => ({
  desktopParentStartMarker: async () => null,
  reapOrphanedBackendsOnce: async () => undefined,
  releaseBackendChild: vi.fn()
}))
vi.mock('./backend-pool', () => ({ ensureRuntime: vi.fn() }))
vi.mock('./backend-readiness', () => ({ waitForHermes: vi.fn() }))
vi.mock('./backend-state', () => {
  let promise: Promise<unknown> | null = null

  return {
    backendConnectionState: {
      attachProcess: () => null,
      clearForCurrentProcess: () => true,
      clearPromiseForAttempt: () => {
        promise = null

        return true
      },
      getPromise: () => promise,
      invalidate: () => null,
      isCurrentAttempt: () => true,
      setPromise: (_attempt: number, value: Promise<unknown>) => {
        promise = value
      },
      startAttempt: () => 1
    }
  }
})
vi.mock('./boot-fake', () => ({ BOOT_FAKE_ERROR: null }))
vi.mock('./boot-progress', () => ({
  advanceBootProgress: async () => undefined,
  updateBootProgress: h.progress,
  waitForFirstRunSetupChoice: vi.fn()
}))
vi.mock('./connection-config', () => ({ readActiveDesktopProfile: () => 'work' }))
vi.mock('./env', () => ({ HERMES_HOME: '/tmp/v3s-hh' }))
vi.mock('./executables', () => ({ getBackendArgsForRuntime: (backend: { args: string[] }) => backend.args }))
vi.mock('./iclone-gate', () => ({ prepareHermesSpawn: h.gate }))
vi.mock('./log', () => ({
  DESKTOP_LOG_PATH: '/tmp/log',
  hermesLog: [],
  recentHermesLog: () => '',
  rememberLog: vi.fn()
}))
vi.mock('./managed-ssh', () => ({ managedPrimaryRestoreOwners: new Set() }))
vi.mock('./managed-ssh-update', () => ({ resolveRemoteBackend: vi.fn() }))
vi.mock('./runtime', () => ({
  makeDashboardReadyFile: () => null,
  resolveHermesCwd: () => '/work',
  resolveWebDist: () => '/web'
}))
vi.mock('./state', () => ({ bootState: h.bootState, lateBound: { isPrimaryInstance: true } }))
vi.mock('./updates', () => ({
  ensureRuntimeUpdateCheckOff: async () => undefined,
  resolveHermesBackend: vi.fn(),
  verifyCuratedHealthCommit: vi.fn(),
  waitForUpdateToFinish: async () => undefined
}))
vi.mock('./window-events', () => ({ getWindowState: () => ({}), sendBackendExit: vi.fn() }))

const { startHermes } = await import('./start-hermes')
const { PYTHON_ISOLATION_FLAGS, sealHermesSpawnEnv } = await import('../iclone-spawn-env')

const GATE_ENV = {
  ICLONE_CONFINEMENT: '1',
  ICLONE_POLICY_FILE: '/ud/permissions/p.json',
  ICLONE_POLICY_KEY_FD: '3',
  ICLONE_POLICY_LOCK: '1',
  PYTHONDONTWRITEBYTECODE: '1',
  PYTHONPYCACHEPREFIX: '/ud/hermes-pycache/spawn-1-a',
  TERMINAL_ENV: 'iclone_seatbelt'
}

/** What prepareHermesSpawn returns, with the REAL seal (so the call site's composition is what is tested). */
function gatedPrimary() {
  return {
    argv: (args: readonly string[]) => [...PYTHON_ISOLATION_FLAGS, ...args],
    attach: h.attach,
    report: { loaded: ['iclone-permissions', 'iclone-confinement'] },
    seal: (composed: Record<string, string | undefined>) =>
      sealHermesSpawnEnv(composed, { gateEnv: GATE_ENV, role: 'primary', runtimeRoot: '/managed' }),
    stdio: ['ignore', 'pipe', 'pipe', 'pipe']
  }
}

beforeEach(() => {
  for (const key of Object.keys(h.bootState)) {
    delete h.bootState[key]
  }

  h.attach.mockReset()
  h.backendEnv = {}
  h.consent = {}
  h.gate.mockReset()
  h.paySpawn.mockReset()
  vi.unstubAllEnvs()
  h.progress.mockReset()
  h.spawn.mockReset()
})

describe('start-hermes — the iclone gate before the spawn', () => {
  it('a refused gate ⇒ no spawn, a latched local failure, and the [iclone-gate] boot error', async () => {
    h.gate.mockRejectedValue(
      new Error('[iclone-gate] The icloneOS permission gate is not in place: Hermes did not load it')
    )

    await expect(startHermes()).rejects.toThrow(/\[iclone-gate\]/)
    expect(h.spawn).not.toHaveBeenCalled()
    expect(String((h.bootState.backendStartFailure as Error | undefined)?.message)).toContain('[iclone-gate]')
    expect(h.progress).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('[iclone-gate]'), running: false }),
      expect.anything()
    )
    // Latched: the next attempt re-throws without probing or spawning again.
    await expect(startHermes()).rejects.toThrow(/\[iclone-gate\]/)
    expect(h.gate).toHaveBeenCalledTimes(1)
  })

  it('the gate is asked first (role primary, the spawn’s runtime, profile, cwd); the spawn carries what it returned', async () => {
    const gated = gatedPrimary()
    const child = { once: vi.fn(), on: vi.fn(), stdio: [], stdout: null, stderr: null }
    h.gate.mockResolvedValue(gated)
    h.spawn.mockReturnValue(child)

    await expect(startHermes()).rejects.toThrow(/superseded/)
    expect(h.gate).toHaveBeenCalledWith({
      backend: expect.objectContaining({ root: '/managed', command: '/managed/venv/bin/python' }),
      cwd: '/work',
      profile: 'work',
      role: 'primary'
    })
    expect(h.spawn).toHaveBeenCalledTimes(1)
    expect(h.gate.mock.invocationCallOrder[0]!).toBeLessThan(h.spawn.mock.invocationCallOrder[0]!)

    const [command, args, options] = h.spawn.mock.calls[0]!
    expect(command).toBe('/managed/venv/bin/python')
    expect(args).toEqual(['-s', '-P', '-m', 'hermes_cli.main', 'serve'])
    expect(options.env).toMatchObject(GATE_ENV)
    expect(options.stdio).toBe(gated.stdio)
    expect(h.attach).toHaveBeenCalledWith(child)
  })

  it('m-r5-2: the pay token is minted for the profile the spawn runs as (runsAs.slug), not the window key', async () => {
    // The desktop profile is `work`; the primary window key is `default` (the pre-J4 slug the token used to take).
    h.gate.mockResolvedValue(gatedPrimary())
    h.spawn.mockReturnValue({ once: vi.fn(), on: vi.fn(), stdio: [], stdout: null, stderr: null })

    await expect(startHermes()).rejects.toThrow(/superseded/)
    expect(h.paySpawn.mock.calls).toEqual([['work']])
    expect(h.paySpawn.mock.invocationCallOrder[0]!).toBeLessThan(h.spawn.mock.invocationCallOrder[0]!)
  })

  it('m-f / m-b: the lock wins over backend.env, consentEnv() and the inherited env; inherited Python config is gone', async () => {
    vi.stubEnv('ICLONE_POLICY_LOCK', '0')
    vi.stubEnv('ICLONE_POLICY_KEY_FD', '9')
    vi.stubEnv('PYTHONSTARTUP', '/evil/startup.py')
    vi.stubEnv('TERMINAL_ENV', 'local')
    vi.stubEnv('PYTHONHOME', '/evil')
    h.backendEnv = {
      ICLONE_POLICY_FILE: '/evil/policy.json',
      PYTHONPATH: '/managed:/managed/venv/lib/python3.11/site-packages:/evil/site',
      PYTHONUTF8: '1'
    }
    h.consent = { ICLONE_CONSENT_CAMERA: 'ask', ICLONE_POLICY_LOCK: '0' }
    h.gate.mockResolvedValue(gatedPrimary())
    h.spawn.mockReturnValue({ once: vi.fn(), on: vi.fn(), stdio: [], stdout: null, stderr: null })

    await expect(startHermes()).rejects.toThrow(/superseded/)

    const env = h.spawn.mock.calls[0]![2].env as Record<string, string>
    expect(env).toMatchObject(GATE_ENV)
    expect(env).toMatchObject({
      ICLONE_CONSENT_CAMERA: 'ask',
      ICLONE_PAY_SOCKET: '/ud/pay.sock',
      PYTHONPATH: '/managed:/managed/venv/lib/python3.11/site-packages',
      PYTHONUTF8: '1'
    })
    expect(env).not.toHaveProperty('PYTHONSTARTUP')
    expect(env).not.toHaveProperty('PYTHONHOME')
  })
})
