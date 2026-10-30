import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MailMessage } from './email-data'
import { type ListActions, type ListView, MailList, TRASH_TRUTH } from './email-list'

const noop = () => undefined

const actions: ListActions = {
  onAskIntro: noop,
  onCheck: noop,
  onClearSearch: noop,
  onCompose: noop,
  onEmptyTrash: noop,
  onLoadMore: noop,
  onNearEnd: noop,
  onOpen: noop,
  onRecover: noop,
  onRetry: noop,
  onSetup: noop
}

function message(id: string, subject: string, at: Date): MailMessage {
  return {
    id,
    threadId: `thr-${id}`,
    direction: 'inbound',
    from: { name: 'Jane', address: 'jane@example.com' },
    to: [],
    subject,
    preview: '',
    isRead: true,
    receivedAt: at.toISOString(),
    at: at.getTime(),
    attachments: 0,
    safety: 'clean'
  }
}

function view(messages: MailMessage[]): ListView {
  return {
    folder: 'inbox',
    messages,
    loading: false,
    error: null,
    query: null,
    canLoadMore: false,
    loadingMore: false,
    moreError: null,
    purged: 0,
    scanned: messages.length
  }
}

function timeOf(subject: string): string {
  return screen.getByText(subject).closest('button')?.querySelector('time')?.textContent ?? ''
}

describe('MailList times', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 26, 23, 58, 0))
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('ages today’s rows once a minute, keeps older rows on their clock, and turns Today into Yesterday at midnight', () => {
    const rows = [
      message('recent', 'Recent', new Date(2026, 8, 26, 23, 52, 0)),
      message('older', 'Older', new Date(2026, 8, 20, 9, 5, 0))
    ]

    render(
      <MailList actions={actions} address="" agentName="Vega" checked={new Set()} selectedId={null} view={view(rows)} />
    )

    expect(timeOf('Recent')).toMatch(/6m ago/)
    expect(timeOf('Older')).toMatch(/9.05/)
    expect(screen.getByRole('heading', { name: 'Today' })).toBeTruthy()

    act(() => {
      vi.advanceTimersByTime(60_000)
    })

    expect(timeOf('Recent')).toMatch(/7m ago/)
    expect(timeOf('Older')).toMatch(/9.05/)

    act(() => {
      vi.advanceTimersByTime(60_000)
    })

    // 00:00 — the same row, now yesterday's, still reads as its age.
    expect(screen.getByRole('heading', { name: 'Yesterday' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Today' })).toBeNull()
    expect(timeOf('Recent')).toMatch(/8m ago/)
  })
})

describe('MailList — Spam failure and the Trash truth (R3d)', () => {
  afterEach(cleanup)

  it('a Spam read the service answers with HTTP 500 shows the error, never a blank pane', () => {
    const failed: ListView = {
      ...view([]),
      folder: 'spam',
      error: { ok: false, kind: 'cli', error: 'Request failed with status code 500' }
    }

    render(
      <MailList actions={actions} address="" agentName="Vega" checked={new Set()} selectedId={null} view={failed} />
    )

    expect(screen.getByText('Couldn’t read Spam')).toBeTruthy()
    expect(screen.getByText('Try again')).toBeTruthy()
  })

  it('Trash says that forever is this device only', () => {
    const trash: ListView = { ...view([message('t1', 'Old', new Date(2026, 9, 1))]), folder: 'trash' }

    render(
      <MailList actions={actions} address="" agentName="Vega" checked={new Set()} selectedId={null} view={trash} />
    )

    expect(screen.getByText(TRASH_TRUTH)).toBeTruthy()
  })
})

// U1p2-T2 — an empty folder whose loaded mail was deleted forever here says
// so and offers it back, never "Nothing here yet".
describe('MailList — mail deleted forever on this device', () => {
  afterEach(cleanup)

  it('an Inbox emptied by Delete forever says so and offers Recover', () => {
    const onRecover = vi.fn()

    render(
      <MailList
        actions={{ ...actions, onRecover }}
        address="vega@agentcard.sh"
        agentName="Vega"
        checked={new Set()}
        selectedId={null}
        view={{ ...view([]), purged: 1 }}
      />
    )

    expect(screen.queryByText('Nothing here yet')).toBeNull()
    expect(screen.getByText('Deleted forever on this device')).toBeTruthy()
    expect(screen.getByText(/One message deleted forever on this device/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Recover 1' }))
    expect(onRecover).toHaveBeenCalledTimes(1)
  })

  it('an empty Trash counts what Delete forever hid; a full one offers it back above the list', () => {
    const { unmount } = render(
      <MailList
        actions={actions}
        address=""
        agentName="Vega"
        checked={new Set()}
        selectedId={null}
        view={{ ...view([]), folder: 'trash', purged: 13 }}
      />
    )

    expect(screen.getByText('Trash is empty')).toBeTruthy()
    expect(screen.getByText(/13 messages deleted forever/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Recover 13' })).toBeTruthy()
    unmount()

    render(
      <MailList
        actions={actions}
        address=""
        agentName="Vega"
        checked={new Set()}
        selectedId={null}
        view={{ ...view([message('t1', 'Old', new Date(2026, 9, 1))]), folder: 'trash', purged: 2 }}
      />
    )

    expect(screen.getByRole('button', { name: 'Recover 2' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Empty trash' })).toBeTruthy()
  })

  it('nothing deleted forever: the Inbox invites mail as before', () => {
    render(
      <MailList actions={actions} address="" agentName="Vega" checked={new Set()} selectedId={null} view={view([])} />
    )

    expect(screen.getByText('Nothing here yet')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Recover/ })).toBeNull()
  })
})

describe('MailList — a search in flight and a search with no match (U3-p2-06)', () => {
  afterEach(cleanup)

  it('names the query while the server searches, with no skeleton rows', () => {
    const searching: ListView = { ...view([]), loading: true, query: 'zzqqxx' }

    const { container } = render(
      <MailList actions={actions} address="" agentName="Vega" checked={new Set()} selectedId={null} view={searching} />
    )

    expect(screen.getByText('Searching mail for “zzqqxx”…')).toBeTruthy()
    expect(container.querySelectorAll('[class*="skeleton"]').length).toBe(0)
  })

  it('says no mail matches and offers the way back', () => {
    const onClearSearch = vi.fn()
    const empty: ListView = { ...view([]), query: 'zzqqxx' }

    render(
      <MailList
        actions={{ ...actions, onClearSearch }}
        address=""
        agentName="Vega"
        checked={new Set()}
        selectedId={null}
        view={empty}
      />
    )

    expect(screen.getByText('No mail matches “zzqqxx”')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(onClearSearch).toHaveBeenCalled()
  })
})
