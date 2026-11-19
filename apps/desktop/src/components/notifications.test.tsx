/**
 * v0.0.9 F4 — the toast (type 1) and the notification centre (type 5) in the DOM: gates N3 (stack ≤ 3 + "+N in
 * Notifications"), N5 (hover/focus pause), N6 (✕ and Esc close; the centre closes on ✕, Esc and a click outside),
 * N7 (a click opens the entry in the centre, whole, with its detail copyable) and N8 (one toast region; only errors
 * are announced assertively). Each case fails on the old stack: two regions, a 4-cap, no pause, no Esc, a dead body.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { f4Centre, f4Notes } from '@/i18n/en/v009-f4'
import {
  $notificationCentre,
  $notifications,
  $toastOverflow,
  clearNotificationHistory,
  clearNotifications,
  closeNotificationCentre,
  notify,
  toastDurationMs
} from '@/store/notifications'
import { stubResizeObserver } from '@/test/jsdom'

import { mergeToastPresence, NotificationStack, stackLiftPx, SWIPE_CLOSE_PX, TOAST_EXIT_MS } from './notifications'

const LONG =
  'The agent could not write its install record: an older record of this runtime sits in ~/.hermes/installs, a folder the sandbox never lets the agent write, so the start stopped before the permission gate loaded.'

const DETAIL = 'EACCES: permission denied, open /Users/x/.hermes/installs/d2a0574a/facts.json'

function mount() {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <NotificationStack />
    </I18nProvider>
  )
}

const toasts = () => screen.queryAllByTestId('toast')

beforeEach(() => {
  clearNotifications()
  clearNotificationHistory()
  closeNotificationCentre()
  $toastOverflow.set(0)
  stubResizeObserver()
})

afterEach(() => {
  cleanup()
  clearNotifications()
  closeNotificationCentre()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('N8 · one region, announced by severity', () => {
  it('renders every toast in ONE labelled region; errors are alerts, the rest polite status', () => {
    notify({ kind: 'error', message: 'Could not save' })
    notify({ kind: 'success', message: 'Saved' })
    mount()

    expect(screen.getAllByRole('region', { name: f4Notes.region })).toHaveLength(1)
    expect(screen.getByRole('alert').textContent).toContain('Could not save')
    expect(screen.getByRole('status').textContent).toContain('Saved')
  })
})

describe('critic m4 / design 3 · the stack never covers a composer', () => {
  const stack = { bottom: 896, left: 1000, right: 1400, top: 500 }

  it('stackLiftPx: a composer under the stack lifts the lowest toast above its top edge; one beside it does not', () => {
    // Composer top at 820 px of a 900 px window: toasts' painted bottom (lift + 4 + 24) must reach 900 - 820 + 8 = 88.
    expect(stackLiftPx([{ bottom: 890, left: 600, right: 1300, top: 820 }], stack, 900)).toBe(60)
    expect(stackLiftPx([{ bottom: 890, left: 0, right: 900, top: 820 }], stack, 900)).toBe(0)
    expect(stackLiftPx([], stack, 900)).toBe(0)
    // A hidden (zero-height) or off-screen composer is no obstacle.
    expect(stackLiftPx([{ bottom: 820, left: 600, right: 1300, top: 820 }], stack, 900)).toBe(0)
    expect(stackLiftPx([{ bottom: 1300, left: 600, right: 1300, top: 1000 }], stack, 900)).toBe(0)
  })

  it('the painted stack carries the lift while a composer is under it', () => {
    const composer = window.document.createElement('div')

    composer.setAttribute('data-slot', 'composer-root')
    window.document.body.appendChild(composer)
    vi.stubGlobal('innerHeight', 768)

    const rects = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      if (this === composer) {
        return { bottom: 760, left: 0, right: 2000, top: 700 } as DOMRect
      }

      return (this.classList.contains('icn-stack') ? stack : { bottom: 0, left: 0, right: 0, top: 0 }) as DOMRect
    })

    try {
      notify({ kind: 'error', message: 'Backend stopped' })
      mount()

      const region = screen.getByTestId('toast-stack')

      expect(region.hasAttribute('data-composer-lift')).toBe(true)
      expect(region.style.getPropertyValue('--icn-stack-lift')).toBe(`${768 - 700 + 8 - 24 - 4}px`)
    } finally {
      rects.mockRestore()
      composer.remove()
    }
  })
})

describe('N3 · at most three on screen', () => {
  it('shows the newest three and "+N in Notifications", which opens the centre', () => {
    for (let i = 0; i < 5; i += 1) {
      notify({ kind: 'error', message: `failure ${i}` })
    }

    mount()

    expect(toasts()).toHaveLength(3)

    const overflow = screen.getByRole('button', { name: f4Notes.overflow(2) })

    fireEvent.click(overflow)

    expect($notificationCentre.get().open).toBe(true)
    expect(screen.getByTestId('notification-centre')).toBeTruthy()
    expect(screen.getAllByTestId('notification-entry')).toHaveLength(5)
  })
})

describe('N6 · ✕ and Esc close a toast', () => {
  it('✕ closes it', () => {
    notify({ kind: 'error', message: 'Could not save' })
    mount()

    fireEvent.click(screen.getByRole('button', { name: f4Notes.close }))

    expect(toasts()).toHaveLength(0)
  })

  it('Esc with focus inside closes it, and calls its onDismiss', () => {
    const onDismiss = vi.fn()

    notify({ kind: 'error', message: 'Could not save', onDismiss })
    mount()

    const toast = screen.getByTestId('toast')

    toast.focus()
    fireEvent.keyDown(toast, { key: 'Escape' })

    expect(toasts()).toHaveLength(0)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('Esc on its ✕ button closes it too (the key bubbles to the toast)', () => {
    notify({ kind: 'warning', message: 'Low credits' })
    mount()

    fireEvent.keyDown(screen.getByRole('button', { name: f4Notes.close }), { key: 'Escape' })

    expect(toasts()).toHaveLength(0)
  })
})

describe('N5 · hover and focus pause the countdown', () => {
  it('a hovered toast outlives its time and leaves after the pointer does', () => {
    vi.useFakeTimers()
    notify({ kind: 'success', message: 'Saved' })
    mount()

    fireEvent.mouseEnter(screen.getByTestId('toast'))
    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(toasts()).toHaveLength(1)

    // Hovered at once, so the countdown resumes with all of its time left (the store's N5 rule: the REMAINING time,
    // never less than 1 s) — not with a bare second.
    const remaining = toastDurationMs({ kind: 'success', message: 'Saved' })

    fireEvent.mouseLeave(screen.getByTestId('toast'))
    act(() => {
      vi.advanceTimersByTime(remaining - 1)
    })
    expect(toasts()).toHaveLength(1)
    act(() => {
      vi.advanceTimersByTime(2)
    })
    expect(toasts()).toHaveLength(0)
  })

  it('a focused toast outlives its time', () => {
    vi.useFakeTimers()
    notify({ kind: 'info', message: 'Path copied' })
    mount()

    fireEvent.focus(screen.getByTestId('toast'))
    act(() => {
      vi.advanceTimersByTime(30_000)
    })

    expect(toasts()).toHaveLength(1)
  })

  it('without hover or focus it leaves after its reading time', () => {
    vi.useFakeTimers()
    notify({ kind: 'info', message: 'Path copied' })
    mount()

    act(() => {
      vi.advanceTimersByTime(4_001)
    })

    expect(toasts()).toHaveLength(0)
  })
})

describe('N2 / N7 · the whole text, one click away', () => {
  it('a long message gets "More"; a short one does not', () => {
    notify({ kind: 'error', message: LONG, title: 'The agent did not start' })
    notify({ kind: 'success', message: 'Saved' })
    mount()

    const [longToast, shortToast] = [
      toasts().find(t => t.textContent?.includes('install record')),
      toasts().find(t => t.textContent?.includes('Saved'))
    ]

    expect(within(longToast as HTMLElement).getByRole('button', { name: f4Notes.more })).toBeTruthy()
    // The full sentence is in the DOM (three lines are a view, never a cut).
    expect(longToast?.textContent).toContain(LONG)
    expect(within(shortToast as HTMLElement).queryByRole('button', { name: f4Notes.more })).toBeNull()
  })

  it('clicking the toast body opens its entry in the centre — what, why, what to do, detail', () => {
    notify({
      detail: DETAIL,
      kind: 'error',
      message: LONG,
      nextStep: 'Open Settings › Diagnostics › Repair kit and press Repair.',
      title: 'The agent did not start'
    })
    mount()

    fireEvent.click(screen.getByText('The agent did not start'))

    expect(toasts()).toHaveLength(0)

    const centre = screen.getByTestId('notification-centre')
    const entry = within(centre).getByTestId('notification-entry')

    expect(entry.hasAttribute('data-focus')).toBe(true)
    expect(entry.textContent).toContain('The agent did not start')
    expect(entry.textContent).toContain(LONG)
    expect(entry.textContent).toContain(f4Centre.next)
    expect(entry.textContent).toContain('Repair kit and press Repair.')
    // The focused entry opens with its raw detail showing.
    expect(within(entry).getByTestId('notification-detail').textContent).toBe(DETAIL)
  })

  it('"More" opens the same entry', () => {
    notify({ kind: 'warning', message: LONG })
    mount()

    fireEvent.click(screen.getByRole('button', { name: f4Notes.more }))

    expect(screen.getByTestId('notification-entry').hasAttribute('data-focus')).toBe(true)
  })

  it('copies the detail from the centre', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)

    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    notify({ detail: DETAIL, kind: 'error', message: 'Request failed', title: 'Could not save' })
    mount()

    fireEvent.click(screen.getByText('Could not save'))
    fireEvent.click(screen.getByRole('button', { name: f4Centre.copyDetail }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(DETAIL))
  })
})

describe('N6 · the centre closes on ✕, Esc and a click outside', () => {
  function openWithOne() {
    notify({ kind: 'info', message: 'Saved' })
    mount()
    fireEvent.click(screen.getByText('Saved'))
    expect(screen.getByTestId('notification-centre')).toBeTruthy()
  }

  it('✕', () => {
    openWithOne()
    fireEvent.click(screen.getByRole('button', { name: f4Centre.close }))
    expect(screen.queryByTestId('notification-centre')).toBeNull()
  })

  it('Esc', () => {
    openWithOne()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('notification-centre')).toBeNull()
  })

  it('a click outside', () => {
    openWithOne()

    const outside = document.body.appendChild(document.createElement('div'))

    fireEvent.pointerDown(outside)
    expect(screen.queryByTestId('notification-centre')).toBeNull()
    outside.remove()
  })

  it('owns the right edge while open and gives it back on close', () => {
    openWithOne()
    expect(document.documentElement.dataset.icloneIsland).toBe('notifications')

    fireEvent.click(screen.getByRole('button', { name: f4Centre.close }))
    expect(document.documentElement.dataset.icloneIsland).toBeUndefined()
  })

  it('keeps every entry after the toasts are cleared (a reconnect)', () => {
    notify({ kind: 'error', message: 'first' })
    notify({ kind: 'error', message: 'second' })
    clearNotifications()
    expect($notifications.get()).toHaveLength(0)

    mount()
    act(() => {
      $notificationCentre.set({ focusId: null, open: true })
    })

    expect(screen.getAllByTestId('notification-entry')).toHaveLength(2)
  })
})

// ── v0.0.9 F4b — exit (120 ms, 0 ms under reduced motion) and swipe-to-close. Old stack: a closed toast vanished in
// the same frame (no data-leaving), and a drag or a two-finger swipe did nothing.
function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      addEventListener: () => {},
      addListener: () => {},
      dispatchEvent: () => false,
      matches: reduce && query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      removeEventListener: () => {},
      removeListener: () => {}
    }))
  )
}

describe('F4b · the exit', () => {
  it('mergeToastPresence keeps a toast that just left at its place, marked leaving; none when not animating', () => {
    const a = { id: 'a', kind: 'info', message: 'A' } as Parameters<typeof mergeToastPresence>[0][number]
    const b = { id: 'b', kind: 'info', message: 'B' } as typeof a
    const c = { id: 'c', kind: 'info', message: 'C' } as typeof a
    const previous = mergeToastPresence([a, b, c], [], false)

    expect(mergeToastPresence([a, c], previous, true).map(e => [e.notification.id, e.leaving])).toEqual([
      ['a', false],
      ['b', true],
      ['c', false]
    ])
    expect(mergeToastPresence([a, c], previous, false).map(e => e.notification.id)).toEqual(['a', 'c'])
    // Same id back while leaving = one live toast.
    expect(mergeToastPresence([b, a, c], previous, true).filter(e => e.notification.id === 'b')).toEqual([
      { leaving: false, notification: b }
    ])
  })

  it('✕ plays a 120 ms exit: the toast leaves the store at once, stays painted inert, then goes', () => {
    stubReducedMotion(false)
    vi.useFakeTimers()
    notify({ kind: 'error', message: 'Could not save' })
    mount()

    fireEvent.click(screen.getByRole('button', { name: f4Notes.close }))

    expect($notifications.get()).toHaveLength(0)
    expect(toasts()).toHaveLength(0)

    const leaving = screen.getByTestId('toast-leaving')

    expect(leaving.hasAttribute('data-leaving')).toBe(true)
    expect(leaving.getAttribute('aria-hidden')).toBe('true')
    expect(leaving.hasAttribute('inert')).toBe(true)

    act(() => {
      vi.advanceTimersByTime(TOAST_EXIT_MS - 1)
    })
    expect(screen.queryByTestId('toast-leaving')).not.toBeNull()

    act(() => {
      vi.advanceTimersByTime(2)
    })
    expect(screen.queryByTestId('toast-leaving')).toBeNull()
  })

  it('under reduced motion the exit is 0 ms: nothing stays painted', () => {
    stubReducedMotion(true)
    notify({ kind: 'error', message: 'Could not save' })
    mount()

    fireEvent.click(screen.getByRole('button', { name: f4Notes.close }))

    expect(toasts()).toHaveLength(0)
    expect(screen.queryByTestId('toast-leaving')).toBeNull()
  })

  it('the CSS gives the exit --ic-dur-fast and turns it off under reduced motion', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const css = readFileSync(resolve(__dirname, 'notification-system.css'), 'utf8')

    expect(css).toMatch(/\.icn-toast\[data-leaving\] \{\s*animation: icn-exit var\(--ic-dur-fast\)/)
    expect(css).toMatch(/@keyframes icn-exit-swipe/)

    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))

    expect(reduced).toMatch(/\.icn-toast\[data-leaving\][^{]*\{\s*animation: none;\s*opacity: 0;/)
  })
})

describe('Q renderer 4 · the stack never clips a toast\'s focus ring', () => {
  it('the scroll box pads at least the ring (outline + offset) on every side a toast meets, and pays it back', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const css = readFileSync(resolve(__dirname, 'notification-system.css'), 'utf8')
    const block = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.:]/g, m => `\\${m}`)} \\{([^}]*)\\}`))?.[1] ?? ''
    const px = (value: string) => Number(value.replace('px', ''))
    const stack = block('.icn-stack')
    const ring = block('.icn-toast:focus-visible')
    const reach = px(ring.match(/outline: (\d+)px/)?.[1] ?? 'NaN') + px(ring.match(/outline-offset: (\d+)px/)?.[1] ?? 'NaN')
    const [top, right, bottom, left] = (stack.match(/padding: ([^;]+);/)?.[1] ?? '').split(' ').map(px)

    expect(stack).toMatch(/overflow-y: auto/)
    expect(reach).toBeGreaterThan(0)

    for (const side of [top, right, bottom, left]) {
      expect(side).toBeGreaterThanOrEqual(reach)
    }

    // The toasts stay where they were: 16px from the right, 28px from the bottom, the same width and height cap.
    expect(stack).toMatch(/box-sizing: border-box/)
    expect(px(stack.match(/\n {2}right: (\d+)(?:px)?;/)?.[1] ?? 'NaN') + right).toBe(16)
    expect(px(stack.match(/\n {2}bottom: (\d+)(?:px)?;/)?.[1] ?? 'NaN') + bottom).toBe(28)
    expect(stack).toContain(`width: calc(var(--ic-note-w) + ${left + right}px)`)
    expect(stack).toContain(`max-height: calc(100vh - ${84 - top - bottom}px)`)
  })
})

describe('F4b · swipe to close', () => {
  it(`a drag of ${SWIPE_CLOSE_PX}px or more to the right closes it, and does not open the centre`, () => {
    const onDismiss = vi.fn()

    stubReducedMotion(true)
    notify({ kind: 'error', message: 'Could not save', onDismiss })
    mount()

    const toast = screen.getByTestId('toast')

    fireEvent.pointerDown(toast, { button: 0, clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerMove(toast, { clientX: 60, clientY: 10, pointerId: 1 })
    expect(toast.hasAttribute('data-swiping')).toBe(true)
    fireEvent.pointerMove(toast, { clientX: 10 + SWIPE_CLOSE_PX + 8, clientY: 10, pointerId: 1 })
    fireEvent.pointerUp(toast, { clientX: 10 + SWIPE_CLOSE_PX + 8, clientY: 10, pointerId: 1 })
    fireEvent.click(toast)

    expect($notifications.get()).toHaveLength(0)
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect($notificationCentre.get().open).toBe(false)
  })

  it('a short drag snaps back: the toast stays and the click that ends the drag opens nothing', () => {
    stubReducedMotion(true)
    notify({ kind: 'error', message: 'Could not save' })
    mount()

    const toast = screen.getByTestId('toast')

    fireEvent.pointerDown(toast, { button: 0, clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerMove(toast, { clientX: 40, clientY: 10, pointerId: 1 })
    fireEvent.pointerUp(toast, { clientX: 40, clientY: 10, pointerId: 1 })
    fireEvent.click(toast)

    expect(toasts()).toHaveLength(1)
    expect(screen.getByTestId('toast').hasAttribute('data-swiping')).toBe(false)
    expect($notificationCentre.get().open).toBe(false)
  })

  it('a two-finger horizontal swipe (wheel deltaX) closes it; a vertical wheel does not', () => {
    stubReducedMotion(true)
    notify({ kind: 'warning', message: 'Low credits' })
    mount()

    fireEvent.wheel(screen.getByTestId('toast'), { deltaX: 0, deltaY: 200 })
    expect(toasts()).toHaveLength(1)

    fireEvent.wheel(screen.getByTestId('toast'), { deltaX: 40, deltaY: 2 })
    fireEvent.wheel(screen.getByTestId('toast'), { deltaX: 40, deltaY: 2 })
    expect(toasts()).toHaveLength(0)
  })
})

describe('F4b · the centre says where its history lives', () => {
  it('shows the memory note under the title: this device only, cleared on restart AND reload (Q renderer 8)', () => {
    notify({ kind: 'info', message: 'Saved' })
    mount()
    fireEvent.click(screen.getByText('Saved'))

    // The history is a renderer atom: the boot card's Retry/Repair and the banner's Retry reload the window and
    // clear it, so the note names the reload too.
    expect(screen.getByTestId('notification-centre-memory').textContent).toBe(
      'Kept in memory on this device only. Cleared when the app restarts or reloads.'
    )
  })
})
