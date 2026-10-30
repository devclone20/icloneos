import { describe, expect, it, vi } from 'vitest'

import { APP_UPDATE_CHANNELS, broadcastToWindows, inactiveAppUpdateState, registerAppUpdateIpc } from './app-update-ipc'

function harness(controller: any, trusted = true) {
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>()

  registerAppUpdateIpc({
    controller: () => controller,
    currentVersion: () => '0.0.2',
    ipcMain: { handle: (channel, fn) => void handlers.set(channel, fn) },
    isTrustedSender: () => trusted,
    readLog: () => [{ at: 1, from: '0.0.1', result: 'installed', to: '0.0.2' }]
  })

  return (channel: string, payload?: unknown) => handlers.get(channel)?.({}, payload)
}

describe('registerAppUpdateIpc', () => {
  it('answers inactive without an updater and refuses every action', () => {
    const call = harness(null)
    expect(call(APP_UPDATE_CHANNELS.state)).toEqual(inactiveAppUpdateState('0.0.2'))
    expect(call(APP_UPDATE_CHANNELS.download)).toBe(false)
    expect(call(APP_UPDATE_CHANNELS.cancel)).toBe(false)
    expect(call(APP_UPDATE_CHANNELS.restart)).toEqual({ outcome: 'not-downloaded' })
    expect(call(APP_UPDATE_CHANNELS.log)).toHaveLength(1)
  })

  it('routes to the controller; restart is confirmed only by an explicit true', () => {
    const ctl = {
      cancel: vi.fn(() => true),
      download: vi.fn(() => true),
      restart: vi.fn(() => ({ outcome: 'installing' })),
      state: vi.fn(() => ({ phase: 'available' }))
    }

    const call = harness(ctl)
    expect(call(APP_UPDATE_CHANNELS.state)).toEqual({ phase: 'available' })
    expect(call(APP_UPDATE_CHANNELS.download)).toBe(true)
    expect(call(APP_UPDATE_CHANNELS.cancel)).toBe(true)
    call(APP_UPDATE_CHANNELS.restart, { confirmed: 'yes' })
    call(APP_UPDATE_CHANNELS.restart, { confirmed: true })
    expect(ctl.restart.mock.calls).toEqual([[{ confirmed: false }], [{ confirmed: true }]])
  })

  it('an untrusted sender gets nothing', () => {
    const call = harness(null, false)
    expect(() => call(APP_UPDATE_CHANNELS.state)).toThrow(/untrusted/)
    expect(() => call(APP_UPDATE_CHANNELS.download)).toThrow(/untrusted/)
    expect(() => call(APP_UPDATE_CHANNELS.log)).toThrow(/untrusted/)
  })
})

describe('broadcastToWindows', () => {
  it('pushes to every live window only', () => {
    const live = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: vi.fn() } }
    const gone = { isDestroyed: () => true, webContents: { isDestroyed: () => false, send: vi.fn() } }
    expect(broadcastToWindows(() => [live, gone], APP_UPDATE_CHANNELS.changed, { phase: 'idle' })).toBe(1)
    expect(live.webContents.send).toHaveBeenCalledWith(APP_UPDATE_CHANNELS.changed, { phase: 'idle' })
    expect(gone.webContents.send).not.toHaveBeenCalled()
  })
})
