/**
 * v0.0.9 F4 — the one notification store, gates N2 (no generic fallback), N3 (stack cap), N5 (timing + pause),
 * N6 (eviction is a dismissal), N7 (every toast lands in the centre and stays). Each case fails on the old store:
 * a >180-char error became the caller's fallback, the cap was 4 and dropped the oldest without `onDismiss`, a caller's
 * 1.5 s beat the reading time, nothing paused, and there was no history at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $notificationCentre,
  $notificationHistory,
  $notifications,
  $toastOverflow,
  $unreadNotifications,
  clearNotificationHistory,
  clearNotifications,
  closeNotificationCentre,
  dismissNotification,
  HISTORY_CAP,
  notify,
  notifyError,
  openNotificationCentre,
  pauseNotification,
  readableError,
  readingTimeMs,
  resumeNotification,
  TOAST_STACK_CAP,
  toastDurationMs
} from './notifications'

const LONG = `${'The agent could not write its install record because an older record of this runtime sits in a folder '.repeat(4)}end.`

beforeEach(() => {
  vi.useFakeTimers()
  clearNotifications()
  clearNotificationHistory()
  closeNotificationCentre()
  $toastOverflow.set(0)
})

afterEach(() => {
  clearNotifications()
  vi.useRealTimers()
})

describe('N5 · the reading-time rule', () => {
  it('is max(4 s, 2 s + 1 s per 15 characters)', () => {
    expect(readingTimeMs('')).toBe(4_000)
    expect(readingTimeMs('x'.repeat(30))).toBe(4_000)
    expect(readingTimeMs('x'.repeat(45))).toBe(5_000)
    expect(readingTimeMs('x'.repeat(150))).toBe(12_000)
    expect(readingTimeMs('x'.repeat(200))).toBe(Math.ceil(2_000 + 200_000 / 15))
  })

  it('never lets a caller shorten it; a longer or sticky duration is kept', () => {
    const message = 'x'.repeat(160)

    expect(toastDurationMs({ durationMs: 3_500, kind: 'success', message })).toBe(readingTimeMs(message))
    expect(toastDurationMs({ durationMs: 1_500, kind: 'info', message: 'Path copied' })).toBe(4_000)
    expect(toastDurationMs({ durationMs: 30_000, kind: 'info', message: 'short' })).toBe(30_000)
    expect(toastDurationMs({ durationMs: 0, kind: 'info', message: 'short' })).toBe(0)
  })

  it('keeps a toast with an action at least 10 s, and an error until it is closed', () => {
    expect(toastDurationMs({ action: {}, durationMs: 8_000, kind: 'info', message: 'Update ready' })).toBe(10_000)
    expect(toastDurationMs({ durationMs: 10_000, kind: 'error', message: 'Sign-in refused' })).toBe(0)
    expect(toastDurationMs({ kind: 'error', message: 'x' })).toBe(0)
  })

  it('a 1.5 s caller toast is still on screen at 3.9 s and gone after 4 s', () => {
    const id = notify({ durationMs: 1_500, kind: 'info', message: 'Path copied' })

    vi.advanceTimersByTime(3_900)
    expect($notifications.get().some(n => n.id === id)).toBe(true)

    vi.advanceTimersByTime(200)
    expect($notifications.get().some(n => n.id === id)).toBe(false)
  })

  it('an error is never auto-dismissed, even when the caller asked for 10 s', () => {
    const id = notify({ durationMs: 10_000, kind: 'error', message: 'The sign-in window could not open.' })

    vi.advanceTimersByTime(10 * 60_000)
    expect($notifications.get().some(n => n.id === id)).toBe(true)
  })

  it('pauses on hover/focus and carries on where it stopped', () => {
    const id = notify({ kind: 'success', message: 'Saved' })

    vi.advanceTimersByTime(3_000)
    pauseNotification(id)
    vi.advanceTimersByTime(60_000)
    expect($notifications.get().some(n => n.id === id)).toBe(true)

    resumeNotification(id)
    vi.advanceTimersByTime(999)
    expect($notifications.get().some(n => n.id === id)).toBe(true)
    vi.advanceTimersByTime(2)
    expect($notifications.get().some(n => n.id === id)).toBe(false)
  })
})

describe('N5 · a same-id update under the pointer stays paused (Q renderer 3)', () => {
  it('a timed toast replaced in place while hovered waits for the pointer, then gets its full time', () => {
    const id = notify({ id: 'compact', kind: 'info', message: 'Compacting the session' })

    pauseNotification(id)
    notify({ id: 'compact', kind: 'info', message: 'Compacted: 41 messages folded' })
    vi.advanceTimersByTime(60_000)
    expect($notifications.get().some(n => n.id === id)).toBe(true)

    resumeNotification(id)
    vi.advanceTimersByTime(readingTimeMs('Compacted: 41 messages folded') - 1)
    expect($notifications.get().some(n => n.id === id)).toBe(true)
    vi.advanceTimersByTime(2)
    expect($notifications.get().some(n => n.id === id)).toBe(false)
  })

  it('a sticky toast turned timed while focused does not start counting either', () => {
    const id = notify({ id: 'browser-record', kind: 'error', message: 'Recording stopped' })

    pauseNotification(id)
    notify({ id: 'browser-record', kind: 'success', message: 'Recording saved' })
    vi.advanceTimersByTime(60_000)
    expect($notifications.get().some(n => n.id === id)).toBe(true)
  })

  it('an update with nobody on the toast counts down as usual', () => {
    const id = notify({ id: 'compact', kind: 'info', message: 'Compacting' })

    pauseNotification(id)
    resumeNotification(id)
    notify({ id: 'compact', kind: 'info', message: 'Compacted' })
    vi.advanceTimersByTime(4_001)
    expect($notifications.get().some(n => n.id === id)).toBe(false)
  })
})

describe('N2 · the words are never swapped for a generic fallback', () => {
  it('keeps a long error sentence whole', () => {
    expect(readableError(new Error(LONG), 'Something went wrong').message).toBe(LONG)

    notifyError(new Error(LONG), 'Repair failed')

    expect($notifications.get()[0]?.message).toBe(LONG)
    expect($notifications.get()[0]?.title).toBe('Repair failed')
  })
})

describe('N3 / N6 · the stack holds three; the cap is a dismissal', () => {
  it('shows at most three and counts the rest into "+N in Notifications"', () => {
    for (let i = 0; i < 5; i += 1) {
      notify({ kind: 'error', message: `failure ${i}` })
    }

    expect(TOAST_STACK_CAP).toBe(3)
    expect($notifications.get().map(n => n.message)).toEqual(['failure 4', 'failure 3', 'failure 2'])
    expect($toastOverflow.get()).toBe(2)
  })

  it('calls onDismiss of an evicted toast (even a sticky error) and clears its timer', () => {
    const evicted = vi.fn()

    notify({ kind: 'error', message: 'oldest', onDismiss: evicted })
    notify({ kind: 'info', message: 'b' })
    notify({ kind: 'info', message: 'c' })
    expect(evicted).not.toHaveBeenCalled()

    notify({ kind: 'info', message: 'd' })
    expect(evicted).toHaveBeenCalledTimes(1)
    expect($notifications.get().some(n => n.message === 'oldest')).toBe(false)
  })

  it('a replaced id stays one toast', () => {
    notify({ id: 'same', kind: 'info', message: 'one' })
    notify({ id: 'same', kind: 'info', message: 'two' })

    expect($notifications.get().filter(n => n.id === 'same')).toHaveLength(1)
    expect($notificationHistory.get().filter(r => r.id === 'same')).toHaveLength(1)
  })

  it('critic m4: the "+N" count goes as soon as the stack has room again, never stale beside one or two toasts', () => {
    for (let i = 0; i < 6; i += 1) {
      notify({ kind: 'error', message: `e${i}` })
    }

    expect($toastOverflow.get()).toBe(3)

    dismissNotification($notifications.get()[0]!.id)
    expect($notifications.get()).toHaveLength(2)
    expect($toastOverflow.get()).toBe(0)

    notify({ kind: 'error', message: 'refill' })
    expect($toastOverflow.get()).toBe(0)
    notify({ kind: 'error', message: 'one more' })
    expect($toastOverflow.get()).toBe(1)

    clearNotifications()
    expect($toastOverflow.get()).toBe(0)
  })

  it('the overflow count resets when the centre opens or the stack empties', () => {
    for (let i = 0; i < 4; i += 1) {
      notify({ kind: 'info', message: `m${i}` })
    }

    expect($toastOverflow.get()).toBe(1)
    openNotificationCentre()
    expect($toastOverflow.get()).toBe(0)

    // r4b/r4c: an open centre absorbs the stack and takes new notifications as entries only
    // (notifications.r4b.test.ts); the stack fills, and overflows, again once it is closed.
    expect($notifications.get()).toEqual([])
    closeNotificationCentre()

    for (let i = 4; i < 8; i += 1) {
      notify({ kind: 'info', message: `m${i}` })
    }

    expect($toastOverflow.get()).toBe(1)

    for (const n of [...$notifications.get()]) {
      dismissNotification(n.id)
    }

    expect($toastOverflow.get()).toBe(0)
  })
})

describe('N7 · every toast lands in the centre and stays', () => {
  it('records what, why, what to do and the raw detail', () => {
    notify({
      detail: 'EACCES: /Users/x/.hermes/installs/abc/facts.json',
      kind: 'error',
      message: 'The install record is not writable.',
      nextStep: 'Open Settings › Diagnostics › Repair kit.',
      title: 'The agent did not start'
    })

    const [entry] = $notificationHistory.get()

    expect(entry).toMatchObject({
      detail: 'EACCES: /Users/x/.hermes/installs/abc/facts.json',
      kind: 'error',
      message: 'The install record is not writable.',
      nextStep: 'Open Settings › Diagnostics › Repair kit.',
      read: false,
      source: 'toast',
      title: 'The agent did not start'
    })
  })

  it('outlives the toast, the cap and clearNotifications (X3)', () => {
    for (let i = 0; i < 6; i += 1) {
      notify({ kind: 'error', message: `e${i}` })
    }

    clearNotifications()

    expect($notifications.get()).toHaveLength(0)
    expect($notificationHistory.get()).toHaveLength(6)
  })

  it('keeps the last 200, newest first', () => {
    for (let i = 0; i < HISTORY_CAP + 25; i += 1) {
      notify({ kind: 'info', message: `n${i}` })
      dismissNotification($notifications.get()[0]?.id ?? '')
    }

    expect($notificationHistory.get()).toHaveLength(HISTORY_CAP)
    expect($notificationHistory.get()[0]?.message).toBe(`n${HISTORY_CAP + 24}`)
  })

  it('counts unread until the centre opens; opening on an id focuses that entry', () => {
    const id = notify({ kind: 'warning', message: 'Credits are low' })

    expect($unreadNotifications.get()).toBe(1)

    openNotificationCentre(id)

    expect($notificationCentre.get()).toEqual({ focusId: id, open: true })
    expect($unreadNotifications.get()).toBe(0)
  })
})
