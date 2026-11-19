/**
 * v0.0.9 G design verdict (F1a, EconomyOS): GF-2, step 3's "Sign in" primary sat at the far right edge of the row,
 * cut off from its step text, while the other steps' actions sit inline under their text. A step's main action now
 * lives in the step body, under its text, like every other step action. GF-3, "Ask the agent / Add notes" repeated
 * in every step: it shows on the active step only, and a step with saved notes keeps them visible.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Step, type StepKit } from './inft-setup-step'

const kit = (notes: Record<string, { text: string }> = {}): StepKit =>
  ({
    notes: { notes, error: null, masked: false, save: async () => undefined } as unknown,
    resume: () => undefined
  }) as StepKit

afterEach(cleanup)

describe('an EconomyOS wizard step', () => {
  it("puts the step's main action under its text, inside the step body", () => {
    render(
      <Step control={<button type="button">Sign in</button>} done={false} index={3} kit={kit()} notesKey="auth" onAskHermes={() => undefined} title="Sign in to your Virtuals account" />
    )

    const action = screen.getByRole('button', { name: 'Sign in' })

    expect(action.closest('.iws__step-body')).not.toBeNull()
  })

  it('shows "Ask the agent / Add notes" on the active step only', () => {
    const { rerender } = render(
      <Step active done={false} index={2} kit={kit()} notesKey="profile" onAskHermes={() => undefined} title="Give this iNFT its own agent profile" />
    )

    expect(screen.queryByRole('button', { name: /ask the agent/i })).not.toBeNull()
    expect(screen.queryByRole('button', { name: /add notes/i })).not.toBeNull()

    rerender(
      <Step active={false} done={false} index={3} kit={kit()} notesKey="auth" onAskHermes={() => undefined} title="Sign in to your Virtuals account" />
    )

    expect(screen.queryByRole('button', { name: /ask the agent/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /add notes/i })).toBeNull()
  })

  it('keeps saved notes visible on a step that is not the active one', () => {
    render(
      <Step active={false} done index={1} kit={kit({ cli: { text: 'use the work wallet' } })} notesKey="cli" onAskHermes={() => undefined} title="The Virtuals connector" />
    )

    expect(screen.getByText(/use the work wallet/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /ask the agent/i })).toBeNull()
  })

  it('the chips are set in body tracking, not a heavier tracked type', () => {
    const css = readFileSync(resolve(__dirname, 'inft-setup.css'), 'utf8')
    const ask = /\.iws__ask\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''

    expect(ask).not.toMatch(/letter-spacing:\s*0\.\d+em/)
  })

  // Design delta GF-9: the step's text hung at the numeral column while its actions sat in the title column.
  it("the step's text and its actions share the title column", () => {
    render(
      <Step done={false} hint="The sign-in opens in your browser." index={3} kit={kit()} notesKey="auth" onAskHermes={() => undefined} title="Sign in" />
    )

    expect(screen.getByText('The sign-in opens in your browser.').closest('.iws__step-hint')).not.toBeNull()

    const css = readFileSync(resolve(__dirname, 'inft-setup.css'), 'utf8')
    const indent = (selector: string) => new RegExp(`\\${selector}\\s*\\{[^}]*padding-(?:left|inline-start):\\s*([^;]+);`).exec(css)?.[1]

    expect(indent('.iws__step-hint')).toBe('var(--iws-step-indent)')
    expect(indent('.iws__step-body')).toBe('var(--iws-step-indent)')
  })
})
