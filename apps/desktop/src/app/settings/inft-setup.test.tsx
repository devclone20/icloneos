import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'

const noop = vi.fn()

vi.mock('./inft-setup-cli', () => ({
  useAcpCliStep: () => ({
    cli: { ok: false },
    cliState: { running: false },
    onRepairResult: noop,
    skills: null,
    skillsBusy: false,
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

import { f1bAcpBundled } from '@/i18n/en/v009-f1b'
import { slugForInft } from '@/iclone-shared/inft-slug'

import { $acpConfigMap } from '../home/acp-setup'
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

    const titles = [copy.picker.title, f1bAcpBundled.stepTitle, copy.auth.title, copy.card.title, copy.live.title]

    for (const title of titles) {
      expect(screen.getByText(title)).toBeTruthy()
    }

    const cli = rows.find(row => row.id === 'iws-step-cli')!

    // v0.0.9 (F1-B): the CLI ships inside the app — no Install (nor Check for updates) in step 1, only its status line.
    // Literal words (the retired copy keys are gone from inft-setup-wizard-copy.ts, W1b).
    expect(within(cli).queryByRole('button', { name: 'Install now' })).toBeNull()
    expect(within(cli).queryByRole('button', { name: 'Check for updates' })).toBeNull()
    expect(within(cli).queryByRole('button', { name: 'Update now' })).toBeNull()
    expect(within(cli).queryByText('Install the Virtuals connector')).toBeNull()
    expect(within(cli).getByText(f1bAcpBundled.stepHint)).toBeTruthy()

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

// Q tests-perf 4: Register identity signs an on-chain transaction; main refuses it unless the click landed on the control
// the preload's owner-click lock recognises. The selector is read from preload.ts itself, so dropping the attribute in
// the UI (or renaming it on one side) turns this red instead of refusing every Register in the real app.
describe('Register identity carries the owner-click marker the preload looks for', () => {
  it('the rendered Register button matches the ACP register lock selector', () => {
    const preload = readFileSync(resolve(__dirname, '../../../electron/preload.ts'), 'utf8')
    const selector = preload.match(/closest\('(\[data-acp-register-confirm\])'\)/)?.[1]

    expect(selector).toBe('[data-acp-register-confirm]')

    const id = 'base:0xabc:6'

    $privySession.set({ status: 'in' } as never)
    $inftRoster.set([{ id, name: 'iclone', chain: 'base', bootstrap: { version: '1' } } as never])
    $activeInft.set({ id } as never)
    $acpConfigMap.set({ [slugForInft(id)]: { authenticated: true, agentId: 'agent-1', cli: true, signerReady: true } } as never)

    render(
      <MemoryRouter>
        <InftSetupPane navigate={noop} onClose={noop} />
      </MemoryRouter>
    )

    const register = screen.getByRole('button', { name: copy.signer.register })

    expect(register.matches(selector!)).toBe(true)
    $acpConfigMap.set({})
  })
})
