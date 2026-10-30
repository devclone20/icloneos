import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hermes = vi.hoisted(() => ({
  deleteSession: vi.fn(),
  getHermesConfigRecord: vi.fn(),
  listAllProfileSessions: vi.fn(),
  saveHermesConfig: vi.fn(),
  setSessionArchived: vi.fn()
}))

vi.mock('@/hermes', async importOriginal => ({ ...(await importOriginal<object>()), ...hermes }))

import { SessionsSettings } from './sessions-settings'

const getDefaultProjectDir = vi.fn()

function mount() {
  return render(
    <MemoryRouter>
      <SessionsSettings />
    </MemoryRouter>
  )
}

beforeEach(() => {
  hermes.listAllProfileSessions.mockResolvedValue({ sessions: [] })
  hermes.getHermesConfigRecord.mockResolvedValue({ sessions: { auto_archive: true, auto_archive_days: 5 } })
  getDefaultProjectDir.mockResolvedValue({ dir: null })
  Object.assign(window, {
    hermesDesktop: {
      settings: {
        getDefaultProjectDir,
        pickDefaultProjectDir: vi.fn(),
        setDefaultProjectDir: vi.fn()
      }
    }
  })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'hermesDesktop')
})

const rowOf = (title: string) => screen.getByText(title).closest('[data-setting-row]') as HTMLElement

describe('Sessions pane anatomy', () => {
  it('the folder row says what it decides; the hint explains the unset state; Choose is its control', async () => {
    await act(async () => void mount())
    const row = rowOf('The folder new chats start in')
    expect(row.textContent).toContain('Not chosen yet, so new chats start in your home folder.')
    expect(row.querySelector('button')?.textContent).toBe('Choose')
  })

  it('a chosen folder becomes the hint, never the title', async () => {
    getDefaultProjectDir.mockResolvedValue({ dir: '/work/projects' })
    await act(async () => void mount())
    const row = rowOf('The folder new chats start in')
    expect(row.textContent).toContain('/work/projects')
    expect(screen.getByRole('button', { name: 'Change' })).toBeTruthy()
  })

  it('auto-archive is a switch row and its days are a field row', async () => {
    await act(async () => void mount())
    expect(rowOf('Archive chats you have not opened in a while').querySelector('[role="switch"]')).toBeTruthy()
    const days = screen.getByRole('spinbutton', { name: 'How many quiet days before a chat is archived' })
    expect((days as HTMLInputElement).value).toBe('5')
    expect(days.closest('[data-setting-row]')).toBeTruthy()
  })

  it('the archive heading is a sentence and no loose paragraph or OS key glyph is left', async () => {
    const { container } = await act(async () => mount())
    expect(screen.getByText('Chats you archived')).toBeTruthy()
    expect(container.querySelectorAll('p').length).toBe(0)
    expect(container.textContent).not.toMatch(/⌘|Ctrl/)
  })
})
