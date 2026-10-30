import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { clearNotifications, notify } from '@/store/notifications'
import { stubResizeObserver } from '@/test/jsdom'

import { NotificationStack, toastTitleClassName } from './notifications'

const LONG_TITLE = 'This turn is no longer in server history (it may have been compressed away).'
const DETAIL = 'target user message is no longer in session history'

describe('toast titles', () => {
  beforeEach(() => {
    clearNotifications()
  })

  afterEach(() => {
    cleanup()
    clearNotifications()
  })

  it('drops the one-line clamp so a long error title can wrap', () => {
    const className = toastTitleClassName()

    expect(className).toMatch(/\bline-clamp-none\b/)
    expect(className).not.toMatch(/\bline-clamp-1\b/)
    expect(className).toMatch(/\bwhitespace-normal\b/)
    expect(className).toContain('max-h-[4.5em]')
    expect(className).toMatch(/\boverflow-y-auto\b/)
  })

  it('renders the full title and body instead of truncating them', () => {
    notify({ kind: 'error', title: LONG_TITLE, message: DETAIL })

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <NotificationStack />
      </I18nProvider>
    )

    const title = screen.getByText(LONG_TITLE)

    expect(title.textContent).toBe(LONG_TITLE)
    expect(title.getAttribute('title')).toBe(LONG_TITLE)
    expect(title.className).toMatch(/\bline-clamp-none\b/)
    expect(title.className).not.toMatch(/\bline-clamp-1\b/)
    expect(title.className).toMatch(/\boverflow-y-auto\b/)
    expect(screen.getByText(DETAIL)).toBeTruthy()
  })
})

describe('toast detail copy', () => {
  beforeEach(() => {
    clearNotifications()
    stubResizeObserver()
  })

  afterEach(() => {
    cleanup()
    clearNotifications()
    vi.unstubAllGlobals()
  })

  it('copies the detail through our control and opens its tip on our roles', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    notify({ kind: 'error', title: LONG_TITLE, message: 'Request failed', detail: DETAIL })

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <NotificationStack />
      </I18nProvider>
    )

    const details = window.document.querySelector('details') as HTMLDetailsElement

    details.open = true

    const button = screen.getByRole('button', { name: 'Copy detail' })

    expect(button.dataset.slot).toBe('tooltip-trigger')
    expect(button.className).toMatch(/text-\(--ic-text-2\)/)

    fireEvent.pointerMove(button, { pointerType: 'mouse' })

    const content = await waitFor(() => {
      const node = window.document.querySelector<HTMLElement>('[data-slot=tooltip-content]')

      expect(node).not.toBeNull()

      return node as HTMLElement
    })

    expect(content.firstElementChild?.textContent).toBe('Copy detail')
    expect(content.innerHTML).not.toMatch(/bg-foreground|text-background|--dt-/)

    fireEvent.click(button)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(DETAIL))
    await screen.findByRole('button', { name: 'Copied' })
  })
})
