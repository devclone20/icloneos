import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type * as Router from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NEW_CHAT_ROUTE } from '@/app/routes'
import { $cronSessions, $messagingSessions, $sessions, $sessionsLoading } from '@/store/session'
import type { SessionInfo } from '@/types/hermes'

import { $itClosePrompt } from './it-keys'
import type * as ItStore from './it-store'
import { $itActiveId, $itInstances, $itWorkspaces, addItWorkspace, setItInstancesForTests } from './it-store'
import { MsgSidebar } from './msg-sidebar'

const navigateSpy = vi.hoisted(() => vi.fn())

vi.mock('react-router', async importOriginal => ({
  ...(await importOriginal<typeof Router>()),
  useNavigate: () => navigateSpy
}))

// The real store, with `+`'s door spied on.
vi.mock('./it-store', async importOriginal => {
  const real = await importOriginal<typeof ItStore>()

  return { ...real, addItWorkspace: vi.fn(real.addItWorkspace) }
})

const tile = vi.hoisted(() => ({ archiveSession: vi.fn(), deleteSession: vi.fn(() => Promise.resolve()) }))

vi.mock('@/store/session-states', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sessionTileDelegate: () => tile
}))

vi.stubGlobal(
  'ResizeObserver',
  class {
    disconnect() {}
    observe() {}
    unobserve() {}
  }
)

function row(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    last_active: 0,
    message_count: 1,
    source: 'desktop',
    started_at: 0,
    title: `chat ${id}`,
    ...over
  } as SessionInfo
}

function mount(props: Partial<Parameters<typeof MsgSidebar>[0]> = {}) {
  const handlers = { onCollapsed: vi.fn(), onToggle: vi.fn(), onView: vi.fn() }

  render(
    <MemoryRouter>
      <MsgSidebar expanded={false} open={false} view="chat" {...handlers} {...props} />
    </MemoryRouter>
  )

  return handlers
}

const rows = () => window.document.querySelectorAll('.imsg-side__list .row-hover')

describe('MsgSidebar', () => {
  beforeEach(() => {
    $sessionsLoading.set(false)
  })

  afterEach(() => {
    cleanup()
    $sessions.set([])
    $messagingSessions.set([])
    $cronSessions.set([])
    $sessionsLoading.set(true)
  })

  it('is a labelled nav, collapsed: the toggle says so and controls the panel', () => {
    $sessions.set([row('a')])
    mount()

    expect(screen.getByRole('navigation', { name: 'Conversations' })).toBeTruthy()

    const toggle = screen.getByRole('button', { name: 'Show conversations' })

    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(window.document.getElementById(toggle.getAttribute('aria-controls') ?? '')).not.toBeNull()
    expect(rows()).toHaveLength(0)
  })

  it('switches views from the rail and reflects the current one in aria-pressed', () => {
    const { onView } = mount({ view: 'it' })
    const [chat] = screen.getAllByRole('button', { name: 'message' })
    const [it] = screen.getAllByRole('button', { name: 'iT' })

    expect(it.getAttribute('aria-pressed')).toBe('true')
    expect(chat.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(chat)
    expect(onView).toHaveBeenCalledWith('chat')
  })

  it('lists ONE session as one Sessions group', () => {
    $sessions.set([row('only', { title: 'Friendly greeting' })])
    mount({ open: true })

    expect(screen.getByRole('group', { name: 'Sessions' })).toBeTruthy()
    expect(rows()).toHaveLength(1)
    expect(screen.getByText('Friendly greeting')).toBeTruthy()
  })

  it('separates the groups by type, archived behind a closed disclosure', () => {
    $sessions.set([row('a'), row('old', { archived: true })])
    $messagingSessions.set([row('t', { source: 'telegram' })])
    $cronSessions.set([row('j')])
    mount({ open: true })

    const groups = screen.getAllByRole('group').filter(group => group.classList.contains('imsg-side__group'))

    expect(groups.map(group => group.getAttribute('data-group'))).toEqual([
      'sessions',
      'platform',
      'scheduled',
      'archived'
    ])
    expect(screen.getAllByRole('heading', { level: 3 }).map(heading => heading.textContent)).toEqual([
      'Sessions',
      'Telegram',
      'Scheduled jobs',
      'Archived (1)'
    ])
    expect(rows()).toHaveLength(3)
  })

  it('a 200-session store renders a bounded window of rows, not 200', () => {
    // jsdom lays nothing out: the virtualizer (offsetHeight) needs a sized
    // scroller and sized slots to render a window at all (0 rows proves nothing).
    const tall = (element: HTMLElement) =>
      element.classList.contains('imsg-side__scroller') ? 400 : element.classList.contains('imsg-side__slot') ? 32 : 0

    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return tall(this)
    })
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return tall(this) ? 240 : 0
    })

    try {
      $sessions.set(Array.from({ length: 200 }, (_, i) => row(`s${i}`, { last_active: i })))
      mount({ open: true })

      expect(rows().length).toBeGreaterThanOrEqual(1)
      expect(rows().length).toBeLessThanOrEqual(60)
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('↑/↓ walk the rows', () => {
    $sessions.set([row('a', { last_active: 3 }), row('b', { last_active: 2 }), row('c', { last_active: 1 })])
    mount({ open: true })

    const targets = [...rows()].map(r => r.querySelector('button') as HTMLButtonElement)

    targets[0].focus()
    fireEvent.keyDown(targets[0], { key: 'ArrowDown' })
    expect(window.document.activeElement).toBe(targets[1])
    fireEvent.keyDown(targets[1], { key: 'ArrowUp' })
    expect(window.document.activeElement).toBe(targets[0])
    fireEvent.keyDown(targets[0], { key: 'ArrowUp' })
    expect(window.document.activeElement).toBe(targets[0])
  })

  it('Escape collapses an open sidebar, and only an open one', () => {
    const open = mount({ open: true })

    fireEvent.keyDown(screen.getByRole('navigation'), { key: 'Escape' })
    expect(open.onToggle).toHaveBeenCalledTimes(1)
    cleanup()

    const closed = mount()

    fireEvent.keyDown(screen.getByRole('navigation'), { key: 'Escape' })
    expect(closed.onToggle).not.toHaveBeenCalled()
  })

  it('settles the collapse even when no transition fires', () => {
    vi.useFakeTimers()

    try {
      const handlers = { onCollapsed: vi.fn(), onToggle: vi.fn(), onView: vi.fn() }

      const { rerender } = render(
        <MemoryRouter>
          <MsgSidebar expanded={false} open view="chat" {...handlers} />
        </MemoryRouter>
      )

      rerender(
        <MemoryRouter>
          <MsgSidebar expanded={false} open={false} view="chat" {...handlers} />
        </MemoryRouter>
      )
      expect(handlers.onCollapsed).not.toHaveBeenCalled()
      act(() => void vi.advanceTimersByTime(700))
      expect(handlers.onCollapsed).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the empty state with a way to start, and a loader while loading', () => {
    mount({ open: true })
    expect(screen.getByText('No sessions yet')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /New conversation/ })).toHaveLength(3)
    cleanup()

    $sessionsLoading.set(true)
    mount({ open: true })
    expect(screen.getByRole('status')).toBeTruthy()
  })

  it('labels every icon-only button', () => {
    mount()

    for (const button of window.document.querySelectorAll('.imsg-side__btn')) {
      expect(button.getAttribute('aria-label')).toBeTruthy()
    }
  })

  it('names every group by its own heading, whose button discloses the rows', () => {
    $sessions.set([row('a'), row('old', { archived: true })])
    mount({ open: true })

    const archived = screen.getByRole('group', { name: 'Archived (1)' })
    const disclosure = archived.querySelector('h3 > button') as HTMLButtonElement

    expect(screen.getByRole('group', { name: 'Sessions' }).querySelector('h3')).toBeTruthy()
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(window.document.getElementById(disclosure.getAttribute('aria-controls') ?? '')).toBeTruthy()
    fireEvent.click(disclosure)
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    expect(rows()).toHaveLength(2)
  })

  it('tags each row with its session id', () => {
    $sessions.set([row('a'), row('b')])
    mount({ open: true })

    expect(
      [...window.document.querySelectorAll('.imsg-row')].map(r => r.getAttribute('data-session-id')).sort()
    ).toEqual(['a', 'b'])
  })

  it('the row ✕ asks first: cancel deletes nothing, confirm deletes exactly that row', async () => {
    tile.deleteSession.mockClear()
    $sessions.set([row('a', { title: 'Keep me' }), row('b', { title: 'Drop me' })])
    mount({ open: true })

    fireEvent.click(screen.getByRole('button', { name: 'Delete Drop me' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(tile.deleteSession).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Delete Drop me' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    await vi.waitFor(() => expect(tile.deleteSession).toHaveBeenCalledTimes(1))
    expect(tile.deleteSession).toHaveBeenCalledWith('b')
  })

  it('Delete or Backspace on a focused row opens the same confirm', async () => {
    $sessions.set([row('a', { title: 'Focused one' })])
    mount({ open: true })

    const target = rows()[0].querySelector('button') as HTMLButtonElement

    for (const key of ['Delete', 'Backspace']) {
      target.focus()
      fireEvent.keyDown(target, { key })
      expect(await screen.findByRole('button', { name: 'Delete' })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull())
    }

    fireEvent.keyDown(target, { key: 'x' })
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('keeps the list through the collapse slide and drops it once the collapse settles', () => {
    vi.useFakeTimers()

    try {
      $sessions.set([row('a')])
      const handlers = { onCollapsed: vi.fn(), onToggle: vi.fn(), onView: vi.fn() }

      const { rerender } = render(
        <MemoryRouter>
          <MsgSidebar expanded={false} open view="chat" {...handlers} />
        </MemoryRouter>
      )

      rerender(
        <MemoryRouter>
          <MsgSidebar expanded={false} open={false} view="chat" {...handlers} />
        </MemoryRouter>
      )
      expect(rows()).toHaveLength(1)
      act(() => void vi.advanceTimersByTime(700))
      expect(rows()).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('MsgSidebar iT view', () => {
  let saved: ReturnType<typeof $itInstances.get>
  const itRows = () => [...window.document.querySelectorAll<HTMLElement>('[data-it-workspace-id]')]
  const nav = () => screen.getByRole('navigation')

  beforeEach(() => {
    saved = $itInstances.get()
    $sessionsLoading.set(false)
    $sessions.set([row('msg')])
    navigateSpy.mockClear()
    vi.mocked(addItWorkspace).mockClear()
  })

  afterEach(() => {
    cleanup()
    $itClosePrompt.set(null)
    setItInstancesForTests(saved)
    $sessions.set([])
    $sessionsLoading.set(true)
  })

  it('"+" follows the view: a conversation on chat, an iT session on iT — never a view change', () => {
    const chat = mount({ view: 'chat' })

    fireEvent.click(screen.getAllByRole('button', { name: 'New conversation' })[0])
    expect(navigateSpy).toHaveBeenCalledWith(NEW_CHAT_ROUTE)
    expect(addItWorkspace).not.toHaveBeenCalled()
    expect(chat.onView).toHaveBeenCalledWith('chat')
    cleanup()

    const it = mount({ view: 'it' })

    fireEvent.click(screen.getAllByRole('button', { name: 'New iT session' })[0])
    expect(addItWorkspace).toHaveBeenCalledTimes(1)
    expect(it.onView).not.toHaveBeenCalled()
    expect(navigateSpy).toHaveBeenCalledTimes(1)
  })

  it('lists exactly the open iT sessions: one row per workspace, no message rows', () => {
    mount({ open: true, view: 'it' })

    expect(screen.getByRole('group', { name: 'iT sessions' })).toBeTruthy()
    expect(itRows().map(r => r.dataset.itWorkspaceId)).toEqual($itWorkspaces.get().map(w => w.id))
    expect(rows()).toHaveLength(0)
  })

  it('marks the active session; "+" adds one that is listed and active at once', () => {
    mount({ open: true, view: 'it' })
    const before = itRows().length

    expect(itRows().find(r => r.hasAttribute('data-selected'))?.dataset.itWorkspaceId).toBe($itActiveId.get())
    fireEvent.click(screen.getAllByRole('button', { name: 'New iT session' })[0])
    expect(itRows()).toHaveLength(before + 1)

    const added = $itWorkspaces.get().at(-1)!
    const added_row = itRows().find(r => r.dataset.itWorkspaceId === added.id)

    expect(added_row?.hasAttribute('data-selected')).toBe(true)
    expect(added_row?.querySelector('[aria-current="true"]')).toBeTruthy()
    expect(screen.getByText(added.title)).toBeTruthy()
  })

  it('renames from the row: Enter commits, Escape keeps the old title', () => {
    mount({ open: true, view: 'it' })
    const [workspace] = $itWorkspaces.get()

    fireEvent.click(screen.getByRole('button', { name: `Rename ${workspace.title}` }))

    const field = screen.getByRole('textbox', { name: `Rename ${workspace.title}` })

    fireEvent.change(field, { target: { value: 'Build' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect($itWorkspaces.get()[0].title).toBe('Build')
    expect(screen.queryByRole('textbox')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Rename Build' }))

    const again = screen.getByRole('textbox', { name: 'Rename Build' })

    fireEvent.change(again, { target: { value: 'Nope' } })
    fireEvent.keyDown(again, { key: 'Escape' })
    expect($itWorkspaces.get()[0].title).toBe('Build')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText('Build')).toBeTruthy()
  })

  it('the last session has no close control; a second one gives both a ✕', () => {
    mount({ open: true, view: 'it' })

    expect(itRows()).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /^Close / })).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: 'New iT session' })[0])
    expect(screen.getAllByRole('button', { name: /^Close / })).toHaveLength(2)
  })

  it('the busy-close prompt shows on its row; Escape dismisses it before it collapses the sidebar', () => {
    const { onToggle } = mount({ open: true, view: 'it' })
    const [workspace] = $itWorkspaces.get()

    act(() => $itClosePrompt.set({ busy: 1, terminalId: null, workspaceId: workspace.id }))

    const prompt = screen.getByRole('alertdialog')

    expect(prompt.closest('[data-it-workspace-id]')?.getAttribute('data-it-workspace-id')).toBe(workspace.id)
    expect(prompt.textContent).toContain('1 shell is busy')
    fireEvent.keyDown(nav(), { key: 'Escape' })
    expect($itClosePrompt.get()).toBeNull()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(onToggle).not.toHaveBeenCalled()
    fireEvent.keyDown(nav(), { key: 'Escape' })
    expect(onToggle).toHaveBeenCalledTimes(1)
  })
})
