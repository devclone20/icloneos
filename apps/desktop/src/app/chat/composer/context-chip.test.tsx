import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PRIMARY_SESSION_VIEW, type SessionView, SessionViewProvider } from '@/app/chat/session-view'
import { ContextCard } from '@/app/context-panel/context-panel'
import { emitGatewayEvent } from '@/contrib/events'
import { createClientSessionState } from '@/lib/chat-runtime'
import { $activeSessionId, setCurrentUsage } from '@/store/session'
import { $sessionStates } from '@/store/session-states'
import type { ContextBreakdown, UsageStats } from '@/types/hermes'

import { bandContextDoorSurfaces, claimBandContextDoor, ContextChip } from './context-chip'

const { getHermesConfigRecord, getUsageAnalytics, request } = vi.hoisted(() => ({
  getHermesConfigRecord: vi.fn(),
  getUsageAnalytics: vi.fn(),
  request: vi.fn()
}))

vi.mock('@/store/gateway', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  $gateway: (await import('nanostores')).atom({ request })
}))

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getHermesConfigRecord: (...args: unknown[]) => getHermesConfigRecord(...args),
  getUsageAnalytics: (...args: unknown[]) => getUsageAnalytics(...args)
}))

// Real `session.context_breakdown` payloads (2026-10-18): the first two from the
// runtime's own compute_session_context_breakdown on stub agents (lab backend),
// the third returned by lab 2 for a resumed session whose agent is not built.
const FIXTURES: Record<string, ContextBreakdown> = {
  claude200k: {
    categories: [
      { color: 'var(--ic-ctx-0)', id: 'system_prompt', label: 'System prompt', tokens: 1205 },
      { color: 'var(--ic-ctx-1)', id: 'tool_definitions', label: 'Tool definitions', tokens: 398 },
      { color: 'var(--ic-ctx-2)', id: 'rules', label: 'Rules', tokens: 725 },
      { color: 'var(--ic-ctx-3)', id: 'skills', label: 'Skills', tokens: 290 },
      { color: 'var(--ic-ctx-4)', id: 'mcp', label: 'MCP', tokens: 220 },
      {
        color: 'var(--ic-ctx-5)',
        id: 'subagent_definitions',
        label: 'Subagent definitions',
        tokens: 256
      },
      { color: 'var(--ic-ctx-6)', id: 'conversation', label: 'Conversation', tokens: 1292 }
    ],
    context_max: 200_000,
    context_percent: 2,
    context_used: 4386,
    estimated_total: 4386,
    model: 'anthropic/claude-sonnet-4-6'
  },
  gpt1m: {
    categories: [
      { color: 'var(--ic-ctx-0)', id: 'system_prompt', label: 'System prompt', tokens: 5005 },
      { color: 'var(--ic-ctx-1)', id: 'tool_definitions', label: 'Tool definitions', tokens: 323 },
      { color: 'var(--ic-ctx-3)', id: 'skills', label: 'Skills', tokens: 2185 },
      { color: 'var(--ic-ctx-6)', id: 'conversation', label: 'Conversation', tokens: 50_017 }
    ],
    context_max: 1_000_000,
    context_percent: 41,
    context_used: 412_345,
    estimated_total: 57_530,
    model: 'openai/gpt-5.5'
  },
  noAgent: { categories: [], context_max: 0, context_percent: 0, context_used: 0, estimated_total: 0, model: '' }
}

const usageFrom = (b: ContextBreakdown, over: Partial<UsageStats> = {}): UsageStats => ({
  cache_read: 1200,
  calls: 3,
  context_max: b.context_max,
  context_percent: b.context_percent,
  context_used: b.context_used,
  cost_usd: 1.23,
  input: 900,
  output: 300,
  reasoning: 40,
  total: 1200,
  ...over
})

let bandDoorsRaised: (() => void)[] = []

const raiseBandDoor = (view: SessionView) => {
  const lower = claimBandContextDoor(view)

  bandDoorsRaised.push(lower)

  return lower
}

/**
 * A session TILE's view: the atom shape session-tile.tsx builds (its own
 * `$runtimeId`, `kind: 'tile'`), which is what makes it a SECOND chat surface
 * in the same document. The chip reads only those two plus the usage atom
 * keyed by this very object (use-context-panel.ts), so its state comes from
 * `$sessionStates[runtimeId].usage` — never the primary's global mirror.
 */
const tileView = (runtimeId: string): SessionView => ({
  ...PRIMARY_SESSION_VIEW,
  $runtimeId: atom<null | string>(runtimeId),
  kind: 'tile'
})

const publishTileUsage = (runtimeId: string, usage: UsageStats) =>
  $sessionStates.set({ ...$sessionStates.get(), [runtimeId]: { ...createClientSessionState('stored-1'), usage } })

const ANALYTICS = {
  by_model: [],
  by_task: [{ input_tokens: 2000, output_tokens: 500, task: 'compression' }],
  daily: [
    {
      actual_cost: 4.5,
      api_calls: 6,
      cache_read_tokens: 10,
      day: new Date().toISOString().slice(0, 10),
      estimated_cost: 4.5,
      input_tokens: 5000,
      output_tokens: 700,
      reasoning_tokens: 0,
      sessions: 2
    }
  ],
  period_days: 1
}

async function renderCard(fixture: ContextBreakdown, usage: null | UsageStats) {
  request.mockResolvedValue(fixture)
  $activeSessionId.set('rt-1')
  setCurrentUsage(usage ?? { calls: 0, input: 0, output: 0, total: 0 })

  const view = render(<ContextCard view={PRIMARY_SESSION_VIEW} />)

  await act(async () => {})

  return view
}

beforeEach(() => {
  getUsageAnalytics.mockResolvedValue(ANALYTICS)
  getHermesConfigRecord.mockResolvedValue({ compression: { threshold: 0.5 } })
})

afterEach(() => {
  cleanup()

  for (const lower of bandDoorsRaised) {
    lower()
  }

  bandDoorsRaised = []
  $sessionStates.set({})
  request.mockReset()
  $activeSessionId.set(null)
  setCurrentUsage({ calls: 0, input: 0, output: 0, total: 0 })
  vi.unstubAllGlobals()
})

describe('ContextCard on real runtime payloads', () => {
  it.each(['claude200k', 'gpt1m'])(
    '%s: rows === runtime categories, Σ rows === estimated_total, free === max − used',
    async key => {
      const fixture = FIXTURES[key]!
      await renderCard(fixture, usageFrom(fixture))

      const rows = within(screen.getByTestId('context-rows'))
        .getAllByRole('listitem')
        .filter(row => row.dataset.category)

      expect(rows.map(row => row.dataset.category)).toEqual(fixture.categories.map(category => category.id))
      expect(rows.map(row => row.querySelector('.ic-ctx-label')?.textContent)).toEqual(
        fixture.categories.map(category => category.label)
      )
      expect(rows.reduce((sum, row) => sum + Number(row.dataset.tokens), 0)).toBe(fixture.estimated_total)
      expect(Number(screen.getByTestId('context-free').dataset.free)).toBe(fixture.context_max - fixture.context_used)
      expect(screen.getByTestId('context-percent').textContent).toBe(`${fixture.context_percent}%`)

      const bar = screen.getByRole('progressbar')

      expect(bar.getAttribute('aria-valuenow')).toBe(String(fixture.context_percent))
      expect(bar.querySelectorAll('.ic-ctx-seg')).toHaveLength(fixture.categories.length)
    }
  )

  it.each(Object.keys(FIXTURES))('%s: tokens only — no currency anywhere in the card', async key => {
    const fixture = FIXTURES[key]!
    const { container } = await renderCard(fixture, fixture.context_max ? usageFrom(fixture) : null)

    expect(container.textContent ?? '').not.toMatch(/\$|USD|€|cost/i)
  })

  it('shows the estimated auto-compact threshold and the distance to it', async () => {
    await renderCard(FIXTURES.claude200k!, usageFrom(FIXTURES.claude200k!))

    const row = screen.getByTestId('context-autocompact')

    expect(row.dataset.threshold).toBe('150000')
    expect(row.textContent).toContain('estimated')
    expect(row.textContent).toContain('~145.6k')
  })

  it('renders an honest pending state when the agent is not built yet', async () => {
    await renderCard(FIXTURES.noAgent!, null)

    expect(screen.queryByTestId('context-rows')).toBeNull()
    expect(screen.getByRole('status').textContent).toMatch(/appears once the agent has started/)
  })

  it('shows session and today spend from usage and analytics', async () => {
    await renderCard(FIXTURES.claude200k!, usageFrom(FIXTURES.claude200k!))

    const session = screen.getByRole('region', { name: /this session/i })
    const today = screen.getByRole('region', { name: /today/i })

    expect(within(session).getByText('Reasoning').nextSibling?.textContent).toBe('40')
    expect(within(today).getByText('API calls').nextSibling?.textContent).toBe('6')
    expect(screen.getByRole('region', { name: /background tasks · last 24 h/i }).textContent).toContain('2.5k')
  })

  it('shows no today block when the runtime reported nothing for today', async () => {
    getUsageAnalytics.mockResolvedValue({ ...ANALYTICS, by_task: [], daily: [] })
    await renderCard(FIXTURES.claude200k!, usageFrom(FIXTURES.claude200k!))

    expect(screen.queryByRole('region', { name: /today/i })).toBeNull()
    expect(screen.getByRole('region', { name: /this session/i })).toBeTruthy()
  })

  it("mounts G2's Compact session action in the card footer", async () => {
    const { container } = await renderCard(FIXTURES.claude200k!, usageFrom(FIXTURES.claude200k!))
    const footer = container.querySelector('.ic-ctx-footer')

    expect(footer).not.toBeNull()
    expect(within(footer as HTMLElement).getByTestId('compact-session-button').textContent).toMatch(/compact/i)
  })

  it('announces the bar with the copy module text, estimated values marked', async () => {
    const fixture = FIXTURES.claude200k!
    await renderCard(fixture, usageFrom(fixture, { context_source: 'local_estimate' }))

    expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toMatch(
      new RegExp(`^${fixture.context_percent}%, ~[\\d.]+k of [\\d.]+k tokens$`)
    )
  })
})

describe('ContextChip', () => {
  it('stays hidden until the runtime reports a context window', () => {
    $activeSessionId.set('rt-1')
    render(<ContextChip />)

    expect(screen.queryByTestId('context-chip')).toBeNull()
  })

  /**
   * LEAD DECISION 2026-10-19 17:10 (gates/L/fronts.json): one door per surface. The owner asked for a
   * context door on the Message window's head band, and the chip is ~300px away on the same surface —
   * so where that door is mounted the chip stands down, and ONLY there: with no band (the HUD and the
   * browser popout are their own windows, hence their own module state) the chip is the only way in.
   */
  it('yields to the Message band door, and comes back when it goes', () => {
    $activeSessionId.set('rt-1')
    setCurrentUsage(usageFrom(FIXTURES.claude200k!, { context_percent: 39, context_used: 78_000 }))

    const view = render(<ContextChip />)

    expect(screen.getByTestId('context-chip')).toBeTruthy()

    let lower = () => {}

    act(() => {
      lower = raiseBandDoor(PRIMARY_SESSION_VIEW)
    })
    expect(screen.queryByTestId('context-chip')).toBeNull()

    act(() => lower())
    expect(screen.getByTestId('context-chip')).toBeTruthy()

    view.unmount()
  })

  /**
   * M1-r2-01: the yield is per SURFACE, not per document. Two chips on screen,
   * one surface's door raised — the OTHER chip stays, because it is the only
   * door to that surface's own numbers (lead grant b: "Where it cannot be
   * proven for a mount, the chip STAYS"). r2's module-wide boolean made both
   * null here, which is the defect this case pins.
   */
  it('hides only the chip of the surface that has the band door', () => {
    $activeSessionId.set('rt-primary')
    setCurrentUsage(usageFrom(FIXTURES.claude200k!, { context_percent: 39, context_used: 78_000 }))
    publishTileUsage('rt-tile', usageFrom(FIXTURES.gpt1m!, { context_percent: 12, context_used: 120_000 }))

    const tile = tileView('rt-tile')

    const view = render(
      <>
        <ContextChip />
        <SessionViewProvider value={tile}>
          <ContextChip />
        </SessionViewProvider>
      </>
    )

    expect(screen.getAllByTestId('context-chip')).toHaveLength(2)

    act(() => {
      raiseBandDoor(PRIMARY_SESSION_VIEW)
    })

    const left = screen.getAllByTestId('context-chip')

    expect(left).toHaveLength(1)
    expect(within(left[0]!).getByTestId('context-chip-percent').textContent).toBe('12%')
    expect(bandContextDoorSurfaces().has(tile)).toBe(false)
    // The live gate reads this seam: one claimed surface, the primary's.
    expect((window as unknown as { __icloneContextDoors?: () => string[] }).__icloneContextDoors?.()).toEqual([
      'primary'
    ])

    view.unmount()
  })

  /** The claim is counted: a remount (strict mode runs the effect twice) must
   *  not leave the door up, and the first cleanup must not drop the second. */
  it('keeps the door up while any claim is held', () => {
    $activeSessionId.set('rt-1')
    setCurrentUsage(usageFrom(FIXTURES.claude200k!, { context_percent: 39, context_used: 78_000 }))

    const view = render(<ContextChip />)

    let first = () => {}

    let second = () => {}

    act(() => {
      first = raiseBandDoor(PRIMARY_SESSION_VIEW)
      second = raiseBandDoor(PRIMARY_SESSION_VIEW)
    })

    act(() => {
      first()
      first()
    })
    expect(screen.queryByTestId('context-chip')).toBeNull()

    act(() => second())
    expect(screen.getByTestId('context-chip')).toBeTruthy()
    expect(bandContextDoorSurfaces().size).toBe(0)

    view.unmount()
  })

  it('paints from cached usage, follows live ticks and opens the card', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        disconnect() {}
        observe() {}
        unobserve() {}
      }
    )
    request.mockResolvedValue(FIXTURES.claude200k)
    $activeSessionId.set('rt-1')
    setCurrentUsage(usageFrom(FIXTURES.claude200k!, { context_percent: 39, context_used: 78_000 }))
    render(<ContextChip />)

    const chip = screen.getByTestId('context-chip')

    expect(chip.textContent).toContain('39%')
    expect(chip.getAttribute('aria-label')).toBe('Context 39% used, 78k of 200k tokens')

    act(() => {
      setCurrentUsage(current => ({ ...current, context_percent: 41, context_used: 82_000 }))
    })
    expect(screen.getByTestId('context-chip-percent').textContent).toBe('41%')

    await act(async () => {
      fireEvent.pointerDown(chip, { button: 0, ctrlKey: false, pointerType: 'mouse' })
      fireEvent.click(chip)
    })

    expect(await screen.findByTestId('context-card')).toBeTruthy()

    await act(async () => {
      emitGatewayEvent({ payload: {}, session_id: 'rt-1', type: 'message.complete' })
      // A turn boundary inside the 1 s window joins the throttle's trailing read.
      await new Promise(resolve => setTimeout(resolve, 1050))
    })
    expect(request.mock.calls.filter(([method]) => method === 'session.context_breakdown').length).toBeGreaterThan(1)
  })
})
