// Once a quit's teardown has begun (main's before-quit, past any remote-update wait), no new SSH dial starts (remote.ts) and the Connections screen's host lookup spawns no
// `ssh -G` (connections-ipc.ts). Every collaborator is a stub; the quit state and its refusal are the real ones.
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

const { beginQuitTeardown, quitState, QuitInProgressError } = await import('./state')
const { bootstrapSshConnection } = await import('./remote')
const { registerConnectionsIpc } = await import('./connections-ipc')

registerConnectionsIpc({ saveRegistryConnection: vi.fn(), stopRegistryConnectionBackends: vi.fn() } as never)

const resolveHost = (host: string) => h.handlers.get('hermes:ssh-config:resolve')?.({}, host) as Promise<unknown>

afterEach(() => {
  quitState.quitting = false
  h.spawn.mockReset()
  h.start.mockClear()
  h.fingerprint.mockClear()
})

describe('no new SSH dial while quitting', () => {
  it('a dial requested once the quit teardown began is refused before its ssh -G and before the bootstrap starts', async () => {
    beginQuitTeardown()
    await expect(
      bootstrapSshConnection('work', { host: 'example.test' } as never, 'reuse', 'boot', 'e'.repeat(64))
    ).rejects.toBeInstanceOf(QuitInProgressError)
    await expect(bootstrapSshConnection('work', { host: 'example.test' } as never, 'reuse', 'boot')).rejects.toThrow(
      'quitting: ssh dial refused'
    )
    expect(h.fingerprint).not.toHaveBeenCalled()
    expect(h.start).not.toHaveBeenCalled()
  })

  it('control: with no quit under way the same dial reaches the bootstrap', async () => {
    await bootstrapSshConnection('work', { host: 'example.test' } as never, 'reuse', 'boot', 'e'.repeat(64))
    expect(h.start).toHaveBeenCalledTimes(1)
  })
})

describe('no `ssh -G` host lookup while quitting', () => {
  it('the lookup requested once the quit teardown began rejects and spawns nothing', async () => {
    expect(h.handlers.has('hermes:ssh-config:resolve')).toBe(true)
    beginQuitTeardown()
    await expect(resolveHost('example.test')).rejects.toBeInstanceOf(QuitInProgressError)
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('control: with no quit under way the lookup spawns ssh -G -- host', async () => {
    h.spawn.mockImplementation(() => {
      throw new Error('stop after spawn')
    })
    await expect(resolveHost('example.test')).rejects.toThrow('stop after spawn')
    expect(h.spawn).toHaveBeenCalledTimes(1)
    expect(h.spawn.mock.calls[0]?.[1]).toEqual(['-G', '--', 'example.test'])
  })
})
