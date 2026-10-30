import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const acp = vi.hoisted(() => ({
  detachInftAcp: vi.fn(async () => ({ ok: true, removed: ['/x'], kept: [] })),
  runAcp: vi.fn(),
  inftKvGet: vi.fn(async () => ({ ok: true, value: null })),
  inftKvSet: vi.fn(async () => ({ ok: true, value: {} })),
  inftKvDelete: vi.fn(async () => ({ ok: true, value: null }))
}))

vi.mock('../home/acp-setup', async importOriginal => ({ ...(await importOriginal<object>()), ...acp }))
vi.mock('../home/inft-profile', () => ({ deleteInftProfile: vi.fn() }))

import { $acpConfigMap } from '../home/acp-setup'
import { $inftRoster } from '../home/privy-session'

import { INFT_PANE_COPY } from './inft-setup-copy'
import { confirmTokenFor, DetachAgentSection, detachLabel, virtualsChecklist } from './inft-setup-detach'

describe('Detach agent', () => {
  it('confirms only with the typed token id, then detaches once', async () => {
    const id = 'base:0x4dfb000000000000000000000000000000000000:6'

    $inftRoster.set([{ id, name: 'iclone' } as never])
    $acpConfigMap.set({ 'base-0x4dfb000000000000000000000000000000000000-6': { agentId: 'a1' } as never })
    render(<DetachAgentSection />)
    fireEvent.click(screen.getByText('Detach agent…'))

    const go = screen.getByRole('button', { name: 'Detach agent' })

    expect(go).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText('Type the token number to confirm'), { target: { value: '#7' } })
    expect(go).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText('Type the token number to confirm'), { target: { value: '#6' } })
    expect(go).toHaveProperty('disabled', false)
    fireEvent.click(go)
    await screen.findByText(/Detached ✓/)
    expect(acp.detachInftAcp).toHaveBeenCalledTimes(1)
    expect(confirmTokenFor(id)).toBe('#6')
    expect(virtualsChecklist('a1', INFT_PANE_COPY.en.detachPanel.checklist)[0].url).toBe(
      'https://app.virtuals.io/acp/agents/a1?tab=wallet&subTab=signers'
    )
  })

  it('each detach row carries the hint saying what stays and what leaves', () => {
    const id = 'base:0x4dfb000000000000000000000000000000000000:6'

    $inftRoster.set([{ id, name: 'iclone' } as never])
    $acpConfigMap.set({ 'base-0x4dfb000000000000000000000000000000000000-6': { agentId: 'a1' } as never })
    render(<DetachAgentSection />)

    const row = screen.getByText('Detach the agent from iclone #6').closest('[data-setting-row]')

    expect(row).not.toBeNull()
    expect(row?.textContent).toContain(INFT_PANE_COPY.en.detachPanel.rowHint)
  })

  it('labels a card once: no "#7 #7" when the name already is the token', () => {
    const id = 'base:0xabc:7'

    expect(detachLabel('#7', id)).toBe('#7')
    expect(detachLabel('iclone #7', id)).toBe('iclone #7')
    expect(detachLabel('iclone', id)).toBe('iclone #7')
    expect(detachLabel('  ', id)).toBe('#7')
    expect(detachLabel('#77', id)).toBe('#77 #7')
  })
})

describe('R6 r5 — the detach panel obeys the card hold', () => {
  const id = 'base:0x4dfb000000000000000000000000000000000000:8'

  const openPanel = () => {
    $inftRoster.set([{ id, name: 'iclone' } as never])
    $acpConfigMap.set({ 'base-0x4dfb000000000000000000000000000000000000-8': { agentId: 'a8' } as never })
    render(<DetachAgentSection />)
    fireEvent.click(screen.getAllByText('Detach agent…').at(-1) as HTMLElement)
  }

  it('sends no card profile reset while the persisted hold lasts', async () => {
    acp.runAcp.mockReset()
    acp.inftKvGet.mockResolvedValueOnce({
      ok: true,
      value: { phase: 'cooldown', cooldownUntil: Date.now() + 60_000, attempt: 0, polls: 0, fetches: 0 }
    } as never)
    openPanel()
    fireEvent.click(screen.getByText('Wipe the cardholder profile'))
    await screen.findByText(/holding this account/)
    expect(acp.runAcp).not.toHaveBeenCalled()
  })

  it('a 429 answer of the reset becomes the persisted hold', async () => {
    acp.runAcp.mockReset()
    acp.inftKvSet.mockClear()
    acp.runAcp.mockResolvedValue({ ok: false, code: 1, stdout: '{"error":"HTTP 429: slow down"}', stderr: '' })
    openPanel()
    fireEvent.click(screen.getByText('Wipe the cardholder profile'))
    await screen.findByText(/Could not wipe/)
    await vi.waitFor(() => expect(acp.inftKvSet).toHaveBeenCalledTimes(1))
    expect(acp.inftKvSet.mock.calls[0]).toMatchObject([id, 'card-signup', { phase: 'cooldown' }])
  })
})
