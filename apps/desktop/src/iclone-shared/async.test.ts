import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sleep } from './async'

describe('sleep', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves after the delay without a signal', async () => {
    let done = false
    const pending = sleep(100).then(() => (done = true))

    await vi.advanceTimersByTimeAsync(99)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(done).toBe(true)
  })

  it('resolves with a signal that never aborts and detaches its listener', async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const pending = sleep(50, { signal: controller.signal })

    await vi.advanceTimersByTimeAsync(50)
    await expect(pending).resolves.toBeUndefined()
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    controller.abort()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects at once with signal.reason when aborted mid-sleep and clears the timer', async () => {
    const controller = new AbortController()
    const pending = sleep(10_000, { signal: controller.signal })
    const reason = new Error('superseded')

    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects immediately for an already-aborted signal, without a timer', async () => {
    const pending = sleep(10_000, { signal: AbortSignal.abort('gone') })

    expect(vi.getTimerCount()).toBe(0)
    await expect(pending).rejects.toBe('gone')
  })

  it('uses abortReason over signal.reason, both mid-sleep and pre-aborted', async () => {
    const custom = new Error('custom')
    const controller = new AbortController()
    const pending = sleep(1000, { abortReason: () => custom, signal: controller.signal })

    controller.abort()
    await expect(pending).rejects.toBe(custom)
    await expect(sleep(1, { abortReason: () => custom, signal: AbortSignal.abort() })).rejects.toBe(custom)
  })

  it('treats a zero or negative delay as the next tick', async () => {
    const pending = sleep(-5)

    await vi.advanceTimersByTimeAsync(0)
    await expect(pending).resolves.toBeUndefined()
  })
})
