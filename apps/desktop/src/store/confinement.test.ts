import { afterEach, describe, expect, it, vi } from 'vitest'

import type { IcloneConfinementBridge } from './confinement'
import { $confinement, pollConfinementOnce, readConfinementOnce, stopRun, watchConfinement } from './confinement'

const RUN = `project+${'a'.repeat(12)}+sess-1+${'b'.repeat(32)}`

function install(bridge: Partial<IcloneConfinementBridge>): void {
  ;(window as unknown as { hermesDesktop: Record<string, unknown> }).hermesDesktop = { icloneConfinement: bridge }
}

afterEach(() => {
  Reflect.deleteProperty(window, 'hermesDesktop')
  $confinement.set({ status: 'loading', state: null, error: null })
})

describe('stopRun — the owner’s Stop on one run goes to main, then the state is read again', () => {
  it('passes the run id through and returns main’s answer', async () => {
    const stop = vi.fn(async (run: string) => ({ ok: true as const, run, killed: [4242] }))
    const state = vi.fn(async () => null)

    install({ stopRun: stop, state })

    await expect(stopRun(RUN)).resolves.toEqual({ ok: true, run: RUN, killed: [4242] })
    expect(stop).toHaveBeenCalledWith(RUN)
    expect(state).toHaveBeenCalledTimes(1)
  })

  it('without the bridge (a browser, or main gone) it reads not-running and never throws', async () => {
    await expect(stopRun(RUN)).resolves.toMatchObject({ ok: false, run: RUN, reason: 'not-running' })

    install({ stopRun: async () => null, state: async () => null })
    await expect(stopRun(RUN)).resolves.toMatchObject({ ok: false, reason: 'not-running', error: 'unavailable' })
  })
})

describe('L4-02: one state read in flight at a time', () => {
  const gated = () => {
    const releases: (() => void)[] = []

    const state = vi.fn(
      () =>
        new Promise<null>(resolve => {
          releases.push(() => resolve(null))
        })
    )

    const releaseAll = async () => {
      while (releases.length > 0) {
        releases.shift()?.()
        await new Promise(resolve => setTimeout(resolve, 0))
      }
    }

    return { state, releaseAll }
  }

  it('a poll during a read is skipped; a burst of change notices costs one more read, not one per notice', async () => {
    const { state, releaseAll } = gated()
    let changed = (): void => undefined

    install({
      state,
      onChanged: callback => {
        changed = callback

        return () => undefined
      }
    })

    const stop = watchConfinement()

    expect(state).toHaveBeenCalledTimes(1)

    for (let index = 0; index < 50; index += 1) {
      pollConfinementOnce()
      changed()
    }

    expect(state).toHaveBeenCalledTimes(1)
    await releaseAll()
    // The first read, then exactly one for every notice that arrived during it.
    expect(state).toHaveBeenCalledTimes(2)
    stop()
  })

  it('polls alone never queue a read behind the one in flight', async () => {
    const { state, releaseAll } = gated()

    install({ state })

    const first = readConfinementOnce()

    pollConfinementOnce()
    pollConfinementOnce()
    await releaseAll()
    await first
    expect(state).toHaveBeenCalledTimes(1)
  })
})
