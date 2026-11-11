// F41b: restarting the same backend is not a change of connection. The window keeps its conversation and reconnects.
import { readFileSync } from 'node:fs'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  order: [] as string[],
  startHermes: vi.fn(async () => undefined)
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => mocks.handlers.set(channel, fn), on: vi.fn() }
}))

vi.mock('./backend', () => ({
  fetchJsonForBackend: vi.fn(),
  primaryProfileKey: vi.fn(),
  resetHermesConnection: vi.fn(),
  sendBackendRestarted: () => mocks.order.push('restarted'),
  sendConnectionApplied: () => mocks.order.push('applied'),
  teardownPrimaryBackendAndWait: async () => void mocks.order.push('teardown')
}))
vi.mock('./start-hermes', () => ({ startHermes: () => (mocks.order.push('start'), mocks.startHermes()) }))
vi.mock('./backend-routing', () => ({ ensureBackend: vi.fn(), ensureRegistryBackend: vi.fn(), freshGatewayWsUrl: vi.fn() }))
vi.mock('./connection-config', () => ({ readDesktopConnectionsRegistry: vi.fn() }))
vi.mock('./log', () => ({ rememberLog: vi.fn() }))
vi.mock('./managed-ssh', () => ({ resetPreviewReach: vi.fn(), sshBootstrapCoordinator: {}, sshScopeKey: vi.fn(), teardownSshConnection: vi.fn() }))
vi.mock('../connection-config', () => ({ gatewayWsUrlIpcResult: vi.fn() }))
vi.mock('../connection-registry', () => ({ backendScopeKey: vi.fn(), resolvedConnectionId: vi.fn() }))
vi.mock('../remote-liveness', () => ({ revalidateRemoteConnection: vi.fn() }))

describe('hermes:backend:restart', () => {
  beforeEach(async () => {
    mocks.handlers.clear()
    mocks.order.length = 0
    mocks.startHermes.mockReset()
    mocks.startHermes.mockResolvedValue(undefined)
    const { registerConnectionRoutingIpc } = await import('./connection-routing-ipc')
    registerConnectionRoutingIpc({} as never)
  })

  it('tells the window after the new backend is up, as a restart and never as a change of connection', async () => {
    await expect(mocks.handlers.get('hermes:backend:restart')!()).resolves.toEqual({ ok: true })
    expect(mocks.order).toEqual(['teardown', 'start', 'restarted'])
  })

  it('a failed start still tells the window, so it goes on trying to reconnect', async () => {
    mocks.startHermes.mockRejectedValueOnce(new Error('no runtime'))
    await expect(mocks.handlers.get('hermes:backend:restart')!()).resolves.toEqual({ error: 'no runtime', ok: false })
    expect(mocks.order).toEqual(['teardown', 'start', 'restarted'])
  })
})

// The wiring between the two processes has no unit of its own: a change here brings the stranded chat back.
describe('the restart reaches the window', () => {
  const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')

  it('main sends and the preload listens on the same channel', () => {
    expect(source('./backend.ts')).toContain("webContents.send('hermes:backend:restarted')")
    const preload = source('../preload.ts')

    expect(preload).toContain("ipcRenderer.on('hermes:backend:restarted', listener)")
    expect(preload).toContain("ipcRenderer.removeListener('hermes:backend:restarted', listener)")
  })

  it('isolation and the doctor report a restart, never a change of connection', () => {
    const main = source('../main.ts')

    expect(main).toContain('restarted: sendBackendRestarted')
    expect(main).toContain('await startHermes()\n      sendBackendRestarted()')
    expect(main).not.toContain('sendConnectionApplied()')
  })
})
