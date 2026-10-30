import { pathToFileURL } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import { createAppSenderGuard, isAppRendererUrl } from './ipc-sender-guard'

vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: () => null } }))

const INDEX = '/Applications/iclone os.app/Contents/Resources/app.asar.unpacked/dist/index.html'
const INDEX_URL = `${pathToFileURL(INDEX).toString()}?win=secondary#/abc`

describe('isAppRendererUrl', () => {
  it('accepts the dev server origin only in dev', () => {
    expect(isAppRendererUrl('http://127.0.0.1:5174/?win=quick#/', 'http://127.0.0.1:5174', INDEX)).toBe(true)
    expect(isAppRendererUrl('http://127.0.0.1:47831/privy.html', 'http://127.0.0.1:5174', INDEX)).toBe(false)
    expect(isAppRendererUrl(INDEX_URL, 'http://127.0.0.1:5174', INDEX)).toBe(false)
  })

  it('accepts only the renderer index file when packaged', () => {
    expect(isAppRendererUrl(INDEX_URL, undefined, INDEX)).toBe(true)
    expect(isAppRendererUrl('file:///tmp/evil/index.html', undefined, INDEX)).toBe(false)
    expect(isAppRendererUrl('https://example.com/', undefined, INDEX)).toBe(false)
    expect(isAppRendererUrl('not a url', undefined, INDEX)).toBe(false)
  })
})

describe('createAppSenderGuard', () => {
  const mainFrame = { url: 'http://127.0.0.1:5174/#/' }

  const sender = (overrides: Record<string, unknown> = {}) => ({
    getType: () => 'window',
    isDestroyed: () => false,
    mainFrame,
    ...overrides
  })

  const guard = (log = vi.fn(), hasOwnerWindow = () => true) =>
    createAppSenderGuard({
      devServer: 'http://127.0.0.1:5174',
      rendererIndexPath: () => INDEX,
      log,
      hasOwnerWindow
    })

  it('logs its tag once when created', () => {
    const log = vi.fn()

    guard(log)
    expect(log).toHaveBeenCalledWith('[iclone-ipc-sender] guard active (dev server origin)')
  })

  it('trusts the top frame of an app window on the renderer origin', () => {
    expect(guard()({ sender: sender(), senderFrame: mainFrame }, 'hermes:terminal:start')).toBe(true)
  })

  it('refuses subframes, webview guests, foreign pages, orphan and destroyed senders', () => {
    const log = vi.fn()
    const check = guard(log)

    expect(check({ sender: sender(), senderFrame: { url: mainFrame.url } }, 'hermes:terminal:write')).toBe(false)
    expect(check({ sender: sender({ getType: () => 'webview' }), senderFrame: mainFrame }, 'x')).toBe(false)
    expect(check({ sender: sender({ isDestroyed: () => true }), senderFrame: mainFrame }, 'x')).toBe(false)
    expect(check({ sender: sender(), senderFrame: null }, 'x')).toBe(false)

    const privyFrame = { url: 'http://127.0.0.1:47831/privy.html' }

    expect(check({ sender: sender({ mainFrame: privyFrame }), senderFrame: privyFrame }, 'x')).toBe(false)
    expect(guard(vi.fn(), () => false)({ sender: sender(), senderFrame: mainFrame }, 'x')).toBe(false)
    expect(log).toHaveBeenCalledWith('[iclone-ipc-sender] refused hermes:terminal:write from window sender')
  })
})
