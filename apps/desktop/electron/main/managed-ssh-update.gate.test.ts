/**
 * V3-S (K139, r2 M1): a pool backend (another local profile, forced-local included) goes through the same
 * `prepareHermesSpawn` as the primary. A refused gate means no spawn and the `[iclone-gate]` error; a passing gate runs
 * before the spawn with role `pool` and THIS profile, and the spawn carries what it returned (lock/confinement/cache
 * env, the fd-3 stdio, attach). Every collaborator of managed-ssh-update is a stub.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  attach: vi.fn(),
  backendEnv: {} as Record<string, string>,
  claim: vi.fn(),
  consent: {} as Record<string, string>,
  gate: vi.fn(),
  paySpawn: vi.fn(),
  spawn: vi.fn()
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
vi.mock('../update-gate', () => ({ waitForUpdateClearance: async () => undefined }))
vi.mock('../windows-child-options', () => ({ hiddenWindowsChildOptions: (options: unknown) => options }))
vi.mock('../windows-remote-lifecycle', () => ({
  detectRemotePlatform: vi.fn(),
  probeWindowsRemote: vi.fn(),
  terminateOwnedWindowsDashboardForUpdate: vi.fn()
}))
vi.mock('./backend', () => ({ claimBackendChild: h.claim, primaryProfileKey: () => 'default' }))
vi.mock('./backend-ownership', () => ({
  desktopParentStartMarker: async () => null,
  reapOrphanedBackendsOnce: async () => undefined,
  releaseBackendChild: vi.fn()
}))
vi.mock('./backend-pool', () => ({
  ensureRuntime: async (backend: unknown) => backend,
  startPoolIdleReaper: vi.fn()
}))
vi.mock('./backend-readiness', () => ({ waitForHermes: vi.fn() }))
vi.mock('./backend-state', () => ({
  backendConnectionState: {},
  backendPool: new Map(),
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
vi.mock('./state', () => ({ lateBound: {} }))
vi.mock('./updates', () => ({
  ensureRuntimeUpdateCheckOff: async () => undefined,
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

/** What prepareHermesSpawn returns for a pool backend, with the REAL seal. */
function gatedPool() {
  return {
    argv: (args: readonly string[]) => [...PYTHON_ISOLATION_FLAGS, ...args],
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
  vi.unstubAllEnvs()
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
      role: 'pool'
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
