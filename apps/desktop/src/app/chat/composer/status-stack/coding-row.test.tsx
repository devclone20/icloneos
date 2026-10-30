import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { $notifications, clearNotifications } from '@/store/notifications'

vi.mock('@/store/coding-status', () => ({
  registerRepoStatusCwd: () => undefined,
  repoStatusForCwd: () =>
    atom({
      added: 12,
      ahead: 0,
      behind: 0,
      branch: 'bb/hitbox',
      defaultBranch: 'main',
      detached: false,
      removed: 3,
      untracked: 0
    }),
  repoWorktreesForCwd: () => atom([])
}))

const { CodingStatusRow } = await import('./coding-row')

describe('CodingStatusRow', () => {
  afterEach(() => {
    cleanup()
  })

  it('is read-only status: the branch, the glyph and the counts click nothing', () => {
    // E3r deleted the review pane's store, so the row has no `onOpen` seam left
    // and nothing in the status strip may be a control again. The branch kebab
    // (rendered only with onBranchOff) is the row's one affordance.
    const { container } = render(<CodingStatusRow repoPath="/repo" />)

    expect(container.querySelector('.coding-status-bar')).not.toBeNull()
    expect(screen.getByText('bb/hitbox').closest('button')).toBeNull()
    expect(screen.getByText('12').closest('button')).toBeNull()
    // The copy-path glyph is the one <button> the row still renders, and it
    // carries neither the branch nor a count: no status text is clickable.
    const texts = [...container.querySelectorAll('button')].map(button => button.textContent ?? '')

    expect(texts.filter(text => text.includes('bb/hitbox') || text.includes('12'))).toEqual([])
  })

  it('keeps the status parts direct flex children of the row', () => {
    const { container } = render(<CodingStatusRow repoPath="/repo" />)

    // The `contents` wrappers existed only to make the label and the counts
    // clickable without a layout box; with them gone the parts must sit in the
    // row itself, not in a new box that would change their gap / `ml-auto`.
    expect(screen.getByText('bb/hitbox').parentElement?.classList.contains('contents')).toBe(false)
    expect(container.querySelector('[class~="contents"]')).toBeNull()
    // The glyph still fills the row's existing 3.5 leading slot exactly.
    expect(container.querySelector('span[class~="size-3.5"]')).not.toBeNull()
  })

  it('parks the copy glyph against the end of the path, not the end of the row', () => {
    render(<CodingStatusRow repoPath="/Users/someone/www/repo" />)

    const path = screen.getByText('repo')

    // The path sizes to its content and the glyph is its immediate sibling, so
    // the pair reads as one unit. `flex-1` belongs to the wrapper (which holds
    // the row's slack open) — on the label it stretched the text and pushed the
    // glyph out to the kebab.
    expect(path.classList.contains('flex-1')).toBe(false)
    expect(path.parentElement?.classList.contains('flex-1')).toBe(true)
    expect(path.nextElementSibling?.tagName).toBe('BUTTON')
  })

  it('copies the absolute cwd inline — checkmark feedback, no toast', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    clearNotifications()

    render(<CodingStatusRow repoPath="/Users/someone/www/repo" />)

    // Painted tildified, copied raw.
    expect(screen.getByText('repo')).toBeTruthy()

    const copy = screen.getByRole('button', { name: 'Copy Path' })

    fireEvent.click(copy)

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('/Users/someone/www/repo'))
    // Confirmation is the button turning into a checkmark, not a notification.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy())
    expect($notifications.get()).toHaveLength(0)
  })
})
