import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { EffortRoutesTable } from '@/lib/reasoning-levels'

import {
  $modelPresets,
  applyModelPreset,
  getModelPreset,
  modelPresetKey,
  presetForSwitch,
  reasoningConfigSetParams,
  selectModelEffort,
  setModelPreset
} from './model-presets'
import {
  $currentFastMode,
  $currentReasoningEffort,
  $reasoningEffortWire,
  setActiveSessionId,
  setCurrentFastMode,
  setCurrentReasoningEffort,
  setReasoningEffortWire
} from './session'

describe('model presets', () => {
  beforeEach(() => {
    $modelPresets.set({})
    setCurrentFastMode(false)
    setCurrentReasoningEffort('')
  })

  it('round-trips a preset and merges patches without dropping prior fields', () => {
    setModelPreset('anthropic', 'claude-opus-4-8', { effort: 'high' })
    setModelPreset('anthropic', 'claude-opus-4-8', { fast: true })

    expect(getModelPreset('anthropic', 'claude-opus-4-8')).toEqual({ effort: 'high', fast: true })
  })

  it('returns an empty preset for unknown models', () => {
    expect(getModelPreset('x', 'y')).toEqual({})
  })

  it('keys by provider::model', () => {
    expect(modelPresetKey('openai', 'gpt-5.5')).toBe('openai::gpt-5.5')
  })

  it('pushes only the provided dimensions to the gateway', async () => {
    const calls: { method: string; params?: Record<string, unknown> }[] = []

    const request = async <T>(method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params })

      return {} as T
    }

    await applyModelPreset({ effort: 'high' }, { failMessage: 'x', request, sessionId: 's1' })
    await applyModelPreset({}, { failMessage: 'x', request, sessionId: 's1' })

    expect(calls).toEqual([{ method: 'config.set', params: { key: 'reasoning', session_id: 's1', value: 'high' } }])
  })

  it('applies a fresh-draft preset locally without mutating gateway config', async () => {
    const calls: { method: string; params?: Record<string, unknown> }[] = []

    const request = async <T>(method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params })

      return {} as T
    }

    await applyModelPreset({ effort: 'high', fast: true }, { failMessage: 'x', request, sessionId: null })

    expect($currentReasoningEffort.get()).toBe('high')
    expect($currentFastMode.get()).toBe(true)
    expect(calls).toEqual([])
  })
})

describe('selectModelEffort', () => {
  type Call = { method: string; params?: Record<string, unknown> }

  const recorder = (fail = false) => {
    const calls: Call[] = []

    const request = async <T>(method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params })

      if (fail) {
        throw new Error('gateway down')
      }

      return {} as T
    }

    return { calls, request }
  }

  beforeEach(() => {
    window.localStorage.clear()
    $modelPresets.set({})
    setCurrentReasoningEffort('')
    setReasoningEffortWire('high')
  })

  it('builds the config.set frame the runtime expects', () => {
    expect(reasoningConfigSetParams('s1', 'xhigh')).toEqual({ key: 'reasoning', session_id: 's1', value: 'xhigh' })
  })

  it('writes one config.set, applies the level and waits for the wire echo', async () => {
    const { calls, request } = recorder()

    const ok = await selectModelEffort(
      { effort: 'low', model: 'claude-opus-4-7', previous: 'high', provider: 'anthropic' },
      { failMessage: 'x', primary: true, request, sessionId: 's1' }
    )

    expect(ok).toBe(true)
    expect(calls).toEqual([{ method: 'config.set', params: { key: 'reasoning', session_id: 's1', value: 'low' } }])
    expect($currentReasoningEffort.get()).toBe('low')
    expect($reasoningEffortWire.get()).toBe('')
  })

  it('keeps each model its own level across model switches and a reload', async () => {
    const { request } = recorder()
    const ctx = { failMessage: 'x', primary: true, request, sessionId: 's1' }

    await selectModelEffort({ effort: 'max', model: 'claude-opus-4-7', previous: '', provider: 'anthropic' }, ctx)
    await selectModelEffort({ effort: 'low', model: 'gpt-5.6', previous: 'max', provider: 'openai-codex' }, ctx)
    await selectModelEffort({ effort: 'high', model: 'glm-5.2', previous: 'low', provider: 'zai' }, ctx)

    expect(getModelPreset('anthropic', 'claude-opus-4-7').effort).toBe('max')
    expect(getModelPreset('openai-codex', 'gpt-5.6').effort).toBe('low')

    vi.resetModules()
    const reloaded = await import('./model-presets')

    expect(reloaded.getModelPreset('anthropic', 'claude-opus-4-7').effort).toBe('max')
    expect(reloaded.getModelPreset('openai-codex', 'gpt-5.6').effort).toBe('low')
    expect(reloaded.getModelPreset('zai', 'glm-5.2').effort).toBe('high')
    expect(JSON.parse(window.localStorage.getItem('hermes.desktop.model-presets') ?? '{}')).toMatchObject({
      'anthropic::claude-opus-4-7': { effort: 'max' }
    })
  })

  it('rolls the level and the preset back when the gateway refuses', async () => {
    const { calls, request } = recorder(true)
    setModelPreset('anthropic', 'claude-sonnet-4-6', { effort: 'medium' })
    setCurrentReasoningEffort('medium')

    const ok = await selectModelEffort(
      { effort: 'max', model: 'claude-sonnet-4-6', previous: 'medium', provider: 'anthropic' },
      { failMessage: 'x', primary: true, request, sessionId: 's1' }
    )

    expect(ok).toBe(false)
    expect(calls).toHaveLength(1)
    expect($currentReasoningEffort.get()).toBe('medium')
    expect(getModelPreset('anthropic', 'claude-sonnet-4-6').effort).toBe('medium')
  })

  it("restores the model's own preset, not the session's level, when the gateway refuses", async () => {
    const { request } = recorder(true)
    const ctx = { failMessage: 'x', primary: true, request, sessionId: 's1' }
    const stored = () => JSON.parse(window.localStorage.getItem('hermes.desktop.model-presets') ?? '{}')
    setModelPreset('anthropic', 'claude-opus-4-7', { effort: 'high' })
    setModelPreset('openai-codex', 'gpt-5.6', { fast: true })

    await selectModelEffort({ effort: 'low', model: 'claude-opus-4-7', previous: '', provider: 'anthropic' }, ctx)
    await selectModelEffort({ effort: 'max', model: 'gpt-5.6', previous: '', provider: 'openai-codex' }, ctx)
    await selectModelEffort({ effort: 'xhigh', model: 'glm-5.2', previous: 'low', provider: 'zai' }, ctx)

    expect(stored()).toEqual({
      'anthropic::claude-opus-4-7': { effort: 'high' },
      'openai-codex::gpt-5.6': { fast: true }
    })
    expect($modelPresets.get()).toEqual(stored())
    expect($currentReasoningEffort.get()).toBe('low')
  })

  it('never lets a late failure undo a newer pick of the same model', async () => {
    const pending: Array<{ reject: (e: Error) => void; resolve: (v: unknown) => void }> = []

    const request = <T>() =>
      new Promise<T>((resolve, reject) => pending.push({ reject, resolve: resolve as (v: unknown) => void }))

    const ctx = { failMessage: 'x', primary: true, request, sessionId: 's1' }
    setModelPreset('anthropic', 'claude-opus-4-7', { effort: 'medium' })
    setCurrentReasoningEffort('medium')

    const first = selectModelEffort(
      { effort: 'low', model: 'claude-opus-4-7', previous: 'medium', provider: 'anthropic' },
      ctx
    )

    const second = selectModelEffort(
      { effort: 'max', model: 'claude-opus-4-7', previous: 'low', provider: 'anthropic' },
      ctx
    )

    pending[1].resolve({})
    pending[0].reject(new Error('late'))

    expect(await Promise.all([first, second])).toEqual([false, true])
    expect($currentReasoningEffort.get()).toBe('max')
    expect(getModelPreset('anthropic', 'claude-opus-4-7').effort).toBe('max')
  })

  it("rolls back only the failed model's preset when a newer pick on the surface is another model's", async () => {
    let fail: (e: Error) => void = () => undefined
    let calls = 0

    const request = <T>() => (calls++ === 0 ? new Promise<T>((_, reject) => (fail = reject)) : Promise.resolve({} as T))

    const ctx = { failMessage: 'x', primary: true, request, sessionId: 's1' }
    setModelPreset('anthropic', 'claude-opus-4-7', { effort: 'medium' })

    const first = selectModelEffort(
      { effort: 'low', model: 'claude-opus-4-7', previous: 'medium', provider: 'anthropic' },
      ctx
    )

    await selectModelEffort({ effort: 'max', model: 'gpt-5.6', previous: 'low', provider: 'openai-codex' }, ctx)
    fail(new Error('late'))

    expect(await first).toBe(false)
    expect($currentReasoningEffort.get()).toBe('max')
    expect(getModelPreset('anthropic', 'claude-opus-4-7').effort).toBe('medium')
    expect(getModelPreset('openai-codex', 'gpt-5.6').effort).toBe('max')
  })

  it('never reaches the gateway without a session (config.set would rewrite the profile default)', async () => {
    const { calls, request } = recorder()

    const ok = await selectModelEffort(
      { effort: 'high', model: 'kimi-k3', previous: '', provider: 'kimi-coding' },
      { failMessage: 'x', primary: true, request, sessionId: null }
    )

    expect(ok).toBe(true)
    expect(calls).toEqual([])
    expect(getModelPreset('kimi-coding', 'kimi-k3').effort).toBe('high')
  })
})

describe('reasoning effort wire echo', () => {
  it('belongs to one session: switching sessions clears it, re-selecting the same one keeps it', () => {
    setActiveSessionId('a')
    setReasoningEffortWire('max')
    setActiveSessionId('a')
    expect($reasoningEffortWire.get()).toBe('max')

    setActiveSessionId('b')
    expect($reasoningEffortWire.get()).toBe('')
    setActiveSessionId(null)
  })
})

describe('presetForSwitch', () => {
  // zai at the pinned runtime: GLM-5.2 sends high/max, every other GLM low..max.
  const TABLE: EffortRoutesTable = {
    entry: {
      codex: {
        astra: 'CODEX_ASTRA_EFFORTS',
        astraIds: [],
        daybreakIds: [],
        gpt56: 'CODEX_GPT56_EFFORTS',
        gpt56Substrings: ['gpt-5.6'],
        gpt6Prefixes: [],
        legacy: 'CODEX_LEGACY_EFFORTS',
        noDisablePrefixes: [],
        provider: 'openai-codex',
        ultraApiMode: 'codex_app_server'
      },
      default: 'OPENAI_COMPAT_WIRE_EFFORTS'
    },
    ladder: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    routes: [
      {
        cases: [{ any: ['glm-5.2'], levels: ['high', 'max'] }, { levels: ['low', 'medium', 'high', 'max'] }],
        providers: ['zai'],
        source: 'plugins/model-providers/zai/__init__.py'
      },
      {
        cases: [{ levels: [] }],
        hosts: ['api.groq.com'],
        providers: ['custom'],
        source: 'plugins/model-providers/custom/__init__.py:CustomProfile.build_api_kwargs_extras'
      }
    ],
    sets: {
      CODEX_GPT56_EFFORTS: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      OPENAI_COMPAT_WIRE_EFFORTS: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    }
  }

  const opts = { table: TABLE }

  it("lands on the new route's default when the current level is not one it sends", () => {
    expect(presetForSwitch('zai', 'glm-5.2', {}, 'low', opts)).toEqual({ effort: 'high' })
    expect(presetForSwitch('zai', 'glm-5.2', { fast: true }, 'xhigh', opts)).toEqual({ effort: 'high', fast: true })
    expect(presetForSwitch('zai', 'glm-5.3', {}, 'none', opts)).toEqual({ effort: 'medium' })
  })

  it('keeps a remembered preset and a current level the route lists', () => {
    expect(presetForSwitch('zai', 'glm-5.2', { effort: 'max' }, 'low', opts)).toEqual({ effort: 'max' })
    expect(presetForSwitch('zai', 'glm-5.3', {}, 'Low', opts)).toEqual({})
  })

  it('leaves effort unset without a level, a knob or a table', () => {
    expect(presetForSwitch('zai', 'glm-5.2', {}, '', opts)).toEqual({})
    expect(presetForSwitch('zai', 'glm-5.2', {}, 'low', { caps: { reasoning: false }, table: TABLE })).toEqual({})
    expect(presetForSwitch('zai', 'glm-5.2', {}, 'low', { table: null })).toEqual({})
  })

  it("reads the route's endpoint and API mode: host- and mode-chosen levels decide the switch", () => {
    const groq = { ...opts, baseUrl: 'https://api.groq.com/openai/v1' }

    expect(presetForSwitch('custom', 'gpt-oss-120b', {}, 'xhigh', groq)).toEqual({})
    expect(presetForSwitch('custom', 'gpt-oss-120b', {}, 'ultra', opts)).toEqual({ effort: 'medium' })
    expect(presetForSwitch('openai-codex', 'gpt-5.6', {}, 'ultra', { ...opts, apiMode: 'codex_app_server' })).toEqual(
      {}
    )
    expect(presetForSwitch('openai-codex', 'gpt-5.6', {}, 'ultra', opts)).toEqual({ effort: 'medium' })
  })
})
