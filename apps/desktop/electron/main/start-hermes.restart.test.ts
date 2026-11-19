/**
 * v0.0.9 F2 (P0_HERMES_FAILURES bugs B and C, gates G1/G2 at the start-hermes seam): a pre-ready exit carries the
 * cause read from the CHILD'S OWN output (never the shared desktop.log, whose tail holds the gate's success line),
 * a transient failure no longer latches for the life of the process (main restarts it on a schedule), and a ready
 * backend that crashes is restarted by main. Every collaborator is a stub; the real backend connection state and the
 * real supervisor run.
 *
 * Red on the old code: (1) the boot error carried `recentHermesLog()` ("[iclone-gate] … loaded by Hermes") and no
 * cause; (2) the 2nd startHermes() after a local failure re-threw forever and nothing ever spawned again; (3) a crash
 * after ready was never restarted by main.
 */
import { EventEmitter } from 'node:events'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as stateModule from './state'

const h = vi.hoisted(() => ({
  bootState: {} as Record<string, unknown>,
  output: '',
  port: vi.fn(),
  progress: vi.fn(),
  restarted: vi.fn(),
  spawn: vi.fn()
}))

vi.mock('node:child_process', () => ({ spawn: h.spawn }))
vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent-f2-home' } }))
vi.mock('../backend-claim', () => ({
  createBackendOutputTail: () => ({
    attach: vi.fn(),
    describe: () => (h.output ? `\nRecent backend output:\n${h.output}` : ''),
    text: () => h.output
  })
}))
vi.mock('../backend-health', () => ({ isReauthRequiredError: () => false }))
vi.mock('../backend-ready', () => ({ waitForDashboardPortAnnouncement: h.port }))
vi.mock('../bootstrap-runner', () => ({ removeOrphanedBootstrapCache: vi.fn() }))
vi.mock('../dashboard-token', () => ({ adoptServedDashboardToken: async () => 'served-token' }))
vi.mock('../gateway-ws-probe', () => ({ probeGatewayWebSocket: async () => ({ ok: true }) }))
vi.mock('../iclone-compat', () => ({ icloneCompatGuard: vi.fn() }))
vi.mock('../iclone-consent', () => ({ consentEnv: () => ({}) }))
vi.mock('../iclone-permissions/ipc', () => ({ listDefaultFolder: vi.fn() }))
vi.mock('../iclone-x402/ipc', () => ({ paySpawn: () => ({ attach: vi.fn(), env: {} }) }))
vi.mock('../iclone-x402/spawn-profile', () => ({
  spawnProfile: () => ({ args: [], slug: 'default', why: 'test' })
}))
vi.mock('../install-liveness', () => ({ endInstallBudget: vi.fn(), INSTALL_WATCHDOG_TAG: '[iclone-install-watchdog]' }))
vi.mock('../parent-process-identity', () => ({ parentWatchdogEnv: () => ({}) }))
vi.mock('../primary-backend-startup', () => ({
  createPrimaryRemoteConnection: vi.fn(),
  FirstRunSetupResetError: class FirstRunSetupResetError extends Error {},
  runPrimaryBackendStartup: async () => ({
    kind: 'local',
    backend: {
      args: ['-m', 'hermes_cli.main', 'serve'],
      command: '/managed/venv/bin/python',
      env: {},
      kind: 'python',
      label: 'Hermes at /managed',
      root: '/managed',
      shell: false
    }
  })
}))
vi.mock('../shell-path', () => ({ ensureLoginShellPath: async () => ({ applied: false, reason: 'unchanged' }) }))
vi.mock('../wsl-path-bridge', () => ({ setActiveGatewayProfile: vi.fn(), setWslBridgeProfileState: vi.fn() }))
vi.mock('./agent-runtime-status', () => ({ markAgentRuntimeRunning: vi.fn() }))
vi.mock('./backend', () => ({
  claimBackendChild: vi.fn(async () => undefined),
  primaryBackendIsRemote: () => false,
  primaryProfileKey: () => 'default',
  sendBackendRestarted: h.restarted,
  stopBackendChild: vi.fn(),
  waitForBackendExit: vi.fn(async () => undefined)
}))
vi.mock('./backend-boot-watch', () => ({
  BOOT_DEPENDENCIES_MESSAGE: 'deps',
  BOOT_PHASE_DEPENDENCIES: 'backend.dependencies',
  watchBackendBoot: () => ({ source: undefined, stop: vi.fn() })
}))
vi.mock('./backend-ownership', () => ({
  desktopParentStartMarker: async () => null,
  reapOrphanedBackendsOnce: vi.fn(async () => undefined),
  releaseBackendChild: vi.fn()
}))
vi.mock('./backend-pool', () => ({ ensureRuntime: vi.fn() }))
vi.mock('./backend-readiness', () => ({ waitForHermes: vi.fn(async () => undefined) }))
vi.mock('./backend-state', async () => {
  const { createBackendConnectionState } = await import('../backend-connection-state')

  return { backendConnectionState: createBackendConnectionState() }
})
vi.mock('./boot-fake', () => ({ BOOT_FAKE_ERROR: null }))
vi.mock('./boot-progress', () => ({
  advanceBootProgress: async () => undefined,
  broadcastBootstrapEvent: vi.fn(),
  updateBootProgress: h.progress,
  waitForFirstRunSetupChoice: vi.fn()
}))
vi.mock('./connection-config', () => ({ readActiveDesktopProfile: () => null }))
vi.mock('./env', () => ({ HERMES_HOME: '/nonexistent-f2-home/.hermes' }))
vi.mock('./executables', () => ({ getBackendArgsForRuntime: (backend: { args: string[] }) => backend.args }))
vi.mock('./iclone-gate', () => ({
  prepareHermesSpawn: async () => ({
    argv: (args: readonly string[]) => [...args],
    attach: vi.fn(),
    command: (command: string) => command,
    seal: (env: Record<string, string | undefined>) => env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}))
vi.mock('./log', () => ({
  DESKTOP_LOG_PATH: '/tmp/desktop.log',
  hermesLog: [],
  // What the SHARED log tail always holds: main's own gate success line. It must never reach the boot error.
  recentHermesLog: () => '[iclone-gate] iclone-permissions loaded by Hermes at 2026-11-14T09:27:43Z',
  rememberLog: vi.fn()
}))
vi.mock('./managed-ssh', () => ({ managedPrimaryRestoreOwners: new Set() }))
vi.mock('./managed-ssh-update', () => ({ resolveRemoteBackend: vi.fn() }))
vi.mock('./runtime', () => ({
  makeDashboardReadyFile: () => null,
  resolveHermesCwd: () => '/work',
  resolveWebDist: () => '/web'
}))
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
const { primaryBackendAutoRestart } = await import('./backend-auto-restart')
const { readBootCause } = await import('../boot-cause')
const { backendConnectionState } = await import('./backend-state')

const STALE_LEASE =
  'hermes: install state is not writable by this user (/Users/u/.hermes/installs/f3cca8023c228495/environments/d2/.leases/1c); run as the install owner or grant write access'

type FakeChild = EventEmitter & { exitCode: null | number; killed: boolean; stderr: null; stdout: null }

function fakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), { exitCode: null, killed: false, stderr: null, stdout: null })
}

const children: FakeChild[] = []

beforeEach(() => {
  for (const key of Object.keys(h.bootState)) {
    delete h.bootState[key]
  }

  children.length = 0
  h.output = ''
  h.progress.mockReset()
  h.restarted.mockReset()
  h.spawn.mockReset()
  h.spawn.mockImplementation(() => {
    const child = fakeChild()

    children.push(child)

    return child
  })
  h.port.mockReset()
  primaryBackendAutoRestart()?.reset()
  // Each case starts with no live connection (the real connection state is module-wide).
  backendConnectionState.invalidate()
})

afterEach(() => {
  vi.useRealTimers()
})

/** The port announcement never comes; the child's exit decides (the race in start-hermes). */
const portNeverAnnounced = () => new Promise<number>(() => undefined)

describe('bug B: the cause of a pre-ready exit is the child’s own output, structured', () => {
  it('a stale install record: bootCause install-state-not-writable, the error carries no shared-log gate line', async () => {
    h.port.mockImplementation(portNeverAnnounced)
    h.output = `${STALE_LEASE}\n`

    const boot = startHermes()

    boot.catch(() => undefined)
    await vi.waitFor(() => expect(h.port).toHaveBeenCalledTimes(1))
    children[0]!.emit('exit', 1, null)

    const error = await boot.then(
      () => null,
      (reason: unknown) => reason as Error
    )

    expect(readBootCause(error)).toMatchObject({ code: 'install-state-not-writable' })
    expect(error!.message).not.toContain('[iclone-gate]')
    expect(error!.message).toContain('Recent backend output:')
    expect(h.progress).toHaveBeenCalledWith(
      expect.objectContaining({ bootCause: expect.objectContaining({ code: 'install-state-not-writable' }) }),
      expect.anything()
    )
    // Deterministic: latched, NOT restarted (a restart cannot cure it; point A's quarantine and the user's Retry do).
    expect(h.bootState.backendStartFailure).toBe(error)
    expect(primaryBackendAutoRestart()?.status()).toMatchObject({ phase: 'stopped', stoppedBecause: 'deterministic' })
  })
})

describe('bug C: no terminal latch — main restarts a transient failure on a schedule', () => {
  it('a transient pre-ready exit is restarted after 1 s; calls before that get the hold and spawn nothing', async () => {
    vi.useFakeTimers()
    h.port.mockImplementationOnce(portNeverAnnounced).mockImplementation(async () => 4242)
    h.output = 'Traceback (most recent call last):\nRuntimeError: boom\n'

    const first = startHermes()

    first.catch(() => undefined)
    await vi.waitFor(() => expect(h.port).toHaveBeenCalledTimes(1))
    children[0]!.emit('exit', 1, null)
    await expect(first).rejects.toThrow(/exited before it became ready/)

    expect(readBootCause(h.bootState.backendStartFailure)).toMatchObject({ code: 'exit-nonzero' })
    expect(primaryBackendAutoRestart()?.status()).toMatchObject({ phase: 'waiting', attempt: 1 })

    // The renderer's reconnect loop during the wait: the hold, no spawn ahead of the schedule.
    await expect(startHermes()).rejects.toThrow(/exited before it became ready/)
    expect(h.spawn).toHaveBeenCalledTimes(1)

    h.output = ''
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(h.restarted).toHaveBeenCalledTimes(1))

    expect(h.spawn).toHaveBeenCalledTimes(2)
    expect(h.bootState.backendStartFailure).toBeNull()
    expect(primaryBackendAutoRestart()?.status().phase).toBe('idle')
    // A later startHermes() joins the live connection: nothing is re-thrown, nothing spawned again.
    await expect(startHermes()).resolves.toMatchObject({ baseUrl: 'http://127.0.0.1:4242', mode: 'local' })
    expect(h.spawn).toHaveBeenCalledTimes(2)
  })

  it('a ready backend that crashes is restarted by main (1 s), and the renderer is told to re-dial', async () => {
    vi.useFakeTimers()
    h.port.mockImplementation(async () => 5151)

    await expect(startHermes()).resolves.toMatchObject({ baseUrl: 'http://127.0.0.1:5151' })
    expect(h.spawn).toHaveBeenCalledTimes(1)

    h.output = 'Segmentation fault\n'
    children[0]!.emit('exit', null, 'SIGSEGV')

    expect(primaryBackendAutoRestart()?.status()).toMatchObject({ phase: 'waiting', attempt: 1, trigger: 'crash' })
    // Held until the schedule: the renderer's reconnect does not respawn on its own.
    await expect(startHermes()).rejects.toThrow(/stopped unexpectedly/)
    expect(h.spawn).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(h.restarted).toHaveBeenCalledTimes(1))
    expect(h.spawn).toHaveBeenCalledTimes(2)
    expect(h.bootState.backendStartFailure).toBeNull()
  })

  it('five automatic attempts in 10 min, then the breaker: stopped, latched, no sixth spawn until the user resets', async () => {
    vi.useFakeTimers()
    h.port.mockImplementation(portNeverAnnounced)
    h.output = 'RuntimeError: boom\n'

    const exitWhenSpawned = async (count: number) => {
      await vi.waitFor(() => expect(h.port).toHaveBeenCalledTimes(count))
      children[count - 1]!.emit('exit', 1, null)
    }

    const first = startHermes()

    first.catch(() => undefined)
    await exitWhenSpawned(1)
    await first.catch(() => undefined)

    for (const [index, delay] of [1_000, 2_000, 4_000, 8_000, 16_000].entries()) {
      await vi.advanceTimersByTimeAsync(delay)
      await exitWhenSpawned(index + 2)
    }

    await vi.waitFor(() => expect(primaryBackendAutoRestart()?.status()).toMatchObject({ phase: 'stopped', stoppedBecause: 'limit' }))
    expect(h.spawn).toHaveBeenCalledTimes(6)

    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.spawn).toHaveBeenCalledTimes(6)
    expect(h.bootState.backendStartFailure).toBeInstanceOf(Error)
  })
})
