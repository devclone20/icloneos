import { afterEach, describe, expect, it, vi } from 'vitest'

import { $payments, watchPayments } from './payments'

/** A bridge whose `status` answers only when the test releases it: a slow main. */
function installSlowBridge() {
  let changed: (() => void) | null = null
  const releases: (() => void)[] = []

  const bridge = {
    status: vi.fn(
      () =>
        new Promise(resolve => {
          releases.push(() => resolve({ ledgerOk: true }))
        })
    ),
    limits: vi.fn(() => Promise.resolve({})),
    mandates: vi.fn(() => Promise.resolve([])),
    onChanged: vi.fn((callback: () => void) => {
      changed = callback

      return () => {
        changed = null
      }
    })
  }

  Object.assign(window, { hermesDesktop: { ...(window.hermesDesktop ?? {}), payments: bridge } })

  return {
    bridge,
    fire: () => changed?.(),
    releaseAll: async () => {
      for (const release of releases.splice(0)) {
        release()
      }

      await vi.advanceTimersByTimeAsync(0)
    }
  }
}

afterEach(() => {
  vi.useRealTimers()
  $payments.set({ status: 'loading', state: null, settings: null, mandates: [] })
})

describe('the Payments poll (L4-03)', () => {
  it('skips its 3 s tick while a read is in flight, and re-reads once after a change announced during one', async () => {
    vi.useFakeTimers()

    const { bridge, fire, releaseAll } = installSlowBridge()
    const stop = watchPayments()

    expect(bridge.status).toHaveBeenCalledTimes(1)

    // Main is slow: ten ticks pass with the first read still open, and none of them asks again.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(bridge.status).toHaveBeenCalledTimes(1)

    // A change main announces mid-read is not dropped: one more read once the open one answers.
    fire()
    fire()
    expect(bridge.status).toHaveBeenCalledTimes(1)
    await releaseAll()
    expect($payments.get().status).toBe('ready')
    expect(bridge.status).toHaveBeenCalledTimes(2)

    await releaseAll()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(bridge.status).toHaveBeenCalledTimes(3)

    stop()
    await releaseAll()
  })
})
