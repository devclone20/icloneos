/**
 * The file pickers name their dialog purpose: each purpose remembers the folder of its last pick (dialogs.ts), so a
 * picker that forgot to say which it is would open in Downloads on Electron 44.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  showOpenDialogForMainWindow: vi.fn(async (..._args: unknown[]) => ({ canceled: false, filePaths: ['/a/b.txt'] })),
  showSaveDialogForMainWindow: vi.fn(async (..._args: unknown[]) => ({ canceled: false, filePath: '/a/out.zip' }))
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent-user-data' },
  clipboard: { read: vi.fn(), readText: vi.fn(), writeText: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => h.handlers.set(channel, handler),
    on: vi.fn()
  },
  nativeImage: { createFromBuffer: vi.fn() },
  webContents: { fromId: vi.fn() }
}))
vi.mock('../wsl-clipboard-image', () => ({ readWslWindowsClipboardImage: vi.fn() }))
vi.mock('../wsl-path-bridge', () => ({ resolvePickerDefaultPath: vi.fn() }))
vi.mock('./backend-routing', () => ({ saveGatewayFile: vi.fn() }))
vi.mock('./dialogs', () => ({
  showOpenDialogForMainWindow: h.showOpenDialogForMainWindow,
  showSaveDialogForMainWindow: h.showSaveDialogForMainWindow
}))
vi.mock('./env', () => ({ IS_WINDOWS: false, IS_WSL: false }))
vi.mock('./link-metadata', () => ({ mimeTypeForPath: vi.fn(), saveImageFromUrl: vi.fn() }))
vi.mock('./log', () => ({ rememberLog: vi.fn() }))
vi.mock('./preview', () => ({
  normalizePreviewTarget: vi.fn(),
  stopPreviewFileWatch: vi.fn(),
  watchDirectory: vi.fn(),
  watchPreviewFile: vi.fn(),
  writeComposerImage: vi.fn()
}))
vi.mock('./window-events', () => ({ lastContextMenuPoint: new Map() }))

const { registerFilesIpc } = await import('./files-ipc')

registerFilesIpc({ windowsState: { mainWindow: null } as never })

function invoke(channel: string, ...args: unknown[]) {
  const handler = h.handlers.get(channel)

  if (!handler) {
    throw new Error(`no handler for ${channel}`)
  }

  return handler({}, ...args)
}

describe('file picker dialog purposes', () => {
  beforeEach(() => {
    h.showOpenDialogForMainWindow.mockClear()
    h.showSaveDialogForMainWindow.mockClear()
  })

  it('hermes:selectPaths opens the add-context picker', async () => {
    await expect(invoke('hermes:selectPaths', { title: 'Add files' })).resolves.toEqual(['/a/b.txt'])

    expect(h.showOpenDialogForMainWindow).toHaveBeenCalledTimes(1)
    expect(h.showOpenDialogForMainWindow.mock.calls[0]?.[1]).toBe('add-context')
    expect(h.showOpenDialogForMainWindow.mock.calls[0]?.[0]).toMatchObject({ title: 'Add files' })
  })

  it('hermes:selectSavePath opens the save-path picker', async () => {
    await expect(invoke('hermes:selectSavePath', { defaultPath: 'profile.zip' })).resolves.toBe('/a/out.zip')

    expect(h.showSaveDialogForMainWindow).toHaveBeenCalledTimes(1)
    expect(h.showSaveDialogForMainWindow.mock.calls[0]?.[1]).toBe('save-path')
    expect(h.showSaveDialogForMainWindow.mock.calls[0]?.[0]).toMatchObject({ defaultPath: 'profile.zip' })
  })
})
