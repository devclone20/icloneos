import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { EnvVarInfo } from '@/types/hermes'

import { KeyField, type KeyRowProps } from './credential-key-ui'

const info: EnvVarInfo = {
  advanced: false,
  category: 'provider',
  description: 'OpenAI key',
  is_password: true,
  is_set: true,
  redacted_value: 'sk-…abcd',
  tools: [],
  url: null
}

function rowProps(edits: Record<string, string> = {}): KeyRowProps {
  return {
    edits,
    onClear: vi.fn(),
    onReveal: vi.fn(),
    onSave: vi.fn(),
    revealed: {},
    saving: null,
    setEdits: vi.fn()
  }
}

describe('KeyField removal control', () => {
  it('shows the actions kebab for a set key at rest, without focusing it', () => {
    render(<KeyField info={info} rowProps={rowProps()} varKey="OPENAI_API_KEY" />)

    expect(screen.getByTestId('credential-actions')).toBeTruthy()
    expect(screen.queryByTestId('credential-remove')).toBeNull()
  })

  it('while editing shows only the inline trash (one removal control per row)', () => {
    const props = rowProps({ OPENAI_API_KEY: '' })
    render(<KeyField info={info} rowProps={props} varKey="OPENAI_API_KEY" />)

    expect(screen.queryByTestId('credential-actions')).toBeNull()
    fireEvent.click(screen.getByTestId('credential-remove'))
    expect(props.onClear).toHaveBeenCalledWith('OPENAI_API_KEY')
  })

  it('an unset key has no removal control', () => {
    render(<KeyField info={{ ...info, is_set: false }} rowProps={rowProps()} varKey="OPENAI_API_KEY" />)

    expect(screen.queryByTestId('credential-actions')).toBeNull()
    expect(screen.queryByTestId('credential-remove')).toBeNull()
  })
})

describe('KeyField inside its row (U2-p2b-06)', () => {
  it('names the key input by the row title', async () => {
    const { SettingRow } = await import('./setting-row')
    render(
      <SettingRow
        control={
          <KeyField
            info={{ ...info, is_password: false, is_set: false }}
            rowProps={rowProps()}
            varKey="OPENAI_API_KEY"
          />
        }
        title="Your OpenAI key"
      />
    )

    expect(screen.getByRole('textbox', { name: 'Your OpenAI key' })).toBeTruthy()
  })
})
