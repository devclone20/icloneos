/**
 * v0.0.9 r4d (design r4 F4-1): the centre groups and ranks. Red on 52cae17554: two identical "Replaced Settings" lines
 * in one minute were two entries, an info title weighed the same as an error's, and times read "04:45 PM".
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { f4Centre } from '@/i18n/en/v009-f4'
import {
  $notificationHistory,
  clearNotificationHistory,
  clearNotifications,
  closeNotificationCentre,
  MERGE_WINDOW_MS,
  notify,
  openNotificationCentre
} from '@/store/notifications'
import { stubResizeObserver } from '@/test/jsdom'
import { read } from '@/test/token-contrast'

import { NotificationStack } from './notifications'

const REPLACED = { kind: 'info' as const, title: 'Replaced Settings', message: 'Open it again from the Dock.' }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 10, 18, 16, 45, 0))
  closeNotificationCentre()
  clearNotifications()
  clearNotificationHistory()
  stubResizeObserver()
})

afterEach(() => {
  cleanup()
  closeNotificationCentre()
  clearNotifications()
  clearNotificationHistory()
  vi.useRealTimers()
})

describe('identical plain notices merge into one entry', () => {
  it('twice within the window is one entry ×2; later, or with an action, or an error, stays apart', () => {
    notify(REPLACED)
    vi.advanceTimersByTime(30_000)
    notify(REPLACED)

    expect($notificationHistory.get()).toHaveLength(1)
    expect($notificationHistory.get()[0]).toMatchObject({ title: 'Replaced Settings', count: 2 })

    vi.advanceTimersByTime(MERGE_WINDOW_MS + 1)
    notify(REPLACED)
    notify({ ...REPLACED, action: { label: 'Open', onClick: () => undefined } })
    notify({ kind: 'error', title: 'The agent stopped', message: 'It quit.' })
    notify({ kind: 'error', title: 'The agent stopped', message: 'It quit.' })

    expect($notificationHistory.get().map(entry => entry.count ?? 1)).toEqual([1, 1, 1, 1, 2])
  })

  it('the centre shows the merged entry once, with ×2, and the time without a leading zero', () => {
    notify(REPLACED)
    notify(REPLACED)
    openNotificationCentre()
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <NotificationStack />
      </I18nProvider>
    )

    const entries = screen.getAllByTestId('notification-entry')

    expect(entries).toHaveLength(1)
    expect(screen.getByTestId('notification-count').textContent).toBe(f4Centre.repeated(2))
    expect(entries[0].querySelector('time')?.textContent).toMatch(/^4:45/)
  })
})

describe('weight says severity', () => {
  it('info and success titles are body weight; the base title (warning, error) stays semibold', () => {
    const css = read('components/notification-system.css')

    expect(css).toMatch(/\.icn-entry:is\(\[data-kind='info'\], \[data-kind='success'\]\) \.icn-title \{\s*font-weight: 400;/)
    expect(css).toMatch(/\.icn-title \{\s*margin: 0;\s*color: var\(--ic-note-ink\);\s*font-size: var\(--ic-type-lg\);\s*font-weight: 600;/)
  })
})
