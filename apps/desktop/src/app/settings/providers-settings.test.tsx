import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConfirmHost } from '@/components/confirm-host'
import { $confirmRequest } from '@/store/confirm'
import type { EnvVarInfo, OAuthProvider } from '@/types/hermes'

const listOAuthProviders = vi.fn()
const disconnectOAuthProvider = vi.fn()
const getEnvVars = vi.fn()
const startManualProviderOAuth = vi.fn()
const startManualLocalEndpoint = vi.fn()
const onboarding = atom({ manual: false })

vi.mock('@/hermes', () => ({
  disconnectOAuthProvider: (providerId: string) => disconnectOAuthProvider(providerId),
  getEnvVars: () => getEnvVars(),
  listOAuthProviders: () => listOAuthProviders()
}))

vi.mock('@/store/onboarding', () => ({
  $desktopOnboarding: onboarding,
  startManualProviderOAuth: (providerId: string) => startManualProviderOAuth(providerId),
  startManualLocalEndpoint: (reason: null | string) => startManualLocalEndpoint(reason)
}))

function provider(id: string, loggedIn: boolean, patch: Partial<OAuthProvider> = {}): OAuthProvider {
  return {
    cli_command: `hermes auth add ${id}`,
    disconnectable: true,
    docs_url: '',
    flow: 'device_code',
    id,
    name: id === 'nous' ? 'Nous Portal' : 'MiniMax',
    status: {
      logged_in: loggedIn
    },
    ...patch
  }
}

// One `/api/env` row (an EnvVarInfo) for the API-keys view. Mirrors the
// `provider()` factory above: a valid base + per-test overrides, typed against
// the real response shape so it can't drift from EnvVarInfo.
function keyVar(patch: Partial<EnvVarInfo> = {}): EnvVarInfo {
  return {
    advanced: false,
    category: 'provider',
    description: '',
    is_password: true,
    is_set: false,
    provider: '',
    provider_label: '',
    redacted_value: null,
    tools: [],
    url: '',
    ...patch
  }
}

beforeEach(() => {
  onboarding.set({ manual: false })
  getEnvVars.mockResolvedValue({})
  disconnectOAuthProvider.mockResolvedValue({ ok: true, provider: 'nous' })
  listOAuthProviders.mockResolvedValue({
    providers: [provider('nous', true), provider('minimax-oauth', false)]
  })
})

afterEach(() => {
  cleanup()
  $confirmRequest.set(null)
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

// Removal goes through confirm() from @/store/confirm, so the host has to be
// mounted for the prompt to render — same as in the real app shell.
async function renderProvidersSettings() {
  const { ProvidersSettings } = await import('./providers-settings')
  let result: ReturnType<typeof render>
  await act(async () => {
    result = render(
      <>
        <ProvidersSettings onClose={vi.fn()} onViewChange={vi.fn()} view="accounts" />
        <ConfirmHost />
      </>
    )
  })

  return result!
}

describe('ProvidersSettings', () => {
  it('disconnects a connected provider account and refreshes the accounts list', async () => {
    await renderProvidersSettings()

    const remove = await screen.findByRole('button', { name: 'Remove Nous Portal' })
    await act(async () => {
      fireEvent.click(remove)
    })

    // Removal is confirmed first with the uniform copy — nothing has been disconnected yet.
    const dialog = await screen.findByRole('dialog', { name: 'Remove Nous Portal?' })
    expect(disconnectOAuthProvider).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    })

    await waitFor(() => expect(disconnectOAuthProvider).toHaveBeenCalledWith('nous'))
    expect(listOAuthProviders).toHaveBeenCalledTimes(2)
  })

  it('leaves the account connected when the removal prompt is dismissed', async () => {
    await renderProvidersSettings()

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Remove Nous Portal' }))
    })

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    })

    expect(disconnectOAuthProvider).not.toHaveBeenCalled()
  })

  it('opens the Anthropic key row from the "Anthropic API Key" card instead of a browser sign-in', async () => {
    const onViewChange = vi.fn()
    listOAuthProviders.mockResolvedValue({
      providers: [provider('anthropic', true, { flow: 'pkce', name: 'Anthropic API Key' })]
    })
    const { ProvidersSettings } = await import('./providers-settings')
    await act(async () => {
      render(<ProvidersSettings onClose={vi.fn()} onViewChange={onViewChange} view="accounts" />)
    })

    // words from the five-locale catalogue, never onboarding's English-only pitch (critic r3 D2)
    expect(await screen.findByText('Paste a key from the Anthropic Console. No browser sign-in needed.')).toBeTruthy()
    expect(screen.queryByText(/sk-ant-/)).toBeNull()
    expect(screen.queryByText('Anthropic API Key')).toBeNull()
    expect(screen.queryByText('Opens your browser to sign in, then continues here')).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByText('Use your own Anthropic key'))
    })

    expect(onViewChange).toHaveBeenCalledWith('keys')
    expect(startManualProviderOAuth).not.toHaveBeenCalled()
  })

  it('routes an unconnected "Anthropic API Key" card to the key form too', async () => {
    const onViewChange = vi.fn()
    listOAuthProviders.mockResolvedValue({
      providers: [provider('anthropic', false, { flow: 'pkce', name: 'Anthropic API Key' })]
    })
    const { ProvidersSettings } = await import('./providers-settings')
    await act(async () => {
      render(<ProvidersSettings onClose={vi.fn()} onViewChange={onViewChange} view="accounts" />)
    })

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: /other providers/i }))
    })
    await act(async () => {
      fireEvent.click(screen.getByText('Use your own Anthropic key'))
    })

    expect(onViewChange).toHaveBeenCalledWith('keys')
    expect(startManualProviderOAuth).not.toHaveBeenCalled()
  })

  it('keeps provider selection separate from account removal', async () => {
    await renderProvidersSettings()

    await act(async () => {
      fireEvent.click(await screen.findByText('Nous Portal'))
    })

    expect(startManualProviderOAuth).toHaveBeenCalledWith('nous')
    expect(disconnectOAuthProvider).not.toHaveBeenCalled()
  })

  it('offers "How to remove…" with the runtime hint for externally managed providers', async () => {
    listOAuthProviders.mockResolvedValue({
      providers: [
        provider('qwen-oauth', true, {
          cli_command: 'hermes auth add qwen-oauth',
          disconnect_hint: "Use `hermes auth add qwen-oauth` or that provider's CLI to remove it.",
          disconnectable: false,
          flow: 'external',
          name: 'Qwen (via Qwen CLI)'
        })
      ]
    })

    await renderProvidersSettings()

    expect(await screen.findByText('Qwen Code')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Remove Qwen Code' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'How to remove… Qwen Code' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/that provider's CLI to remove it/)).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: /copy/i })).toBeNull()
  })

  it('opens only an http(s) docs_url from "How to remove…"', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    listOAuthProviders.mockResolvedValue({
      providers: [
        provider('qwen-oauth', true, {
          disconnectable: false,
          docs_url: 'javascript:alert(1)',
          flow: 'external',
          name: 'Qwen (via Qwen CLI)'
        })
      ]
    })

    await renderProvidersSettings()
    fireEvent.click(await screen.findByRole('button', { name: 'How to remove… Qwen Code' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByRole('button', { name: 'Open provider site' })).toBeNull()

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Got it' }))
    })

    expect(open).not.toHaveBeenCalled()
    open.mockRestore()
  })

  it('labels the connected-account removal control with visible text', async () => {
    listOAuthProviders.mockResolvedValue({ providers: [provider('nous', true)] })

    await renderProvidersSettings()

    const remove = await screen.findByTestId('account-remove')
    expect(remove.textContent).toContain('Remove')
  })

  it('every provider you can connect is THE settings row with Connect at the trailing edge', async () => {
    listOAuthProviders.mockResolvedValue({
      providers: [provider('nous', false, { flow: 'device_code', name: 'Nous Portal' })]
    })
    const { ProvidersSettings } = await import('./providers-settings')
    await act(async () => {
      render(<ProvidersSettings onClose={vi.fn()} onViewChange={vi.fn()} view="accounts" />)
    })

    const connect = await screen.findByRole('button', { name: 'Connect Nous Portal' })
    const row = connect.closest('[data-setting-row]') as HTMLElement
    expect(row.firstElementChild?.lastElementChild?.contains(connect)).toBe(true)
    expect(row.textContent).toContain('One subscription for more than 300 leading models.')
    // Featured, Fireworks AI and OpenRouter: every choice is a row, none hand-rolled
    const choices = window.document.querySelectorAll('[data-provider-connect]')
    expect(choices.length).toBeGreaterThanOrEqual(2)

    for (const button of choices) {
      expect(button.closest('[data-setting-row]')).toBeTruthy()
    }

    await act(async () => {
      fireEvent.click(connect)
    })
    expect(startManualProviderOAuth).toHaveBeenCalledWith('nous')
  })

  it('a provider API key is THE settings row; its extra fields open as rows of their own', async () => {
    getEnvVars.mockResolvedValue({
      WIDGETAI_API_KEY: keyVar({ description: 'Widget models.', provider: 'widgetai', provider_label: 'WidgetAI' }),
      WIDGETAI_BASE_URL: { ...keyVar({ provider: 'widgetai', provider_label: 'WidgetAI' }), is_password: false }
    })
    listOAuthProviders.mockResolvedValue({ providers: [] })
    const { ProvidersSettings } = await import('./providers-settings')
    await act(async () => {
      render(<ProvidersSettings onClose={vi.fn()} onViewChange={vi.fn()} view="keys" />)
    })

    const title = await screen.findByText('WidgetAI')
    const row = title.closest('[data-setting-row]') as HTMLElement
    // a provider the catalogue has no words for shows no hint, never the backend's English description
    expect(row.textContent).not.toContain('Widget models.')
    expect(row.querySelector('[data-credential-key="WIDGETAI_API_KEY"] input')).toBeTruthy()
    expect(screen.queryByText('Use a different server address')).toBeNull()

    const loose = () =>
      [...window.document.querySelectorAll('[data-provider-key-group] button')].filter(
        button => !button.closest('[data-setting-row]')
      )

    // the disclosure lives inside the row: 0 controls beside it
    expect(loose()).toHaveLength(0)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'More settings (1)' }))
    })
    expect(screen.getByText('Use a different server address').closest('[data-setting-row]')).toBeTruthy()
    expect(loose()).toHaveLength(0)
    // and it folds back
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Fewer settings' }))
    })
    expect(screen.queryByText('Use a different server address')).toBeNull()
  })

  it('renders a Keys card for a backend-tagged provider with no PROVIDER_GROUPS prefix', async () => {
    // A provider the backend catalog tags (provider/provider_label) but that has
    // no desktop PROVIDER_GROUPS prefix row must still render its own card —
    // this is the GUI/CLI drift fix: membership comes from the backend, not
    // from the hand-maintained prefix list.
    getEnvVars.mockResolvedValue({
      WIDGETAI_API_KEY: keyVar({
        provider: 'widgetai',
        provider_label: 'WidgetAI',
        url: 'https://widgetai.example/keys'
      })
    })
    listOAuthProviders.mockResolvedValue({ providers: [] })

    const { ProvidersSettings } = await import('./providers-settings')
    await act(async () => {
      render(<ProvidersSettings onClose={vi.fn()} onViewChange={vi.fn()} view="keys" />)
    })

    expect(await screen.findByText('WidgetAI')).toBeTruthy()
  })

  it('orders API-key providers by priority then name, and filters them via search', async () => {
    // These three providers have no curated PROVIDER_GROUPS priority, so they
    // share the default priority and fall back to alphabetical among themselves
    // (Acme, Middle, Zebra) — exercising the name tiebreak of the priority sort.
    getEnvVars.mockResolvedValue({
      ZEBRA_API_KEY: keyVar({ provider: 'zebra', provider_label: 'Zebra' }),
      ACME_API_KEY: keyVar({ provider: 'acme', provider_label: 'Acme' }),
      MIDDLE_API_KEY: keyVar({ provider: 'middle', provider_label: 'Middle' })
    })
    listOAuthProviders.mockResolvedValue({ providers: [] })

    const { ProvidersSettings } = await import('./providers-settings')
    render(<ProvidersSettings onClose={vi.fn()} onViewChange={vi.fn()} view="keys" />)

    // Equal priority → alphabetical tiebreak: Acme, Middle, Zebra.
    await screen.findByText('Acme')
    const labels = screen.getAllByText(/Acme|Middle|Zebra/).map(el => el.textContent)
    expect(labels).toEqual(['Acme', 'Middle', 'Zebra'])

    // Typing narrows the list to matching providers only.
    const search = screen.getByPlaceholderText('Search providers…')
    await act(async () => {
      fireEvent.change(search, { target: { value: 'mid' } })
    })

    await waitFor(() => expect(screen.queryByText('Acme')).toBeNull())
    expect(screen.getByText('Middle')).toBeTruthy()
    expect(screen.queryByText('Zebra')).toBeNull()

    // A non-matching query shows the empty-state copy.
    await act(async () => {
      fireEvent.change(search, { target: { value: 'nonesuch-xyz' } })
    })
    expect(await screen.findByText('No providers match your search.')).toBeTruthy()
  })

  it('offers an own-model-server row in the API-keys tab that opens the custom-endpoint flow', async () => {
    // Regression: the composer pill and the providers "have an API key"
    // affordance both dead-end on the env-var-driven key catalog, which never
    // lists a custom endpoint — so without this row there is no reachable
    // Desktop GUI path to add one. See issue #62817.
    getEnvVars.mockResolvedValue({})
    listOAuthProviders.mockResolvedValue({ providers: [] })

    const { ProvidersSettings } = await import('./providers-settings')
    render(<ProvidersSettings onClose={vi.fn()} onViewChange={vi.fn()} view="keys" />)

    // One row on THE settings row: the sentence, the hint below, the button at the trailing edge.
    const title = await screen.findByText('Use a model server of your own')
    const row = title.closest('[data-setting-row]')
    expect(row).toBeTruthy()
    expect(screen.getByText(/OpenAI-compatible server works/)).toBeTruthy()

    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Set up' }))

    await waitFor(() => expect(startManualLocalEndpoint).toHaveBeenCalledWith(null))
  })
})
