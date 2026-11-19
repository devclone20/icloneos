/**
 * v0.0.9 r4 (design r3 N9): polish on the EconomyOS setup's step 1. Red on 5470b2b185: "60 skills in 1 folders", the
 * chips lowercased the iNFT's name ("iclone aurora"), the re-check glyph hung mid-row away from the chips, a lone
 * "Licences" label floated in the step, and the column was capped at 720px so step actions missed the page's edge.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
import { $acpTools } from '@/store/acp-tools'

import { $inftRoster, $privySession } from '../home/privy-session'

import { InftSetupPane } from './inft-setup'
import { INFT_WIZARD_COPY } from './inft-setup-wizard-copy'

const copy = INFT_WIZARD_COPY.en

afterEach(() => {
  cleanup()
  $acpTools.set(null)
})

function mountSignedIn() {
  $privySession.set({ status: 'in' } as never)
  $inftRoster.set([{ id: 'base:0xabc:101', name: 'iCLONE Aurora', chain: 'Base', bootstrap: { version: '1' } } as never])

  return render(
    <MemoryRouter>
      <InftSetupPane navigate={noop} onClose={noop} />
    </MemoryRouter>
  )
}

describe('step 1 polish (design r3 N9)', () => {
  it('pluralises the skills line', () => {
    expect(copy.cli.taught(60, 1)).toBe('Your agent has learned it (60 skills in 1 folder).')
    expect(copy.cli.taught(1, 2)).toBe('Your agent has learned it (1 skill in 2 folders).')
    expect(INFT_WIZARD_COPY['pt-PT'].cli.taught(1, 1)).toBe('O seu agente já o aprendeu (1 competência em 1 pasta).')
  })

  it('the chip shows the iNFT name as written', () => {
    mountSignedIn()

    const chip = screen.getByRole('button', { pressed: true })

    expect(chip.querySelector('b')?.textContent).toBe('iCLONE Aurora')
  })

  it('the re-check sits in the "Choose the iNFT" heading', () => {
    mountSignedIn()

    const refresh = screen.getByRole('button', { name: copy.picker.refresh })
    const heading = refresh.closest('.iws__title-row')

    expect(heading?.textContent).toBe(copy.picker.title)
  })

  it('the licences are a disclosure row at the foot of step 1, not a lone label', () => {
    $acpTools.set({ state: 'installed', cliVersion: '1.0.38', packages: 42, installedAt: '2026-11-18' } as never)
    const { container } = mountSignedIn()
    const step = container.querySelector<HTMLElement>('#iws-step-cli')!
    const row = within(step).getByRole('button', { name: f1bAcpBundled.licencesHint })

    expect(row.className).toContain('iws__disclosure')
    expect(row.querySelector('svg')).not.toBeNull()
    expect(within(step).queryByRole('button', { name: f1bAcpBundled.licences })).toBeNull()
  })

  it('no 720px cap: the step actions share the page\'s right edge', () => {
    const css = readFileSync(resolve(__dirname, 'inft-setup.css'), 'utf8')
    const at = css.indexOf('.iws {')

    expect(css.slice(at, css.indexOf('}', at))).not.toMatch(/max-width/)
  })
})
