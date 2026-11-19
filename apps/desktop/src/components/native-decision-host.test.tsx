/**
 * v0.0.9 F4b — the window side of main's decisions (spec F4 type 4) and of main-only notices (centre, gate G-NATIVE).
 * Old code had no host: a decision main raised could only be a native box, and a failed detached update only an
 * OK-only `showErrorBox`. The bridge is a fake; nothing touches Electron or the real HOME.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $notificationHistory,
  $notifications,
  clearNotificationHistory,
  clearNotifications
} from '@/store/notifications'

import { NativeDecisionHost } from './native-decision-host'

function fakeBridge(options: { shown?: boolean; accept?: (response: number) => boolean; notices?: unknown[] } = {}) {
  let onAsk: ((ask: unknown) => void) | null = null
  let onReady: (() => void) | null = null
  let queued = options.notices ?? []

  const bridge = {
    answer: vi.fn(async (_id: string, response: number) => (options.accept ? options.accept(response) : true)),
    drainNotices: vi.fn(async () => {
      const out = queued

      queued = []

      return out
    }),
    onAsk: vi.fn((cb: (ask: unknown) => void) => {
      onAsk = cb

      return () => (onAsk = null)
    }),
    onNoticesReady: vi.fn((cb: () => void) => {
      onReady = cb

      return () => (onReady = null)
    }),
    shown: vi.fn(async () => options.shown ?? true)
  }

  return {
    ask: (payload: unknown) => act(() => onAsk?.(payload)),
    bridge,
    queue: (items: unknown[]) => {
      queued = [...queued, ...items]
      act(() => onReady?.())
    }
  }
}

const QUIT = {
  buttons: ['Keep Running', 'Quit Anyway'],
  cancelId: 0,
  defaultId: 0,
  detail: 'Your agent is still working on 2 sessions.\nQuitting stops them.',
  id: 'nd-1',
  title: 'Quit while work is running?',
  tone: 'warning'
}

function install(fake: ReturnType<typeof fakeBridge>) {
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { nativeDecisions: fake.bridge }
}

beforeEach(() => {
  clearNotifications()
  $notifications.set([])
  clearNotificationHistory()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
  clearNotifications()
  $notifications.set([])
  clearNotificationHistory()
})

describe('F4b · NativeDecisionHost — decisions', () => {
  it('shows an ask only after main confirms "shown"; the safe button has focus; the whole detail is there', async () => {
    const fake = fakeBridge()

    install(fake)
    render(<NativeDecisionHost />)

    fake.ask(QUIT)

    expect(fake.bridge.shown).toHaveBeenCalledWith('nd-1')
    await screen.findByRole('dialog')
    expect(screen.getByText('Quit while work is running?')).toBeTruthy()
    expect(screen.getByTestId('native-decision-detail').textContent).toBe(QUIT.detail)
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Keep Running'))
  })

  it('a settled decision ("shown" → false) is never painted', async () => {
    const fake = fakeBridge({ shown: false })

    install(fake)
    render(<NativeDecisionHost />)

    fake.ask(QUIT)

    await waitFor(() => expect(fake.bridge.shown).toHaveBeenCalled())
    await act(async () => {})
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a malformed ask is dropped without asking main', () => {
    const fake = fakeBridge()

    install(fake)
    render(<NativeDecisionHost />)

    fake.ask({ ...QUIT, cancelId: 7 })
    fake.ask({ id: 'x', title: 'no buttons' })

    expect(fake.bridge.shown).not.toHaveBeenCalled()
  })

  it('Esc answers the safe button (explicit "Keep Running"), then the dialog goes', async () => {
    const fake = fakeBridge()

    install(fake)
    render(<NativeDecisionHost />)
    fake.ask(QUIT)
    await screen.findByRole('dialog')

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    await waitFor(() => expect(fake.bridge.answer).toHaveBeenCalledWith('nd-1', 0))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it("only the non-cancel buttons carry the owner-click marker main checks (lead decision 2)", async () => {
    const fake = fakeBridge()

    install(fake)
    render(<NativeDecisionHost />)
    fake.ask(QUIT)

    const quit = await screen.findByRole('button', { name: 'Quit Anyway' })
    const keep = screen.getByRole('button', { name: 'Keep Running' })

    expect(quit.closest('[data-native-decision-confirm]')).not.toBeNull()
    expect(keep.closest('[data-native-decision-confirm]')).toBeNull()
    expect(screen.getByTestId('native-decision-buttons').querySelectorAll('[data-native-decision-confirm]')).toHaveLength(
      1
    )
  })

  it('a click on the other button sends its index', async () => {
    const fake = fakeBridge()

    install(fake)
    render(<NativeDecisionHost />)
    fake.ask(QUIT)

    fireEvent.click(await screen.findByRole('button', { name: 'Quit Anyway' }))

    await waitFor(() => expect(fake.bridge.answer).toHaveBeenCalledWith('nd-1', 1))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('an answer main refuses (no real gesture) leaves the dialog up', async () => {
    const fake = fakeBridge({ accept: response => response === 0 })

    install(fake)
    render(<NativeDecisionHost />)
    fake.ask(QUIT)

    fireEvent.click(await screen.findByRole('button', { name: 'Quit Anyway' }))

    await waitFor(() => expect(fake.bridge.answer).toHaveBeenCalledWith('nd-1', 1))
    await act(async () => {})
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})

describe('F4b · NativeDecisionHost — notices main could not show', () => {
  const FAILED = {
    at: 1,
    detail: 'Details: /tmp/handoff.log',
    id: 'n-1',
    kind: 'error',
    message: 'exit 1: the swap could not replace the app bundle',
    nextStep: 'Try again from Settings › Updates.',
    title: 'The update did not finish'
  }

  it('drains on mount: an error toast + centre entry, whole, sticky, surviving the reconnect clear', async () => {
    const fake = fakeBridge({ notices: [FAILED] })

    install(fake)
    render(<NativeDecisionHost />)

    await waitFor(() => expect($notifications.get()).toHaveLength(1))

    const toast = $notifications.get()[0]

    expect(toast).toMatchObject({
      detail: FAILED.detail,
      durationMs: 0,
      kind: 'error',
      message: FAILED.message,
      nextStep: FAILED.nextStep,
      survivesClear: true,
      title: FAILED.title
    })
    expect($notificationHistory.get()[0]).toMatchObject({ detail: FAILED.detail, title: FAILED.title })

    clearNotifications()
    expect($notifications.get()).toHaveLength(1)
  })

  it('drains again when main says notices are ready; a history-only notice adds no toast', async () => {
    const fake = fakeBridge()

    install(fake)
    render(<NativeDecisionHost />)
    await waitFor(() => expect(fake.bridge.drainNotices).toHaveBeenCalledTimes(1))

    fake.queue([{ ...FAILED, historyOnly: true, id: 'n-2', kind: 'info', title: 'iclone os 0.0.9 is ready' }])

    await waitFor(() => expect($notificationHistory.get()[0]).toMatchObject({ source: 'native' }))
    expect($notifications.get()).toHaveLength(0)
  })
})
