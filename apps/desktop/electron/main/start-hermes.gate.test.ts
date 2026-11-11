/**
 * V3-S (K139, r2 M1): the primary backend spawn goes through `prepareHermesSpawn`. A refused gate means no spawn at
 * all, a latched local failure and an `[iclone-gate]` boot error; a passing gate runs before the spawn, and the spawn
 * carries exactly what it returned (lock/confinement/cache env, the fd-3 stdio, attach). Every collaborator is a stub.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as stateModule from './state'

const h = vi.hoisted(() => ({
  attach: vi.fn(),
  backendEnv: {} as Record<string, string>,
  bootState: {} as Record<string, unknown>,
  consent: {} as Record<string, string>,
  gate: vi.fn(),
  paySpawn: vi.fn(),
  progress: vi.fn(),
  remote: false,
  spawn: vi.fn(),
  startupError: null as Error | null
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
  runPrimaryBackendStartup: async () => {
    if (h.startupError) {
      throw h.startupError
    }

    return {
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
    }
  }
}))
vi.mock('../shell-path', () => ({ ensureLoginShellPath: async () => ({ applied: false, reason: 'unchanged' }) }))
vi.mock('../wsl-path-bridge', () => ({ setActiveGatewayProfile: vi.fn(), setWslBridgeProfileState: vi.fn() }))
vi.mock('./backend', () => ({
  claimBackendChild: vi.fn(),
  primaryBackendIsRemote: () => h.remote,
  primaryProfileKey: () => 'default',
  stopBackendChild: vi.fn(),
  waitForBackendExit: vi.fn(async () => undefined)
}))
vi.mock('./backend-ownership', () => ({
  desktopParentStartMarker: async () => null,
  reapOrphanedBackendsOnce: vi.fn(async () => undefined),
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
// The real quitState and refusal (state.ts has no runtime imports); the boot state stays a stub.
vi.mock('./state', async () => ({
  ...(await vi.importActual<typeof stateModule>('./state')),
  bootState: h.bootState,
  lateBound: { isPrimaryInstance: true }
}))
vi.mock('./updates', () => ({
  ensureRuntimeUpdateCheckOff: async () => undefined,
  resolveHermesBackend: vi.fn(),
  verifyCuratedHealthCommit: vi.fn(),
  waitForUpdateToFinish: async () => undefined
}))
vi.mock('./window-events', () => ({ getWindowState: () => ({}), sendBackendExit: vi.fn() }))

const { startHermes } = await import('./start-hermes')
const { beginQuitTeardown, quitState, QuitInProgressError } = await import('./state')
const backendModule = await import('./backend')
const ownershipModule = await import('./backend-ownership')
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
    command: (command: string) => command,
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
  h.remote = false
  h.spawn.mockReset()
  h.startupError = null
  quitState.quitting = false
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
      role: 'primary',
      webDist: '/web'
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

describe('start-hermes — no boot while the app is quitting', () => {
  it('a boot retry scheduled before the quit and run after its before-quit is refused: no gate, no spawn, no latch', async () => {
    vi.useFakeTimers()

    try {
      h.gate.mockResolvedValue(gatedPrimary())

      // The renderer's retry, queued while the app still ran.
      const retry = new Promise<unknown>((resolve, reject) => {
        setTimeout(() => startHermes().then(resolve, reject), 500)
      })

      // The quit's teardown marks it (main's before-quit, past any remote-update wait).
      beginQuitTeardown()
      vi.advanceTimersByTime(500)

      await expect(retry).rejects.toBeInstanceOf(QuitInProgressError)
      await expect(retry).rejects.toThrow('quitting: boot refused')
      expect(h.gate).not.toHaveBeenCalled()
      expect(h.spawn).not.toHaveBeenCalled()
      // A refusal is not a boot failure: nothing is latched for the next launch of the window.
      expect(h.bootState.backendStartFailure).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a quit whose teardown begins while orphans are reaped: refused right after that await, before the gate', async () => {
    h.gate.mockResolvedValue(gatedPrimary())
    vi.mocked(ownershipModule.reapOrphanedBackendsOnce).mockImplementationOnce(async () => {
      beginQuitTeardown()
    })

    await expect(startHermes()).rejects.toBeInstanceOf(QuitInProgressError)
    expect(h.gate).not.toHaveBeenCalled()
    expect(h.spawn).not.toHaveBeenCalled()
    expect(h.bootState.backendStartFailure).toBeUndefined()
  })

  it('a quit whose teardown begins during a later await (the gate) is refused right before the spawn: no spawn, no latch', async () => {
    h.gate.mockImplementation(async () => {
      beginQuitTeardown()

      return gatedPrimary()
    })

    await expect(startHermes()).rejects.toBeInstanceOf(QuitInProgressError)
    expect(h.gate).toHaveBeenCalledTimes(1)
    expect(h.spawn).not.toHaveBeenCalled()
    expect(h.bootState.backendStartFailure).toBeUndefined()
  })

  it('a quit whose teardown begins while the child is claimed: that child is stopped at once, nothing latched', async () => {
    const child = { once: vi.fn(), on: vi.fn(), stdio: [], stdout: null, stderr: null }

    h.gate.mockResolvedValue(gatedPrimary())
    h.spawn.mockReturnValue(child)
    vi.mocked(backendModule.claimBackendChild).mockImplementationOnce((async () => {
      beginQuitTeardown()
    }) as never)
    vi.mocked(backendModule.stopBackendChild).mockClear()

    await expect(startHermes()).rejects.toBeInstanceOf(QuitInProgressError)
    expect(h.spawn).toHaveBeenCalledTimes(1)
    expect(backendModule.stopBackendChild).toHaveBeenCalledWith(child)
    expect(h.bootState.backendStartFailure).toBeUndefined()
  })

  it('the post-claim stop waits for the child to exit (SIGKILL after the grace) and releases it before it throws', async () => {
    const child = { once: vi.fn(), on: vi.fn(), stdio: [], stdout: null, stderr: null }
    let exited = () => undefined as void

    h.gate.mockResolvedValue(gatedPrimary())
    h.spawn.mockReturnValue(child)
    vi.mocked(backendModule.claimBackendChild).mockImplementationOnce((async () => {
      beginQuitTeardown()
    }) as never)
    vi.mocked(backendModule.waitForBackendExit).mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          exited = resolve
        }) as never
    )
    vi.mocked(ownershipModule.releaseBackendChild).mockClear()
    let settled = false

    const boot = startHermes().finally(() => {
      settled = true
    })

    boot.catch(() => undefined)

    for (let tick = 0; tick < 50; tick += 1) {
      await Promise.resolve()
    }

    expect(backendModule.waitForBackendExit).toHaveBeenCalledWith(child)
    // Still waiting for the exit: not released, not thrown.
    expect(ownershipModule.releaseBackendChild).not.toHaveBeenCalled()
    expect(settled).toBe(false)
    exited()
    await expect(boot).rejects.toBeInstanceOf(QuitInProgressError)
    expect(ownershipModule.releaseBackendChild).toHaveBeenCalledWith(child)
  })

  it('control: the same boot with no quit under way reaches the gate', async () => {
    h.gate.mockRejectedValue(new Error('[iclone-gate] stop here'))
    await expect(startHermes()).rejects.toThrow(/\[iclone-gate\]/)
    expect(h.gate).toHaveBeenCalledTimes(1)
  })
})

describe('start-hermes — a remote boot failure only the user can resolve', () => {
  const bootErrorCalls = () =>
    h.progress.mock.calls.map(([update]) => update as { error?: null | string; retryable?: boolean; running?: boolean })

  it("'ownership-unverifiable' is latched as needing the user: the error is shown, no automatic retry, the next attempt re-throws without booting", async () => {
    h.remote = true
    h.startupError = Object.assign(
      new Error("Can't confirm that the Hermes server already running there is its own."),
      {
        kind: 'ownership-unverifiable'
      }
    )

    await expect(startHermes()).rejects.toThrow(/already running there/)

    expect(h.progress).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('already running there'),
        phase: 'backend.error',
        retryable: false,
        running: false
      }),
      expect.anything()
    )
    expect(h.bootState.backendStartFailure).toBe(h.startupError)

    const callsBefore = h.progress.mock.calls.length

    await expect(startHermes()).rejects.toBe(h.startupError)
    expect(h.progress.mock.calls.length).toBe(callsBefore)
  })

  it('control: a transient remote failure stays retryable and is not latched', async () => {
    h.remote = true
    h.startupError = new Error('Remote host briefly unreachable')

    await expect(startHermes()).rejects.toThrow(/briefly unreachable/)

    const failure = bootErrorCalls().find(update => update.error)

    expect(failure?.retryable).toBe(true)
    expect(failure?.running).toBe(false)
    expect(h.bootState.backendStartFailure ?? null).toBeNull()
  })
})

describe('start-hermes — runtime confinement at the call site', () => {
  const TEXT = '(version 1)\n(deny default)\n'

  const RUNTIME_ENV = {
    ...GATE_ENV,
    ICLONE_CONFINEMENT_LAUNCHER: '/ud/confinement/run/launcher.sock',
    ICLONE_RUNTIME_CONFINED: '1'
  }

  /** prepareHermesSpawn under runtime confinement: sandbox-exec, the profile and its defines, then the interpreter. */
  function gatedConfined() {
    const isolated = (args: readonly string[]) => [...PYTHON_ISOLATION_FLAGS, ...args]

    return {
      ...gatedPrimary(),
      command: vi.fn((_command: string) => '/usr/bin/sandbox-exec'),
      argv: vi.fn((args: readonly string[], command?: string) =>
        command === undefined ? isolated(args) : ['-p', TEXT, '-D', 'PROJECT=/work', command, ...isolated(args)]
      ),
      seal: (composed: Record<string, string | undefined>) =>
        sealHermesSpawnEnv(composed, { gateEnv: RUNTIME_ENV, role: 'primary', runtimeRoot: '/managed' })
    }
  }

  it('on: spawns sandbox-exec -p <profile> -D… <python> -s -P <args>, with the fd-3 stdio and the launcher env', async () => {
    const gated = gatedConfined()
    const child = { once: vi.fn(), on: vi.fn(), stdio: [], stdout: null, stderr: null }

    h.gate.mockResolvedValue(gated)
    h.spawn.mockReturnValue(child)

    await expect(startHermes()).rejects.toThrow(/superseded/)

    const [command, args, options] = h.spawn.mock.calls[0]!

    expect(gated.command).toHaveBeenCalledWith('/managed/venv/bin/python')
    expect(command).toBe('/usr/bin/sandbox-exec')
    expect(args).toEqual([
      '-p',
      TEXT,
      '-D',
      'PROJECT=/work',
      '/managed/venv/bin/python',
      '-s',
      '-P',
      '-m',
      'hermes_cli.main',
      'serve'
    ])
    expect(options.stdio).toBe(gated.stdio)
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe', 'pipe'])
    expect(options.env).toMatchObject({
      ICLONE_CONFINEMENT_LAUNCHER: '/ud/confinement/run/launcher.sock',
      ICLONE_RUNTIME_CONFINED: '1'
    })
    expect(h.attach).toHaveBeenCalledWith(child)
  })

  it('off: the call site spawns exactly the backend command and the isolated argv', async () => {
    h.gate.mockResolvedValue(gatedPrimary())
    h.spawn.mockReturnValue({ once: vi.fn(), on: vi.fn(), stdio: [], stdout: null, stderr: null })

    await expect(startHermes()).rejects.toThrow(/superseded/)

    const [command, args, options] = h.spawn.mock.calls[0]!

    expect(command).toBe('/managed/venv/bin/python')
    expect(args).toEqual(['-s', '-P', '-m', 'hermes_cli.main', 'serve'])
    expect(options.env).not.toHaveProperty('ICLONE_RUNTIME_CONFINED')
    expect(options.env).not.toHaveProperty('ICLONE_CONFINEMENT_LAUNCHER')
  })
})
