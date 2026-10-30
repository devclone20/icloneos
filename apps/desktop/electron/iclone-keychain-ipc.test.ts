/**
 * V3-FX r3: the Keychain doors — state and the clean relaunch — refuse an untrusted sender (critic k16), and the
 * relaunch happens only when it can change something (on now, off at launch).
 */
import { describe, expect, it, vi } from 'vitest'

import { registerKeychainIpc } from './iclone-keychain-ipc'

function setup(over: { trusted?: boolean; on?: boolean; atLaunch?: boolean } = {}) {
  const handlers = new Map<string, (event: unknown) => unknown>()
  const relaunch = vi.fn()

  registerKeychainIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener as (event: unknown) => unknown) },
    isTrustedSender: () => over.trusted ?? true,
    on: () => over.on ?? true,
    atLaunch: over.atLaunch ?? false,
    relaunch
  })

  return { call: (channel: string) => handlers.get(channel)!({}), relaunch }
}

describe('r3: the Keychain doors', () => {
  it('an untrusted sender gets null from both, and nothing relaunches', () => {
    const { call, relaunch } = setup({ trusted: false })

    expect(call('iclone:keychain:state')).toBeNull()
    expect(call('iclone:keychain:restart')).toBeNull()
    expect(relaunch).not.toHaveBeenCalled()
  })

  it('state: the setting now and at launch', () => {
    expect(setup({ on: true, atLaunch: false }).call('iclone:keychain:state')).toEqual({ on: true, atLaunch: false })
  })

  it('restart: only when on now and off at launch; then exactly one clean relaunch', () => {
    for (const [on, atLaunch] of [
      [false, false],
      [true, true],
      [false, true]
    ] as const) {
      const { call, relaunch } = setup({ on, atLaunch })

      expect(call('iclone:keychain:restart')).toBe(false)
      expect(relaunch).not.toHaveBeenCalled()
    }

    const { call, relaunch } = setup({ on: true, atLaunch: false })

    expect(call('iclone:keychain:restart')).toBe(true)
    expect(relaunch).toHaveBeenCalledTimes(1)
  })
})
