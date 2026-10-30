import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MemoryProviderConfig } from '@/types/hermes'

const getMemoryProviderConfig = vi.fn()
const saveMemoryProviderConfig = vi.fn()
const deleteEnvVar = vi.fn()
const getEnvVars = vi.fn(async (_profile?: string): Promise<Record<string, unknown>> => ({}))

vi.mock('@/hermes', () => ({
  deleteEnvVar: (key: string, profile?: string) => deleteEnvVar(key, profile),
  getEnvVars: (profile?: string) => getEnvVars(profile),
  getMemoryProviderConfig: (provider: string) => getMemoryProviderConfig(provider),
  saveMemoryProviderConfig: (provider: string, values: unknown) => saveMemoryProviderConfig(provider, values)
}))

vi.mock('@/store/profile', async () => {
  const { atom } = await import('nanostores')

  return { $activeGatewayProfile: atom('default') }
})

vi.mock('@/store/notifications', () => ({
  notify: vi.fn(),
  notifyError: vi.fn()
}))

function honchoSchema(): MemoryProviderConfig {
  return {
    name: 'honcho',
    label: 'Honcho',
    docs_url: 'https://docs.honcho.dev/v3/guides/integrations/hermes',
    fields: [
      {
        key: 'apiKey',
        label: 'API key',
        kind: 'secret',
        value: '',
        description: 'Authenticate with Honcho Cloud.',
        placeholder: 'Enter Honcho API key',
        is_set: false,
        inline: true,
        group: 'Connection',
        options: []
      },
      {
        key: 'baseUrl',
        label: 'Base URL',
        kind: 'text',
        value: '',
        description: 'Self-hosted Honcho URL.',
        placeholder: 'https://… (self-hosted)',
        is_set: false,
        inline: true,
        group: 'Connection',
        options: []
      },
      {
        key: 'environment',
        label: 'Environment',
        kind: 'select',
        value: 'production',
        description: 'Honcho environment.',
        placeholder: '',
        is_set: true,
        inline: true,
        group: 'Connection',
        options: [
          { value: 'production', label: 'Production', description: '' },
          { value: 'demo', label: 'Demo', description: '' },
          { value: 'local', label: 'Local', description: '' }
        ]
      },
      {
        key: 'workspace',
        label: 'Workspace',
        kind: 'text',
        value: 'myws',
        description: 'Honcho workspace ID.',
        placeholder: 'hermes',
        is_set: true,
        inline: true,
        group: 'Connection',
        options: []
      },
      // Non-inline field: must NOT render in the compact panel and must NOT be
      // submitted when the panel saves.
      {
        key: 'writeFrequency',
        label: 'Write frequency',
        kind: 'text',
        value: 'async',
        description: '',
        placeholder: '',
        is_set: true,
        inline: false,
        group: 'Message writing',
        options: []
      }
    ]
  }
}

beforeEach(() => {
  getEnvVars.mockResolvedValue({})
  getMemoryProviderConfig.mockResolvedValue(honchoSchema())
  saveMemoryProviderConfig.mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function renderPanel(provider = 'honcho') {
  const { ProviderConfigPanel } = await import('./provider-config-panel')

  return render(<ProviderConfigPanel provider={provider} />)
}

describe('ProviderConfigPanel', () => {
  it('renders the declared inline fields generically', async () => {
    await renderPanel()

    expect(await screen.findByDisplayValue('myws')).toBeTruthy()
    expect(screen.getByPlaceholderText('https://… (self-hosted)')).toBeTruthy()
    expect(screen.getByText('Production')).toBeTruthy()
    expect(screen.getByText('Self-hosted Honcho URL.')).toBeTruthy()
  })

  it('puts each inline field on THE row: its hint under the title, its control inside the row', async () => {
    await renderPanel()

    const input = await screen.findByDisplayValue('myws')
    expect(input.closest('[data-setting-row]')).toBeTruthy()
    const hint = screen.getByText('Self-hosted Honcho URL.')
    expect(hint.closest('[data-setting-row]')?.contains(screen.getByPlaceholderText('https://… (self-hosted)'))).toBe(
      true
    )
  })

  it('hides fields that are not marked inline', async () => {
    await renderPanel()

    await screen.findByDisplayValue('myws')
    expect(screen.queryByDisplayValue('async')).toBeNull()
    expect(screen.queryByText('Write frequency')).toBeNull()
  })

  it('collapses and expands the fields', async () => {
    await renderPanel()

    expect(await screen.findByDisplayValue('myws')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Honcho settings/ }))
    expect(screen.queryByDisplayValue('myws')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Honcho settings/ }))
    expect(await screen.findByDisplayValue('myws')).toBeTruthy()
  })

  it('autosaves a text field on blur as a one-key partial save', async () => {
    await renderPanel()

    const baseUrl = await screen.findByPlaceholderText('https://… (self-hosted)')
    fireEvent.change(baseUrl, { target: { value: 'http://localhost:8000' } })
    fireEvent.blur(baseUrl)

    await waitFor(() =>
      expect(saveMemoryProviderConfig).toHaveBeenCalledWith('honcho', { baseUrl: 'http://localhost:8000' })
    )
    expect(saveMemoryProviderConfig).toHaveBeenCalledTimes(1)
  })

  it('does not save on blur when nothing changed', async () => {
    await renderPanel()

    const workspace = await screen.findByDisplayValue('myws')
    fireEvent.blur(workspace)

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).toBeNull())
    expect(saveMemoryProviderConfig).not.toHaveBeenCalled()
  })

  it('autosaves a committed secret and clears the draft', async () => {
    await renderPanel()

    const apiKey = await screen.findByPlaceholderText('Enter Honcho API key')
    fireEvent.blur(apiKey)
    expect(saveMemoryProviderConfig).not.toHaveBeenCalled()

    fireEvent.change(apiKey, { target: { value: 'hch-new-key' } })
    fireEvent.blur(apiKey)

    await waitFor(() => expect(saveMemoryProviderConfig).toHaveBeenCalledWith('honcho', { apiKey: 'hch-new-key' }))
    await waitFor(() => expect((apiKey as HTMLInputElement).value).toBe(''))
  })

  it('offers a full-config trigger when modal-only fields exist', async () => {
    await renderPanel()

    await screen.findByDisplayValue('myws')
    expect(screen.getByRole('button', { name: /Full config/ })).toBeTruthy()
  })

  it('shows an inline error with retry when the load fails, then recovers', async () => {
    getMemoryProviderConfig.mockRejectedValueOnce(new Error('Timed out connecting to Hermes backend'))

    await renderPanel()

    expect(await screen.findByText(/Timed out connecting/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByDisplayValue('myws')).toBeTruthy()
  })

  it('renders nothing for a provider with no declared config surface', async () => {
    getMemoryProviderConfig.mockResolvedValue({ name: 'builtin', label: 'builtin', docs_url: '', fields: [] })

    const { container } = await renderPanel('builtin')

    await waitFor(() => expect(getMemoryProviderConfig).toHaveBeenCalledWith('builtin'))
    expect(container.querySelector('section')).toBeNull()
  })
})

describe('ProviderConfigPanel secret removal', () => {
  // The runtime's real payload: secret fields carry no env_key.
  function withSetSecret(): MemoryProviderConfig {
    const schema = honchoSchema()
    schema.fields = schema.fields.map(field => (field.key === 'apiKey' ? { ...field, is_set: true } : field))

    return schema
  }

  async function renderPanel(provider = 'honcho') {
    const { ProviderConfigPanel } = await import('./provider-config-panel')
    const { ConfirmHost } = await import('@/components/confirm-host')
    await act(async () => {
      render(
        <>
          <ProviderConfigPanel provider={provider} />
          <ConfirmHost />
        </>
      )
    })
  }

  afterEach(async () => {
    const { $confirmRequest } = await import('@/store/confirm')
    $confirmRequest.set(null)
  })

  it('clears a set secret through DELETE /api/env after confirm, then reloads the schema', async () => {
    window.localStorage.clear()
    getMemoryProviderConfig.mockResolvedValue(withSetSecret())
    getEnvVars.mockResolvedValue({
      HONCHO_API_KEY: { category: 'tool', is_password: true, is_set: true },
      HONCHO_BASE_URL: { category: 'tool', is_password: false, is_set: true }
    })
    deleteEnvVar.mockResolvedValue({ ok: true })
    await renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Remove API key' }))
    const dialog = await screen.findByRole('dialog', { name: 'Remove API key?' })
    expect(dialog.textContent).toContain('HONCHO_API_KEY')

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    })

    await waitFor(() => expect(deleteEnvVar).toHaveBeenCalledWith('HONCHO_API_KEY', undefined))
    await waitFor(() => expect(getMemoryProviderConfig).toHaveBeenCalledTimes(2))
    expect(saveMemoryProviderConfig).not.toHaveBeenCalled()
    expect(getEnvVars).toHaveBeenCalledTimes(2)
  })

  it('says where a set secret lives when no env var holds it (e.g. honcho.json)', async () => {
    getMemoryProviderConfig.mockResolvedValue(withSetSecret())
    getEnvVars.mockResolvedValue({ HONCHO_API_KEY: { category: 'tool', is_password: true, is_set: false } })
    await renderPanel()

    expect((await screen.findByTestId('memory-secret-elsewhere')).textContent).toContain(
      "API key is stored in the provider's own config file"
    )
    expect(screen.queryByRole('button', { name: 'Remove API key' })).toBeNull()
  })

  it('still loads the schema when GET /api/env fails, and claims neither Remove nor a config-file location', async () => {
    getMemoryProviderConfig.mockResolvedValue(withSetSecret())
    getEnvVars.mockRejectedValue(new Error('500: down'))
    await renderPanel()

    expect(await screen.findByText('Honcho settings')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Remove API key' })).toBeNull()
    expect(screen.queryByTestId('memory-secret-elsewhere')).toBeNull()
    expect(screen.getByTestId('memory-secret-unchecked').textContent).toContain(
      'Could not check where API key is stored'
    )
  })

  it('removes a secret through the env var the runtime declares (byterover api_key -> BRV_API_KEY)', async () => {
    const schema = honchoSchema()
    getMemoryProviderConfig.mockResolvedValue({
      ...schema,
      fields: [{ ...schema.fields[0], is_set: true, key: 'api_key' }],
      label: 'ByteRover',
      name: 'byterover'
    })
    getEnvVars.mockResolvedValue({ BRV_API_KEY: { category: 'tool', is_password: true, is_set: true } })
    deleteEnvVar.mockResolvedValue({ ok: true })
    await renderPanel('byterover')

    fireEvent.click(await screen.findByRole('button', { name: 'Remove API key' }))
    expect(screen.queryByTestId('memory-secret-elsewhere')).toBeNull()
    const dialog = await screen.findByRole('dialog', { name: 'Remove API key?' })
    expect(dialog.textContent).toContain('BRV_API_KEY')

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    })

    await waitFor(() => expect(deleteEnvVar).toHaveBeenCalledWith('BRV_API_KEY', undefined))
  })
})
