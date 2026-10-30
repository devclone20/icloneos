import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  canOpenBrowserWindow,
  canOpenNewWindow,
  canOpenSessionInTerminal,
  canOpenSessionWindow,
  isPeerInstanceWindow,
  openBrowserInNewWindow,
  openNewWindow,
  openSessionInNewWindow,
  openSessionInTerminal
} from './windows'

const desktopWindow = window as unknown as { hermesDesktop?: Window['hermesDesktop'] }
const initialHermesDesktop = desktopWindow.hermesDesktop

const notifyError = vi.fn()
const notify = vi.fn()

vi.mock('./notifications', () => ({
  notify: (...args: unknown[]) => notify(...args),
  notifyError: (...args: unknown[]) => notifyError(...args)
}))

function installBridge(
  openSessionWindow?: Window['hermesDesktop']['openSessionWindow'],
  openWindow?: Window['hermesDesktop']['openWindow'],
  openBrowserWindow?: Window['hermesDesktop']['openBrowserWindow']
) {
  desktopWindow.hermesDesktop = {
    ...(openSessionWindow ? { openSessionWindow } : {}),
    ...(openWindow ? { openWindow } : {}),
    ...(openBrowserWindow ? { openBrowserWindow } : {})
  } as unknown as Window['hermesDesktop']
}

beforeEach(() => {
  notifyError.mockClear()
  notify.mockClear()
})

afterEach(() => {
  if (initialHermesDesktop) {
    desktopWindow.hermesDesktop = initialHermesDesktop
  } else {
    delete desktopWindow.hermesDesktop
  }
})

describe('canOpenSessionWindow', () => {
  it('is false when the desktop bridge is absent', () => {
    delete desktopWindow.hermesDesktop
    expect(canOpenSessionWindow()).toBe(false)
  })

  it('is false when the bridge lacks openSessionWindow', () => {
    installBridge(undefined)
    expect(canOpenSessionWindow()).toBe(false)
  })

  it('is true when the bridge exposes openSessionWindow', () => {
    installBridge(vi.fn().mockResolvedValue({ ok: true }))
    expect(canOpenSessionWindow()).toBe(true)
  })
})

describe('isPeerInstanceWindow', () => {
  it('recognizes only the full peer marker', () => {
    expect(isPeerInstanceWindow('?peer=1')).toBe(true)
    expect(isPeerInstanceWindow('?peer=0')).toBe(false)
    expect(isPeerInstanceWindow('?win=secondary')).toBe(false)
    expect(isPeerInstanceWindow('')).toBe(false)
  })
})

describe('openSessionInNewWindow', () => {
  it('no-ops without a session id', async () => {
    const open = vi.fn().mockResolvedValue({ ok: true })
    installBridge(open)

    await openSessionInNewWindow('')

    expect(open).not.toHaveBeenCalled()
    expect(notifyError).not.toHaveBeenCalled()
  })

  it('no-ops gracefully when the bridge is absent (web fallback)', async () => {
    delete desktopWindow.hermesDesktop

    await openSessionInNewWindow('s1')

    expect(notifyError).not.toHaveBeenCalled()
  })

  it('invokes the bridge with the session id', async () => {
    const open = vi.fn().mockResolvedValue({ ok: true })
    installBridge(open)

    await openSessionInNewWindow('s1')

    expect(open).toHaveBeenCalledWith('s1', undefined)
    expect(notifyError).not.toHaveBeenCalled()
  })

  it('forwards the watch flag for spectator (subagent) windows', async () => {
    const open = vi.fn().mockResolvedValue({ ok: true })
    installBridge(open)

    await openSessionInNewWindow('s1', { watch: true })

    expect(open).toHaveBeenCalledWith('s1', { watch: true })
    expect(notifyError).not.toHaveBeenCalled()
  })

  it('notifies on an ok:false result', async () => {
    installBridge(vi.fn().mockResolvedValue({ ok: false, error: 'invalid-session-id' }))

    await openSessionInNewWindow('s1')

    expect(notifyError).toHaveBeenCalledTimes(1)
  })

  it('notifies when the bridge throws', async () => {
    installBridge(vi.fn().mockRejectedValue(new Error('boom')))

    await openSessionInNewWindow('s1')

    expect(notifyError).toHaveBeenCalledTimes(1)
  })
})

describe('canOpenNewWindow', () => {
  it('is false when the desktop bridge is absent', () => {
    delete desktopWindow.hermesDesktop
    expect(canOpenNewWindow()).toBe(false)
  })

  it('is false when the bridge lacks openWindow', () => {
    installBridge(vi.fn().mockResolvedValue({ ok: true }))
    expect(canOpenNewWindow()).toBe(false)
  })

  it('is true when the bridge exposes openWindow', () => {
    installBridge(undefined, vi.fn().mockResolvedValue({ ok: true }))
    expect(canOpenNewWindow()).toBe(true)
  })
})

describe('openNewWindow', () => {
  it('no-ops gracefully when the bridge is absent (web fallback)', async () => {
    delete desktopWindow.hermesDesktop

    await openNewWindow()

    expect(notifyError).not.toHaveBeenCalled()
  })

  it('no-ops when openWindow is missing', async () => {
    installBridge(vi.fn().mockResolvedValue({ ok: true }))

    await openNewWindow()

    expect(notifyError).not.toHaveBeenCalled()
  })

  it('invokes the bridge', async () => {
    const openWindow = vi.fn().mockResolvedValue({ ok: true })
    installBridge(undefined, openWindow)

    await openNewWindow()

    expect(openWindow).toHaveBeenCalledTimes(1)
    expect(notifyError).not.toHaveBeenCalled()
  })

  it('notifies on an ok:false result', async () => {
    installBridge(undefined, vi.fn().mockResolvedValue({ ok: false, error: 'nope' }))

    await openNewWindow()

    expect(notifyError).toHaveBeenCalledTimes(1)
  })
})

describe('canOpenBrowserWindow', () => {
  it('is false when the desktop bridge is absent', () => {
    delete desktopWindow.hermesDesktop
    expect(canOpenBrowserWindow()).toBe(false)
  })

  it('is false when the bridge lacks openBrowserWindow', () => {
    installBridge(vi.fn().mockResolvedValue({ ok: true }))
    expect(canOpenBrowserWindow()).toBe(false)
  })

  it('is true when the bridge exposes openBrowserWindow', () => {
    installBridge(undefined, undefined, vi.fn().mockResolvedValue({ ok: true }))
    expect(canOpenBrowserWindow()).toBe(true)
  })
})

describe('openBrowserInNewWindow', () => {
  it('returns false without a tab id', async () => {
    const open = vi.fn().mockResolvedValue({ ok: true })
    installBridge(undefined, undefined, open)

    expect(await openBrowserInNewWindow('')).toBe(false)
    expect(open).not.toHaveBeenCalled()
    expect(notifyError).not.toHaveBeenCalled()
  })

  it('returns false when the bridge is absent', async () => {
    delete desktopWindow.hermesDesktop

    expect(await openBrowserInNewWindow('tab-1')).toBe(false)
    expect(notifyError).not.toHaveBeenCalled()
  })

  it('invokes the bridge with the tab id', async () => {
    const open = vi.fn().mockResolvedValue({ ok: true })
    installBridge(undefined, undefined, open)

    expect(await openBrowserInNewWindow('tab-1')).toBe(true)
    expect(open).toHaveBeenCalledWith('tab-1')
    expect(notifyError).not.toHaveBeenCalled()
  })

  it('returns false and notifies on an ok:false result', async () => {
    installBridge(undefined, undefined, vi.fn().mockResolvedValue({ ok: false, error: 'invalid-tab-id' }))

    expect(await openBrowserInNewWindow('tab-1')).toBe(false)
    expect(notifyError).toHaveBeenCalledTimes(1)
  })

  it('returns false and notifies when the bridge throws', async () => {
    installBridge(undefined, undefined, vi.fn().mockRejectedValue(new Error('boom')))

    expect(await openBrowserInNewWindow('tab-1')).toBe(false)
    expect(notifyError).toHaveBeenCalledTimes(1)
  })
})

describe('Open in terminal — V3-S r3: not offered while the permission gate refuses it', () => {
  const copy = {
    gateRefused: {
      message: 'Abrir no terminal está desativado: um agente iniciado fora do icloneOS não pode receber a sua chave.',
      title: 'Abrir no terminal'
    }
  }

  function installTerminal(result: { error?: string; ok: boolean }) {
    const openSessionInTerminal = vi.fn(async () => result)
    desktopWindow.hermesDesktop = { openSessionInTerminal } as unknown as Window['hermesDesktop']

    return openSessionInTerminal
  }

  it('canOpenSessionInTerminal() is false even with the desktop bridge present (main refuses every such launch)', () => {
    installTerminal({ ok: true })

    expect(canOpenSessionInTerminal()).toBe(false)
  })

  it('the backstop: a gate refusal from main is shown with the localized title and text only, never main’s reason', async () => {
    const reason = '[iclone-gate] The icloneOS permission gate is not in place, so the agent was not started: x'
    const bridge = installTerminal({ error: reason, ok: false })

    await openSessionInTerminal('s1', { profile: 'work' }, copy)

    expect(bridge).toHaveBeenCalledWith('s1', { profile: 'work' })
    expect(notifyError).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith({ kind: 'error', ...copy.gateRefused })
    expect(JSON.stringify(notify.mock.calls)).not.toContain('permission gate is not in place')
  })

  it('any other failure keeps the generic title', async () => {
    installTerminal({ error: 'No terminal emulator found', ok: false })

    await openSessionInTerminal('s1', undefined, copy)

    expect(notify).not.toHaveBeenCalled()
    expect(notifyError).toHaveBeenCalledWith(
      new Error('No terminal emulator found'),
      'Could not open chat in a terminal'
    )
  })
})
