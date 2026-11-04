/**
 * The clipboard IPC handlers on Electron 44's async clipboard: every call is awaited, and the image handler keeps
 * its contract (the saved composer path of a PNG, or '' when the clipboard holds no image).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  clipboard: {
    read: vi.fn(async (): Promise<unknown[]> => []),
    readText: vi.fn(async () => ''),
    writeText: vi.fn(async (_text: string) => undefined)
  },
  createFromBuffer: vi.fn((bytes: Buffer) => ({
    isEmpty: () => bytes.length === 0,
    toPNG: () => Buffer.concat([Buffer.from('png:'), bytes])
  })),
  writeComposerImage: vi.fn(async (_buffer: Buffer, _ext: string) => '/composer/image.png'),
  wslImage: vi.fn((): Buffer | null => null)
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent-user-data' },
  clipboard: h.clipboard,
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => h.handlers.set(channel, handler),
    on: vi.fn()
  },
  nativeImage: { createFromBuffer: h.createFromBuffer },
  webContents: { fromId: vi.fn() }
}))
vi.mock('../wsl-clipboard-image', () => ({ readWslWindowsClipboardImage: h.wslImage }))
vi.mock('../wsl-path-bridge', () => ({ resolvePickerDefaultPath: vi.fn() }))
vi.mock('./backend-routing', () => ({ saveGatewayFile: vi.fn() }))
vi.mock('./dialogs', () => ({ showOpenDialogForMainWindow: vi.fn(), showSaveDialogForMainWindow: vi.fn() }))
vi.mock('./env', () => ({ IS_WINDOWS: false, IS_WSL: false }))
vi.mock('./link-metadata', () => ({ mimeTypeForPath: vi.fn(), saveImageFromUrl: vi.fn() }))
vi.mock('./log', () => ({ rememberLog: vi.fn() }))
vi.mock('./preview', () => ({
  normalizePreviewTarget: vi.fn(),
  stopPreviewFileWatch: vi.fn(),
  watchDirectory: vi.fn(),
  watchPreviewFile: vi.fn(),
  writeComposerImage: h.writeComposerImage
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

function imageItem(type: string, bytes: Buffer) {
  return { types: [type], getType: async () => new Blob([new Uint8Array(bytes)], { type }) }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('clipboard IPC on the async clipboard', () => {
  it('writeClipboard resolves true only after the write settles, with the text coerced to a string', async () => {
    let settle: () => void = () => {}
    h.clipboard.writeText.mockImplementationOnce(
      () => new Promise<undefined>(resolve => (settle = () => resolve(undefined)))
    )

    let done = false

    const pending = Promise.resolve(invoke('hermes:writeClipboard', 42)).then(value => {
      done = true

      return value
    })

    await Promise.resolve()
    expect(done).toBe(false)
    settle()
    await expect(pending).resolves.toBe(true)
    expect(h.clipboard.writeText).toHaveBeenCalledWith('42')
  })

  it('writeClipboard surfaces a failed write as a rejection', async () => {
    h.clipboard.writeText.mockRejectedValueOnce(new Error('denied'))

    await expect(invoke('hermes:writeClipboard', 'x')).rejects.toThrow('denied')
  })

  it('readClipboard resolves with the text', async () => {
    h.clipboard.readText.mockResolvedValueOnce('pasted')

    await expect(invoke('hermes:readClipboard')).resolves.toBe('pasted')
  })

  it("saveClipboardImage: no image on the clipboard resolves '' and writes nothing", async () => {
    h.clipboard.read.mockResolvedValueOnce([{ types: ['text/plain'], getType: async () => new Blob(['hi']) }])

    await expect(invoke('hermes:saveClipboardImage')).resolves.toBe('')
    expect(h.writeComposerImage).not.toHaveBeenCalled()
  })

  it('saveClipboardImage: an image is re-encoded to PNG and saved as a .png composer image', async () => {
    h.clipboard.read.mockResolvedValueOnce([imageItem('image/png', Buffer.from('raw'))])

    await expect(invoke('hermes:saveClipboardImage')).resolves.toBe('/composer/image.png')
    expect(h.createFromBuffer).toHaveBeenCalledTimes(1)
    expect(h.writeComposerImage).toHaveBeenCalledWith(Buffer.from('png:raw'), '.png')
  })
})
