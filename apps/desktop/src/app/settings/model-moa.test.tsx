import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
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

describe('ModelSettings MoA preset editor', () => {
  const moaConfig = () => ({
    default_preset: 'default',
    active_preset: '',
    presets: {
      default: {
        reference_models: [
          { provider: 'nous', model: 'hermes-4' },
          { provider: 'openrouter', model: 'deepseek/deepseek-v4-pro' }
        ],
        aggregator: { provider: 'openrouter', model: 'anthropic/claude-opus-4.8' },
        reference_temperature: 0,
        aggregator_temperature: 0,
        max_tokens: 4096,
        enabled: true
      }
    },
    reference_models: [
      { provider: 'nous', model: 'hermes-4' },
      { provider: 'openrouter', model: 'deepseek/deepseek-v4-pro' }
    ],
    aggregator: { provider: 'openrouter', model: 'anthropic/claude-opus-4.8' },
    reference_temperature: 0,
    aggregator_temperature: 0,
    max_tokens: 4096,
    enabled: true
  })

  beforeEach(() => {
    getGlobalModelOptions.mockResolvedValue({
      providers: [
        {
          name: 'Nous',
          slug: 'nous',
          models: ['hermes-4', 'hermes-4-mini'],
          authenticated: true,
          capabilities: { 'hermes-4': { reasoning: true, fast: true } }
        },
        {
          name: 'OpenRouter',
          slug: 'openrouter',
          models: ['deepseek/deepseek-v4-pro', 'anthropic/claude-opus-4.8'],
          authenticated: true
        }
      ]
    })
    getMoaModels.mockResolvedValue(moaConfig())
    saveMoaModels.mockImplementation((body: unknown) => Promise.resolve(body))
  })

  async function openReferenceEditor() {
    await renderModelSettings()
    expect(await screen.findByText('Which model gives reference answer 1')).toBeTruthy()
  }

  function slotSelects() {
    // Combobox order in the MoA section (last 7 on the page): preset select,
    // then provider+model per reference (2 refs), then aggregator
    // provider+model. Reference 1's pair is therefore at -6 / -5.
    const all = screen.getAllByRole('combobox')

    return { ref1Provider: all.at(-6)!, ref1Model: all.at(-5)! }
  }

  it('keeps every MoA control on THE row: inside a row, never in the title column (I-B r5)', async () => {
    await openReferenceEditor()
    const add = screen.getByText('Add reference model').closest('button')!
    const addRow = add.closest('[data-setting-row]')

    expect(addRow?.textContent).toContain('Ask one more model for a reference answer')

    for (const title of [
      'Which model gives reference answer 1',
      'Which model gives reference answer 2',
      'Which model writes the final answer'
    ]) {
      const row = screen.getByText(title).closest('[data-setting-row]') as HTMLElement
      const titleColumn = screen.getByText(title).parentElement as HTMLElement

      expect(row.querySelectorAll('[role="combobox"]').length).toBe(2)
      expect(titleColumn.querySelector('[role="combobox"], button, [role="switch"]')).toBeNull()
    }

    // The on/off switch keeps the title line (its own aside cell), never under the selects.
    for (const n of [1, 2]) {
      const row = screen
        .getByText(`Which model gives reference answer ${n}`)
        .closest('[data-setting-row]') as HTMLElement

      expect(row.querySelector('[data-setting-aside] [role="switch"]')).toBeTruthy()
    }

    // The preset row shows its value once: in the select, not again as a detail line.
    expect(
      screen.getByText('Choose the preset you want to edit').closest('[data-setting-row]')?.querySelector('.font-mono')
    ).toBeNull()
  })

  it('holds the autosave while a slot is half-filled (provider changed, model pending)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    try {
      await openReferenceEditor()

      fireEvent.click(slotSelects().ref1Provider)
      fireEvent.click(await screen.findByRole('option', { name: 'OpenRouter' }))

      // Model was cleared by the provider change → config incomplete → the
      // debounced autosave must NOT fire, even well past the 600ms window.
      await vi.advanceTimersByTimeAsync(2000)
      expect(saveMoaModels).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('saves once the model pick completes the slot', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    try {
      await openReferenceEditor()

      fireEvent.click(slotSelects().ref1Provider)
      fireEvent.click(await screen.findByRole('option', { name: 'OpenRouter' }))
      await vi.advanceTimersByTimeAsync(700)

      fireEvent.click(slotSelects().ref1Model)
      fireEvent.click(await screen.findByRole('option', { name: 'anthropic/claude-opus-4.8' }))
      await vi.advanceTimersByTimeAsync(700)

      expect(saveMoaModels).toHaveBeenCalledTimes(1)
      const sent = saveMoaModels.mock.calls[0][0] as ReturnType<typeof moaConfig>
      expect(sent.presets.default.reference_models[0]).toEqual({
        provider: 'openrouter',
        model: 'anthropic/claude-opus-4.8'
      })
      // The untouched slots ride along unchanged — nothing reverts to defaults.
      expect(sent.presets.default.reference_models[1]).toEqual({
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-pro'
      })
      expect(sent.presets.default.aggregator).toEqual({
        provider: 'openrouter',
        model: 'anthropic/claude-opus-4.8'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not clear the model or save when the same provider is re-selected', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    try {
      await openReferenceEditor()

      fireEvent.click(slotSelects().ref1Provider)
      fireEvent.click(await screen.findByRole('option', { name: 'Nous' }))
      await vi.advanceTimersByTimeAsync(700)

      // Radix treats re-picking the current value as a no-op (no
      // onValueChange), so nothing changes: no save, model still shown.
      expect(saveMoaModels).not.toHaveBeenCalled()
      expect(slotSelects().ref1Model.textContent).toContain('hermes-4')
    } finally {
      vi.useRealTimers()
    }
  })

  it('autosaves the selected preset when its enabled switch is toggled', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    try {
      await openReferenceEditor()

      fireEvent.click(screen.getByRole('switch', { name: 'Use this preset' }))
      await vi.advanceTimersByTimeAsync(700)

      expect(saveMoaModels).toHaveBeenCalledWith(
        expect.objectContaining({
          presets: expect.objectContaining({
            default: expect.objectContaining({ enabled: false })
          })
        })
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('saves a disabled reference model without removing it (per-slot enabled toggle)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    try {
      await openReferenceEditor()

      fireEvent.click(screen.getByRole('switch', { name: 'Use reference model 1' }))
      await vi.advanceTimersByTimeAsync(700)

      expect(saveMoaModels).toHaveBeenCalledWith(
        expect.objectContaining({
          presets: expect.objectContaining({
            default: expect.objectContaining({
              reference_models: [
                expect.objectContaining({ provider: 'nous', model: 'hermes-4', enabled: false }),
                expect.objectContaining({ provider: 'openrouter', model: 'deepseek/deepseek-v4-pro' })
              ]
            })
          })
        })
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
