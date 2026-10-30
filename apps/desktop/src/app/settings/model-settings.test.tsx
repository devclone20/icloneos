import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Radix Select calls scrollIntoView on its items when the content opens; jsdom
// doesn't implement it (nor hasPointerCapture / releasePointerCapture), so stub
// them to let the dropdown open in tests.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
})

const getGlobalModelInfo = vi.fn()
const getGlobalModelOptions = vi.fn()
const getAuxiliaryModels = vi.fn()
const getMoaModels = vi.fn()
const setModelAssignment = vi.fn()
const getRecommendedDefaultModel = vi.fn()
const saveMoaModels = vi.fn()
const setEnvVar = vi.fn()
const getHermesConfigRecord = vi.fn()
const saveHermesConfig = vi.fn()
const startManualLocalEndpoint = vi.fn()
const startManualOnboarding = vi.fn()
const startManualProviderOAuth = vi.fn()
const deleteEnvVar = vi.fn()
const listOAuthProviders = vi.fn()
const getEnvVars = vi.fn()
const disconnectOAuthProvider = vi.fn()
let profileSwitchHandler: (() => void) | null = null

vi.mock('@/hermes', () => ({
  getGlobalModelInfo: (profile?: null | string) => getGlobalModelInfo(profile),
  getGlobalModelOptions: (opts?: unknown, profile?: null | string) => getGlobalModelOptions(opts, profile),
  getAuxiliaryModels: (profile?: null | string) => getAuxiliaryModels(profile),
  getApiRequestProfile: () => 'default',
  getMoaModels: (profile?: null | string) => getMoaModels(profile),
  profileScopeKey: (scope?: null | string) => (scope ?? '').trim() || 'default',
  setModelAssignment: (body: unknown) => setModelAssignment(body),
  getRecommendedDefaultModel: (slug: string) => getRecommendedDefaultModel(slug),
  saveMoaModels: (body: unknown) => saveMoaModels(body),
  setEnvVar: (key: string, value: string) => setEnvVar(key, value),
  getHermesConfigRecord: () => getHermesConfigRecord(),
  saveHermesConfig: (config: unknown) => saveHermesConfig(config),
  setApiRequestProfile: () => {},
  deleteEnvVar: (key: string, profile?: string) => deleteEnvVar(key, profile),
  listOAuthProviders: () => listOAuthProviders(),
  getEnvVars: (profile?: null | string) => getEnvVars(profile),
  disconnectOAuthProvider: (id: string) => disconnectOAuthProvider(id)
}))

vi.mock('@/store/onboarding', () => ({
  startManualLocalEndpoint: () => startManualLocalEndpoint(),
  startManualOnboarding: () => startManualOnboarding(),
  startManualProviderOAuth: (slug: string) => startManualProviderOAuth(slug)
}))

vi.mock('../hooks/use-on-profile-switch', () => ({
  useOnProfileSwitch: (handler: () => void) => {
    profileSwitchHandler = handler
  }
}))

beforeEach(() => {
  getGlobalModelInfo.mockResolvedValue({ provider: 'nous', model: 'hermes-4' })
  getGlobalModelOptions.mockResolvedValue({
    providers: [
      {
        name: 'Nous',
        slug: 'nous',
        models: ['hermes-4', 'hermes-4-mini'],
        authenticated: true,
        capabilities: { 'hermes-4': { reasoning: true, fast: true } }
      }
    ]
  })
  getAuxiliaryModels.mockResolvedValue({
    main: { provider: 'nous', model: 'hermes-4' },
    tasks: [{ task: 'vision', provider: 'auto', model: '', base_url: '' }]
  })
  getMoaModels.mockResolvedValue(null)
  setModelAssignment.mockResolvedValue({ ok: true, provider: 'nous', model: 'hermes-4', gateway_tools: [] })
  getRecommendedDefaultModel.mockResolvedValue({ provider: 'nous', model: 'hermes-4', free_tier: null })
  setEnvVar.mockResolvedValue({ ok: true })
  getHermesConfigRecord.mockResolvedValue({ agent: { reasoning_effort: 'medium', service_tier: 'normal' } })
  saveHermesConfig.mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  profileSwitchHandler = null
})

async function renderModelSettings(scopeProfile?: string) {
  const { ModelSettings } = await import('./model-settings')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(
    // The aux-task deep-link highlight reads useSearchParams, so the page
    // needs a router context in tests (the app provides HashRouter at root).
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ModelSettings scopeProfile={scopeProfile} />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

describe('ModelSettings profile scope', () => {
  // #90549: the API helpers treat `null` as "deliberately target the
  // primary/default profile". A page following the active profile must pass
  // `undefined`, or every read repaints the primary's model and the user's
  // change looks reverted.
  it('follows the active profile (undefined, never null) when unscoped', async () => {
    await renderModelSettings()

    await waitFor(() => expect(getGlobalModelInfo).toHaveBeenCalledWith(undefined))
    expect(getGlobalModelOptions).toHaveBeenCalledWith(undefined, undefined)
    expect(getAuxiliaryModels).toHaveBeenCalledWith(undefined)
    expect(getMoaModels).toHaveBeenCalledWith(undefined)
  })

  it('reads through the explicit scope override when one is set', async () => {
    await renderModelSettings('research')

    await waitFor(() => expect(getGlobalModelInfo).toHaveBeenCalledWith('research'))
    expect(getGlobalModelOptions).toHaveBeenCalledWith(undefined, 'research')
    expect(getAuxiliaryModels).toHaveBeenCalledWith('research')
    expect(getMoaModels).toHaveBeenCalledWith('research')
  })
})

describe('ModelSettings', () => {
  it('loads the current main model and lists configured providers only', async () => {
    await renderModelSettings()

    await waitFor(() => expect(getGlobalModelInfo).toHaveBeenCalled())
    await waitFor(() => expect(getGlobalModelOptions).toHaveBeenCalled())

    // Open the provider Select — only configured providers should be listed.
    const triggers = await screen.findAllByRole('combobox')
    fireEvent.click(triggers[0])

    // "Nous" shows in both the trigger and the open list.
    expect((await screen.findAllByText('Nous')).length).toBeGreaterThan(0)
    expect(screen.queryByText(/DeepSeek/)).toBeNull()
  })

  it.each(['custom', 'local', 'custom:lab'])(
    'opens local endpoint setup when %s has no inventory row',
    async provider => {
      getGlobalModelInfo.mockResolvedValueOnce({ provider, model: '' })
      getGlobalModelOptions.mockResolvedValueOnce({ providers: [] })

      await renderModelSettings()

      const providerSelect = (await screen.findAllByRole('combobox'))[0]

      expect(providerSelect.textContent).toContain(provider)
      expect(screen.queryByText(/undefined/)).toBeNull()
      expect(screen.queryByText(/signs in through your browser/)).toBeNull()

      fireEvent.click(await screen.findByRole('button', { name: 'Set up provider' }))

      expect(startManualLocalEndpoint).toHaveBeenCalledOnce()
      expect(startManualOnboarding).not.toHaveBeenCalled()
      expect(startManualProviderOAuth).not.toHaveBeenCalled()
    }
  )

  it('opens the generic provider picker for an unknown provider with no inventory row', async () => {
    getGlobalModelInfo.mockResolvedValueOnce({ provider: 'retired-provider', model: '' })
    getGlobalModelOptions.mockResolvedValueOnce({ providers: [] })

    await renderModelSettings()

    fireEvent.click(await screen.findByRole('button', { name: 'Set up provider' }))

    expect(startManualOnboarding).toHaveBeenCalledOnce()
    expect(startManualLocalEndpoint).not.toHaveBeenCalled()
    expect(startManualProviderOAuth).not.toHaveBeenCalled()
  })

  it('deep-links a known OAuth provider row into its setup flow', async () => {
    getGlobalModelInfo.mockResolvedValueOnce({ provider: 'anthropic', model: '' })
    getGlobalModelOptions.mockResolvedValueOnce({
      providers: [
        {
          name: 'Anthropic',
          slug: 'anthropic',
          models: [],
          authenticated: false,
          auth_type: 'oauth'
        }
      ]
    })

    await renderModelSettings()

    fireEvent.click(await screen.findByRole('button', { name: 'Set up Anthropic' }))

    expect(startManualProviderOAuth).toHaveBeenCalledWith('anthropic')
    expect(startManualLocalEndpoint).not.toHaveBeenCalled()
    expect(startManualOnboarding).not.toHaveBeenCalled()
  })

  it('replaces the selected provider and model when the active profile changes', async () => {
    getGlobalModelInfo
      .mockResolvedValueOnce({ provider: 'custom', model: 'local-a' })
      .mockResolvedValueOnce({ provider: 'nous', model: 'hermes-4' })
    getGlobalModelOptions
      .mockResolvedValueOnce({
        providers: [
          {
            name: 'Custom A',
            slug: 'custom',
            models: ['local-a'],
            authenticated: true
          }
        ]
      })
      .mockResolvedValueOnce({
        providers: [
          {
            name: 'Nous',
            slug: 'nous',
            models: ['hermes-4'],
            authenticated: true,
            capabilities: { 'hermes-4': { reasoning: true, fast: true } }
          }
        ]
      })

    await renderModelSettings()
    expect((await screen.findAllByRole('combobox'))[0].textContent).toContain('Custom A')

    await act(async () => {
      profileSwitchHandler?.()
    })

    await waitFor(() => expect(getGlobalModelInfo).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getAllByRole('combobox')[0].textContent).toContain('Nous'))
    expect(screen.queryByRole('button', { name: 'Set up provider' })).toBeNull()
  })

  it('preserves a user-defined provider endpoint when applying the main model', async () => {
    getGlobalModelOptions.mockResolvedValueOnce({
      providers: [
        {
          name: 'Nous',
          slug: 'nous',
          models: ['hermes-4'],
          authenticated: true
        },
        {
          name: 'Ollama',
          slug: 'local-ollama',
          models: ['qwen3:latest'],
          authenticated: true,
          is_user_defined: true,
          api_url: 'http://localhost:11434/v1'
        }
      ]
    })
    setModelAssignment.mockResolvedValueOnce({
      ok: true,
      provider: 'local-ollama',
      model: 'qwen3:latest',
      gateway_tools: []
    })

    await renderModelSettings()

    const providerSelect = (await screen.findAllByRole('combobox'))[0]
    fireEvent.click(providerSelect)
    fireEvent.click(await screen.findByRole('option', { name: 'Ollama' }))

    const modelSelect = (await screen.findAllByRole('combobox'))[1]
    fireEvent.click(modelSelect)
    fireEvent.click(await screen.findByRole('option', { name: 'qwen3:latest' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }))

    await waitFor(() =>
      expect(setModelAssignment).toHaveBeenCalledWith({
        model: 'qwen3:latest',
        provider: 'local-ollama',
        scope: 'main',
        base_url: 'http://localhost:11434/v1'
      })
    )
  })

  it('writes the profile default speed (service_tier) when the fast switch is toggled', async () => {
    await renderModelSettings()
    await waitFor(() => expect(getHermesConfigRecord).toHaveBeenCalled())

    const fastSwitch = await screen.findByRole('switch')
    fireEvent.click(fastSwitch)

    await waitFor(() =>
      expect(saveHermesConfig).toHaveBeenCalledWith(
        expect.objectContaining({ agent: expect.objectContaining({ service_tier: 'fast' }) })
      )
    )
  })

  it('hides the reasoning/speed defaults when the main model reports no capabilities', async () => {
    getGlobalModelOptions.mockResolvedValueOnce({
      providers: [
        {
          name: 'Nous',
          slug: 'nous',
          models: ['hermes-4'],
          authenticated: true,
          capabilities: { 'hermes-4': { reasoning: false, fast: false } }
        }
      ]
    })

    await renderModelSettings()
    await waitFor(() => expect(getHermesConfigRecord).toHaveBeenCalled())

    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('renders the auxiliary task rows', async () => {
    await renderModelSettings()

    expect(await screen.findByText('Which model reads images')).toBeTruthy()
    expect(screen.getAllByText(/Same as the main model/).length).toBeGreaterThan(0)
  })

  it('assigns an auxiliary task to the main model via setModelAssignment', async () => {
    await renderModelSettings()

    // One "Set to main" button per task slot; the first is Vision.
    const setToMainButtons = await screen.findAllByRole('button', { name: 'Set to main' })
    fireEvent.click(setToMainButtons[0])

    await waitFor(() =>
      expect(setModelAssignment).toHaveBeenCalledWith({
        model: 'hermes-4',
        provider: 'nous',
        scope: 'auxiliary',
        task: 'vision'
      })
    )
  })

  it('carries the user-defined endpoint when an aux slot is set to a local main model', async () => {
    getGlobalModelOptions.mockResolvedValueOnce({
      providers: [
        {
          name: 'Ollama',
          slug: 'local-ollama',
          models: ['qwen3:latest'],
          authenticated: true,
          is_user_defined: true,
          api_url: 'http://localhost:11434/v1'
        }
      ]
    })
    getGlobalModelInfo.mockResolvedValueOnce({ provider: 'local-ollama', model: 'qwen3:latest' })
    getAuxiliaryModels.mockResolvedValueOnce({
      main: { provider: 'local-ollama', model: 'qwen3:latest' },
      tasks: [{ task: 'vision', provider: 'auto', model: '', base_url: '' }]
    })

    await renderModelSettings()

    const setToMainButtons = await screen.findAllByRole('button', { name: 'Set to main' })
    fireEvent.click(setToMainButtons[0])

    await waitFor(() =>
      expect(setModelAssignment).toHaveBeenCalledWith({
        model: 'qwen3:latest',
        provider: 'local-ollama',
        scope: 'auxiliary',
        task: 'vision',
        base_url: 'http://localhost:11434/v1'
      })
    )
  })

  it('warns when a main switch leaves auxiliary tasks pinned to another provider', async () => {
    setModelAssignment.mockResolvedValueOnce({
      ok: true,
      provider: 'openrouter',
      model: 'anthropic/claude-opus-4.7',
      gateway_tools: [],
      stale_aux: [{ task: 'compression', provider: 'nous', model: 'hermes-4' }]
    })

    await renderModelSettings()
    await waitFor(() => expect(getGlobalModelInfo).toHaveBeenCalled())

    const applyButton = await screen.findByRole('button', { name: 'Apply' })
    fireEvent.click(applyButton)

    // The switch-time notice names the pinned provider and offers a reset.
    expect(await screen.findByText(/still run on/)).toBeTruthy()
    expect(screen.getByText(/still run on nous, not on your main model/)).toBeTruthy()
  })

  it('shows a persistent banner when a loaded aux slot mismatches the main provider', async () => {
    getAuxiliaryModels.mockResolvedValueOnce({
      main: { provider: 'nous', model: 'hermes-4' },
      tasks: [{ task: 'curator', provider: 'openrouter', model: 'anthropic/claude-opus-4.7', base_url: '' }]
    })

    await renderModelSettings()

    // Banner present on load, no switch required.
    expect(await screen.findByText(/still run on/)).toBeTruthy()
  })
})

describe('ModelSettings credential removal', () => {
  // The runtime's real authenticated row: no key_env, no auth_type.
  const openRouter = {
    authenticated: true,
    is_current: true,
    models: ['openai/gpt-5'],
    name: 'OpenRouter',
    slug: 'openrouter'
  }

  // The button resolves its plan (GET /api/env + OAuth catalog) before enabling.
  async function findReadyRemove() {
    const button = await screen.findByTestId('model-remove-credentials')
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))

    return button
  }

  function LocationProbe() {
    const location = useLocation()

    return <output data-testid="location">{`${location.pathname}${location.search}`}</output>
  }

  async function renderWithConfirm(scopeProfile?: string) {
    const { ModelSettings } = await import('./model-settings')
    const { ConfirmHost } = await import('@/components/confirm-host')
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    return render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <ModelSettings scopeProfile={scopeProfile} />
          <ConfirmHost />
          <LocationProbe />
        </QueryClientProvider>
      </MemoryRouter>
    )
  }

  beforeEach(async () => {
    const { $credentialRemoved } = await import('./credential-removal')
    $credentialRemoved.set({})
    getEnvVars.mockResolvedValue({
      OPENROUTER_API_KEY: { category: 'provider', is_password: true, is_set: true, provider: 'openrouter' },
      OPENROUTER_BASE_URL: { category: 'provider', is_password: false, is_set: true, provider: 'openrouter' }
    })
    getGlobalModelInfo.mockResolvedValue({ provider: 'openrouter', model: 'openai/gpt-5' })
    getAuxiliaryModels.mockResolvedValue({ main: { provider: 'openrouter', model: 'openai/gpt-5' }, tasks: [] })
    getGlobalModelOptions.mockResolvedValue({ provider: 'openrouter', providers: [openRouter] })
    deleteEnvVar.mockResolvedValue({ ok: true })
    disconnectOAuthProvider.mockResolvedValue({ ok: true })
    listOAuthProviders.mockResolvedValue({ providers: [] })
  })

  afterEach(async () => {
    const { $confirmRequest } = await import('@/store/confirm')
    const { $credentialRemoved } = await import('./credential-removal')
    $confirmRequest.set(null)
    $credentialRemoved.set({})
  })

  it('removes the API key of the active provider after confirm and holds the page at "choose a provider"', async () => {
    await renderWithConfirm()

    fireEvent.click(await findReadyRemove())
    const dialog = await screen.findByRole('dialog', { name: 'Remove OPENROUTER_API_KEY?' })
    expect(dialog.textContent).toContain('This is your current model provider')
    expect(deleteEnvVar).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    })

    await waitFor(() => expect(deleteEnvVar).toHaveBeenCalledWith('OPENROUTER_API_KEY', undefined))
    // The runtime still lists the cached models as ready; the app-side flag
    // keeps the page in needs-setup and never picks another provider.
    expect((await screen.findByTestId('model-choose-provider')).textContent).toContain('Choose a provider')
    expect(screen.queryByTestId('model-remove-credentials')).toBeNull()
    expect(setModelAssignment).not.toHaveBeenCalled()
    expect(saveHermesConfig).not.toHaveBeenCalled()
  })

  it('leaves the key in place when the confirm is dismissed', async () => {
    await renderWithConfirm()

    fireEvent.click(await findReadyRemove())
    const dialog = await screen.findByRole('dialog')

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    })

    expect(deleteEnvVar).not.toHaveBeenCalled()
    expect(screen.queryByTestId('model-choose-provider')).toBeNull()
  })

  it('maps an OAuth provider slug to its catalog id before disconnecting', async () => {
    getGlobalModelInfo.mockResolvedValue({ provider: 'anthropic', model: 'claude' })
    getAuxiliaryModels.mockResolvedValue({ main: { provider: 'anthropic', model: 'claude' }, tasks: [] })
    getGlobalModelOptions.mockResolvedValue({
      providers: [{ authenticated: true, models: ['claude'], name: 'Anthropic', slug: 'anthropic' }]
    })
    getEnvVars.mockResolvedValue({})
    listOAuthProviders.mockResolvedValue({
      providers: [
        {
          disconnectable: true,
          docs_url: '',
          flow: 'pkce',
          id: 'anthropic',
          name: 'Anthropic',
          status: { logged_in: true }
        }
      ]
    })

    await renderWithConfirm()
    fireEvent.click(await findReadyRemove())
    const dialog = await screen.findByRole('dialog', { name: 'Remove Anthropic?' })

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    })

    await waitFor(() => expect(disconnectOAuthProvider).toHaveBeenCalledWith('anthropic'))
    expect(deleteEnvVar).not.toHaveBeenCalled()
  })

  it('removes the key of a scoped profile and flags only that profile', async () => {
    const { $credentialRemoved, credentialRemovedFor } = await import('./credential-removal')
    await renderWithConfirm('inft-7')

    fireEvent.click(await findReadyRemove())
    const dialog = await screen.findByRole('dialog', { name: 'Remove OPENROUTER_API_KEY?' })

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    })

    await waitFor(() => expect(deleteEnvVar).toHaveBeenCalledWith('OPENROUTER_API_KEY', 'inft-7'))
    expect(getEnvVars).toHaveBeenCalledWith('inft-7')
    expect(credentialRemovedFor($credentialRemoved.get(), 'inft-7')?.provider).toBe('openrouter')
    expect(credentialRemovedFor($credentialRemoved.get())).toBeNull()
  })

  it("ignores another profile's removed-credential flag", async () => {
    const { markCredentialRemoved } = await import('./credential-removal')
    markCredentialRemoved('openrouter', 'other-inft')
    await renderWithConfirm()

    expect(await screen.findByTestId('model-remove-credentials')).toBeTruthy()
    expect(screen.queryByTestId('model-choose-provider')).toBeNull()
  })

  it('labels the button "Manage in Providers" and navigates without a dialog when nothing is removable', async () => {
    getEnvVars.mockResolvedValue({})
    await renderWithConfirm()

    const button = await findReadyRemove()
    expect(button.textContent).toContain('Manage in Providers')

    await act(async () => {
      fireEvent.click(button)
    })

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(deleteEnvVar).not.toHaveBeenCalled()
    expect(screen.getByTestId('location').textContent).toBe('/settings?tab=providers&pview=accounts')
  })

  it('removes one of several Anthropic credentials, names what remains and keeps the provider (no "choose a provider")', async () => {
    const anthropic = {
      authenticated: true,
      is_current: true,
      models: ['claude'],
      name: 'Anthropic',
      slug: 'anthropic'
    }

    getGlobalModelInfo.mockResolvedValue({ provider: 'anthropic', model: 'claude' })
    getAuxiliaryModels.mockResolvedValue({ main: { provider: 'anthropic', model: 'claude' }, tasks: [] })
    getGlobalModelOptions.mockResolvedValue({ provider: 'anthropic', providers: [anthropic] })
    getEnvVars.mockResolvedValue({
      ANTHROPIC_API_KEY: { category: 'provider', is_password: true, is_set: true, provider: 'anthropic' }
    })
    // The lab's catalog (2026-10-16): `anthropic` is signed in BY ANTHROPIC_API_KEY
    // (source env_var, the same key), `claude-code` by ~/.claude/.credentials.json.
    listOAuthProviders.mockResolvedValue({
      providers: [
        {
          cli_command: '',
          disconnectable: false,
          docs_url: '',
          flow: 'pkce',
          id: 'anthropic',
          name: 'Anthropic API Key',
          status: { logged_in: true, source: 'env_var', source_label: 'ANTHROPIC_API_KEY' }
        },
        {
          cli_command: '',
          docs_url: '',
          flow: 'external',
          id: 'claude-code',
          name: 'Claude Code',
          status: { logged_in: true, source: 'claude_code_cli' }
        }
      ]
    })
    deleteEnvVar.mockImplementation(async () => {
      getEnvVars.mockResolvedValue({})

      return { ok: true }
    })

    await renderWithConfirm()
    fireEvent.click(await findReadyRemove())
    const dialog = await screen.findByRole('dialog', { name: 'Remove ANTHROPIC_API_KEY?' })
    expect(dialog.textContent).toContain('Anthropic is also signed in through Claude Code. It stays')
    expect(dialog.textContent).not.toContain('This is your current model provider')

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    })

    await waitFor(() => expect(deleteEnvVar).toHaveBeenCalledWith('ANTHROPIC_API_KEY', undefined))
    // The sign-ins cannot be disconnected here: the control hands off to Providers.
    await waitFor(async () => expect((await findReadyRemove()).textContent).toContain('Manage in Providers'))
    expect(screen.getByTestId('model-credentials-remaining').textContent).toBe(
      'Anthropic is still signed in through Claude Code.'
    )
    expect(screen.queryByTestId('model-choose-provider')).toBeNull()
    expect(screen.queryByText(/credentials were removed/)).toBeNull()
    expect(setModelAssignment).not.toHaveBeenCalled()
  })

  it('keeps the next env secret as the control when two keys back the provider', async () => {
    getEnvVars.mockResolvedValue({
      OPENROUTER_API_KEY: { category: 'provider', is_password: true, is_set: true, provider: 'openrouter' },
      OPENROUTER_TOKEN: { category: 'provider', is_password: true, is_set: true, provider: 'openrouter' }
    })
    deleteEnvVar.mockImplementation(async () => {
      getEnvVars.mockResolvedValue({
        OPENROUTER_TOKEN: { category: 'provider', is_password: true, is_set: true, provider: 'openrouter' }
      })

      return { ok: true }
    })

    await renderWithConfirm()
    fireEvent.click(await findReadyRemove())
    const first = await screen.findByRole('dialog', { name: 'Remove OPENROUTER_API_KEY?' })
    expect(first.textContent).toContain('OpenRouter is also signed in through OPENROUTER_TOKEN. It stays')

    await act(async () => {
      fireEvent.click(within(first).getByRole('button', { name: 'Remove' }))
    })

    await waitFor(() =>
      expect(screen.getByTestId('model-credentials-remaining').textContent).toContain('OPENROUTER_TOKEN')
    )
    expect(screen.queryByTestId('model-choose-provider')).toBeNull()

    fireEvent.click(await findReadyRemove())
    const second = await screen.findByRole('dialog', { name: 'Remove OPENROUTER_TOKEN?' })
    expect(second.textContent).toContain('This is your current model provider')

    await act(async () => {
      fireEvent.click(within(second).getByRole('button', { name: 'Remove' }))
    })

    expect((await screen.findByTestId('model-choose-provider')).textContent).toContain(
      'OpenRouter credentials were removed'
    )
    expect(screen.queryByTestId('model-credentials-remaining')).toBeNull()
  })

  it('offers no removal for a provider that still needs setup', async () => {
    getGlobalModelOptions.mockResolvedValue({
      providers: [{ ...openRouter, authenticated: false, is_current: false, models: [] }]
    })

    await renderWithConfirm()
    await waitFor(() => expect(getGlobalModelOptions).toHaveBeenCalled())
    await screen.findAllByRole('combobox')

    expect(screen.queryByTestId('model-remove-credentials')).toBeNull()
  })
})

describe('ModelSettings restart-required refusal', () => {
  const SKEW_ERROR = new Error(
    'Error invoking remote method \'hermes:api\': Error: 503: {"detail":"Restart required: This dashboard is running ' +
      'code from 1a2b3c4d5e but the checkout on disk is now 6f7a8b9c0d. The model picker would risk a stale-module ' +
      'crash — restart the dashboard to load the new code (systemctl --user restart hermes-dashboard, or hermes ' +
      'dashboard --port <port>)"}'
  )

  const desktop = window as unknown as { hermesDesktop?: { restartBackend?: () => Promise<{ ok: boolean }> } }
  let previousDesktop: typeof desktop.hermesDesktop

  beforeEach(() => {
    previousDesktop = desktop.hermesDesktop
  })

  afterEach(() => {
    desktop.hermesDesktop = previousDesktop
  })

  it('shows a plain sentence with a Restart action instead of the raw IPC error', async () => {
    const restartBackend = vi.fn().mockResolvedValue({ ok: true })
    desktop.hermesDesktop = { ...(previousDesktop ?? {}), restartBackend }
    getGlobalModelOptions.mockRejectedValueOnce(SKEW_ERROR)

    await renderModelSettings()

    expect(await screen.findByText(/updated while it was running/)).toBeTruthy()
    expect(screen.queryByText(/systemctl|Error invoking remote method|503/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Restart' }))

    await waitFor(() => expect(restartBackend).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByText(/updated while it was running/)).toBeNull())
    expect(getGlobalModelOptions).toHaveBeenCalledTimes(2)
  })

  it('a restart pending on one endpoint hides nothing that did answer: Mixture of Agents still renders (I-B r6)', async () => {
    getGlobalModelOptions.mockRejectedValueOnce(SKEW_ERROR)
    getMoaModels.mockResolvedValueOnce({
      default_preset: 'default',
      active_preset: '',
      presets: {
        default: {
          reference_models: [{ provider: 'nous', model: 'hermes-4' }],
          aggregator: { provider: 'nous', model: 'hermes-4' },
          reference_temperature: 0,
          aggregator_temperature: 0,
          max_tokens: 4096,
          enabled: true
        }
      },
      reference_models: [{ provider: 'nous', model: 'hermes-4' }],
      aggregator: { provider: 'nous', model: 'hermes-4' },
      reference_temperature: 0,
      aggregator_temperature: 0,
      max_tokens: 4096,
      enabled: true
    })

    await renderModelSettings()

    expect(await screen.findByText(/updated while it was running/)).toBeTruthy()
    expect(await screen.findByText('Which model gives reference answer 1')).toBeTruthy()
  })

  it('keeps the action and says so when the restart fails', async () => {
    const restartBackend = vi.fn().mockResolvedValue({ ok: false, error: 'spawn failed' })
    desktop.hermesDesktop = { ...(previousDesktop ?? {}), restartBackend }
    getGlobalModelOptions.mockRejectedValueOnce(SKEW_ERROR)

    await renderModelSettings()
    fireEvent.click(await screen.findByRole('button', { name: 'Restart' }))

    expect(await screen.findByText(/did not restart/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Restart' })).toBeTruthy()
  })

  it('unwraps other load failures instead of printing the IPC wrapper', async () => {
    getGlobalModelOptions.mockRejectedValueOnce(new Error("Error invoking remote method 'hermes:api': Error: boom"))

    await renderModelSettings()

    expect(await screen.findByText('boom')).toBeTruthy()
    expect(screen.queryByText(/Error invoking remote method/)).toBeNull()
  })
})
