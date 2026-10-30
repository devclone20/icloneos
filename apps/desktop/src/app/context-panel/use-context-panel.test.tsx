import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { emitGatewayEvent, onGatewayEvent } from '@/contrib/events'

import {
  BREAKDOWN_MIN_INTERVAL_MS,
  createRefreshScheduler,
  SPEND_REFRESH_MS,
  useContextPanelData
} from './use-context-panel'

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

const breakdownCalls = () => request.mock.calls.filter(([method]) => method === 'session.context_breakdown')

beforeEach(() => {
  vi.useFakeTimers()
  request.mockResolvedValue({ categories: [], context_max: 0, context_percent: 0, context_used: 0, estimated_total: 0 })
  getUsageAnalytics.mockResolvedValue({ by_model: [], daily: [], period_days: 1 })
  getHermesConfigRecord.mockResolvedValue({ compression: { threshold: 0.5 } })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  request.mockReset()
  getUsageAnalytics.mockReset()
  getHermesConfigRecord.mockReset()
})

describe('createRefreshScheduler', () => {
  it('runs the first request at once and collapses the rest of the window into one trailing run', () => {
    const run = vi.fn()
    const scheduler = createRefreshScheduler(run, 1000)

    scheduler.request()
    scheduler.request()
    scheduler.request()
    expect(run).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(999)
    expect(run).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(run).toHaveBeenCalledTimes(2)

    scheduler.flush()
    expect(run).toHaveBeenCalledTimes(3)
    scheduler.request()
    scheduler.cancel()
    vi.advanceTimersByTime(5000)
    expect(run).toHaveBeenCalledTimes(3)
  })
})

describe('useContextPanelData', () => {
  it('stays idle while closed', () => {
    renderHook(() => useContextPanelData('rt-1', false))

    expect(request).not.toHaveBeenCalled()
    expect(getUsageAnalytics).not.toHaveBeenCalled()
  })

  it('reads the breakdown at most once per second while usage ticks stream', async () => {
    renderHook(() => useContextPanelData('rt-1', true))
    await act(async () => {})
    expect(breakdownCalls()).toHaveLength(1)
    expect(breakdownCalls()[0]?.[1]).toEqual({ session_id: 'rt-1' })

    // 5 ticks at 200 ms spacing inside one second, plus one for another session.
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        emitGatewayEvent({ payload: { usage: {} }, session_id: 'rt-1', type: 'session.usage' })
        emitGatewayEvent({ payload: { usage: {} }, session_id: 'rt-other', type: 'session.usage' })
        vi.advanceTimersByTime(200)
      })
    }

    await act(async () => {
      vi.advanceTimersByTime(BREAKDOWN_MIN_INTERVAL_MS)
    })

    expect(breakdownCalls().length).toBeLessThanOrEqual(3)
    expect(breakdownCalls().length).toBeLessThanOrEqual(1 + 5)
  })

  it('re-reads at once on message.complete and refreshes spend with it', async () => {
    renderHook(() => useContextPanelData('rt-1', true))
    await act(async () => {
      vi.advanceTimersByTime(BREAKDOWN_MIN_INTERVAL_MS)
    })
    const before = breakdownCalls().length
    const spendBefore = getUsageAnalytics.mock.calls.length

    await act(async () => {
      emitGatewayEvent({ payload: {}, session_id: 'rt-1', type: 'message.complete' })
    })

    expect(breakdownCalls().length).toBe(before + 1)
    expect(getUsageAnalytics.mock.calls.length).toBe(spendBefore + 1)
    expect(getUsageAnalytics).toHaveBeenCalledWith(1)
  })

  it('folds a turn boundary inside the 1 s window into the trailing run (never > 1 read/s)', async () => {
    renderHook(() => useContextPanelData('rt-1', true))
    await act(async () => {})
    expect(breakdownCalls()).toHaveLength(1)

    await act(async () => {
      emitGatewayEvent({ payload: { usage: {} }, session_id: 'rt-1', type: 'session.usage' })
      emitGatewayEvent({ payload: {}, session_id: 'rt-1', type: 'session.info' })
      emitGatewayEvent({ payload: {}, session_id: 'rt-1', type: 'message.complete' })
    })
    expect(breakdownCalls()).toHaveLength(1)

    await act(async () => {
      vi.advanceTimersByTime(BREAKDOWN_MIN_INTERVAL_MS)
    })
    expect(breakdownCalls()).toHaveLength(2)
  })

  it('keeps a live run of ticks and turn ends at one read per second, one trailing read per turn end', async () => {
    const at: number[] = []

    request.mockImplementation(async (method: string) => {
      if (method === 'session.context_breakdown') {
        at.push(Date.now())
      }

      return { categories: [], context_max: 0, context_percent: 0, context_used: 0, estimated_total: 0 }
    })
    renderHook(() => useContextPanelData('rt-1', true))
    await act(async () => {})

    // The live lab-2 gate's shape: 3 turns of 6 usage ticks (700 ms apart), each closed by message.complete + session.info.
    const turns = 3
    const ticksPerTurn = 6

    for (let turn = 0; turn < turns; turn += 1) {
      for (let tick = 0; tick < ticksPerTurn; tick += 1) {
        await act(async () => {
          emitGatewayEvent({ payload: { usage: {} }, session_id: 'rt-1', type: 'session.usage' })
          emitGatewayEvent({ payload: {}, session_id: 'rt-1', type: 'tool.complete' })
          vi.advanceTimersByTime(700)
        })
      }

      await act(async () => {
        emitGatewayEvent({ payload: {}, session_id: 'rt-1', type: 'message.complete' })
        emitGatewayEvent({ payload: {}, session_id: 'rt-1', type: 'session.info' })
        vi.advanceTimersByTime(1500)
      })
    }

    const gaps = at.slice(1).map((t, i) => t - (at[i] ?? t))

    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(BREAKDOWN_MIN_INTERVAL_MS)
    expect(at.length).toBeLessThanOrEqual(turns * ticksPerTurn + turns + 1)
    // The read after each turn end lands after the turn's last tick: the card settles on the finished turn.
    expect(at.at(-1)).toBeGreaterThanOrEqual(Date.now() - 1500)
  })

  it('refreshes spend every 60 s and unsubscribes on close', async () => {
    const probe = vi.fn()
    const off = onGatewayEvent('session.usage', probe)
    const { result, unmount } = renderHook(() => useContextPanelData('rt-1', true))

    await act(async () => {})
    expect(result.current.compression?.thresholdPercent).toBe(0.5)
    const spendCalls = getUsageAnalytics.mock.calls.length

    await act(async () => {
      vi.advanceTimersByTime(SPEND_REFRESH_MS)
    })
    expect(getUsageAnalytics.mock.calls.length).toBe(spendCalls + 1)

    unmount()
    const afterClose = breakdownCalls().length

    emitGatewayEvent({ payload: {}, session_id: 'rt-1', type: 'message.complete' })
    vi.advanceTimersByTime(SPEND_REFRESH_MS * 2)
    expect(breakdownCalls().length).toBe(afterClose)
    off()
  })

  it('keeps the last breakdown and flags the error when the RPC fails', async () => {
    request.mockResolvedValueOnce({
      categories: [{ color: '', id: 'a', label: 'A', tokens: 5 }],
      context_max: 10,
      context_percent: 50,
      context_used: 5,
      estimated_total: 5
    })

    const { result } = renderHook(() => useContextPanelData('rt-err', true))

    await act(async () => {})
    expect(result.current.breakdown?.estimated_total).toBe(5)

    request.mockRejectedValueOnce(new Error('closed'))
    await act(async () => {
      emitGatewayEvent({ payload: {}, session_id: 'rt-err', type: 'session.info' })
      vi.advanceTimersByTime(BREAKDOWN_MIN_INTERVAL_MS)
    })

    expect(result.current.breakdownError).toBe(true)
    expect(result.current.breakdown?.estimated_total).toBe(5)
  })
})
