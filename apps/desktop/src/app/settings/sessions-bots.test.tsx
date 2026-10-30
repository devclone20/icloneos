import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { $bindings } from '@/store/keybinds'

vi.mock('@/contrib/react/use-contributions', () => ({ useContributions: () => [] }))
vi.mock('@/contrib/react/boundary', () => ({ ContribRender: () => null }))
vi.mock('../contrib/context', () => ({ WiredPane: () => <div data-testid="wired-sidebar" /> }))

import { SessionsBotsSettings } from './sessions-bots'

const initialBindings = $bindings.get()

afterEach(() => {
  cleanup()
  $bindings.set(initialBindings)
})

const newChatRow = () => screen.getByText('Start a new chat in the current workspace').closest('[data-setting-row]')

describe('Sessions & Bots anatomy', () => {
  it('puts every function on THE row: a one-sentence title with its explanation under it', () => {
    const { container } = render(<SessionsBotsSettings />)
    const rows = container.querySelectorAll('[data-setting-row]')
    // intro + 9 chat functions + bots-unavailable + 6 bot functions
    expect(rows.length).toBe(17)
    const row = screen.getByText('Start a new chat in the current workspace').closest('[data-setting-row]')
    // The shortcut lives in the hint, formatted for the platform; never a glyph in the title.
    expect(row?.textContent).toMatch(/Press (⌘N|Ctrl\+N), or right-click the row/)
    expect(row?.textContent).not.toContain('{shortcut}')
    expect(screen.getByText('Copy, hide or delete a bot').closest('[data-setting-row]')).toBeTruthy()

    for (const r of rows) {
      const title = r.querySelector('div')?.textContent ?? ''
      expect(title).not.toMatch(/ · |\//)
    }

    expect(container.textContent).not.toMatch(/git worktrees|load-more|Cron jobs/)
  })

  it('headings are sentences on the chassis heading, not raw h3 nouns', () => {
    const { container } = render(<SessionsBotsSettings />)
    expect(container.querySelectorAll('h3').length).toBe(0)
    expect(screen.getByText('Your chats, as the sidebar shows them')).toBeTruthy()
    expect(screen.getByText('Your bots, each with a chat of its own')).toBeTruthy()
  })

  it("the new-chat hint shows the user's own binding and drops the shortcut when it is unbound", () => {
    act(() => $bindings.set({ ...initialBindings, 'session.new': ['mod+shift+k'] }))
    render(<SessionsBotsSettings />)
    expect(newChatRow()?.textContent).toMatch(/Press [^,]*K, or right-click/)
    cleanup()

    act(() => $bindings.set({ ...initialBindings, 'session.new': [] }))
    render(<SessionsBotsSettings />)
    expect(newChatRow()?.textContent).toContain('Right-click the row to open the chat beside the current one.')
    expect(newChatRow()?.textContent).not.toMatch(/Press|\{shortcut\}/)
  })
})
