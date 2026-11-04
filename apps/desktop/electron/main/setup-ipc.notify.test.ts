import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Set up step's system notification: a `failed` listener is attached (an unsigned macOS build shows nothing and
 * emits it), and the notification is held until it closes, fails or is clicked, so it cannot be collected before the
 * OS answers.
 */
import type { SetupSystemSeam } from '../iclone-setup'

const h = vi.hoisted(() => ({
  notifications: [] as FakeNotification[],
  rememberLog: vi.fn((_line: string) => undefined),
  system: null as SetupSystemSeam | null
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
  desktopCapturer: { getSources: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  Notification: FakeNotification,
  shell: { openExternal: vi.fn() },
  systemPreferences: { getMediaAccessStatus: vi.fn() }
}))
vi.mock('../iclone-consent', () => ({ consentAllows: () => true }))
vi.mock('../iclone-setup', () => ({
  registerIcloneSetup: ({ system }: { system: SetupSystemSeam }) => {
    h.system = system
  }
}))
vi.mock('./log', () => ({ rememberLog: h.rememberLog }))
vi.mock('./window-ipc', () => ({ requestMicrophoneAccess: vi.fn() }))

const { registerSetupIpc } = await import('./setup-ipc')

registerSetupIpc(
  (() => true) as never,
  { screenCaptureAttempted: () => false, markScreenCaptureAttempt: () => {} } as never
)

function showNotification() {
  if (!h.system) {
    throw new Error('registerIcloneSetup was not given the system seam')
  }

  return h.system.showNotification('Set up', 'Screen Recording is on')
}

describe('setup system notifications', () => {
  beforeEach(() => {
    h.notifications.length = 0
    h.rememberLog.mockClear()
  })

  it('attaches a failed listener before show() and reports the notification shown', () => {
    expect(showNotification()).toBe(true)

    const [notification] = h.notifications

    expect(notification).toBeDefined()
    expect(notification?.listeners.get('failed')).toHaveLength(1)
    expect(notification?.show).toHaveBeenCalledTimes(1)
    // Attached before show(): a failure the OS reports synchronously from show() must still be heard.
    expect(notification?.failedListenersAtShow).toEqual([1])
  })

  it('a failure is logged once without the title or body', () => {
    showNotification()
    showNotification()
    h.notifications[0]?.emit('failed', {}, 'denied')
    h.notifications[1]?.emit('failed', {}, 'denied')

    expect(h.rememberLog.mock.calls.map(([line]) => line)).toEqual(['[notify] setup notification not shown: denied'])
  })

  it('holds the notification until it closes, fails or is clicked', () => {
    showNotification()

    const [notification] = h.notifications

    expect(notification?.listeners.get('close')).toHaveLength(1)
    expect(notification?.listeners.get('click')).toHaveLength(1)
    expect(notification?.listeners.get('failed')).toHaveLength(1)
  })
})
