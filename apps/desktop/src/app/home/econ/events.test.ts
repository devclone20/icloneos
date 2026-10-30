import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invalidateAcp = vi.hoisted(() => vi.fn())

vi.mock('./cli', () => ({ invalidateAcp }))

import {
  $acpStreamLive,
  applyAcpEvent,
  COALESCE_MS,
  HIDDEN_STOP_MS,
  invalidationsFor,
  parseAcpEvent,
  RELEASE_MS,
  resetAcpEventsForTests,
  useAcpEvents
} from './events'
import { STREAM_FALLBACK_SECS, useAutoRefresh } from './live'
import { $liveEconEnabled, $liveEconIntervalSecs } from './prefs'

const SLUG = 'inft-6'

function fakeBridge() {
  const listeners = new Set<(payload: unknown) => void>()
  const watch = vi.fn(async (slug: string | null) => ({ ok: true as const, slug }))

  const onEvent = vi.fn((callback: (payload: unknown) => void) => {
    listeners.add(callback)

    return () => listeners.delete(callback)
  })

  Object.assign(window, { hermesDesktop: { icloneAcp: { watch, onEvent } } })

  return { listeners, watch, onEvent, push: (payload: unknown) => listeners.forEach(fn => fn(payload)) }
}

const job = (type = 'job.funded') => ({ slug: SLUG, source: 'jobs', type, jobId: '42', status: 'TRANSACTION', at: 1 })

function setVisibility(value: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  $liveEconEnabled.set(true)
  $liveEconIntervalSecs.set(60)
  invalidateAcp.mockClear()
  resetAcpEventsForTests()
})

afterEach(() => {
  cleanup()
  resetAcpEventsForTests()
  vi.useRealTimers()
})

describe('parseAcpEvent / invalidationsFor / applyAcpEvent', () => {
  it('accepts only the bare event shape', () => {
    expect(parseAcpEvent(job())).toEqual(job())
    expect(parseAcpEvent({ ...job(), slug: '../x' })).toBeNull()
    expect(parseAcpEvent({ ...job(), source: 'mail' })).toBeNull()
    expect(parseAcpEvent({ ...job(), type: 'Job Funded!' })).toBeNull()
    expect(parseAcpEvent(null)).toBeNull()
  })

  it('maps job events to the job, events and offering reads (+ wallet when money moved)', () => {
    expect(invalidationsFor('job.created')).toEqual([['job'], ['events'], ['offering']])
    expect(invalidationsFor('job.message')).toEqual([['job'], ['events'], ['offering']])
    expect(invalidationsFor('job.completed')).toContainEqual(['wallet'])
    expect(invalidationsFor('stream.live')).toEqual([['job'], ['events'], ['offering']])
    expect(invalidationsFor('stream.down')).toEqual([])
  })

  it('a (re)connect marks the slug live and invalidates once; a drop clears it without a re-read', () => {
    expect(applyAcpEvent({ ...job('stream.live'), source: 'stream' })).toBe(true)
    expect($acpStreamLive.get()[SLUG]).toBe(true)
    expect(invalidateAcp.mock.calls).toEqual([
      [SLUG, ['job']],
      [SLUG, ['events']],
      [SLUG, ['offering']]
    ])

    invalidateAcp.mockClear()
    expect(applyAcpEvent({ ...job('stream.down'), source: 'stream' })).toBe(false)
    expect($acpStreamLive.get()[SLUG]).toBe(false)
    expect(invalidateAcp).not.toHaveBeenCalled()
  })
})

describe('useAcpEvents', () => {
  it('one bridge listener per window, watch(slug) on mount, a burst = one silent re-read, watch(null) on unmount', async () => {
    const bridge = fakeBridge()
    const onChange = vi.fn()

    const first = renderHook(() => useAcpEvents(SLUG, onChange))
    const second = renderHook(() => useAcpEvents(SLUG, () => undefined))

    expect(bridge.onEvent).toHaveBeenCalledTimes(1)
    expect(bridge.watch).toHaveBeenCalledWith(SLUG)

    act(() => {
      bridge.push(job('job.created'))
      bridge.push(job('budget.set'))
      bridge.push(job('job.funded'))
    })
    expect(onChange).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(COALESCE_MS))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(invalidateAcp).toHaveBeenCalledWith(SLUG, ['job'])

    first.unmount()
    await act(async () => vi.advanceTimersByTimeAsync(RELEASE_MS))
    expect(bridge.watch).not.toHaveBeenCalledWith(null)
    second.unmount()
    // The pending let-go keeps the bridge listener: a stream.stopped/down inside the gap must still be heard.
    expect(bridge.listeners.size).toBe(1)
    await act(async () => vi.advanceTimersByTimeAsync(RELEASE_MS - 1))
    expect(bridge.watch).not.toHaveBeenCalledWith(null)
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(bridge.watch).toHaveBeenLastCalledWith(null)
    expect(bridge.listeners.size).toBe(0)
  })

  it('a remount inside RELEASE_MS (StrictMode, HMR) keeps the stream: no watch(null), no second start', async () => {
    const bridge = fakeBridge()

    renderHook(() => useAcpEvents(SLUG, () => undefined)).unmount()
    await act(async () => vi.advanceTimersByTimeAsync(RELEASE_MS - 1))
    renderHook(() => useAcpEvents(SLUG, () => undefined))
    await act(async () => vi.advanceTimersByTimeAsync(RELEASE_MS * 4))

    expect(bridge.watch.mock.calls).toEqual([[SLUG]])
  })

  it('close then reopen after RELEASE_MS asks main again, and the stream.live of the new child reaches the window', async () => {
    const bridge = fakeBridge()
    const onChange = vi.fn()

    renderHook(() => useAcpEvents(SLUG, () => undefined)).unmount()
    await act(async () => vi.advanceTimersByTimeAsync(RELEASE_MS))
    renderHook(() => useAcpEvents(SLUG, onChange))
    act(() => bridge.push({ slug: SLUG, source: 'stream', type: 'stream.live', jobId: null, status: null, at: 1 }))
    await act(async () => vi.advanceTimersByTimeAsync(COALESCE_MS))

    expect(bridge.watch.mock.calls).toEqual([[SLUG], [null], [SLUG]])
    expect(onChange).toHaveBeenCalledTimes(1)
    expect($acpStreamLive.get()[SLUG]).toBe(true)
  })

  it('remount_after_live_keeps_live: live, unmount, remount inside RELEASE_MS — still live, the period stays 300 s', async () => {
    const bridge = fakeBridge()
    const load = vi.fn(async () => undefined)
    const live = { slug: SLUG, source: 'stream', type: 'stream.live', jobId: null, status: null, at: 1 }

    renderHook(() => useAutoRefresh('acp', SLUG, load, [], 0, { streamed: true }))
    const first = renderHook(() => useAcpEvents(SLUG, () => undefined))

    act(() => bridge.push(live))
    await act(async () => vi.advanceTimersByTimeAsync(COALESCE_MS))
    expect($acpStreamLive.get()[SLUG]).toBe(true)
    const loads = load.mock.calls.length

    first.unmount()
    expect($acpStreamLive.get()[SLUG]).toBe(true)
    await act(async () => vi.advanceTimersByTimeAsync(RELEASE_MS - 1))
    renderHook(() => useAcpEvents(SLUG, () => undefined))
    await act(async () => vi.advanceTimersByTimeAsync(RELEASE_MS * 4))

    expect(bridge.watch.mock.calls).toEqual([[SLUG]])
    expect($acpStreamLive.get()[SLUG]).toBe(true)
    // The Settings period (60 s) would have ticked by now; the stream's 300 s has not.
    await act(async () => vi.advanceTimersByTimeAsync(STREAM_FALLBACK_SECS * 1000 - RELEASE_MS * 5 - COALESCE_MS - 1))
    expect(load).toHaveBeenCalledTimes(loads)
  })

  it('the flag drops only when the stream is really let go (debounced release, hidden stop, stream.down)', async () => {
    const bridge = fakeBridge()
    const live = { slug: SLUG, source: 'stream', type: 'stream.live', jobId: null, status: null, at: 1 }

    const view = renderHook(() => useAcpEvents(SLUG, () => undefined))

    act(() => bridge.push(live))
    view.unmount()
    await act(async () => vi.advanceTimersByTimeAsync(RELEASE_MS))
    expect($acpStreamLive.get()[SLUG]).toBe(false)

    renderHook(() => useAcpEvents(SLUG, () => undefined))
    act(() => bridge.push(live))
    act(() => setVisibility('hidden'))
    await act(async () => vi.advanceTimersByTimeAsync(HIDDEN_STOP_MS - 1))
    expect($acpStreamLive.get()[SLUG]).toBe(true)
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect($acpStreamLive.get()[SLUG]).toBe(false)

    act(() => setVisibility('visible'))
    act(() => bridge.push(live))
    act(() => bridge.push({ ...live, type: 'stream.down' }))
    expect($acpStreamLive.get()[SLUG]).toBe(false)
  })

  it('stream.up (main: the same child is already connected) sets live with no re-read', async () => {
    const bridge = fakeBridge()
    const onChange = vi.fn()

    renderHook(() => useAcpEvents(SLUG, onChange))
    act(() => bridge.push({ slug: SLUG, source: 'stream', type: 'stream.up', jobId: null, status: null, at: 1 }))
    await act(async () => vi.advanceTimersByTimeAsync(COALESCE_MS * 2))

    expect($acpStreamLive.get()[SLUG]).toBe(true)
    expect(invalidateAcp).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('two_slugs_survivor_watched: B closes while A is held — main is asked for A again, never null', async () => {
    const bridge = fakeBridge()

    const a = renderHook(() => useAcpEvents('inft-a', () => undefined))
    const b = renderHook(() => useAcpEvents('inft-b', () => undefined))

    b.unmount()
    await act(async () => vi.advanceTimersByTimeAsync(RELEASE_MS))
    expect(bridge.watch.mock.calls).toEqual([['inft-a'], ['inft-b'], ['inft-a']])

    a.unmount()
    await act(async () => vi.advanceTimersByTimeAsync(RELEASE_MS))
    expect(bridge.watch.mock.calls).toEqual([['inft-a'], ['inft-b'], ['inft-a'], [null]])
  })

  it('a slug replaced in main lets go silently: no watch(null) while the newer slug is held', async () => {
    const bridge = fakeBridge()

    const a = renderHook(() => useAcpEvents('inft-a', () => undefined))

    renderHook(() => useAcpEvents('inft-b', () => undefined))
    a.unmount()
    await act(async () => vi.advanceTimersByTimeAsync(RELEASE_MS))

    expect(bridge.watch.mock.calls).toEqual([['inft-a'], ['inft-b']])
  })

  const stream = (type: string) => ({ slug: SLUG, source: 'stream', type, jobId: null, status: null, at: 1 })

  for (const type of ['stream.stopped', 'stream.down']) {
    const id = type === 'stream.stopped' ? 'gap_stream_stopped_not_live' : 'gap_stream_down_not_live'

    it(`${id}: a ${type} inside RELEASE_MS clears live, and a remount in the gap asks main again`, async () => {
      const bridge = fakeBridge()

      renderHook(() => useAcpEvents(SLUG, () => undefined)).unmount()
      act(() => bridge.push(stream('stream.live')))
      expect($acpStreamLive.get()[SLUG]).toBe(true)

      const first = renderHook(() => useAcpEvents(SLUG, () => undefined))

      first.unmount()
      await act(async () => vi.advanceTimersByTimeAsync(RELEASE_MS / 2))
      act(() => bridge.push(stream(type)))
      expect($acpStreamLive.get()[SLUG]).toBe(false)

      renderHook(() => useAcpEvents(SLUG, () => undefined))
      await act(async () => vi.advanceTimersByTimeAsync(RELEASE_MS * 4))

      expect($acpStreamLive.get()[SLUG]).toBe(false)
      expect(bridge.watch.mock.calls).toEqual([[SLUG], [SLUG]])
    })
  }

  it('a reconnect inside the gap (down then live) needs no re-ask; the listener detaches only when idle', async () => {
    const bridge = fakeBridge()

    renderHook(() => useAcpEvents(SLUG, () => undefined)).unmount()
    act(() => {
      bridge.push(stream('stream.live'))
      bridge.push(stream('stream.down'))
      bridge.push(stream('stream.live'))
    })
    expect(bridge.listeners.size).toBe(1)

    const again = renderHook(() => useAcpEvents(SLUG, () => undefined))

    expect(bridge.watch.mock.calls).toEqual([[SLUG]])
    expect($acpStreamLive.get()[SLUG]).toBe(true)

    again.unmount()
    await act(async () => vi.advanceTimersByTimeAsync(RELEASE_MS))
    expect(bridge.watch.mock.calls).toEqual([[SLUG], [null]])
    expect(bridge.listeners.size).toBe(0)
  })

  it('a job event reaches the window within 2 s', async () => {
    const bridge = fakeBridge()
    const onChange = vi.fn()

    renderHook(() => useAcpEvents(SLUG, onChange))
    act(() => bridge.push(job()))
    await act(async () => vi.advanceTimersByTimeAsync(2000))
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('never starts with the live engine off, and lets the stream go after a long hide', async () => {
    const bridge = fakeBridge()

    $liveEconEnabled.set(false)
    const off = renderHook(() => useAcpEvents(SLUG, () => undefined))

    expect(bridge.watch).not.toHaveBeenCalled()
    off.unmount()

    $liveEconEnabled.set(true)
    renderHook(() => useAcpEvents(SLUG, () => undefined))
    expect(bridge.watch).toHaveBeenCalledTimes(1)

    act(() => setVisibility('hidden'))
    await act(async () => vi.advanceTimersByTimeAsync(HIDDEN_STOP_MS - 1))
    expect(bridge.watch).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(bridge.watch).toHaveBeenLastCalledWith(null)

    act(() => setVisibility('visible'))
    expect(bridge.watch).toHaveBeenLastCalledWith(SLUG)
  })
})

describe('useAutoRefresh with a streamed app', () => {
  it('stretches the timer to the fallback while the stream is live and never re-runs load on a flip', async () => {
    const load = vi.fn(async () => undefined)

    renderHook(() => useAutoRefresh('acp', SLUG, load, [], 0, { streamed: true }))
    await act(async () => undefined)
    expect(load).toHaveBeenCalledTimes(1)

    act(() => $acpStreamLive.set({ [SLUG]: true }))
    expect(load).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTimeAsync(STREAM_FALLBACK_SECS * 1000 - 1))
    expect(load).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(load).toHaveBeenCalledTimes(2)

    // The drop schedules the next tick from now at the Settings period.
    act(() => $acpStreamLive.set({ [SLUG]: false }))
    expect(load).toHaveBeenCalledTimes(2)
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('an app that is not streamed keeps the Settings period while a stream is live', async () => {
    const load = vi.fn(async () => undefined)

    $acpStreamLive.set({ [SLUG]: true })
    renderHook(() => useAutoRefresh('wallet', SLUG, load, [], 0))
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(load).toHaveBeenCalledTimes(2)
  })
})
