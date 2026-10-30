import { describe, expect, it, vi } from 'vitest'

import {
  guardPreviewNavigation,
  hardenWebviewAttach,
  installWebviewGuard,
  isAllowedWebviewSrc,
  PREVIEW_PARTITION
} from './webview-guard'

describe('isAllowedWebviewSrc', () => {
  it.each([
    'https://example.com/page',
    'http://localhost:5173/',
    'http://127.0.0.1:3000',
    'http://[::1]:8080/x',
    'http://app.localhost:4000',
    'file:///tmp/site/index.html',
    'file:///tmp/site/page.HTM',
    'http://127.0.0.2:8000',
    'http://0.0.0.0:5173',
    'about:blank',
    undefined
  ])('allows %s', src => {
    expect(isAllowedWebviewSrc(src)).toBe(true)
  })

  it.each([
    'http://example.com',
    'http://192.168.1.10:8080',
    'http://127.0.0.1.example.com',
    'file:///tmp/home/.ssh/id_ed25519',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'chrome://settings',
    'hermes-media://x',
    'not a url'
  ])('denies %s', src => {
    expect(isAllowedWebviewSrc(src)).toBe(false)
  })
})

describe('hardenWebviewAttach', () => {
  it('strips the preload and pins every dangerous preference', () => {
    const prefs: Record<string, unknown> = {
      preload: '/evil/preload.js',
      preloadURL: 'file:///evil/preload.js',
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      nodeIntegrationInWorker: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      experimentalFeatures: true,
      enableBlinkFeatures: 'Foo'
    }

    expect(hardenWebviewAttach(prefs, { src: 'https://example.com', partition: PREVIEW_PARTITION })).toEqual({
      allow: true
    })
    expect(prefs).toEqual({
      partition: PREVIEW_PARTITION,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false
    })
  })

  it('forces the preview partition when none was requested', () => {
    const prefs: Record<string, unknown> = {}

    expect(hardenWebviewAttach(prefs, { src: 'https://example.com' }).allow).toBe(true)
    expect(prefs.partition).toBe(PREVIEW_PARTITION)
  })

  it('refuses any other partition (the app session included)', () => {
    expect(hardenWebviewAttach({}, { src: 'https://example.com', partition: 'persist:hermes' })).toEqual({
      allow: false,
      reason: 'partition "persist:hermes"'
    })
    expect(hardenWebviewAttach({ partition: 'persist:iclone-privy' }, { src: 'https://example.com' }).allow).toBe(false)
  })

  it('refuses a non-https remote src', () => {
    expect(hardenWebviewAttach({}, { src: 'http://example.com' })).toEqual({ allow: false, reason: 'src scheme http:' })
  })
})

describe('installWebviewGuard', () => {
  it('hooks every new webContents and prevents a refused attach', () => {
    const log = vi.fn()
    let created: ((event: unknown, contents: unknown) => void) | undefined
    const app = { on: vi.fn((_name: string, listener: typeof created) => (created = listener)) }

    installWebviewGuard(app as never, log)
    expect(app.on).toHaveBeenCalledWith('web-contents-created', expect.any(Function))
    expect(log).toHaveBeenCalledWith('[iclone-webview-guard] installed')

    let attach: ((event: { preventDefault: () => void }, prefs: object, params: object) => void) | undefined

    const contents = {
      getType: () => 'window',
      on: vi.fn((_name: string, listener: typeof attach) => (attach = listener)),
      setWindowOpenHandler: vi.fn()
    }

    created?.({}, contents)
    expect(contents.on).toHaveBeenCalledWith('will-attach-webview', expect.any(Function))
    // X1b: every webContents starts with the default deny; an app window replaces it with its own handler afterwards
    // (windows.ts wireCommonWindowHandlers) — see the ordering test below.
    expect(contents.setWindowOpenHandler).toHaveBeenCalledOnce()

    const denied = { preventDefault: vi.fn() }

    attach?.(denied, { preload: '/x.js' }, { src: 'javascript:alert(1)' })
    expect(denied.preventDefault).toHaveBeenCalledOnce()
    expect(log).toHaveBeenLastCalledWith('[iclone-webview-guard] denied <webview> attach: src scheme javascript:')

    const allowed = { preventDefault: vi.fn() }
    const prefs: Record<string, unknown> = { preload: '/x.js' }

    attach?.(allowed, prefs, { src: 'https://example.com' })
    expect(allowed.preventDefault).not.toHaveBeenCalled()
    expect(prefs.preload).toBeUndefined()
  })

  it('denies every window a <webview> guest asks for (X1: OpenURL ignores the missing allowpopups)', () => {
    const log = vi.fn()
    let created: ((event: unknown, contents: unknown) => void) | undefined
    const app = { on: vi.fn((_name: string, listener: typeof created) => (created = listener)) }

    installWebviewGuard(app as never, log)

    const guest = { getType: () => 'webview', on: vi.fn(), setWindowOpenHandler: vi.fn() }

    created?.({}, guest)
    expect(guest.setWindowOpenHandler).toHaveBeenCalledOnce()

    const handler = guest.setWindowOpenHandler.mock.calls[0]?.[0] as (details: {
      url: string
      disposition: string
    }) => { action: string }

    // A synthetic ctrl/meta-click (foreground-tab) and a middle-click (new-window): both measured to open a visible
    // BrowserWindow in the default session on Electron 40.10.2 without this handler.
    expect(handler({ url: 'https://example.com/popup', disposition: 'foreground-tab' })).toEqual({ action: 'deny' })
    expect(handler({ url: 'https://example.com/popup', disposition: 'new-window' })).toEqual({ action: 'deny' })
    expect(handler({ url: 'not a url', disposition: 'new-window' })).toEqual({ action: 'deny' })
    expect(log).toHaveBeenCalledWith('[iclone-webview-guard] denied window from <webview>: https:')
    expect(log).toHaveBeenLastCalledWith('[iclone-webview-guard] denied window from <webview>: invalid')
  })
})

describe('installWebviewGuard default window-open handler (X1b, review M1)', () => {
  // A webContents whose last setWindowOpenHandler wins, as in Electron.
  function contentsOf(type: string) {
    let current: ((details: { url: string; disposition: string }) => { action: string }) | null = null

    return {
      getType: () => type,
      on: vi.fn(),
      setWindowOpenHandler: vi.fn((handler: typeof current) => (current = handler)),
      request: (url: string, disposition = 'foreground-tab') => current?.({ url, disposition }) ?? 'electron-default'
    }
  }

  function install() {
    const log = vi.fn()
    let created: ((event: unknown, contents: unknown) => void) | undefined
    const app = { on: vi.fn((_name: string, listener: typeof created) => (created = listener)) }

    installWebviewGuard(app as never, log)

    return { created: (contents: unknown) => created?.({}, contents), log }
  }

  it.each(['window', 'webview', 'browserView', 'backgroundPage', 'remote', 'offscreen'])(
    'a <%s> webContents with no handler of its own denies every window its page asks for',
    type => {
      const { created, log } = install()
      const contents = contentsOf(type)

      created(contents)
      expect(contents.request('https://attacker.example.test/pop', 'new-window')).toEqual({ action: 'deny' })
      expect(contents.request('https://attacker.example.test/pop', 'foreground-tab')).toEqual({ action: 'deny' })
      expect(log).toHaveBeenLastCalledWith(`[iclone-webview-guard] denied window from <${type}>: https:`)
    }
  )

  it('an app window that installs its own handler after construction replaces the default', () => {
    const { created } = install()
    const contents = contentsOf('window')
    const own = vi.fn(() => ({ action: 'deny' as const }))

    created(contents)
    contents.setWindowOpenHandler(own)
    contents.request('https://example.test/doc')
    expect(own).toHaveBeenCalledOnce()
  })
})

describe('guardPreviewNavigation', () => {
  type Listener = (details: { resourceType: string; url: string }, callback: (r: { cancel: boolean }) => void) => void

  function setup() {
    const log = vi.fn()
    let listener: Listener | undefined
    const previewSession = { webRequest: { onBeforeRequest: vi.fn((l: Listener) => (listener = l)) } }

    guardPreviewNavigation(previewSession as never, log)

    const decide = (resourceType: string, url: string) => {
      const callback = vi.fn()

      listener?.({ resourceType, url }, callback)

      return callback.mock.calls[0]?.[0]
    }

    return { decide, log }
  }

  it('cancels a top-level load the attach guard would refuse (embedder loadURL, redirect)', () => {
    const { decide, log } = setup()

    expect(decide('mainFrame', 'file:///etc/passwd')).toEqual({ cancel: true })
    expect(decide('mainFrame', 'http://example.com/')).toEqual({ cancel: true })
    expect(log).toHaveBeenLastCalledWith('[iclone-webview-guard] blocked preview navigation: http:')
  })

  it('lets allowed documents and every subresource through', () => {
    const { decide } = setup()

    expect(decide('mainFrame', 'https://example.com/')).toEqual({ cancel: false })
    expect(decide('mainFrame', 'http://localhost:5173/')).toEqual({ cancel: false })
    expect(decide('image', 'http://example.com/a.png')).toEqual({ cancel: false })
  })

  it('is wired by installWebviewGuard once the app is ready', async () => {
    const onBeforeRequest = vi.fn()
    const app = { on: vi.fn(), whenReady: vi.fn(() => Promise.resolve()) }

    installWebviewGuard(app as never, vi.fn(), () => ({ webRequest: { onBeforeRequest } }) as never)
    await Promise.resolve()
    await Promise.resolve()
    expect(onBeforeRequest).toHaveBeenCalledOnce()
  })
})
