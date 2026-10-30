import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $backgroundStatusBySession,
  type BackgroundStopWatch,
  type ComposerStatusItem,
  refreshBackgroundProcesses,
  resetBackgroundPollingGuard
} from '@/store/composer-status'
import { $gateway } from '@/store/gateway'

import { BACKGROUND_POLL_MS, MAX_POLLS_IN_FLIGHT, startBackgroundPoller } from './poller'

const item = (id: string, state: ComposerStatusItem['state']): ComposerStatusItem => ({
  id,
  state,
  title: id,
  type: 'background'
})

const running = (...sids: string[]) => Object.fromEntries(sids.map(sid => [sid, [item(`${sid}-p`, 'running')]]))

let stop: (() => void) | null = null

beforeEach(() => vi.useFakeTimers())

afterEach(() => {
  stop?.()
  stop = null
  vi.useRealTimers()
})

describe('the all-session poller (contract §2.3)', () => {
  it('G6: an empty set arms NO timer and sends 0 process.list in 60 s', () => {
    const bySession = atom<Record<string, ComposerStatusItem[]>>({})
    const refresh = vi.fn((_sid: string) => Promise.resolve())

    stop = startBackgroundPoller({ bySession, refresh })

    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(60_000)
    expect(refresh).not.toHaveBeenCalled()

    // Only finished rows: still nothing to poll.
    bySession.set({ a: [item('p', 'done'), item('q', 'failed')] })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('polls EVERY session with a running row — not only the one on screen — every 5 s', async () => {
    const bySession = atom(running('on-screen', 'off-screen-1', 'off-screen-2'))
    const refresh = vi.fn((_sid: string) => Promise.resolve())

    stop = startBackgroundPoller({ bySession, refresh })

    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_MS - 1)
    expect(refresh).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(refresh.mock.calls.map(([sid]) => sid).sort()).toEqual(['off-screen-1', 'off-screen-2', 'on-screen'])
  })

  it('disarms when the last running row finishes, re-arms when one starts', async () => {
    const bySession = atom(running('a'))
    const refresh = vi.fn((_sid: string) => Promise.resolve())

    stop = startBackgroundPoller({ bySession, refresh })
    bySession.set({ a: [item('a-p', 'done')] })
    expect(vi.getTimerCount()).toBe(0)

    bySession.set(running('b'))
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_MS)
    expect(refresh).toHaveBeenCalledWith('b')
  })

  it('never has more than 4 requests in flight, and a slow session is not polled twice at once', async () => {
    const sids = ['s1', 's2', 's3', 's4', 's5', 's6']
    const bySession = atom(running(...sids))
    const pending = new Map<string, () => void>()
    let inFlight = 0
    let peak = 0

    const refresh = vi.fn(
      (sid: string) =>
        new Promise<void>(resolve => {
          inFlight += 1
          peak = Math.max(peak, inFlight)
          pending.set(sid, () => {
            inFlight -= 1
            pending.delete(sid)
            resolve()
          })
        })
    )

    stop = startBackgroundPoller({ bySession, refresh })

    await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_MS)
    expect(inFlight).toBe(MAX_POLLS_IN_FLIGHT)

    // Nothing answered: the next tick may not add a fifth request.
    await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_MS)
    expect(inFlight).toBe(MAX_POLLS_IN_FLIGHT)

    // Two answer: the next tick serves the two sessions that were waiting (round-robin), not the same four.
    pending.get('s1')?.()
    pending.get('s2')?.()
    await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_MS)

    expect(new Set(refresh.mock.calls.map(([sid]) => sid))).toEqual(new Set(sids))
    expect(peak).toBe(MAX_POLLS_IN_FLIGHT)
  })

  it('a refresh that throws does not stop the loop', async () => {
    const bySession = atom(running('a'))
    const refresh = vi.fn((_sid: string) => Promise.reject(new Error('socket closed')))

    stop = startBackgroundPoller({ bySession, refresh })
    await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_MS * 3)

    expect(refresh).toHaveBeenCalledTimes(3)
  })

  it('stopping the poller clears its timer', () => {
    const bySession = atom(running('a'))

    stop = startBackgroundPoller({ bySession, refresh: () => Promise.resolve() })
    stop()
    stop = null

    expect(vi.getTimerCount()).toBe(0)
    bySession.set(running('a', 'b'))
    expect(vi.getTimerCount()).toBe(0)
  })

  /**
   * The measured poll cost (contract gates): requests per minute scale with RUNNING sessions only, capped by the
   * in-flight limit; an idle app costs 0.
   */
  it.each([
    [0, 0],
    [1, 12],
    [3, 36],
    [8, 48]
  ])('cost: %i running sessions ⇒ %i process.list per minute', async (sessions, perMinute) => {
    const bySession = atom(running(...Array.from({ length: sessions }, (_, i) => `s${i}`)))
    const refresh = vi.fn((_sid: string) => Promise.resolve())

    stop = startBackgroundPoller({ bySession, refresh })
    await vi.advanceTimersByTimeAsync(60_000)

    expect(refresh).toHaveBeenCalledTimes(perMinute)
  })

  it('a session lost to 4001 holds NO timer and gets 0 requests until it comes back', async () => {
    const bySession = atom(running('lost'))
    const gone = atom<ReadonlySet<string>>(new Set(['lost']))
    const refresh = vi.fn((_sid: string) => Promise.resolve())

    stop = startBackgroundPoller({ bySession, gone, refresh })

    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(refresh).not.toHaveBeenCalled()

    // Latched while armed: the timer is dropped at once, not on the next wake-up.
    gone.set(new Set())
    expect(vi.getTimerCount()).toBe(1)
    gone.set(new Set(['lost']))
    expect(vi.getTimerCount()).toBe(0)

    // The session returns (a fresh runtime bound to it): polling resumes.
    gone.set(new Set())
    await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_MS)
    expect(refresh).toHaveBeenCalledWith('lost')
  })

  it('keeps polling a session whose only job left the stack on an X the registry has not confirmed', async () => {
    const watch: BackgroundStopWatch = { failed: false, item: item('p', 'running'), since: 0, unconfirmed: false }
    const stopWatch = atom<Record<string, Record<string, BackgroundStopWatch>>>({ s: { p: watch } })
    const refresh = vi.fn((_sid: string) => Promise.resolve())

    stop = startBackgroundPoller({ bySession: atom({}), refresh, stopWatch })
    await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_MS)
    expect(refresh).toHaveBeenCalledWith('s')

    stopWatch.set({})
    expect(vi.getTimerCount()).toBe(0)
  })
})

/**
 * The on-screen session is also polled by its mounted composer stack (status-stack: a seed refresh on open, then a
 * 5 s interval). Both run on the REAL `refreshBackgroundProcesses`; the gateway counts what is actually sent.
 */
describe('poll cost of the on-screen session', () => {
  const request = vi.fn((_method: string, _params?: Record<string, unknown>) =>
    Promise.resolve({ processes: [{ command: 'sleep 600', session_id: 'p', status: 'running' }] })
  )

  const sent = (sid: string) => request.mock.calls.filter(([, params]) => params?.session_id === sid).length

  /** What the mounted stack does for its session (status-stack/index.tsx). */
  const mountStack = (sid: string) => {
    void refreshBackgroundProcesses(sid)
    const timer = setInterval(() => void refreshBackgroundProcesses(sid), BACKGROUND_POLL_MS)

    return () => clearInterval(timer)
  }

  beforeEach(() => {
    request.mockClear()
    resetBackgroundPollingGuard()
    $gateway.set({ request } as never)
    $backgroundStatusBySession.set({ seen: [item('p', 'running')], unseen: [item('p', 'running')] })
  })

  afterEach(() => {
    $gateway.set(null)
    $backgroundStatusBySession.set({})
    resetBackgroundPollingGuard()
  })

  it.each([0, 1, 2_500, 4_999])(
    'stack mounted %i ms before the poller: 12 process.list per minute for it, 12 for an off-screen one',
    async phase => {
      let unmount = () => {}

      setTimeout(() => (unmount = mountStack('seen')), 0)
      await vi.advanceTimersByTimeAsync(phase)
      stop = startBackgroundPoller()

      // Warm up one minute, then count a steady minute.
      await vi.advanceTimersByTimeAsync(60_000)

      const [seenBefore, unseenBefore] = [sent('seen'), sent('unseen')]

      await vi.advanceTimersByTimeAsync(60_000)
      expect(sent('seen') - seenBefore).toBe(12)
      expect(sent('unseen') - unseenBefore).toBe(12)

      // The stack unmounts (the owner opened another session): the poller takes the session back.
      unmount()
      await vi.advanceTimersByTimeAsync(15_000)

      const after = sent('seen')

      await vi.advanceTimersByTimeAsync(60_000)
      expect(sent('seen') - after).toBe(12)
    }
  )
})
