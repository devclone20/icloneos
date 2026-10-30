/**
 * V3-S (K139, r2 M1 + m4): "Open in terminal" launches a Hermes TUI in the user's own terminal app. It goes through the
 * real `prepareHermesSpawn` (role `external-terminal`), which refuses: that process is not a child of main, so its
 * permission key cannot be delivered. Nothing is written or spawned, no key is minted, no gate probe runs.
 */
import type * as NodeFs from 'node:fs'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  confinement: vi.fn(() => ({})),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  permissions: vi.fn(),
  spawn: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn()
}))

vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: h.spawn }))
// The real fs underneath (modules the handler imports read fs.constants at load); the three calls it makes are spies.
vi.mock('node:fs', async importOriginal => {
  const real = await importOriginal<typeof NodeFs>()

  return {
    ...real,
    default: { ...real, existsSync: () => false, mkdirSync: h.mkdirSync, writeFileSync: h.writeFileSync }
  }
})
vi.mock('electron', () => {
  const ipcMain = {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => h.handlers.set(channel, handler),
    on: vi.fn(),
    removeHandler: vi.fn()
  }

  return {
    app: { getPath: () => '/nonexistent-user-data', isPackaged: false },
    BrowserWindow: { fromWebContents: vi.fn(), getAllWindows: () => [] },
    ipcMain,
    powerSaveBlocker: { isStarted: () => false, start: vi.fn(), stop: vi.fn() },
    systemPreferences: {}
  }
})
vi.mock('../external-terminal', () => ({
  buildTerminalScript: () => '#!/bin/sh',
  resolveTerminalLaunch: () => ({ args: ['-a', 'Terminal'], command: '/usr/bin/open' }),
  terminalScriptEnv: () => ({}),
  terminalScriptExtension: () => '.command',
  tuiResumeArgs: (id: string) => ['--tui', '--resume', id]
}))
vi.mock('../find-in-page', () => ({
  installFoundInPageForwarder: vi.fn(),
  performFindAfterIndexingStarted: vi.fn(),
  stopFind: vi.fn()
}))
vi.mock('../iclone-consent', () => ({ consentAllows: () => true, withScreenDeclined: vi.fn() }))
vi.mock('../iclone-confinement/ipc', () => ({ confinementSpawnEnv: h.confinement }))
vi.mock('../iclone-permissions/ipc', () => ({ permissionsSpawn: h.permissions }))
vi.mock('../power-save', () => ({ createKeepAwake: () => ({}) }))
vi.mock('../quick-entry', () => ({ sanitizeQuickEntrySettings: vi.fn() }))
vi.mock('../window-below', () => ({ readWindowBelow: vi.fn() }))
vi.mock('./backend-routing', () => ({ reachablePreviewUrl: vi.fn() }))
vi.mock('./env', () => ({
  ACTIVE_HERMES_ROOT: '/managed',
  DEV_SERVER: undefined,
  HERMES_HOME: '/tmp/v3s-hh',
  IS_MAC: true,
  REMOTE_DISPLAY_REASON: null,
  SOURCE_REPO_ROOT: '/repo'
}))
vi.mock('./executables', () => ({ findOnPath: vi.fn() }))
vi.mock('./log', () => ({ rememberLog: vi.fn() }))
vi.mock('./quick-entry', () => ({
  applyQuickEntrySettings: vi.fn(),
  hideQuickEntryWindow: vi.fn(),
  quickEntryShortcut: vi.fn(),
  readQuickEntrySettings: vi.fn(),
  writeQuickEntrySettings: vi.fn()
}))
vi.mock('./runtime', () => ({
  resolveRendererIndex: () => '/app/dist/index.html',
  sanitizeWorkspaceCwd: () => ({ cwd: '/work' })
}))
vi.mock('./shell-open', () => ({ openExternalUrl: vi.fn(), openPreviewInBrowser: vi.fn() }))
vi.mock('./updates', () => ({
  resolveHermesBackend: (args: string[]) => ({
    args: ['-m', 'hermes_cli.main', ...args],
    command: '/managed/venv/bin/python',
    env: {},
    kind: 'python',
    root: '/managed'
  })
}))
vi.mock('./window-events', () => ({ setAndPersistZoomLevel: vi.fn() }))
vi.mock('./windows', () => ({
  createBrowserWindow: vi.fn(),
  createInstanceWindow: vi.fn(),
  createSessionWindow: vi.fn(),
  wakeIndicatorController: { getState: vi.fn(), setState: vi.fn() }
}))

const { registerWindowIpc } = await import('./window-ipc')

beforeEach(() => {
  h.handlers.clear()

  for (const mock of [h.confinement, h.permissions, h.spawn, h.writeFileSync, h.mkdirSync]) {
    mock.mockClear()
  }

  registerWindowIpc({ connectionRuntimeState: {}, windowsState: {} } as never)
})

describe('Open in terminal — an app-launched Hermes outside main', () => {
  it('is refused by the gate: [iclone-gate], no launcher script, no spawn, no key minted, no probe', async () => {
    const open = h.handlers.get('hermes:window:openInTerminal')!

    const result = (await open({}, 'session-1', { cwd: '/work', profile: 'work' })) as { error?: string; ok: boolean }

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/^\[iclone-gate\] .*cannot receive its permission key/)
    expect(h.spawn).not.toHaveBeenCalled()
    expect(h.writeFileSync).not.toHaveBeenCalled()
    // Not even the launcher folder is made before the refusal (critic row O8).
    expect(h.mkdirSync).not.toHaveBeenCalled()
    expect(h.permissions).not.toHaveBeenCalled()
    expect(h.confinement).not.toHaveBeenCalled()
  })
})
