import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type * as ReactRouter from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EngineFallbackBanner, freshFallback } from '@/app/chat/engine-fallback-banner'
import { SETTINGS_ROUTE } from '@/app/routes'
import { enEngine } from '@/i18n/en'
import { $selectedStoredSessionId } from '@/store/session'

import { EngineSettings } from './engine-settings'
import { engineSelection, statusLine, windowLine } from './engine-settings-model'

type Assignment = { base_url?: string; confirm_expensive_model?: boolean; model: string; provider: string }

const setModelAssignment = vi.fn<(body: Assignment) => Promise<unknown>>()
const getGlobalModelInfo = vi.fn()
const getHermesConfigRecord = vi.fn()
// The [provider, model] of every model.set the UI sent.
const sent = () => setModelAssignment.mock.calls.map(([body]) => [body.provider, body.model])

vi.mock('@/api/models', () => ({
  getGlobalModelInfo: () => getGlobalModelInfo(),
  getRecommendedDefaultModel: async () => ({ model: 'hermes-default' }),
  setModelAssignment: (body: Assignment) => setModelAssignment(body)
}))

vi.mock('@/api/config', () => ({ getHermesConfigRecord: () => getHermesConfigRecord() }))

const navigateSpy = vi.fn()

vi.mock('react-router', async importOriginal => ({
  ...(await importOriginal<typeof ReactRouter>()),
  useInRouterContext: () => true,
  useNavigate: () => navigateSpy
}))

const base = {
  authMethod: 'claude.ai',
  fallbackTarget: null as null | { baseUrl?: string; model: string; provider: string },
  installed: true,
  lastFallback: null,
  loggedIn: true,
  path: '/h/.local/bin/claude',
  pluginInstalled: true,
  subscriptionType: 'max',
  version: '2.1.302',
  window: null
}

const statusSpy = vi.fn()

function bridge(status: unknown) {
  const setFallback = vi.fn(async (_target: { baseUrl?: string; model: string; provider: string }) => ({
    ok: true as const
  }))

  const read = () => status as typeof base

  statusSpy.mockReset().mockImplementation(async () => status)

  const fallbackState = vi.fn(async () => ({
    fallbackTarget: read().fallbackTarget,
    lastFallback: read().lastFallback
  }))

  Object.assign(window, { hermesDesktop: { icloneClaudeCode: { fallbackState, setFallback, status: statusSpy } } })

  return setFallback
}

beforeEach(() => {
  localStorage.clear()
  setModelAssignment.mockReset().mockResolvedValue({ ok: true })
  getGlobalModelInfo.mockReset().mockResolvedValue({ model: 'hermes-4', provider: 'nous' })
  getHermesConfigRecord.mockReset().mockResolvedValue({ model: { provider: 'nous' } })
})
afterEach(cleanup)

describe('Engine pane', () => {
  it.each([
    [
      { ...base, installed: false, loggedIn: false, path: null },
      'not-installed',
      'Claude Code is not installed on this computer.'
    ],
    [{ ...base, loggedIn: false }, 'not-logged-in', 'Claude Code is installed but not signed in.'],
    [base, 'ready', 'Claude Code is signed in and ready on your Max plan.']
  ])('renders state %#', async (status, state, line) => {
    bridge(status)
    await act(async () => void render(<EngineSettings />))
    expect(screen.getByText(line).closest('[data-engine-state]')?.getAttribute('data-engine-state')).toBe(state)
    expect(screen.queryAllByText('claude auth login').length).toBe(state === 'ready' ? 0 : 1)
  })

  it('puts each engine on THE row: one sentence, a hint under it, the choice at the trailing edge', async () => {
    bridge(base)
    let view: ReturnType<typeof render> | undefined
    await act(async () => void (view = render(<EngineSettings />)))
    const nous = screen.getByText('Run your agent on the standard engine').closest('[data-setting-row]')
    expect(nous?.textContent).toContain('The default every agent starts on, answered by Nous Portal models.')
    const claude = screen.getByText('Run your agent on your Claude Code plan').closest('[data-setting-row]')
    expect(claude?.querySelector('button, [role=switch], [role=radio]')).toBeTruthy()
    expect(view?.container.textContent).not.toMatch(/Hermes/)
  })

  it('Start a conversation: one click opens a new chat on Claude Code, switching the engine first when needed', async () => {
    bridge(base)
    await act(async () => void render(<EngineSettings />))
    await act(async () => void fireEvent.click(screen.getByText('Start a conversation')))
    // On Nous: the switch happens first (default model), then the new-chat route.
    expect(sent()).toEqual([['claude-code-cli', 'claude-opus-5-5']])
    expect(navigateSpy).toHaveBeenCalledWith('/')

    navigateSpy.mockReset()
    setModelAssignment.mockReset().mockResolvedValue({ ok: true })
    getGlobalModelInfo.mockResolvedValue({ model: 'claude-sonnet-5-5', provider: 'claude-code-cli' })
    cleanup()
    await act(async () => void render(<EngineSettings />))
    await act(async () => void fireEvent.click(screen.getByText('Start a conversation')))
    // Already on Claude Code: no model.set, straight to the chat.
    expect(sent()).toEqual([])
    expect(navigateSpy).toHaveBeenCalledWith('/')
  })

  it('Start a conversation is absent until Claude Code is signed in, and a refused switch does not open a chat', async () => {
    bridge({ ...base, loggedIn: false })
    await act(async () => void render(<EngineSettings />))
    expect(screen.queryByText('Start a conversation')).toBeNull()
    cleanup()

    navigateSpy.mockReset()
    setModelAssignment.mockResolvedValue({ confirm_message: 'no', ok: false })
    bridge(base)
    await act(async () => void render(<EngineSettings />))
    await act(async () => void fireEvent.click(screen.getByText('Start a conversation')))
    expect(navigateSpy).not.toHaveBeenCalled()
    expect(screen.getByText('Could not switch the engine.')).toBeTruthy()
  })

  it('Start a conversation tells a refusal on the status row, and a confirmed switch carries on into the chat', async () => {
    setModelAssignment.mockResolvedValueOnce({ ok: false })
    bridge(base)
    await act(async () => void render(<EngineSettings />))
    const startButton = screen.getByText('Start a conversation')
    await act(async () => void fireEvent.click(startButton))
    expect(screen.getByText('Could not switch the engine.').closest('[data-setting-row]')).toBe(
      startButton.closest('[data-setting-row]')
    )
    expect(navigateSpy).not.toHaveBeenCalled()

    setModelAssignment.mockResolvedValueOnce({ confirm_required: true, ok: false })
    await act(async () => void fireEvent.click(screen.getByText('Start a conversation')))
    await act(async () => void fireEvent.click(screen.getByText('Confirm')))
    expect(navigateSpy).toHaveBeenCalledWith('/')
  })

  it('keeps every part of the pane on THE row: sentence headings, no loose paragraph, Check again in the status row', async () => {
    bridge(base)
    let view!: ReturnType<typeof render>
    await act(async () => void (view = render(<EngineSettings />)))
    const { container } = view
    expect(screen.getByText('Choose what answers your agent')).toBeTruthy()
    expect(screen.getByText('Check that Claude Code is ready')).toBeTruthy()
    expect(container.querySelectorAll('p').length).toBe(0)
    expect(container.textContent).not.toContain('~/.claude')
    const status = container.querySelector('[data-engine-state] [data-setting-row]') as HTMLElement
    // The version and the start explanation are the hint; the title never carries a value.
    expect(status.textContent).toContain('Version 2.1.302')
    expect(status.textContent).toContain('Opens a new chat answered by Claude Code on your plan.')
    expect(status.querySelector('[data-engine-recheck]')).toBeTruthy()
    expect(status.querySelector('[data-engine-start]')).toBeTruthy()

    const privacy = screen
      .getByText('Claude Code keeps its chat history on this computer')
      .closest('[data-setting-row]')

    expect(privacy?.textContent).toContain('the engine you used before it')
  })

  it('drops the plan clause when the plan is unknown', async () => {
    bridge({ ...base, subscriptionType: null })
    await act(async () => void render(<EngineSettings />))
    expect(screen.getByText('Claude Code is signed in and ready.')).toBeTruthy()
  })

  it('Check again re-reads the bridge with refresh=true and stamps the time; it is never silent', async () => {
    bridge(base)
    await act(async () => void render(<EngineSettings />))
    expect(statusSpy).toHaveBeenCalledTimes(1)
    expect(statusSpy).toHaveBeenLastCalledWith(true)
    expect(screen.getByText(/checked \d\d:\d\d:\d\d/).textContent).toMatch(/Usage window appears after the first reply/)
    await act(async () => void fireEvent.click(screen.getByText('Check again')))
    expect(statusSpy).toHaveBeenCalledTimes(2)
    expect(statusSpy).toHaveBeenLastCalledWith(true)
  })

  it('a failing bridge is said in the catalogue words, never the bridge message, and never spins for ever', async () => {
    bridge(base)
    statusSpy.mockImplementation(async () => {
      throw new Error('claude binary exited 127')
    })
    await act(async () => void render(<EngineSettings />))
    expect(screen.getByText('Claude Code status could not be read.')).toBeTruthy()
    expect(screen.queryByText(/exited 127/)).toBeNull()
    expect(screen.queryByText('Start a conversation')).toBeNull()
  })

  it('renders the checking state before the bridge answers', () => {
    expect(statusLine(null)).toBe('Checking Claude Code…')
  })

  it('switching to Claude Code uses model.set with the engine provider and records the Nous fallback', async () => {
    const setFallback = bridge(base)
    await act(async () => void render(<EngineSettings />))
    const use = screen.getAllByText('Use')[0]
    await act(async () => void fireEvent.click(use))
    expect(setFallback).toHaveBeenCalledWith({ model: 'hermes-4', provider: 'nous' })
    expect(sent()).toEqual([['claude-code-cli', 'claude-opus-5-5']])
  })

  it('is additive: OpenRouter stays visible, Claude Code records it, and leaving returns to it', async () => {
    let current = { model: 'anthropic/claude-x', provider: 'openrouter' }
    getGlobalModelInfo.mockImplementation(async () => current)
    setModelAssignment.mockImplementation(async ({ model, provider }) => {
      current = { model, provider }

      return { ok: true }
    })
    const status = { ...base }
    const setFallback = bridge(status)
    setFallback.mockImplementation(async (target: { model: string; provider: string }) => {
      status.fallbackTarget = target

      return { ok: true as const }
    })
    await act(async () => void render(<EngineSettings />))

    const providerRow = () =>
      screen.getByText('Run your agent on OpenRouter').closest('[data-engine-row="provider"]') as HTMLElement

    // The Nous row is not "Active" for another provider; that provider is shown as the active one.
    expect(screen.getAllByText('Active').length).toBe(1)
    expect(providerRow().textContent).toContain('OpenRouter')
    expect(providerRow().textContent).toContain('Active')
    expect(providerRow().textContent).toContain('anthropic/claude-x')

    const [, useClaude] = screen.getAllByText('Use')
    await act(async () => void fireEvent.click(useClaude))
    expect(setFallback).toHaveBeenCalledWith({ model: 'anthropic/claude-x', provider: 'openrouter' })
    expect(current).toEqual({ model: 'claude-opus-5-5', provider: 'claude-code-cli' })

    // Switching Claude models keeps the recorded engine.
    await act(async () => void fireEvent.click(screen.getByText('Sonnet 5.5')))
    expect(setFallback).toHaveBeenLastCalledWith({ model: 'anthropic/claude-x', provider: 'openrouter' })

    const back = providerRow().querySelector('button') as HTMLButtonElement
    expect(back.textContent).toBe('Use')
    await act(async () => void fireEvent.click(back))
    expect(current).toEqual({ model: 'anthropic/claude-x', provider: 'openrouter' })
    expect(sent().some(([provider]) => provider === 'nous')).toBe(false)
  })

  it('is additive for a custom endpoint: its URL is recorded and sent back, never a key', async () => {
    const url = 'http://127.0.0.1:9/v1'
    let current = { model: 'my-local-model', provider: 'custom' }
    getGlobalModelInfo.mockImplementation(async () => current)
    getHermesConfigRecord.mockImplementation(async () => ({
      model: current.provider === 'custom' ? { api_key: 'sk-local', base_url: url } : { base_url: '' }
    }))
    setModelAssignment.mockImplementation(async ({ model, provider }) => {
      current = { model, provider }

      return { ok: true }
    })
    const status = { ...base }
    const setFallback = bridge(status)
    setFallback.mockImplementation(async target => {
      status.fallbackTarget = target

      return { ok: true as const }
    })
    await act(async () => void render(<EngineSettings />))
    await act(async () => void fireEvent.click(screen.getAllByText('Use')[1]))
    expect(setFallback).toHaveBeenCalledWith({ baseUrl: url, model: 'my-local-model', provider: 'custom' })
    expect(JSON.stringify(setFallback.mock.calls)).not.toContain('sk-local')

    const back = screen
      .getByText('Run your agent on custom')
      .closest('[data-engine-row="provider"]')
      ?.querySelector('button')

    await act(async () => void fireEvent.click(back as HTMLButtonElement))
    expect(setModelAssignment).toHaveBeenLastCalledWith({
      base_url: url,
      model: 'my-local-model',
      provider: 'custom',
      scope: 'main'
    })
    expect(JSON.stringify(setModelAssignment.mock.calls)).not.toContain('sk-local')
  })

  it('a guarded model shows the confirm step; Confirm re-sends with the acknowledgement', async () => {
    setModelAssignment.mockResolvedValueOnce({
      confirm_message: 'o1-pro costs $150/M.',
      confirm_required: true,
      ok: false
    })
    bridge(base)
    await act(async () => void render(<EngineSettings />))
    await act(async () => void fireEvent.click(screen.getAllByText('Use')[0]))
    expect(screen.getByText('Confirm this model before the engine switches.')).toBeTruthy()
    // The runtime's own sentence never reaches the person (S27.1).
    expect(screen.queryByText('o1-pro costs $150/M.')).toBeNull()
    await act(async () => void fireEvent.click(screen.getByText('Confirm')))
    expect(setModelAssignment).toHaveBeenLastCalledWith(
      expect.objectContaining({ confirm_expensive_model: true, provider: 'claude-code-cli' })
    )
    expect(screen.queryByText('Confirm this model before the engine switches.')).toBeNull()
  })

  it.each([
    [async () => ({ ok: false }), 'Could not switch the engine.'],
    [
      async () => {
        throw new Error('400: provider and model required for main')
      },
      'Could not switch the engine.'
    ]
  ])('a refused or failed switch shows its reason %#', async (answer, line) => {
    setModelAssignment.mockImplementationOnce(answer)
    bridge(base)
    await act(async () => void render(<EngineSettings />))
    const use = screen.getAllByText('Use')[0]
    await act(async () => void fireEvent.click(use))
    // Told on the row that asked for the switch, not on the Claude Code row.
    expect(screen.getByText(line).closest('[data-setting-row]')).toBe(use.closest('[data-setting-row]'))
  })

  it('payload, window line', () => {
    expect(engineSelection('claude', 'claude-haiku-5-5')).toEqual({
      model: 'claude-haiku-5-5',
      provider: 'claude-code-cli'
    })
    expect(engineSelection('nous', 'hermes-4')).toEqual({ model: 'hermes-4', provider: 'nous' })
    expect(windowLine(null)).toBe('Usage window appears after the first reply.')

    const line = windowLine({
      fiveHour: { resetsAt: null, utilization: 0.63 },
      isUsingOverage: false,
      sevenDay: { resetsAt: null, utilization: 0.2 },
      status: 'allowed'
    })

    expect(line).toBe('5-hour window 63% · 7-day 20%')
  })
})

describe('Engine fallback banner (U1-p2-04)', () => {
  const now = () => ({ at: Date.now(), reason: 'not_logged_in', text: 'Claude Code is not logged in' })

  it('speaks one plain line on the conversation it arrived on, and marks itself seen as it renders', async () => {
    $selectedStoredSessionId.set('chat-a')
    bridge({ ...base, lastFallback: now() })
    await act(async () => void render(<EngineFallbackBanner />))
    expect(screen.getByRole('status').textContent).toContain(enEngine.fallback)
    expect(screen.queryByText(/Claude Code|logged in|Stay on/)).toBeNull()
    expect(localStorage.getItem('iclone.engine.fallbackSeen')).not.toBeNull()
    expect(statusSpy).not.toHaveBeenCalled()
    expect(setModelAssignment).not.toHaveBeenCalled()
  })

  it('"Why?" opens Settings > Engine and takes the line away', async () => {
    $selectedStoredSessionId.set('chat-a')
    bridge({ ...base, lastFallback: now() })
    await act(async () => void render(<EngineFallbackBanner />))
    await act(async () => void fireEvent.click(screen.getByText(enEngine.fix)))
    expect(navigateSpy).toHaveBeenCalledWith(`${SETTINGS_ROUTE}?tab=engine`)
    expect(screen.queryByRole('status')).toBeNull()
    expect(sent()).toEqual([])
  })

  it('the close button dismisses it without touching the engine choice', async () => {
    $selectedStoredSessionId.set('chat-a')
    bridge({ ...base, lastFallback: now() })
    await act(async () => void render(<EngineFallbackBanner />))
    await act(async () => void fireEvent.click(screen.getByLabelText(enEngine.dismiss)))
    expect(screen.queryByRole('status')).toBeNull()
    expect(setModelAssignment).not.toHaveBeenCalled()
  })

  it('K54: the next answers that fall back for the same reason stay silent; another reason speaks once', async () => {
    $selectedStoredSessionId.set('chat-a')
    bridge({ ...base, lastFallback: now() })
    await act(async () => void render(<EngineFallbackBanner />))
    expect(screen.getByRole('status')).toBeTruthy()
    cleanup()

    // The next answer in the same conversation falls back again (Nous not signed in): consumed, not shown.
    const second = { ...now(), at: Date.now() + 5 }

    bridge({ ...base, lastFallback: second })
    await act(async () => void render(<EngineFallbackBanner />))
    expect(screen.queryByRole('status')).toBeNull()
    expect(localStorage.getItem('iclone.engine.fallbackSeen')).toBe(String(second.at))
    cleanup()

    bridge({ ...base, lastFallback: { ...now(), at: Date.now() + 10, reason: 'rate_limited' } })
    await act(async () => void render(<EngineFallbackBanner />))
    expect(screen.getByRole('status')).toBeTruthy()
  })

  it('stays silent on an empty stage and leaves with its conversation', async () => {
    $selectedStoredSessionId.set(null)
    bridge({ ...base, lastFallback: now() })
    await act(async () => void render(<EngineFallbackBanner />))
    expect(screen.queryByRole('status')).toBeNull()
    cleanup()

    $selectedStoredSessionId.set('chat-a')
    bridge({ ...base, lastFallback: { ...now(), at: Date.now() + 1 } })
    await act(async () => void render(<EngineFallbackBanner />))
    expect(screen.getByRole('status')).toBeTruthy()
    await act(async () => void $selectedStoredSessionId.set('chat-b'))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('stays hidden when seen or stale', () => {
    const f = { at: 1000, reason: 'r', text: 't' }
    expect(freshFallback(f, 1000, 2000)).toBeNull()
    expect(freshFallback(f, 0, 1000 + 11 * 60_000)).toBeNull()
    expect(freshFallback(f, 0, 2000)).toEqual(f)
  })
})
