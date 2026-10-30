import { describe, expect, it, vi } from 'vitest'

import { registerTerminalIpc } from './terminal-ipc'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())

vi.mock('electron', () => ({
  app: {},
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) }
}))

vi.mock('node-pty', () => ({ default: { spawn: vi.fn() } }))

describe('terminal IPC sender check', () => {
  it('refuses every hermes:terminal:* call from a sender the guard rejects', async () => {
    const isTrustedSender = vi.fn((_event: unknown, _channel: string) => false)
    const ensureBackend = vi.fn()

    registerTerminalIpc({
      isWindows: false,
      findOnPath: () => null,
      rememberLog: () => {},
      activeSshTerminalTarget: () => null,
      ensureBackend,
      getSshConnectionState: () => undefined,
      isTrustedSender
    })

    const event = { sender: { id: 7 } }

    await expect(Promise.resolve(handlers.get('hermes:terminal:start')?.(event, {}))).rejects.toThrow(
      'Terminal is only available to the app window'
    )
    expect(handlers.get('hermes:terminal:write')?.(event, 'id', 'rm -rf ~\r')).toBe(false)
    expect(handlers.get('hermes:terminal:resize')?.(event, 'id', { cols: 80, rows: 24 })).toBe(false)
    await expect(handlers.get('hermes:terminal:cwd')?.(event, 'id')).resolves.toBeNull()
    expect(handlers.get('hermes:terminal:dispose')?.(event, 'id')).toBe(false)

    expect(ensureBackend).not.toHaveBeenCalled()
    expect(isTrustedSender.mock.calls.map(([, channel]) => channel)).toEqual([
      'hermes:terminal:start',
      'hermes:terminal:write',
      'hermes:terminal:resize',
      'hermes:terminal:cwd',
      'hermes:terminal:dispose'
    ])
  })
})
