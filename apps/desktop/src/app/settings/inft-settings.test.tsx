import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const signin = vi.hoisted(() => ({ startAcpSignIn: vi.fn() }))

vi.mock('./inft-acp-signin', () => signin)
vi.mock('@/store/profile', async importOriginal => ({
  ...(await importOriginal<object>()),
  refreshProfiles: vi.fn(async () => [])
}))
vi.mock('@/api/profiles', () => ({ getProfileSoul: vi.fn(), updateProfileSoul: vi.fn() }))
vi.mock('./inft-ownership-section', () => ({ InftOwnershipSection: () => null }))
vi.mock('./inft-setup-detach', () => ({ DetachAgentSection: () => null }))

import { $inftRoster } from '../home/privy-session'

import { InftSettings } from './inft-settings'

describe('InftSettings — per-iNFT ACP sign-in', () => {
  it('offers "Sign in to Virtuals" for a buildable card and starts the flow for that card', async () => {
    const id = 'base:0x4dfb000000000000000000000000000000000000:6'
    const listeners: Array<(state: unknown) => void> = []

    signin.startAcpSignIn.mockReturnValue({
      state: { phase: 'waiting', url: 'https://app.virtuals.io/auth/x' },
      subscribe: (listener: (state: unknown) => void) => {
        listeners.push(listener)

        return () => undefined
      },
      openLink: vi.fn(),
      cancel: vi.fn(),
      finished: Promise.resolve({ phase: 'waiting' })
    })
    $inftRoster.set([
      { id, name: 'iclone', chain: 'base', collection: 'icloneOS', bootstrap: { version: '1' } } as never,
      { id: 'base:0xabc:9', name: 'plain nft', chain: 'base', collection: 'other' } as never
    ])
    render(<InftSettings />)

    const buttons = await screen.findAllByRole('button', { name: 'Sign in to Virtuals' })

    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0])
    expect(signin.startAcpSignIn).toHaveBeenCalledWith(id)
    expect(screen.getByText(/Finish signing in in your browser/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open link again' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
  })
})

describe('InftSettings — every row is THE row', () => {
  it('renders each topic as one sentence with its hint below and its control trailing', () => {
    $inftRoster.set([])
    const { container } = render(<InftSettings />)
    const rows = Array.from(container.querySelectorAll('[data-setting-row]'))

    expect(rows.length).toBeGreaterThanOrEqual(14)
    expect(container.querySelector('[class*="justify-between"]')).toBeNull()

    const motion = screen.getByText('Let the piece move and breathe').closest('[data-setting-row]')

    expect(motion?.textContent).toContain('Off freezes the figure')
    expect(motion?.querySelector('[role="switch"]')?.getAttribute('aria-label')).toBe('Let the piece move and breathe')

    const glow = screen.getByText('How bright the field behind the character is').closest('[data-setting-row]')

    expect(glow?.querySelector('input[type="range"]')).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: /How finely the piece is drawn/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reset card order' }).closest('[data-setting-row]')).toBeTruthy()
  })
})
