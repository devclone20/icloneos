// The wallet scan channels (iclone:inft-scan, iclone:inft-scan-tick, iclone:inft-book-scan) answer only the app's own
// renderer: the same createAppSenderGuard main puts on ACP, iNFT-KV and email (critic N4). A foreign or unknown
// webContents gets null and the handler never runs: 0 indexer pages, 0 RPC batches spent on an arbitrary address.
// Electron and the network are fakes: nothing leaves the machine.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const lab = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>(), userData: '' }))

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/nonexistent',
    getPath: () => lab.userData,
    isPackaged: false,
    once: () => undefined,
    on: () => undefined
  },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => lab.handlers.set(channel, handler),
    on: () => undefined,
    removeListener: () => undefined
  },
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler: () => undefined,
      clearStorageData: () => Promise.resolve(),
      getStoragePath: () => lab.userData
    })
  },
  shell: { openExternal: () => undefined }
}))

vi.mock('node:http', () => {
  const createServer = () => {
    const server: Record<string, unknown> = { listening: true, listen: () => server, close: () => server }

    server.on = () => server
    server.once = () => server

    return server
  }

  return { createServer, default: { createServer } }
})

const WALLET = '0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631'
const CONTRACT = '0x9999999999999999999999999999999999999999'
const RENDERER_INDEX = '/Applications/iclone os.app/Contents/Resources/app.asar/dist/index.html'
const RENDERER_URL = 'file:///Applications/iclone%20os.app/Contents/Resources/app.asar/dist/index.html'

interface FakeContents {
  owned: boolean
  getType: () => string
  isDestroyed: () => boolean
  mainFrame: { url: string }
}

function contents(type: string, url: string, { owned = true, destroyed = false } = {}): FakeContents {
  return { owned, getType: () => type, isDestroyed: () => destroyed, mainFrame: { url } }
}

const appWindow = contents('window', RENDERER_URL)
const trusted = { sender: appWindow, senderFrame: appWindow.mainFrame }
const privyWindow = contents('window', 'http://127.0.0.1:47831/privy.html')
const webview = contents('webview', RENDERER_URL)
const detached = contents('window', RENDERER_URL, { owned: false })
const destroyed = contents('window', RENDERER_URL, { destroyed: true })

const FOREIGN: [string, unknown][] = [
  [
    'a window on a remote page with its own preload (the Privy sign-in window)',
    { sender: privyWindow, senderFrame: privyWindow.mainFrame }
  ],
  ['a <webview> guest on the renderer URL', { sender: webview, senderFrame: webview.mainFrame }],
  ['a subframe inside the app window', { sender: appWindow, senderFrame: { url: RENDERER_URL } }],
  ['a webContents no BrowserWindow owns', { sender: detached, senderFrame: detached.mainFrame }],
  ['a destroyed app window', { sender: destroyed, senderFrame: destroyed.mainFrame }],
  ['an unknown webContents (no type, no frame)', { sender: {} }],
  ['a sender whose frame is already gone', { sender: appWindow, senderFrame: null }]
]

// Each scan channel with arguments that WOULD spend the indexer and RPC budget if the handler ran.
const CALLS: [string, unknown[]][] = [
  ['iclone:inft-scan', [WALLET]],
  ['iclone:inft-scan-tick', [WALLET, [`base:${CONTRACT}:1`]]],
  ['iclone:inft-book-scan', [WALLET, null]]
]

const fetchMock = vi.fn((_input: string | URL, init?: { method?: string; body?: string }) => {
  const calls = init?.method === 'POST' ? (JSON.parse(init.body ?? '[]') as { id: number }[]) : null

  return Promise.resolve({
    ok: true,
    json: () =>
      Promise.resolve(
        calls
          ? calls.map(call => ({ id: call.id, result: `0x${WALLET.slice(2).padStart(64, '0')}` }))
          : { items: [], next_page_params: null }
      )
  })
})

const bookPages = vi.fn((_chain: string) => Promise.resolve({ items: [], next: null }))

const call = (channel: string, event: unknown, ...args: unknown[]) => {
  const handler = lab.handlers.get(channel)

  if (!handler) {
    throw new Error(`${channel} is not registered`)
  }

  return Promise.resolve(handler(event, ...args))
}

async function register() {
  vi.resetModules()
  lab.handlers.clear()

  const { createAppSenderGuard } = await import('./ipc-sender-guard')
  const { initIclonePrivy } = await import('./iclone-privy')
  const { initInftBook } = await import('./iclone-inft-book')

  const isTrustedSender = createAppSenderGuard({
    rendererIndexPath: () => RENDERER_INDEX,
    log: () => undefined,
    hasOwnerWindow: sender => 'owned' in sender && sender.owned === true
  })

  initIclonePrivy({ getMainWindow: () => null, isTrustedSender })
  initInftBook({ chains: ['Base', 'Robinhood'], readPage: bookPages, isTrustedSender })
}

beforeAll(async () => {
  lab.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'iclone-scan-sender-'))
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.stubGlobal('fetch', fetchMock)
  await register()
})

afterAll(() => {
  vi.unstubAllGlobals()
  fs.rmSync(lab.userData, { recursive: true, force: true })
})

describe('the scan channels refuse every foreign sender', () => {
  it.each(FOREIGN)('%s: null on all 3 channels, 0 requests', async (_name, event) => {
    fetchMock.mockClear()
    bookPages.mockClear()

    for (const [channel, args] of CALLS) {
      await expect(call(channel, event, ...args)).resolves.toBeNull()
    }

    expect(fetchMock).not.toHaveBeenCalled()
    expect(bookPages).not.toHaveBeenCalled()
  })

  it('the app window still scans: the same calls answer and read', async () => {
    fetchMock.mockClear()
    bookPages.mockClear()

    for (const [channel, args] of CALLS) {
      await expect(call(channel, trusted, ...args)).resolves.toMatchObject({ ok: true })
    }

    expect(fetchMock).toHaveBeenCalled()
    expect(bookPages).toHaveBeenCalledTimes(1)
  })
})
