import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { MessagingEnvVarInfo } from '@/hermes'

import { MessagingField } from './messaging-field'

const field = {
  description: 'Paste the token your bot gives you.',
  is_password: true,
  is_set: true,
  key: 'EXAMPLE_BOT_TOKEN',
  prompt: 'Bot token',
  redacted_value: '••••1234',
  url: 'https://example.com/docs'
} as unknown as MessagingEnvVarInfo

describe('MessagingField', () => {
  it('is THE settings row: label as title, help below, field and actions at the trailing edge', () => {
    const { container } = render(
      <MessagingField edits={{}} field={field} onClear={vi.fn()} onEdit={vi.fn()} saving={null} />
    )

    const row = container.querySelector('[data-setting-row]') as HTMLElement
    expect(row).toBeTruthy()
    // a field the catalogue misses: a neutral sentence, never the backend prompt or the variable name (S27.1)
    expect(row.textContent).toContain('Fill in this setting')
    expect(row.textContent).not.toContain('Bot token')
    expect(row.textContent).not.toContain('EXAMPLE_BOT_TOKEN')
    // the backend's description is English in every locale: a field the catalogue misses shows no help
    expect(row.textContent).not.toContain('Paste the token your bot gives you.')
    const input = container.querySelector('#messaging-field-EXAMPLE_BOT_TOKEN') as HTMLElement
    expect(input).toBeTruthy()
    expect(row.firstElementChild?.lastElementChild?.contains(input)).toBe(true)
  })

  it('titles a known field with its one sentence and keeps the noun as the empty field placeholder', () => {
    const known = { ...field, is_set: false, key: 'TELEGRAM_BOT_TOKEN' } as MessagingEnvVarInfo

    const { container } = render(
      <MessagingField edits={{}} field={known} onClear={vi.fn()} onEdit={vi.fn()} saving={null} />
    )

    const row = container.querySelector('[data-setting-row]') as HTMLElement
    expect(row.querySelector('label')?.textContent).toBe('Paste the token your Telegram bot gives you')
    const input = container.querySelector('#messaging-field-TELEGRAM_BOT_TOKEN') as HTMLInputElement
    expect(input.placeholder).toBe('Paste Telegram bot token')
  })
})
