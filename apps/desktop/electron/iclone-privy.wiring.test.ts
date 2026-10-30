// The real initIclonePrivy wiring (sign-in record, partition guard, login
// window, status probe) with electron and node:http mocked — not a copy of it.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it, vi } from 'vitest'

interface FakeWindow {
  webContents: Record<string, unknown>
  destroyed: boolean
}

const st = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, Set<(...args: unknown[]) => void>>(),
  windows: [] as FakeWindow[],
  cleared: [] as boolean[],
  appPath: '',
  userData: '',
  storage: ''
}))

vi.mock('electron', () => {
  class FakeBrowserWindow {
    webContents: Record<string, unknown>
    destroyed = false

    constructor() {
      const webContents: Record<string, unknown> = { send: () => undefined, setWindowOpenHandler: () => undefined }

      webContents.on = () => webContents
      webContents.once = () => webContents
      this.webContents = webContents
      st.windows.push(this)
    }

    loadURL() {
      return Promise.resolve()
    }

    isDestroyed() {
      return this.destroyed
    }

    destroy() {
      this.destroyed = true
    }

    close() {
      this.destroyed = true
    }

    once() {
      return this
    }

    on() {
      return this
    }

    show() {}

    focus() {}

    setVisibleOnAllWorkspaces() {}
  }

  return {
    app: {
      getAppPath: () => st.appPath,
      getPath: () => st.userData,
      focus: () => undefined,
      isPackaged: false,
      once: () => undefined,
      on: () => undefined
    },
    BrowserWindow: FakeBrowserWindow,
    ipcMain: {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => st.handlers.set(channel, handler),
      on: (channel: string, listener: (...args: unknown[]) => void) => {
        if (!st.listeners.has(channel)) {
          st.listeners.set(channel, new Set())
        }

        st.listeners.get(channel)!.add(listener)
      },
      removeListener: (channel: string, listener: (...args: unknown[]) => void) =>
        st.listeners.get(channel)?.delete(listener)
    },
    session: {
      fromPartition: () => ({
        setPermissionRequestHandler: () => undefined,
        clearStorageData: () => {
          // Records whether any probe window was still alive when the partition was cleared.
          st.cleared.push(st.windows.some(w => !w.destroyed))

          return Promise.resolve()
        },
        getStoragePath: () => st.storage
      })
    },
    shell: { openExternal: () => undefined }
  }
})

vi.mock('node:http', () => {
  const createServer = () => {
    const server: Record<string, unknown> = { listening: true, listen: () => server, close: () => server }

    server.on = () => server
    server.once = () => server

    return server
  }

  return { createServer, default: { createServer } }
})

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ADDRESS = '0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631'
const IN = { type: 'auth', status: 'in', address: ADDRESS, userId: 'u', label: 'owner' }
const OUT = { type: 'logout', status: 'out', address: null, userId: null, label: null }
const dirs: string[] = []

type StatusAnswer = { status: string } | null

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iclone-privy-wiring-'))

  dirs.push(dir)

  return dir
}

const recordFile = () => path.join(st.userData, 'iclone-privy-signin.json')

function readRecord(): string | null {
  try {
    return (JSON.parse(fs.readFileSync(recordFile(), 'utf8')) as { state?: string }).state ?? null
  } catch {
    return null
  }
}

function emitFrom(win: FakeWindow, payload: unknown): void {
  for (const listener of [...(st.listeners.get('iclone:privy-window-event') ?? [])]) {
    listener({ sender: win.webContents }, payload)
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5))

/** A fresh main process: module state reset, a userData that holds `record`. */
async function boot(record: 'in' | 'out', versionChange?: { current: string; previous: null | string }) {
  vi.resetModules()
  st.handlers.clear()
  st.listeners.clear()
  st.windows.length = 0
  st.cleared.length = 0
  st.appPath = DESKTOP
  st.userData = tmp()
  st.storage = tmp()
  fs.mkdirSync(path.join(st.storage, 'Local Storage', 'leveldb'), { recursive: true })
  fs.writeFileSync(recordFile(), JSON.stringify({ state: record }))

  const { initIclonePrivy } = await import('./iclone-privy')

  initIclonePrivy({ getMainWindow: () => null, versionChange, isTrustedSender: () => true })

  return {
    status: () => st.handlers.get('iclone:privy-status')!() as Promise<StatusAnswer>,
    open: () => st.handlers.get('iclone:privy-open')!({}) as Promise<{ ok: boolean }>,
    logout: () => st.handlers.get('iclone:privy-logout')!() as Promise<{ ok: boolean }>
  }
}

afterAll(() => {
  dirs.forEach(dir => fs.rmSync(dir, { recursive: true, force: true }))
})

describe('privy sign-in record ordering (real wiring)', () => {
  it('the bundled Privy page is found, so the probe really runs', async () => {
    const main = await boot('in')
    const pending = main.status()

    await tick()
    expect(st.windows).toHaveLength(1)
    emitFrom(st.windows[0], IN)

    await expect(pending).resolves.toMatchObject({ status: 'in', address: ADDRESS })
    expect(readRecord()).toBe('in')
  })

  it("a stale probe 'out' landing after the login window signed in keeps the record 'in' and answers null", async () => {
    const main = await boot('in')
    const pending = main.status()

    await tick()
    const probe = st.windows[0]

    expect((await main.open()).ok).toBe(true)
    emitFrom(st.windows[1], IN)
    expect(readRecord()).toBe('in')

    emitFrom(probe, OUT)

    await expect(pending).resolves.toBeNull()
    expect(readRecord()).toBe('in')
  })

  it('the next restart after that still probes (the wallet is not forgotten)', async () => {
    const main = await boot('in')
    const pending = main.status()

    await tick()
    await main.open()
    emitFrom(st.windows[1], IN)
    emitFrom(st.windows[0], OUT)
    await pending

    const userData = st.userData

    vi.resetModules()
    st.handlers.clear()
    st.listeners.clear()
    st.windows.length = 0
    st.userData = userData

    const { initIclonePrivy } = await import('./iclone-privy')

    initIclonePrivy({ getMainWindow: () => null, isTrustedSender: () => true })
    void (st.handlers.get('iclone:privy-status')!() as Promise<StatusAnswer>)
    await tick()

    expect(st.windows).toHaveLength(1)
  })

  it("sign-out during a probe ends it before the partition is cleared; a late 'in' never re-records 'in'", async () => {
    const main = await boot('in')
    const pending = main.status()

    await tick()
    const probe = st.windows[0]

    await expect(main.logout()).resolves.toEqual({ ok: true })
    expect(probe.destroyed).toBe(true)
    expect(st.cleared).toEqual([false])
    expect(readRecord()).toBe('out')

    emitFrom(probe, IN)

    await expect(pending).resolves.toBeNull()
    expect(readRecord()).toBe('out')
  })

  it('after a sign-out the next status ask opens no window', async () => {
    const main = await boot('in')

    await main.logout()
    await expect(main.status()).resolves.toMatchObject({ status: 'out' })
    expect(st.windows).toHaveLength(0)
  })
})

describe('signed out since the update (V3-0b item 3, real wiring)', () => {
  const UPDATED = { current: '0.0.0.3', previous: '0.0.0.2' }

  async function answerOut(main: Awaited<ReturnType<typeof boot>>) {
    const pending = main.status()

    await tick()
    emitFrom(st.windows[0], OUT)

    return pending
  }

  it("signed in before the update and 'out' now: the answer carries afterUpdate", async () => {
    const main = await boot('in', UPDATED)

    await expect(answerOut(main)).resolves.toMatchObject({ status: 'out', afterUpdate: true })
  })

  it('the same version, an unknown previous version or no version facts: no hint', async () => {
    for (const change of [
      { current: '0.0.0.3', previous: '0.0.0.3' },
      { current: '0.0.0.3', previous: null },
      undefined
    ]) {
      const main = await boot('in', change)
      const answer = await answerOut(main)

      expect(answer).toMatchObject({ status: 'out' })
      expect(answer).not.toHaveProperty('afterUpdate')
    }
  })

  it('signed out before the update: no hint', async () => {
    const main = await boot('out', UPDATED)
    const answer = await main.status()

    expect(answer).toMatchObject({ status: 'out' })
    expect(answer).not.toHaveProperty('afterUpdate')
  })

  it('still signed in after the update: no hint', async () => {
    const main = await boot('in', UPDATED)
    const pending = main.status()

    await tick()
    emitFrom(st.windows[0], IN)

    const answer = await pending

    expect(answer).toMatchObject({ status: 'in' })
    expect(answer).not.toHaveProperty('afterUpdate')
  })

  it('a sign-out by hand this launch is newer news than the update: no hint', async () => {
    const main = await boot('in', UPDATED)

    await main.logout()

    const answer = await main.status()

    expect(answer).not.toHaveProperty('afterUpdate')
  })
})
