/**
 * The `hermes:notify` handler's system notification: a `failed` listener is attached (an unsigned macOS build shows
 * nothing and emits it), and the notification is held until it closes, fails or is clicked, so it cannot be collected
 * before the OS answers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  notifications: [] as FakeNotification[],
  rememberLog: vi.fn((_line: string) => undefined)
}))

class FakeNotification {
  listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  /** How many `failed` listeners were attached when each show() was called. */
  failedListenersAtShow: number[] = []
  show = vi.fn(() => {
    this.failedListenersAtShow.push(this.listeners.get('failed')?.length ?? 0)
  })

  constructor(public options: Record<string, unknown>) {
    h.notifications.push(this)
  }

  static isSupported() {
    return true
  }

  on(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])

    return this
  }

  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args)
    }
  }
}

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent-home' },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => h.handlers.set(channel, handler),
    on: vi.fn()
  },
  Notification: FakeNotification,
  shell: { openExternal: vi.fn(), openPath: vi.fn() }
}))
vi.mock('../iclone-consent', () => ({ consentAllows: () => true }))
vi.mock('../renderer-log', () => ({ formatRendererBoundaryReport: vi.fn() }))
vi.mock('./env', () => ({ fileExists: () => false }))
vi.mock('./link-metadata', () => ({ fetchLinkTitle: vi.fn(), resolveFaviconCached: vi.fn() }))
vi.mock('./log', () => ({
  DESKTOP_LOG_PATH: '/nonexistent/desktop.log',
  flushDesktopLogBufferSync: vi.fn(),
  hermesLog: vi.fn(),
  rememberLog: h.rememberLog
}))
vi.mock('./runtime', () => ({
  readDefaultProjectDir: () => null,
  resolveHermesCwd: () => '/',
  sanitizeWorkspaceCwd: vi.fn(),
  writeDefaultProjectDir: vi.fn()
}))
vi.mock('./windows', () => ({ focusWindow: vi.fn() }))

const { registerShellIpc } = await import('./shell-ipc')

registerShellIpc({ windowsState: { mainWindow: null } as never })

let serial = 0

function notify() {
  const handler = h.handlers.get('hermes:notify')

  if (!handler) {
    throw new Error('no handler for hermes:notify')
  }

  // A fresh kind + session each time: the handler collapses duplicates.
  serial += 1

  return handler({}, { kind: 'turn-end', sessionId: `s${serial}`, title: 'Hermes', body: 'done' })
}

describe('hermes:notify system notifications', () => {
  beforeEach(() => {
    h.notifications.length = 0
    h.rememberLog.mockClear()
  })

  it('attaches a failed listener before show() and reports the request taken', () => {
    expect(notify()).toBe(true)

    const [notification] = h.notifications

    expect(notification).toBeDefined()
    expect(notification?.listeners.get('failed')).toHaveLength(1)
    expect(notification?.show).toHaveBeenCalledTimes(1)
    // Attached before show(): a failure the OS reports synchronously from show() must still be heard.
    expect(notification?.failedListenersAtShow).toEqual([1])
  })

  it('a failure is logged without the title or body', () => {
    notify()

    h.notifications[0]?.emit('failed', {}, 'Notifications are not allowed for this application')

    expect(h.rememberLog.mock.calls.map(([line]) => line)).toEqual([
      '[notify] app notification not shown: Notifications are not allowed for this application'
    ])
  })

  it('holds the notification until it closes, fails or is clicked', () => {
    notify()
    notify()
    notify()

    for (const notification of h.notifications) {
      expect(notification.listeners.get('close')).toHaveLength(1)
      expect(notification.listeners.get('failed')).toHaveLength(1)
      // The handler's own click listener plus the hold's release.
      expect(notification.listeners.get('click')?.length).toBeGreaterThanOrEqual(2)
    }
  })
})
