/**
 * Since Electron 44 a file dialog with an empty `defaultPath` opens in Downloads, and one given a bare file name
 * leaves the folder to the OS. Each dialog purpose remembers the folder of its last pick, so the next dialog opens
 * where the user was; a path the caller chose wins.
 */
import path from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  showOpenDialog: vi.fn(async (..._args: unknown[]) => ({ canceled: false, filePaths: [] as string[] })),
  showSaveDialog: vi.fn(async (..._args: unknown[]) => ({ canceled: false, filePath: '' as string | undefined })),
  state: { mainWindow: null as unknown }
}))

vi.mock('electron', () => ({ dialog: { showOpenDialog: h.showOpenDialog, showSaveDialog: h.showSaveDialog } }))
vi.mock('./state', () => ({ windowsState: h.state }))

const { forgetDialogDirectories, rememberedDefaultPath, showOpenDialogForMainWindow, showSaveDialogForMainWindow } =
  await import('./dialogs')

function lastOptions(spy: typeof h.showOpenDialog | typeof h.showSaveDialog) {
  const args = spy.mock.calls.at(-1) ?? []

  return args.at(-1) as { defaultPath?: string }
}

beforeEach(() => {
  vi.clearAllMocks()
  forgetDialogDirectories()
  h.state.mainWindow = null
})

describe('dialogs remember the last folder per purpose', () => {
  it('first open has nothing to remember: the caller options pass through unchanged', async () => {
    await showOpenDialogForMainWindow({ title: 'Add context' }, 'add-context')
    expect(lastOptions(h.showOpenDialog)).toEqual({ title: 'Add context', defaultPath: undefined })
  })

  it('an open dialog reopens in the folder of its last pick', async () => {
    h.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/work/repo/notes.md', '/work/repo/a.ts'] })
    await showOpenDialogForMainWindow({ properties: ['openFile'] }, 'add-context')
    await showOpenDialogForMainWindow({ properties: ['openFile'] }, 'add-context')
    expect(lastOptions(h.showOpenDialog).defaultPath).toBe(path.dirname('/work/repo/notes.md'))
  })

  it('a save dialog keeps the caller file name inside the remembered folder', async () => {
    h.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: '/exports/first.zip' })
    await showSaveDialogForMainWindow({ defaultPath: 'first.zip' }, 'save-download')
    expect(lastOptions(h.showSaveDialog).defaultPath).toBe('first.zip')

    await showSaveDialogForMainWindow({ defaultPath: 'second.zip' }, 'save-download')
    expect(lastOptions(h.showSaveDialog).defaultPath).toBe(path.join(path.dirname('/exports/first.zip'), 'second.zip'))
  })

  it('an absolute defaultPath from the caller is never replaced', async () => {
    h.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: '/exports/first.zip' })
    await showSaveDialogForMainWindow({}, 'save-path')
    await showSaveDialogForMainWindow({ defaultPath: '/chosen/by/caller.txt' }, 'save-path')
    expect(lastOptions(h.showSaveDialog).defaultPath).toBe('/chosen/by/caller.txt')
  })

  it('a cancelled dialog remembers nothing; purposes do not share a folder; no purpose, no memory', async () => {
    h.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: ['/ignored/x'] })
    await showOpenDialogForMainWindow({}, 'add-context')
    h.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: '/saves/a.txt' })
    await showSaveDialogForMainWindow({}, 'save-path')
    h.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: '/elsewhere/b.txt' })
    await showSaveDialogForMainWindow({})

    expect(rememberedDefaultPath('add-context', undefined)).toBeUndefined()
    expect(rememberedDefaultPath('save-download', 'x.bin')).toBe('x.bin')
    expect(rememberedDefaultPath('save-path', undefined)).toBe(path.dirname('/saves/a.txt'))
    expect(rememberedDefaultPath(undefined, undefined)).toBeUndefined()
  })

  it('parents the dialog on the main window when one exists', async () => {
    const win = { id: 1 }
    h.state.mainWindow = win
    await showOpenDialogForMainWindow({}, 'add-context')
    expect(h.showOpenDialog.mock.calls.at(-1)?.[0]).toBe(win)
  })
})
