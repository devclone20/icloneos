import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'

const noop = vi.fn()

vi.mock('./inft-setup-cli', () => ({
  useAcpCliStep: () => ({
    cli: { ok: false },
    cliInstall: { running: false },
    cliUpdate: null,
    skills: null,
    skillsBusy: false,
    installCli: noop,
    checkCliUpdate: noop,
    teachAgent: noop
  })
}))
vi.mock('./inft-setup-runner', () => ({
  useStepRunner: () => ({ steps: {}, exec: noop, refresh: noop, resumePoll: noop, setStep: noop })
}))
vi.mock('./inft-setup-notes', () => ({
  useStepNotes: () => ({ notes: {}, masked: false, error: null, saveNote: noop, deleteNote: noop })
}))
vi.mock('./inft-setup-agent', () => ({
  useAgentSteps: () => ({
    agentName: '',
    setAgentName: noop,
    startSignIn: noop,
    createAgent: noop,
    armSigner: noop,
    provisionEmail: noop,
    registerErc8004: noop
  })
}))
vi.mock('./inft-setup-card', () => ({
  useCardSteps: () => ({
    signup: { phase: 'idle' },
    gate: { gate: 'open', reason: '' },
    confirmArmed: false,
    cooldownHeld: false
  })
}))
vi.mock('./inft-setup-profile', () => ({
  useProfileStep: () => ({ profileSlug: 'iclone-6', profileExists: false })
}))

import { $inftRoster, $privySession } from '../home/privy-session'
import { $activeInft } from '../home/stage-store'

import { InftSetupPane } from './inft-setup'
import { INFT_WIZARD_COPY } from './inft-setup-wizard-copy'

const copy = INFT_WIZARD_COPY.en

describe('InftSetupPane — every step on the Settings row', () => {
  it('signed out: the gate is a row with its sentence and the connect button at the trailing edge', () => {
    $privySession.set({ status: 'out' } as never)

    const { container } = render(
      <MemoryRouter>
        <InftSetupPane navigate={noop} onClose={noop} />
      </MemoryRouter>
    )

    const rows = container.querySelectorAll('[data-setting-row]')

    expect(rows.length).toBe(2)
    expect(screen.getByText(copy.gate.signedOut)).toBeTruthy()
    expect(within(rows[1] as HTMLElement).getByRole('button', { name: copy.gate.connect })).toBeTruthy()
  })

  it('signed in with an iNFT: the picker and all eleven steps are rows, with the step sentence as the title', () => {
    $privySession.set({ status: 'in' } as never)
    $inftRoster.set([{ id: 'base:0xabc:6', name: 'iclone', chain: 'base', bootstrap: { version: '1' } } as never])

    const { container } = render(
      <MemoryRouter>
        <InftSetupPane navigate={noop} onClose={noop} />
      </MemoryRouter>
    )

    const rows = [...container.querySelectorAll<HTMLElement>('[data-setting-row]')]

    expect(rows.length).toBe(12)

    for (const title of [copy.picker.title, copy.cli.title, copy.auth.title, copy.card.title, copy.live.title]) {
      expect(screen.getByText(title)).toBeTruthy()
    }

    const cli = rows.find(row => row.id === 'iws-step-cli')!

    expect(within(cli).getByRole('button', { name: copy.cli.install })).toBeTruthy()
    expect(within(cli).getByText(copy.cli.hint)).toBeTruthy()

    // Nothing interactive outside a row.
    const loose = [...container.querySelectorAll('button,input,textarea,select')].filter(
      el => !el.closest('[data-setting-row]')
    )

    expect(loose).toEqual([])
  })

  it('without an ?inft= link the chooser preselects the iNFT on stage, not the newest card', () => {
    $privySession.set({ status: 'in' } as never)
    $inftRoster.set([
      { id: 'base:0xabc:7', name: '#7 Robinhood', chain: 'base', bootstrap: { version: '1' } },
      { id: 'base:0xabc:6', name: '#6 Robinhood', chain: 'base', bootstrap: { version: '1' } }
    ] as never)
    $activeInft.set({ id: 'base:0xabc:6' } as never)

    render(
      <MemoryRouter>
        <InftSetupPane navigate={noop} onClose={noop} />
      </MemoryRouter>
    )

    const pressed = screen.getAllByRole('button', { pressed: true })

    expect(pressed.length).toBe(1)
    expect(pressed[0].textContent).toContain('#6')
    $activeInft.set(null)
  })
})
