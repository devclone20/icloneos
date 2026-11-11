/**
 * V3-S (K139, r2 M1): a pool backend (another local profile, forced-local included) goes through the same
 * `prepareHermesSpawn` as the primary. A refused gate means no spawn and the `[iclone-gate]` error; a passing gate runs
 * before the spawn with role `pool` and THIS profile, and the spawn carries what it returned (lock/confinement/cache
 * env, the fd-3 stdio, attach). Every collaborator of managed-ssh-update is a stub.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as stateModule from './state'

const h = vi.hoisted(() => ({
  attach: vi.fn(),
  backendEnv: {} as Record<string, string>,
  claim: vi.fn(),
  consent: {} as Record<string, string>,
  gate: vi.fn(),
  paySpawn: vi.fn(),
  pool: new Map<string, unknown>(),
  spawn: vi.fn(),
  updateClearance: vi.fn(async () => undefined)
}))

vi.mock('node:child_process', () => ({ spawn: h.spawn }))
vi.mock('../backend-claim', () => ({ createBackendOutputTail: () => ({ attach: vi.fn(), describe: () => '' }) }))
vi.mock('../backend-ready', () => ({ waitForDashboardPortAnnouncement: vi.fn() }))
vi.mock('../connection-config', () => ({ normalizeSshConfig: vi.fn(), normAuthMode: vi.fn() }))
vi.mock('../connection-registry', () => ({ backendScopeKey: vi.fn(), backendScopePrefix: vi.fn() }))
vi.mock('../dashboard-token', () => ({ adoptServedDashboardToken: vi.fn() }))
vi.mock('../desktop-remote-route', () => ({ resolveDesktopRemoteRoute: vi.fn() }))
vi.mock('../gateway-ws-probe', () => ({ probeGatewayWebSocket: vi.fn() }))
vi.mock('../iclone-consent', () => ({ consentEnv: () => h.consent }))
vi.mock('../iclone-x402/ipc', () => ({ paySpawn: h.paySpawn }))
vi.mock('../managed-ssh-update', () => ({ managedSshScopeRole: vi.fn(), waitForManagedSshBootstrapFence: vi.fn() }))
vi.mock('../packaged-env', () => ({ codePathEnv: () => undefined }))
vi.mock('../parent-process-identity', () => ({ parentWatchdogEnv: () => ({}) }))
vi.mock('../profile-delete-routing', () => ({ assertLocalProfileCanStart: vi.fn() }))
vi.mock('../remote-lifecycle', () => ({}))
vi.mock('../ssh-connection', () => ({ createSshProbeConnection: vi.fn() }))
vi.mock('../update-gate', () => ({ waitForUpdateClearance: h.updateClearance }))
vi.mock('../windows-child-options', () => ({ hiddenWindowsChildOptions: (options: unknown) => options }))
vi.mock('../windows-remote-lifecycle', () => ({
  detectRemotePlatform: vi.fn(),
  probeWindowsRemote: vi.fn(),
  terminateOwnedWindowsDashboardForUpdate: vi.fn()
}))
vi.mock('./backend', () => ({
  claimBackendChild: h.claim,
  primaryProfileKey: () => 'default',
  stopBackendChild: vi.fn(),
  waitForBackendExit: vi.fn(async () => undefined)
}))
vi.mock('./backend-ownership', () => ({
  desktopParentStartMarker: vi.fn(async () => null),
  reapOrphanedBackendsOnce: vi.fn(async () => undefined),
  releaseBackendChild: vi.fn()
}))
vi.mock('./backend-pool', () => ({
  ensureRuntime: vi.fn(async (backend: unknown) => backend),
  startPoolIdleReaper: vi.fn()
}))
vi.mock('./backend-readiness', () => ({ waitForHermes: vi.fn() }))
vi.mock('./backend-state', () => ({
  backendConnectionState: {},
  backendPool: h.pool,
  profileDeletionGate: { assertCanStart: vi.fn() }
}))
vi.mock('./connection-config', () => ({
  readDesktopConnectionConfig: vi.fn(),
  readDesktopConnectionsRegistry: vi.fn(),
  sshConnections: new Map()
}))
vi.mock('./env', () => ({ directoryExists: () => true, HERMES_HOME: '/tmp/v3s-hh' }))
vi.mock('./executables', () => ({ getBackendArgsForRuntime: (backend: { args: string[] }) => backend.args }))
vi.mock('./iclone-gate', () => ({ prepareHermesSpawn: h.gate }))
vi.mock('./log', () => ({ hermesLog: [], rememberLog: vi.fn() }))
vi.mock('./managed-ssh', () => ({
  managedConnectionUpdateGate: {},
  managedPrimaryRestoreOwners: new Set(),
  sshBootstrapCoordinator: {},
  sshRememberLog: vi.fn(),
  sshScopeKey: vi.fn()
}))
vi.mock('./remote', () => ({ bootstrapSshConnection: vi.fn(), buildRemoteConnection: vi.fn() }))
vi.mock('./runtime', () => ({
  makeDashboardReadyFile: () => null,
  resolveHermesCwd: () => '/work',
  resolveWebDist: () => '/web'
}))
vi.mock('./secrets', () => ({ decryptDesktopSecret: vi.fn() }))
// The real quitState and refusal (state.ts has no runtime imports).
vi.mock('./state', async () => ({ ...(await vi.importActual<typeof stateModule>('./state')), lateBound: {} }))
vi.mock('./updates', () => ({
  ensureRuntimeUpdateCheckOff: vi.fn(async () => undefined),
  resolveHermesBackend: (args: string[]) => ({
    args: ['-m', 'hermes_cli.main', ...args],
    command: '/managed/venv/bin/python',
    env: h.backendEnv,
    kind: 'python',
    label: 'Hermes at /managed',
    root: '/managed',
    shell: false
  }),
  UPDATE_WAIT_POLL_MS: 10,
  UPDATE_WAIT_TIMEOUT_MS: 10,
  updateGateDeps: () => ({}),
  verifyCuratedHealthCommit: vi.fn()
}))
vi.mock('./window-events', () => ({ getWindowState: () => ({}) }))

const { spawnPoolBackend } = await import('./managed-ssh-update')
const { beginQuitTeardown, quitState, QuitInProgressError } = await import('./state')
const backendModule = await import('./backend')
const ownershipModule = await import('./backend-ownership')
const poolModule = await import('./backend-pool')
const updatesModule = await import('./updates')
const routeModule = await import('../desktop-remote-route')
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

const RUNTIME_TEXT = '(version 1)\n(deny default)\n'

/**
 * What prepareHermesSpawn returns for a pool backend, with the REAL seal. `confined`: the runtime-profile shape the gate
 * hands out when confinement is on (sandbox-exec, then the profile and its defines, then the interpreter); off, the
 * command and argv are the backend's own.
 */
function gatedPool(confined = false) {
  const isolated = (args: readonly string[]) => [...PYTHON_ISOLATION_FLAGS, ...args]

  return {
    command: (command: string) => (confined ? '/usr/bin/sandbox-exec' : command),
    argv: (args: readonly string[], command?: string) =>
      confined && command !== undefined
        ? ['-p', RUNTIME_TEXT, '-D', 'RUNTIME_ROOT=/managed', command, ...isolated(args)]
        : isolated(args),
    attach: h.attach,
    report: { loaded: ['iclone-permissions'] },
    seal: (composed: Record<string, string | undefined>) =>
      sealHermesSpawnEnv(composed, { gateEnv: GATE_ENV, role: 'pool', runtimeRoot: '/managed' }),
    stdio: ['ignore', 'pipe', 'pipe', 'pipe']
  }
}

const entry = () => ({
  connectionPromise: null,
  lastActiveAt: 0,
  port: null,
  process: null,
  remoteBaseUrl: null,
  token: null
})

beforeEach(() => {
  for (const mock of [h.attach, h.claim, h.gate, h.paySpawn, h.spawn]) {
    mock.mockReset()
  }

  h.backendEnv = {}
  h.consent = {}
  h.pool.clear()
  h.updateClearance.mockClear()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  quitState.quitting = false
})

describe.each([
  ['a pool backend (another local profile)', { forceLocal: false }],
  ['a forced-local backend', { forceLocal: true }]
])('spawnPoolBackend — %s goes through the gate', (_label, opts) => {
  it('a refused gate (no key, not armed, …) ⇒ no spawn, the [iclone-gate] error, nothing on the entry', async () => {
    h.gate.mockRejectedValue(new Error('[iclone-gate] icloneOS could not issue a permission key for the agent'))
    const pool = entry()

    await expect(spawnPoolBackend('work', pool as never, opts)).rejects.toThrow(/\[iclone-gate\]/)
    expect(h.spawn).not.toHaveBeenCalled()
    expect(pool.process).toBeNull()
  })

  it('the gate is asked first (role pool, THIS profile, runtime, cwd); the spawn carries what it returned', async () => {
    const gated = gatedPool()
    const child = { once: vi.fn(), on: vi.fn(), stdio: [], stdout: null, stderr: null }
    h.gate.mockResolvedValue(gated)
    h.spawn.mockReturnValue(child)
    h.claim.mockRejectedValue(new Error('stop after claim'))

    await expect(spawnPoolBackend('work', entry() as never, opts)).rejects.toThrow(/stop after claim/)
    expect(h.gate).toHaveBeenCalledWith({
      backend: expect.objectContaining({ command: '/managed/venv/bin/python', root: '/managed' }),
      cwd: '/work',
      profile: 'work',
      role: 'pool',
      webDist: '/web'
    })
    expect(h.gate.mock.invocationCallOrder[0]!).toBeLessThan(h.spawn.mock.invocationCallOrder[0]!)

    const [command, args, options] = h.spawn.mock.calls[0]!
    expect(command).toBe('/managed/venv/bin/python')
    expect(args.slice(0, 2)).toEqual(['-s', '-P'])
    expect(args).toEqual(expect.arrayContaining(['--profile', 'work', 'serve']))
    expect(options.env).toMatchObject({ ...GATE_ENV, HERMES_DESKTOP: '1' })
    expect(options.stdio).toBe(gated.stdio)
    expect(h.attach).toHaveBeenCalledWith(child)
    expect(h.attach.mock.invocationCallOrder[0]!).toBeLessThan(h.claim.mock.invocationCallOrder[0]!)
  })

  it('confinement on: the pool backend runs under the runtime profile like the primary (sandbox-exec, then python)', async () => {
    h.gate.mockResolvedValue(gatedPool(true))
    h.spawn.mockReturnValue({ once: vi.fn(), on: vi.fn(), stdio: [], stdout: null, stderr: null })
    h.claim.mockRejectedValue(new Error('stop after claim'))

    await expect(spawnPoolBackend('work', entry() as never, opts)).rejects.toThrow(/stop after claim/)

    const [command, args] = h.spawn.mock.calls[0]!
    expect(command).toBe('/usr/bin/sandbox-exec')
    expect(args.slice(0, 2)).toEqual(['-p', RUNTIME_TEXT])
    // The interpreter follows the profile's defines, with its isolation flags and THIS profile's serve args.
    const python = args.indexOf('/managed/venv/bin/python')
    expect(python).toBeGreaterThan(1)
    expect(args.slice(python + 1, python + 3)).toEqual(['-s', '-P'])
    expect(args.slice(python)).toEqual(expect.arrayContaining(['--profile', 'work', 'serve']))
  })

  it('confinement off: command and argv are exactly the backend interpreter with its isolation flags', async () => {
    h.gate.mockResolvedValue(gatedPool(false))
    h.spawn.mockReturnValue({ once: vi.fn(), on: vi.fn(), stdio: [], stdout: null, stderr: null })
    h.claim.mockRejectedValue(new Error('stop after claim'))

    await expect(spawnPoolBackend('work', entry() as never, opts)).rejects.toThrow(/stop after claim/)

    const [command, args] = h.spawn.mock.calls[0]!
    expect(command).toBe('/managed/venv/bin/python')
    expect(args[0]).toBe('-s')
    expect(args).not.toContain('/usr/bin/sandbox-exec')
    expect(args).not.toContain('-p')
  })

  it('m-f / m-b: the lock wins over backend.env, consentEnv() and the inherited env; no payment env; Python isolated', async () => {
    vi.stubEnv('ICLONE_POLICY_LOCK', '0')
    vi.stubEnv('ICLONE_PAY_SOCKET', '/inherited/pay.sock')
    vi.stubEnv('ICLONE_PAY_TOKEN_FILE', '/inherited/pay-token')
    vi.stubEnv('PYTHONSTARTUP', '/evil/startup.py')
    vi.stubEnv('TERMINAL_ENV', 'local')
    h.backendEnv = { ICLONE_POLICY_LOCK: '0', PYTHONPATH: '/managed:/evil/site' }
    h.consent = { ICLONE_CONSENT_CAMERA: 'ask', ICLONE_POLICY_FILE: '/evil/policy.json' }
    h.gate.mockResolvedValue(gatedPool())
    h.spawn.mockReturnValue({ once: vi.fn(), on: vi.fn(), stdio: [], stdout: null, stderr: null })
    h.claim.mockRejectedValue(new Error('stop after claim'))

    await expect(spawnPoolBackend('work', entry() as never, opts)).rejects.toThrow(/stop after claim/)

    const env = h.spawn.mock.calls[0]![2].env as Record<string, string>
    expect(env).toMatchObject({ ...GATE_ENV, ICLONE_CONSENT_CAMERA: 'ask', PYTHONPATH: '/managed' })
    expect(Object.keys(env).filter(key => key.startsWith('ICLONE_PAY_'))).toEqual([])
    expect(env).not.toHaveProperty('PYTHONSTARTUP')
    // A pool backend never mints a payment token (V3-J: the pay socket is the primary's).
    expect(h.paySpawn).not.toHaveBeenCalled()
  })
})

describe('spawnPoolBackend — no pool backend while the app is quitting', () => {
  const child = () => ({ once: vi.fn(), on: vi.fn(), stdio: [], stdout: null, stderr: null })

  const quitDuring = (mock: { mockImplementationOnce(fn: never): unknown }, value?: unknown) =>
    mock.mockImplementationOnce((async (arg: unknown) => {
      beginQuitTeardown()

      return value === undefined ? arg : value
    }) as never)

  beforeEach(() => {
    h.gate.mockResolvedValue(gatedPool())
    h.spawn.mockReturnValue(child())
  })

  it('a quit already under way is refused at the entry: no reap, nothing started', async () => {
    beginQuitTeardown()
    await expect(spawnPoolBackend('work', entry() as never, { forceLocal: true })).rejects.toBeInstanceOf(
      QuitInProgressError
    )
    expect(ownershipModule.reapOrphanedBackendsOnce).not.toHaveBeenCalled()
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('a quit that begins during the orphan reap is refused right after it: no remote resolution', async () => {
    quitDuring(vi.mocked(ownershipModule.reapOrphanedBackendsOnce))
    await expect(spawnPoolBackend('work', entry() as never, { forceLocal: false })).rejects.toBeInstanceOf(
      QuitInProgressError
    )
    expect(routeModule.resolveDesktopRemoteRoute).not.toHaveBeenCalled()
    expect(h.updateClearance).not.toHaveBeenCalled()
  })

  it('a quit that begins during the remote resolution is refused right after it: no update wait', async () => {
    vi.mocked(routeModule.resolveDesktopRemoteRoute).mockImplementation((() => {
      beginQuitTeardown()

      return null
    }) as never)
    await expect(spawnPoolBackend('work', entry() as never, { forceLocal: false })).rejects.toBeInstanceOf(
      QuitInProgressError
    )
    expect(routeModule.resolveDesktopRemoteRoute).toHaveBeenCalled()
    expect(h.updateClearance).not.toHaveBeenCalled()
  })

  it('a quit that begins during the update clearance is refused right after it: no runtime', async () => {
    quitDuring(h.updateClearance as never, null)
    await expect(spawnPoolBackend('work', entry() as never, { forceLocal: true })).rejects.toBeInstanceOf(
      QuitInProgressError
    )
    expect(poolModule.ensureRuntime).not.toHaveBeenCalled()
  })

  it('a quit that begins during the runtime check is refused right after it: no update-check config', async () => {
    quitDuring(vi.mocked(poolModule.ensureRuntime))
    await expect(spawnPoolBackend('work', entry() as never, { forceLocal: true })).rejects.toBeInstanceOf(
      QuitInProgressError
    )
    expect(updatesModule.ensureRuntimeUpdateCheckOff).not.toHaveBeenCalled()
  })

  it('a quit that begins during the update-check config is refused right after it: no gate', async () => {
    quitDuring(vi.mocked(updatesModule.ensureRuntimeUpdateCheckOff), null)
    await expect(spawnPoolBackend('work', entry() as never, { forceLocal: true })).rejects.toBeInstanceOf(
      QuitInProgressError
    )
    expect(h.gate).not.toHaveBeenCalled()
  })

  it('a quit that begins during the gate is refused right after it: no parent marker, no spawn', async () => {
    quitDuring(h.gate as never, gatedPool())
    await expect(spawnPoolBackend('work', entry() as never, { forceLocal: true })).rejects.toBeInstanceOf(
      QuitInProgressError
    )
    expect(ownershipModule.desktopParentStartMarker).not.toHaveBeenCalled()
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('a quit that begins during the last await (the parent marker) is refused right before the spawn', async () => {
    quitDuring(vi.mocked(ownershipModule.desktopParentStartMarker), null)
    await expect(spawnPoolBackend('work', entry() as never, { forceLocal: true })).rejects.toBeInstanceOf(
      QuitInProgressError
    )
    expect(ownershipModule.desktopParentStartMarker).toHaveBeenCalledTimes(1)
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('a quit that begins while the child is claimed: stopped, waited for, released and out of the pool, then refused', async () => {
    const spawned = child()
    const pool = entry()

    h.spawn.mockReturnValue(spawned)
    h.pool.set('work', pool)
    h.claim.mockImplementationOnce(async () => {
      beginQuitTeardown()
    })

    await expect(spawnPoolBackend('work', pool as never, { forceLocal: true })).rejects.toBeInstanceOf(
      QuitInProgressError
    )
    expect(backendModule.stopBackendChild).toHaveBeenCalledWith(spawned)
    expect(backendModule.waitForBackendExit).toHaveBeenCalledWith(spawned)
    expect(ownershipModule.releaseBackendChild).toHaveBeenCalledWith(spawned)

    const order = [
      vi.mocked(backendModule.stopBackendChild).mock.invocationCallOrder[0]!,
      vi.mocked(backendModule.waitForBackendExit).mock.invocationCallOrder[0]!,
      vi.mocked(ownershipModule.releaseBackendChild).mock.invocationCallOrder[0]!
    ]

    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(h.pool.has('work')).toBe(false)
    expect(pool.process).toBeNull()
  })

  it('control: with no quit the same pool boot spawns once', async () => {
    h.claim.mockRejectedValue(new Error('stop after claim'))
    await expect(spawnPoolBackend('work', entry() as never, { forceLocal: true })).rejects.toThrow(/stop after claim/)
    expect(h.spawn).toHaveBeenCalledTimes(1)
  })
})
