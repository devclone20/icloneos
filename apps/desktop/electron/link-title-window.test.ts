import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  createLinkTitleWindow,
  guardLinkTitleSession,
  linkTitleWindowOptions,
  readLinkTitleWindowTitle
} from './link-title-window'

type WindowOpenHandler = (details: { url: string; disposition: string }) => { action: string }

function makeFakeBrowserWindow() {
  const calls: { audioMuted: boolean[]; windowOpenHandlers: WindowOpenHandler[] } = {
    audioMuted: [],
    windowOpenHandlers: []
  }

  class FakeBrowserWindow {
    options: unknown
    webContents = {
      setAudioMuted(value: boolean) {
        calls.audioMuted.push(value)
      },
      setWindowOpenHandler(handler: WindowOpenHandler) {
        calls.windowOpenHandlers.push(handler)
      }
    }

    constructor(options: unknown) {
      this.options = options
    }
  }

  return { FakeBrowserWindow, calls }
}

test('linkTitleWindowOptions keeps the offscreen, hardened defaults', () => {
  const session = { id: 'link-titles' }
  const options = linkTitleWindowOptions(session)

  assert.equal(options.show, false)
  assert.equal(options.webPreferences.session, session)
  assert.equal(options.webPreferences.contextIsolation, true)
  assert.equal(options.webPreferences.sandbox, true)
  assert.equal(options.webPreferences.nodeIntegration, false)
})

test('createLinkTitleWindow mutes audio so historical links never autoplay sound', () => {
  // Regression for #49505: the hidden title-fetch window loaded YouTube/watch
  // URLs (to read their <title>) without muting, leaking ~2s of audio on every
  // history re-render.
  const { FakeBrowserWindow, calls } = makeFakeBrowserWindow()

  const window = createLinkTitleWindow(FakeBrowserWindow, { id: 'link-titles' })

  assert.ok(window instanceof FakeBrowserWindow)
  assert.deepEqual(calls.audioMuted, [true])
})

test('createLinkTitleWindow denies every window the loaded page tries to open (X1)', () => {
  // Measured on Electron 40.10.2 without the handler: window.open opened a visible window in the title partition and a
  // synthetic ctrl/meta-click opened one in the DEFAULT session, both from a page nobody clicked.
  const { FakeBrowserWindow, calls } = makeFakeBrowserWindow()

  createLinkTitleWindow(FakeBrowserWindow, { id: 'link-titles' })

  assert.equal(calls.windowOpenHandlers.length, 1)

  const handler = calls.windowOpenHandlers[0]

  assert.deepEqual(handler({ url: 'https://example.invalid/open', disposition: 'new-window' }), { action: 'deny' })
  assert.deepEqual(handler({ url: 'https://example.invalid/meta', disposition: 'foreground-tab' }), { action: 'deny' })
  // Muting still happens after the handler is installed.
  assert.deepEqual(calls.audioMuted, [true])
})

test('createLinkTitleWindow still returns the window if muting throws', () => {
  class ThrowingBrowserWindow {
    options: unknown
    webContents = {
      setAudioMuted(): void {
        throw new Error('webContents unavailable')
      },
      setWindowOpenHandler(): void {
        throw new Error('webContents unavailable')
      }
    }

    constructor(options: unknown) {
      this.options = options
    }
  }

  const window = createLinkTitleWindow(ThrowingBrowserWindow, { id: 'link-titles' })

  assert.ok(window instanceof ThrowingBrowserWindow)
})

test('guardLinkTitleSession cancels downloads triggered by the title-fetch window', () => {
  let cancelled = false
  const handlers: Record<string, (event: unknown, item: { cancel(): void }) => void> = {}
  guardLinkTitleSession({
    on: (e: string, h: (event: unknown, item: { cancel(): void }) => void) => {
      handlers[e] = h
    }
  })
  handlers['will-download'](null, {
    cancel: () => {
      cancelled = true
    }
  })
  assert.ok(cancelled)
})

test('guardLinkTitleSession is a no-op when session.on throws', () => {
  assert.doesNotThrow(() =>
    guardLinkTitleSession({
      on() {
        throw new Error()
      }
    })
  )
})

test('readLinkTitleWindowTitle returns empty for missing or destroyed windows', () => {
  assert.equal(readLinkTitleWindowTitle(null), '')
  assert.equal(readLinkTitleWindowTitle(undefined), '')
  assert.equal(readLinkTitleWindowTitle({ isDestroyed: () => true }), '')
})

test('readLinkTitleWindowTitle returns empty when webContents is destroyed', () => {
  const window = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => true, getTitle: () => 'Should Not Read' }
  }

  assert.equal(readLinkTitleWindowTitle(window), '')
})

test('readLinkTitleWindowTitle swallows getTitle throws after teardown', () => {
  const window = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      getTitle: () => {
        throw new Error('Object has been destroyed')
      }
    }
  }

  assert.equal(readLinkTitleWindowTitle(window), '')
})

test('readLinkTitleWindowTitle returns trimmed page title', () => {
  const window = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      getTitle: () => 'Example Domain'
    }
  }

  assert.equal(readLinkTitleWindowTitle(window), 'Example Domain')
})
