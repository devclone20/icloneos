import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConfirmHost } from '@/components/confirm-host'
import { readCredentialAudit } from '@/lib/credential-audit'
import { $confirmRequest } from '@/store/confirm'
import type { CustomEndpoint } from '@/types/hermes'

const getCustomEndpoints = vi.fn()
const deleteCustomEndpoint = vi.fn()
const notify = vi.fn()
const notifyError = vi.fn()

vi.mock('@/hermes', () => ({
  activateCustomEndpoint: vi.fn(),
  deleteCustomEndpoint: (id: string) => deleteCustomEndpoint(id),
  discoverCustomEndpointModels: vi.fn(),
  getCustomEndpoints: () => getCustomEndpoints(),
  saveCustomEndpoint: vi.fn(),
  validateCustomEndpoint: vi.fn()
}))

vi.mock('@/store/notifications', () => ({
  notify: (input: unknown) => notify(input),
  notifyError: (err: unknown, title: string) => notifyError(err, title)
}))

const lab: CustomEndpoint = {
  base_url: 'http://127.0.0.1:8081/v1',
  discover_models: false,
  has_api_key: true,
  id: 'lab',
  model: 'gpt-5.4',
  models: ['gpt-5.4'],
  name: 'Lab Proxy',
  source: 'custom_providers'
}

beforeEach(() => {
  window.localStorage.clear()
  getCustomEndpoints.mockResolvedValue({ current: { base_url: '', model: '', provider: '' }, endpoints: [lab] })
  deleteCustomEndpoint.mockResolvedValue({ endpoints: [], ok: true })
})

afterEach(() => {
  cleanup()
  $confirmRequest.set(null)
  vi.clearAllMocks()
})

async function renderEndpoints() {
  const { CustomEndpointsSettings } = await import('./custom-endpoints-settings')

  await act(async () => {
    render(
      <>
        <CustomEndpointsSettings />
        <ConfirmHost />
      </>
    )
  })
}

describe('CustomEndpointsSettings removal', () => {
  it('confirms, deletes, notifies and writes one audit line (names only)', async () => {
    await renderEndpoints()

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Lab Proxy' }))
    const dialog = await screen.findByRole('dialog', { name: 'Remove Lab Proxy?' })
    expect(dialog.textContent).toContain('Deletes the endpoint, its key and any model pinned to it.')
    expect(deleteCustomEndpoint).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    })

    await waitFor(() => expect(deleteCustomEndpoint).toHaveBeenCalledWith('lab'))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove Lab Proxy' })).toBeNull())
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success', title: 'Credential removed' }))

    const audit = readCredentialAudit()
    expect(audit[0]).toMatchObject({
      id: 'lab',
      kind: 'custom_endpoint',
      result: 'removed',
      surface: 'custom_endpoints'
    })
    expect(JSON.stringify(audit)).not.toContain('127.0.0.1')
  })

  it('keeps the endpoint when the confirm is dismissed', async () => {
    await renderEndpoints()

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Lab Proxy' }))
    const dialog = await screen.findByRole('dialog')

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    })

    expect(deleteCustomEndpoint).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Remove Lab Proxy' })).toBeTruthy()
  })

  it('treats a 404 as already removed and reloads the list', async () => {
    deleteCustomEndpoint.mockRejectedValue(new Error('404: endpoint not found'))
    await renderEndpoints()

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Lab Proxy' }))
    const dialog = await screen.findByRole('dialog')
    getCustomEndpoints.mockResolvedValue({ current: { base_url: '', model: '', provider: '' }, endpoints: [] })

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    })

    await waitFor(() => expect(readCredentialAudit()[0]?.result).toBe('already_removed'))
    expect(notifyError).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove Lab Proxy' })).toBeNull())
  })
})

describe('CustomEndpointsSettings anatomy', () => {
  it('lists each server and every form field on THE settings row, with the control at the trailing edge', async () => {
    await renderEndpoints()
    const title = await screen.findByText('Where the server answers')
    const row = title.closest('[data-setting-row]') as HTMLElement
    expect(row).toBeTruthy()
    expect(within(row).getByText(/OpenAI-compatible servers usually end in \/v1/)).toBeTruthy()
    expect(within(row).getByRole('textbox', { name: 'Where the server answers' })).toBeTruthy()
    const toggle = screen.getByRole('switch', { name: 'Start new chats on this server' })
    expect(toggle.closest('[data-setting-row]')).toBeTruthy()
    const remove = await screen.findByRole('button', { name: 'Remove Lab Proxy' })
    expect(remove.closest('[data-setting-row]')?.textContent).toContain('Lab Proxy')
  })
})

describe('Settings › Providers › Model servers words', () => {
  it.each(['ja', 'zh', 'zh-hant', 'ar', 'pt-PT'] as const)(
    '%s has every word and none of them in English',
    async locale => {
      const { setRuntimeI18nLocale } = await import('@/i18n')
      const { customEndpointsCopyNow } = await import('./custom-endpoints-copy')
      setRuntimeI18nLocale('en')
      const english = customEndpointsCopyNow()
      setRuntimeI18nLocale(locale)
      const local = customEndpointsCopyNow()
      setRuntimeI18nLocale('en')
      const examples = new Set(Object.values(english.placeholders).filter(value => /[/.:-]|\d/.test(value)))

      for (const [key, value] of Object.entries(english)) {
        const translated = (local as Record<string, unknown>)[key]

        if (typeof value === 'string') {
          expect(translated, key).not.toBe(value)
        } else if (typeof value === 'function') {
          expect((translated as (n: number) => string)(3), key).not.toBe((value as (n: number) => string)(3))
        }
      }

      for (const [key, value] of Object.entries(english.placeholders)) {
        if (!examples.has(value)) {
          expect(local.placeholders[key as keyof typeof english.placeholders], key).not.toBe(value)
        }
      }
    }
  )
})
