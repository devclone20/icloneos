import { describe, expect, it, vi } from 'vitest'

import {
  createNotificationFailureWatch,
  type FailingNotification,
  HELD_MAX,
  notificationErrorLine
} from './notification-failure'

function fakeNotification() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()

  const notification: FailingNotification = {
    on: ((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    }) as FailingNotification['on']
  }

  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of listeners.get(event) ?? []) {
      listener(...args)
    }
  }

  return {
    action: () => emit('action', {}, 0),
    click: () => emit('click'),
    close: () => emit('close'),
    fail: (error: string) => emit('failed', {}, error),
    listeners: (event: string) => listeners.get(event)?.length ?? 0,
    notification,
    reply: () => emit('reply', {}, 'ok')
  }
}

describe('notification failures (unsigned macOS builds emit failed)', () => {
  it('logs the first failure of a source once, with the platform error only', () => {
    const lines: string[] = []
    const watch = createNotificationFailureWatch(line => lines.push(line))
    const first = fakeNotification()
    const second = fakeNotification()

    watch(first.notification, 'chat')
    watch(second.notification, 'chat')
    first.fail('Notifications are not allowed\nfor this application')
    second.fail('Notifications are not allowed for this application')

    expect(lines).toEqual(['[notify] chat notification not shown: Notifications are not allowed for this application'])
  })

  it('each source logs its own first failure', () => {
    const lines: string[] = []
    const watch = createNotificationFailureWatch(line => lines.push(line))
    const chat = fakeNotification()
    const setup = fakeNotification()

    watch(chat.notification, 'chat')
    watch(setup.notification, 'setup')
    chat.fail('denied')
    setup.fail('denied')

    expect(lines).toHaveLength(2)
  })

  it('a failure releases what the caller holds every time, logged or not, and never throws', () => {
    const watch = createNotificationFailureWatch(() => {})
    const release = vi.fn()
    const a = fakeNotification()
    const b = fakeNotification()

    watch(a.notification, 'update', release)
    watch(b.notification, 'update', release)
    expect(() => a.fail('x')).not.toThrow()
    expect(() => b.fail('x')).not.toThrow()
    expect(release).toHaveBeenCalledTimes(2)
  })

  it('bounds the error to one short line', () => {
    expect(notificationErrorLine('')).toBe('unknown error')
    expect(notificationErrorLine(undefined)).toBe('unknown error')
    expect(notificationErrorLine('a'.repeat(500))).toHaveLength(161)
  })
})

describe('a watched notification is held until the OS answers', () => {
  it('is held from watch() and released on close, failed or click', () => {
    const watch = createNotificationFailureWatch(() => {})
    const closed = fakeNotification()
    const failed = fakeNotification()
    const clicked = fakeNotification()

    watch(closed.notification, 'chat')
    watch(failed.notification, 'chat')
    watch(clicked.notification, 'chat')
    expect(watch.held()).toBe(3)

    closed.close()
    expect(watch.held()).toBe(2)
    failed.fail('denied')
    expect(watch.held()).toBe(1)
    clicked.click()
    expect(watch.held()).toBe(0)
  })

  it('listens once for each of close, failed, click, action and reply', () => {
    const watch = createNotificationFailureWatch(() => {})
    const one = fakeNotification()

    watch(one.notification, 'chat')

    expect(['close', 'failed', 'click', 'action', 'reply'].map(event => one.listeners(event))).toEqual([1, 1, 1, 1, 1])
  })

  it('is released when the user picks an action or replies', () => {
    const watch = createNotificationFailureWatch(() => {})
    const acted = fakeNotification()
    const replied = fakeNotification()

    watch(acted.notification, 'chat')
    watch(replied.notification, 'chat')
    expect(watch.held()).toBe(2)

    acted.action()
    expect(watch.held()).toBe(1)
    replied.reply()
    expect(watch.held()).toBe(0)
  })

  it('never holds more than HELD_MAX: the oldest is let go first', () => {
    const watch = createNotificationFailureWatch(() => {})
    const all = Array.from({ length: HELD_MAX + 5 }, () => fakeNotification())

    for (const one of all) {
      watch(one.notification, 'chat')
      expect(watch.held()).toBeLessThanOrEqual(HELD_MAX)
    }

    expect(watch.held()).toBe(HELD_MAX)

    // The five oldest were evicted: closing them changes nothing, closing the newest releases it.
    for (const evicted of all.slice(0, 5)) {
      evicted.close()
    }

    expect(watch.held()).toBe(HELD_MAX)
    all.at(-1)?.close()
    expect(watch.held()).toBe(HELD_MAX - 1)
    all[5]?.close()
    expect(watch.held()).toBe(HELD_MAX - 2)
  })
})
