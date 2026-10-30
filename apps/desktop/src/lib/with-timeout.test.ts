import { readFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TimeoutError } from './with-timeout'
import {
  BACKEND_BOOT_WAIT_TIMEOUT_MS,
  BACKEND_MAIN_SILENCE_MS,
  type IdleActivitySignal,
  isTimeoutError,
  RECONNECT_ATTEMPT_TIMEOUT_MS,
  withIdleTimeout,
  withTimeout
} from './with-timeout'

describe('withTimeout', () => {
  it('rejects with an onTimeout exception instead of letting it escape the timer callback', async () => {
    vi.useFakeTimers()

    try {
      const callbackFailure = new Error('abort callback failed')

      const result = withTimeout(new Promise<never>(() => undefined), 10, 'work timed out', () => {
        throw callbackFailure
      })

      const rejection = expect(result).rejects.toBe(callbackFailure)

      await vi.advanceTimersByTimeAsync(10)
      await rejection
    } finally {
      vi.useRealTimers()
    }
  })
})

/** A hand-driven activity source that records its subscription lifecycle. */
function activitySource() {
  let listener: ((signal: IdleActivitySignal) => void) | null = null
  const state = { subscribed: 0, unsubscribed: 0 }

  return {
    state,
    get live() {
      return listener !== null
    },
    signal(signal: IdleActivitySignal) {
      listener?.(signal)
    },
    subscribe: (next: (signal: IdleActivitySignal) => void) => {
      state.subscribed += 1
      listener = next

      return () => {
        state.unsubscribed += 1
        listener = null
      }
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void

  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, reject, resolve }
}

/** Track a promise's outcome without awaiting it (so fake time can be advanced underneath). */
function track<T>(promise: Promise<T>) {
  const out: { error?: unknown; settled: boolean; value?: T } = { settled: false }
  promise.then(
    value => {
      out.settled = true
      out.value = value
    },
    error => {
      out.settled = true
      out.error = error
    }
  )

  return out
}

const MESSAGE = 'Timed out connecting to Hermes backend'

describe('withIdleTimeout (the helper: idle budget, base and install ceilings as options)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const boot = (work: Promise<unknown>, source: ReturnType<typeof activitySource>) =>
    track(
      withIdleTimeout(work, BACKEND_BOOT_WAIT_TIMEOUT_MS, MESSAGE, {
        ceilingMessage: ms => `ceiling ${ms} ms`,
        ceilingMs: BACKEND_BOOT_WAIT_TIMEOUT_MS,
        installCeilingMs: 300_000,
        subscribe: source.subscribe
      })
    )

  it('keeps one named constant per budget: idle 45 s, main silence 120 s, reconnect 20 s', () => {
    expect(BACKEND_BOOT_WAIT_TIMEOUT_MS).toBe(45_000)
    expect(BACKEND_MAIN_SILENCE_MS).toBe(120_000)
    expect(RECONNECT_ATTEMPT_TIMEOUT_MS).toBe(20_000)
  })

  it('a silent source fails at exactly 45 s with the same message as before', async () => {
    const source = activitySource()
    const out = boot(new Promise(() => undefined), source)

    await vi.advanceTimersByTimeAsync(BACKEND_BOOT_WAIT_TIMEOUT_MS - 1)
    expect(out.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(isTimeoutError(out.error)).toBe(true)
    expect((out.error as TimeoutError).message).toBe(MESSAGE)
    expect(source.state.unsubscribed).toBe(1)
  })

  it('without install activity the whole budget stays 45 s: plain heartbeats do not stretch a healthy boot', async () => {
    const source = activitySource()
    const out = boot(new Promise(() => undefined), source)

    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(10_000)
      source.signal('activity')
    }

    await vi.advanceTimersByTimeAsync(4_999)
    expect(out.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect((out.error as Error).message).toBe('ceiling 45000 ms')
  })

  it('299 s of steady install progress resolves when the work does', async () => {
    const source = activitySource()
    const work = deferred<string>()
    const out = boot(work.promise, source)

    for (let elapsed = 0; elapsed < 290_000; elapsed += 10_000) {
      source.signal('install')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(out.settled).toBe(false)
    }

    source.signal('install')
    await vi.advanceTimersByTimeAsync(9_000)
    expect(out.settled).toBe(false)
    work.resolve('connected')
    await vi.advanceTimersByTimeAsync(0)
    expect(out).toMatchObject({ settled: true, value: 'connected' })
    expect(source.state.unsubscribed).toBe(1)
    expect(source.live).toBe(false)
  })

  it('steady install progress past 300 s fails with a message naming the ceiling', async () => {
    const source = activitySource()
    const out = boot(new Promise(() => undefined), source)

    for (let elapsed = 0; elapsed < 300_000; elapsed += 10_000) {
      source.signal('install')
      await vi.advanceTimersByTimeAsync(10_000)
    }

    expect(out.settled).toBe(true)
    expect((out.error as Error).message).toBe('ceiling 300000 ms')
    expect(source.live).toBe(false)
  })

  it('46 s of silence fails at any point of an install (45 s after the last sign)', async () => {
    for (const quietAfter of [0, 60_000, 200_000]) {
      const source = activitySource()
      const out = boot(new Promise(() => undefined), source)
      source.signal('install')

      for (let elapsed = 0; elapsed < quietAfter; elapsed += 10_000) {
        await vi.advanceTimersByTimeAsync(10_000)
        source.signal('install')
      }

      await vi.advanceTimersByTimeAsync(BACKEND_BOOT_WAIT_TIMEOUT_MS - 1)
      expect(out.settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect((out.error as Error).message).toBe(MESSAGE)
    }
  })

  it('releases the subscription when the work rejects, and passes the rejection through', async () => {
    const source = activitySource()
    const work = deferred<never>()
    const out = boot(work.promise, source)
    const failure = new Error('bootstrap failed')

    work.reject(failure)
    await vi.advanceTimersByTimeAsync(0)
    expect(out.error).toBe(failure)
    expect(source.state).toEqual({ subscribed: 1, unsubscribed: 1 })
    source.signal('install')
    await vi.advanceTimersByTimeAsync(600_000)
    expect(out.error).toBe(failure)
  })

  it('a hold (waiting on the user) stops both clocks; activity during it does not lift it; release re-arms 45 s', async () => {
    const source = activitySource()
    const out = boot(new Promise(() => undefined), source)

    await vi.advanceTimersByTimeAsync(40_000)
    source.signal('hold')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    source.signal('activity')
    source.signal('install')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(out.settled).toBe(false)
    source.signal('release')
    // 40 s of the 45 s base ceiling were spent before the hold: 5 s left of armed time.
    await vi.advanceTimersByTimeAsync(4_999)
    expect(out.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect((out.error as Error).message).toBe('ceiling 45000 ms')
  })

  it('time on hold never counts toward the install ceiling', async () => {
    const source = activitySource()
    const work = deferred<string>()
    const out = boot(work.promise, source)

    for (let i = 0; i < 15; i += 1) {
      source.signal('install')
      await vi.advanceTimersByTimeAsync(10_000)
    }

    source.signal('hold')
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    source.signal('release')

    for (let i = 0; i < 14; i += 1) {
      source.signal('install')
      await vi.advanceTimersByTimeAsync(10_000)
    }

    // 290 s armed.
    expect(out.settled).toBe(false)
    source.signal('install')
    await vi.advanceTimersByTimeAsync(9_999)
    expect(out.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect((out.error as Error).message).toBe('ceiling 300000 ms')
  })

  it('runs onTimeout before rejecting, like withTimeout', async () => {
    const seen: string[] = []

    const out = track(
      withIdleTimeout(new Promise(() => undefined), 1_000, MESSAGE, {
        onTimeout: error => seen.push(error.message)
      })
    )

    await vi.advanceTimersByTimeAsync(1_000)
    expect(seen).toEqual([MESSAGE])
    expect(isTimeoutError(out.error)).toBe(true)
  })
})

describe('boot-class budget call sites (ruling 42 / RTB-1)', () => {
  const read = (file: string) => readFileSync(path.join(import.meta.dirname, '..', file), 'utf8')

  it('the cold-boot awaits use the liveness budget; reconnect-class awaits keep the 20 s budget', () => {
    const boot = read('app/gateway/hooks/use-gateway-boot.ts')

    expect(boot.match(/awaitBackendBoot\(/g)?.length).toBe(2)
    expect(boot).toContain("'Timed out connecting to Hermes backend'")
    expect(boot).toContain("'Timed out reconnecting to Hermes backend'")
    expect(boot).not.toMatch(/BACKEND_BOOT_WAIT_TIMEOUT_MS/)
    // The eight reconnect-class bounds of the base (import + 7 awaits) are all still there, none raised or replaced.
    expect(boot.match(/RECONNECT_ATTEMPT_TIMEOUT_MS/g)?.length).toBe(8)
    expect(boot).not.toMatch(/withTimeout\([^)]*?,\s*\d[\d_]*,/)
    // Every remaining withTimeout in the boot hook is reconnect-class and uses the reconnect budget.
    const bounded = [...boot.matchAll(/withTimeout\(\s*[\s\S]*?,\s*([A-Z_]+),/g)].map(match => match[1])

    expect(bounded.length).toBeGreaterThan(0)
    expect(new Set(bounded)).toEqual(new Set(['RECONNECT_ATTEMPT_TIMEOUT_MS']))
  })
})
