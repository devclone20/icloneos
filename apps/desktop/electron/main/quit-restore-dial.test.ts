// A quit (Cmd-Q or a signal) that waits for a remote update lets the update's restore dials through: the update ends
// 'updated' and its recovery record is cleared. Only once the quit is past that wait (its teardown began) is every dial
// refused. The quit state, its refusal, the dial and the update's lifecycle are the real ones; the rest are stubs.
import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  spawn: vi.fn(),
  start: vi.fn(async () => ({ ok: true })),
  fingerprint: vi.fn(async () => 'f'.repeat(64))
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => h.handlers.set(channel, handler) }
}))
vi.mock('node:child_process', () => ({ spawn: h.spawn }))

for (const stub of [
  '../../src/iclone-shared/guards',
  '../backend-health',
  '../connection-config',
  '../connection-registry',
  '../dashboard-token',
  '../gateway-ws-probe',
  '../managed-ssh-update',
  '../native-auth-decisions',
  '../packaged-env',
  '../remote-lifecycle',
  '../ssh-config',
  '../ssh-connection',
  '../windows-remote-lifecycle',
  './backend',
  './backend-pool',
  './backend-readiness',
  './backend-routing',
  './backend-state',
  './connection-config',
  './gateway-files',
  './http',
  './oauth',
  './secret-storage',
  './secrets',
  './start-hermes'
]) {
  vi.doMock(stub, () => ({}))
}

vi.mock('../windows-child-options', () => ({ hiddenWindowsChildOptions: (options: unknown) => options }))
vi.mock('../ssh-bootstrap-coordinator', () => ({ sshConfigFingerprint: () => 'scope-fingerprint' }))
vi.mock('./managed-ssh', () => ({
  effectiveSshConfigFingerprint: h.fingerprint,
  sshBootstrapCoordinator: { start: h.start },
  sshScopeKey: (profile: null | string) => profile ?? 'default'
}))

import { EventEmitter } from 'node:events'

import type * as managedSshUpdate from '../managed-ssh-update'

const { beginQuitTeardown, quitState, QuitInProgressError } = await import('./state')
const { bootstrapSshConnection } = await import('./remote')
const { installShutdownSignals } = await import('../shutdown-signals')
const { runManagedSshUpdate } = await vi.importActual<typeof managedSshUpdate>('../managed-ssh-update')

const CORRELATION = '12345678-1234-4678-9234-567812345678'
const dial = () => bootstrapSshConnection('work', { host: 'example.test' } as never, 'reuse', 'boot', 'e'.repeat(64))

/** One update in its restore phase: the restore dials through the real bootstrapSshConnection. */
async function updateThatRestores() {
  const events: string[] = []

  const result = await runManagedSshUpdate({
    connectionId: 'work',
    correlationId: CORRELATION,
    scopes: [{ key: 'work', profile: 'default' }],
    preflightRemote: async () => undefined,
    drainScope: async () => undefined,
    updateRemote: async () => ({ exitCode: 0, receipt: { correlationId: CORRELATION, outcome: 'success' } }),
    awaitRestoreClearance: async () => undefined,
    closeTransports: async () => undefined,
    restoreScope: async () => {
      events.push('restore')
      await dial()
    },
    completeRecovery: async () => {
      events.push('complete recovery')
    },
    releaseGate: () => undefined
  } as never)

  return { events, result }
}

/** The app with the real quit handlers, and main's before-quit while a remote update runs: prevented, waiting. */
function quittingAppWaitingForAnUpdate() {
  const app = Object.assign(new EventEmitter(), {
    exit: vi.fn(),
    quit: () => app.emit('before-quit', { preventDefault() {}, defaultPrevented: false }),
    whenReady: () => new Promise(() => undefined)
  })

  const proc = new EventEmitter()

  installShutdownSignals({
    app,
    process: proc,
    quitState,
    log: () => undefined,
    beginTeardown: () => undefined,
    pendingTeardown: () => [],
    stopOwnedChildren: () => [],
    saveMinimumState: () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined
  } as never)
  app.on('before-quit', (event: { preventDefault(): void }) => event.preventDefault())

  return { app, proc }
}

afterEach(() => {
  quitState.quitting = false
  quitState.isQuittingForHandoff = false
  h.start.mockClear()
  h.fingerprint.mockClear()
})

describe('a quit that waits for a remote update lets its restore dial through', () => {
  it('Cmd-Q (no signal): the restore dial reaches the bootstrap, the update ends updated, the recovery is cleared', async () => {
    const { app } = quittingAppWaitingForAnUpdate()

    app.quit()
    expect(quitState.quitting).toBe(false)

    const { events, result } = await updateThatRestores()

    expect(h.start).toHaveBeenCalledTimes(1)
    expect(result.outcome).toBe('updated')
    expect(result.ok).toBe(true)
    expect(events).toEqual(['restore', 'complete recovery'])
  })

  it('a signal quit waiting for the same update: its restore dial goes through too', async () => {
    const { proc } = quittingAppWaitingForAnUpdate()

    proc.emit('SIGTERM', 'SIGTERM')
    expect(quitState.quitting).toBe(false)

    const { result } = await updateThatRestores()

    expect(h.start).toHaveBeenCalledTimes(1)
    expect(result.outcome).toBe('updated')
  })
})

describe('past the wait, the teardown seals every dial', () => {
  it('a dial once the teardown began is refused before its ssh -G and the bootstrap: QuitInProgressError', async () => {
    const { app } = quittingAppWaitingForAnUpdate()

    app.quit()
    beginQuitTeardown()
    expect(quitState.quitting).toBe(true)
    await expect(dial()).rejects.toBeInstanceOf(QuitInProgressError)
    expect(h.fingerprint).not.toHaveBeenCalled()
    expect(h.start).not.toHaveBeenCalled()
  })

  it('an update that restores only after the teardown began: restore refused, the recovery record kept', async () => {
    beginQuitTeardown()

    const { events, result } = await updateThatRestores()

    expect(h.start).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.outcome).toBe('restore-failed')
    expect(events).toEqual(['restore'])
  })
})
