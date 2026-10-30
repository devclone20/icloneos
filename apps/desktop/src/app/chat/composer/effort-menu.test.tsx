import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatBarState } from '@/app/chat/composer/types'
import { queryClient } from '@/lib/query-client'
import { $gateway } from '@/store/gateway'
import { $modelPresets, getModelPreset } from '@/store/model-presets'
import { $activeSessionId, setCurrentReasoningEffort, setReasoningEffortWire } from '@/store/session'

import { ModelPill } from './model-pill'

// A slice of served.py `effortRoutes` at the pinned runtime: the entry clamp
// plus the Anthropic adapter route (see reasoning-levels.test.ts for all routes).
const { TABLE } = vi.hoisted(() => ({
  TABLE: {
    entry: {
      codex: {
        astra: 'CODEX_ASTRA_EFFORTS',
        astraIds: ['gpt-6-astra'],
        daybreakIds: [],
        gpt56: 'CODEX_GPT56_EFFORTS',
        gpt56Substrings: ['gpt-5.6'],
        gpt6Prefixes: ['gpt-6-sol'],
        legacy: 'CODEX_LEGACY_EFFORTS',
        noDisablePrefixes: ['gpt-6.1-sol'],
        provider: 'openai-codex',
        ultraApiMode: 'codex_app_server'
      },
      default: 'OPENAI_COMPAT_WIRE_EFFORTS'
    },
    ladder: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    routes: [
      {
        cases: [
          { any: ['claude-sonnet-4-5', 'claude-3'], levels: [] },
          { levels: [], without: ['claude'] },
          {
            any: ['claude-sonnet-4-6'],
            levels: ['low', 'medium', 'high', 'max'],
            overrides: { minimal: 'low', ultra: 'max', xhigh: 'max' }
          },
          { levels: ['low', 'medium', 'high', 'xhigh', 'max'], overrides: { minimal: 'low', ultra: 'max' } }
        ],
        providers: ['anthropic', 'claude'],
        source: 'agent/anthropic_adapter.py'
      },
      {
        cases: [{ catalog: 'openrouter', levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] }],
        providers: ['openrouter', 'or'],
        source: 'plugins/model-providers/openrouter/__init__.py:OpenRouterProfile.build_api_kwargs_extras'
      },
      {
        cases: [{ levels: ['low', 'medium', 'high'], set: 'TOKENHUB_EFFORTS' }],
        hosts: ['tokenhub.tencentmaas.com'],
        providers: [],
        source: 'agent/transports/chat_completions.py:build_kwargs'
      },
      {
        cases: [{ levels: [] }],
        hosts: ['api.groq.com'],
        providers: ['custom', 'ollama'],
        source: 'plugins/model-providers/custom/__init__.py:CustomProfile.build_api_kwargs_extras'
      },
      {
        cases: [
          {
            catalog: 'router',
            levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
            set: 'OPENAI_COMPAT_WIRE_EFFORTS'
          }
        ],
        providers: ['router', 'ramp'],
        source: 'plugins/model-providers/router/__init__.py'
      },
      {
        cases: [
          { levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], set: 'OPENAI_COMPAT_WIRE_EFFORTS' }
        ],
        providers: ['custom', 'ollama'],
        source: 'plugins/model-providers/custom/__init__.py'
      }
    ],
    sets: {
      CODEX_ASTRA_EFFORTS: ['low', 'medium', 'high', 'xhigh', 'max'],
      CODEX_GPT56_EFFORTS: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      CODEX_LEGACY_EFFORTS: ['none', 'low', 'medium', 'high', 'xhigh'],
      OPENAI_COMPAT_WIRE_EFFORTS: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    }
  }
}))

vi.mock('@/types/runtime-contract.generated', async importOriginal => ({
  ...(await importOriginal<object>()),
  EFFORT_ROUTES: TABLE
}))

// `model.options` as the runtime answers it: capabilities + price per model.
const CATALOG = {
  providers: [
    {
      capabilities: { 'claude-opus-4-7': { reasoning: true }, 'claude-sonnet-4-6': { reasoning: true } },
      name: 'Anthropic',
      pricing: { 'claude-opus-4-7': { output: '$25.00' } },
      slug: 'anthropic'
    },
    {
      capabilities: {
        'meta-llama/llama-3-chat': { reasoning: false },
        'openai/gpt-5.4': { reasoning: true, supported_efforts: ['low', 'medium', 'high'] },
        'openai/gpt-5.5': { reasoning: true }
      },
      name: 'OpenRouter',
      slug: 'openrouter'
    },
    // Rows carry the route's endpoint (`api_url`) and API mode: host- and mode-chosen transports apply only with them.
    {
      api_url: 'https://api.groq.com/openai/v1',
      capabilities: { 'gpt-oss-120b': { reasoning: true } },
      name: 'Groq',
      slug: 'custom:groq'
    },
    {
      api_url: 'https://tokenhub.tencentmaas.com/v1',
      capabilities: { 'hunyuan-t1': { reasoning: true } },
      name: 'TokenHub',
      slug: 'custom:tokenhub'
    },
    {
      api_mode: 'codex_app_server',
      capabilities: { 'gpt-5.6': { reasoning: true } },
      name: 'Codex',
      slug: 'openai-codex'
    },
    {
      capabilities: {
        'gpt-5.4': { reasoning: true, supported_efforts: ['low', 'medium'] },
        'gpt-5.5': { reasoning: true }
      },
      name: 'Ramp Router',
      slug: 'router'
    }
  ]
}

const pill = (model: string, provider = 'anthropic'): ChatBarState['model'] => ({
  canSwitch: true,
  model,
  modelMenuContent: <div />,
  provider
})

const openEffort = async () => {
  fireEvent.keyDown(await screen.findByTestId('effort-trigger'), { key: 'ArrowDown' })

  return screen.getByTestId('effort-menu')
}

const configSets = (request: { mock: { calls: unknown[][] } }) => request.mock.calls.filter(c => c[0] === 'config.set')

const rows = () => Array.from(screen.getByTestId('effort-menu').querySelectorAll<HTMLElement>('[data-effort]'))

describe('composer Effort menu', () => {
  const request = vi.fn(async (method: string) => (method === 'model.options' ? CATALOG : {}))

  beforeEach(() => {
    window.localStorage.clear()
    $modelPresets.set({})
    $activeSessionId.set('s1')
    setCurrentReasoningEffort('high')
    setReasoningEffortWire('')
    request.mockClear()
    $gateway.set({ request } as never)
  })

  afterEach(() => {
    cleanup()
    queryClient.clear()
    $gateway.set(null as never)
    $activeSessionId.set(null)
  })

  it('splits the pill and lists exactly the levels the route sends verbatim', async () => {
    render(<ModelPill disabled={false} model={pill('claude-opus-4-7')} />)

    expect((await screen.findByTestId('effort-trigger')).textContent).toContain('High')
    const menu = await openEffort()

    expect(menu.getAttribute('role')).toBe('menu')
    expect(menu.className).toContain('w-58')
    expect(rows().map(r => r.dataset.effort)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(rows().every(r => r.className.includes('h-8'))).toBe(true)
    expect(rows().find(r => r.getAttribute('aria-checked') === 'true')?.dataset.effort).toBe('high')
  })

  it('drops the levels a model rejects and says what the route sends for the requested one', async () => {
    setCurrentReasoningEffort('xhigh')
    render(<ModelPill disabled={false} model={pill('claude-sonnet-4-6')} />)
    await openEffort()

    expect(rows().map(r => r.dataset.effort)).toEqual(['low', 'medium', 'high', 'max'])
    expect(rows().some(r => r.getAttribute('aria-checked') === 'true')).toBe(false)
    expect(screen.getByTestId('effort-wire-note').textContent).toBe('Sends Max on this route')
  })

  it('shows the wire level the runtime echoes when it differs from the request', async () => {
    setReasoningEffortWire('medium')
    render(<ModelPill disabled={false} model={pill('claude-opus-4-7')} />)
    await openEffort()

    expect(screen.getByTestId('effort-wire-note').textContent).toBe('Sends Medium on this route')
  })

  it('writes the pick to the session with one config.set and remembers it for the model', async () => {
    render(<ModelPill disabled={false} model={pill('claude-opus-4-7')} />)
    await openEffort()
    fireEvent.click(rows().find(r => r.dataset.effort === 'low')!)

    expect(configSets(request)).toEqual([['config.set', { key: 'reasoning', session_id: 's1', value: 'low' }]])
    expect(getModelPreset('anthropic', 'claude-opus-4-7').effort).toBe('low')
  })

  it('never checks a level OpenRouter may still lower, and says so', async () => {
    render(<ModelPill disabled={false} model={pill('openai/gpt-5.5', 'openrouter')} />)
    await openEffort()

    expect(rows().map(r => r.dataset.effort)).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(rows().some(r => r.getAttribute('aria-checked') === 'true')).toBe(false)
    expect(rows().find(r => r.dataset.requested === 'true')?.dataset.effort).toBe('high')
    expect(screen.getByTestId('effort-catalog-note').textContent).toBe(
      'OpenRouter may send a lower level than High for this model'
    )
    expect(screen.queryByTestId('effort-wire-note')).toBeNull()
  })

  it("lists exactly OpenRouter's catalog levels when the runtime reports them", async () => {
    render(<ModelPill disabled={false} model={pill('openai/gpt-5.4', 'openrouter')} />)
    await openEffort()

    expect(rows().map(r => r.dataset.effort)).toEqual(['low', 'medium', 'high'])
    expect(rows().find(r => r.getAttribute('aria-checked') === 'true')?.dataset.effort).toBe('high')
    expect(screen.queryByTestId('effort-catalog-note')).toBeNull()
  })

  it('keeps the single label on a route without effort levels (budget-token Claude)', async () => {
    render(<ModelPill disabled={false} model={pill('claude-sonnet-4-5')} />)
    await waitFor(() => expect(request).toHaveBeenCalledWith('model.options', expect.anything()))

    expect(screen.queryByTestId('effort-trigger')).toBeNull()
    expect(screen.getByText(/ · High$/)).toBeTruthy()
  })

  it('never splits before the catalog answers, nor for a model the runtime says has no reasoning', async () => {
    render(<ModelPill disabled={false} model={pill('meta-llama/llama-3-chat', 'openrouter')} />)

    expect(screen.queryByTestId('effort-trigger')).toBeNull()
    await waitFor(() => expect(request).toHaveBeenCalledWith('model.options', expect.anything()))
    await act(async () => {})
    expect(screen.queryByTestId('effort-trigger')).toBeNull()
  })

  it('keeps an open menu mounted when a catalog refresh drops the levels', async () => {
    render(<ModelPill disabled={false} model={pill('claude-opus-4-7')} />)
    await openEffort()

    await act(async () => {
      for (const query of queryClient.getQueryCache().getAll()) {
        queryClient.setQueryData(query.queryKey, {
          providers: [{ ...CATALOG.providers[0], capabilities: { 'claude-opus-4-7': { reasoning: false } } }]
        })
      }
    })

    await waitFor(() => expect(rows()).toEqual([]))
    expect(screen.getByTestId('effort-menu')).toBeTruthy()
  })

  it('shows the runtime price, closes on Escape and gives focus back to its trigger', async () => {
    render(<ModelPill disabled={false} model={pill('claude-opus-4-7')} />)
    const menu = await openEffort()

    expect(screen.getByTestId('effort-price').textContent).toBe('$25.00/Mtok out')
    fireEvent.keyDown(menu, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByTestId('effort-menu')).toBeNull())
    const trigger = screen.getByTestId('effort-trigger')

    expect(trigger.ownerDocument.activeElement).toBe(trigger)
  })

  it('applies host-chosen routes from the row endpoint: Groq has no effort rows, TokenHub its own set', async () => {
    render(<ModelPill disabled={false} model={pill('gpt-oss-120b', 'custom:groq')} />)
    await waitFor(() => expect(request).toHaveBeenCalledWith('model.options', expect.anything()))
    await act(async () => {})
    expect(screen.queryByTestId('effort-trigger')).toBeNull()
    cleanup()

    setCurrentReasoningEffort('max')
    render(<ModelPill disabled={false} model={pill('hunyuan-t1', 'custom:tokenhub')} />)
    await openEffort()

    expect(rows().map(r => r.dataset.effort)).toEqual(['low', 'medium', 'high'])
    expect(screen.getByTestId('effort-wire-note').textContent).toBe('Sends High on this route')
  })

  it('lists Codex ultra only on the app-server API mode the row reports', async () => {
    setCurrentReasoningEffort('ultra')
    render(<ModelPill disabled={false} model={pill('gpt-5.6', 'openai-codex')} />)
    await openEffort()

    expect(rows().map(r => r.dataset.effort)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    expect(rows().find(r => r.getAttribute('aria-checked') === 'true')?.dataset.effort).toBe('ultra')
  })

  it('never checks a level the Ramp Router catalog may lower; its listed levels narrow the rows', async () => {
    render(<ModelPill disabled={false} model={pill('gpt-5.5', 'router')} />)
    await openEffort()

    expect(rows().map(r => r.dataset.effort)).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(rows().some(r => r.getAttribute('aria-checked') === 'true')).toBe(false)
    expect(screen.getByTestId('effort-catalog-note').textContent).toBe(
      'Ramp Router may send a lower level than High for this model'
    )
    cleanup()

    setCurrentReasoningEffort('medium')
    render(<ModelPill disabled={false} model={pill('gpt-5.4', 'router')} />)
    await openEffort()

    expect(rows().map(r => r.dataset.effort)).toEqual(['low', 'medium'])
    expect(rows().find(r => r.getAttribute('aria-checked') === 'true')?.dataset.effort).toBe('medium')
    expect(screen.queryByTestId('effort-catalog-note')).toBeNull()
  })

  it('marks the requested row when the runtime echoes another wire level', async () => {
    setReasoningEffortWire('medium')
    render(<ModelPill disabled={false} model={pill('claude-opus-4-7')} />)
    await openEffort()

    expect(rows().find(r => r.dataset.unsupported === 'true')?.dataset.effort).toBe('high')
  })
})
