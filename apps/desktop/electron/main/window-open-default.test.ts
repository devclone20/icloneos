import { describe, expect, it, vi } from 'vitest'

// X1b (review M1): the gateway and portal sign-in windows load remote pages and install no window-open handler of
// their own. Electron's default for such a webContents builds a visible, unguarded BrowserWindow. The guard's
// 'web-contents-created' default must therefore reach them — through the REAL constructors in oauth.ts / portal.ts.

const fake = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  const appListeners = new Map<string, Listener[]>()

  const windows: Array<{
    handler: ((details: { url: string; disposition: string }) => { action: string }) | null
    listeners: Map<string, Listener[]>
    loaded: string[]
  }> = []

  class FakeBrowserWindow {
    handler: ((details: { url: string; disposition: string }) => { action: string }) | null = null
    listeners = new Map<string, Listener[]>()
    loaded: string[] = []
    destroyed = false
    webContents: Record<string, unknown>

    constructor() {
      const self = this

      this.webContents = {
        getType: () => 'window',
        on: () => undefined,
        once: () => undefined,
        setWindowOpenHandler: (handler: FakeBrowserWindow['handler']) => {
          self.handler = handler
        }
      }
      windows.push(this)

      // Electron emits 'web-contents-created' while the BrowserWindow is being constructed.
      for (const listener of appListeners.get('web-contents-created') ?? []) {
        listener({}, this.webContents)
      }
    }

    on(name: string, listener: Listener) {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener])
    }

    once(name: string, listener: Listener) {
      this.on(name, listener)
    }

    loadURL(url: string) {
      this.loaded.push(url)

      return Promise.resolve()
    }

    isDestroyed() {
      return this.destroyed
    }

    destroy() {
      this.destroyed = true
    }

    isVisible() {
      return true
    }

    show() {}

    static getAllWindows() {
      return []
    }
  }

  const cookieSession = { cookies: { get: async () => [], remove: async () => undefined } }

  return {
    app: {
      commandLine: { appendSwitch: () => undefined },
      getAppPath: () => '/nonexistent-app',
      getPath: () => '/nonexistent-user-data',
      isPackaged: false,
      isReady: () => true,
      on: (name: string, listener: Listener) => appListeners.set(name, [...(appListeners.get(name) ?? []), listener]),
      whenReady: () => new Promise<void>(() => undefined)
    },
    BrowserWindow: FakeBrowserWindow,
    cookieSession,
    windows
  }
})

vi.mock('electron', () => ({
  app: fake.app,
  BrowserWindow: fake.BrowserWindow,
  net: {},
  session: { fromPartition: () => fake.cookieSession }
}))

// A failed registry read falls back to the shared OAuth partition (the session mocked above), as in oauth.test.ts.
vi.mock('./connection-config', () => ({
  headersForRemoteRequest: () => ({}),
  readDesktopConnectionConfig: () => null,
  readDesktopConnectionsRegistry: () => {
    throw new Error('no registry in this test')
  }
}))

const { installWebviewGuard } = await import('../webview-guard')
const { openOauthLoginWindow } = await import('./oauth')
const { openPortalLoginWindow } = await import('./portal')

function lastWindow() {
  const win = fake.windows.at(-1)

  if (!win) {
    throw new Error('no window was constructed')
  }

  return win
}

function closeWindow(win: ReturnType<typeof lastWindow>) {
  for (const listener of win.listeners.get('closed') ?? []) {
    listener()
  }
}

describe('X1b: the default deny reaches the sign-in windows that install no handler', () => {
  const log = vi.fn()

  installWebviewGuard(fake.app as never, log)

  it.each([
    ['gateway sign-in (oauth.ts openOauthLoginWindow)', () => openOauthLoginWindow('https://gw.example.test')],
    ['Hermes Cloud sign-in (portal.ts openPortalLoginWindow)', () => openPortalLoginWindow()]
  ])('%s denies every window its page asks for', async (_label, open) => {
    const pending = open().catch(() => 'closed')
    const win = lastWindow()

    expect(win.loaded.length).toBe(1)
    expect(win.handler).not.toBeNull()
    // A page script's window.open (new-window) and a synthetic meta-/middle-click (foreground-tab): both are denied.
    expect(win.handler?.({ url: 'https://attacker.example.test/pop', disposition: 'new-window' })).toEqual({
      action: 'deny'
    })
    expect(win.handler?.({ url: 'https://attacker.example.test/pop', disposition: 'foreground-tab' })).toEqual({
      action: 'deny'
    })
    expect(log).toHaveBeenLastCalledWith('[iclone-webview-guard] denied window from <window>: https:')

    closeWindow(win)
    await expect(pending).resolves.toBe('closed')
  })
})
