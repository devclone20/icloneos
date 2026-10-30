import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConfigField } from './config-field'

afterEach(() => cleanup())

describe('ConfigField accessible names (U1-p2b-03 / U4-p2b-07)', () => {
  it('names a boolean switch by its row title and describes it by its hint', () => {
    render(
      <ConfigField
        onChange={vi.fn()}
        schema={{ description: 'Whether the agent may browse.', type: 'boolean' }}
        schemaKey="browser.enabled"
        value
      />
    )

    const toggle = screen.getByRole('switch')
    const titleId = toggle.getAttribute('aria-labelledby')
    const hintId = toggle.getAttribute('aria-describedby')

    expect(titleId).toBeTruthy()
    expect(hintId).toBeTruthy()
    expect(window.document.getElementById(titleId as string)?.textContent).toBe('Enabled')
    expect(window.document.getElementById(hintId as string)?.textContent).toBe('Whether the agent may browse.')
    expect(screen.getByRole('switch', { name: 'Enabled' })).toBe(toggle)
  })

  it('names a text field by its row title', () => {
    render(
      <ConfigField onChange={vi.fn()} schema={{ type: 'string' }} schemaKey="browser.some_endpoint" value="https://x" />
    )

    expect(screen.getByRole('textbox', { name: 'Some Endpoint' })).toBeTruthy()
  })
})
