import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $econStatus,
  cadenceTtlMs,
  FOCUSED_WARM_MS,
  frontEconApp,
  liveCadenceSecs,
  parallelPrefetch,
  raiseEconApp,
  READ_FAILED_TEXT,
  reportEconStatus,
  resetLiveCadence,
  SAVED_MAIL_TEXT,
  statusText,
  useAutoRefresh,
  useEconStatus
} from './live'
import { $liveEconIntervalSecs } from './prefs'

const SLUG = 'inft-live'
const ECON_CSS = resolve(process.cwd(), 'src/app/home/econ/econ.css')

function status() {
  return $econStatus.get()[`email:${SLUG}`]
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(1_000_000)
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  // The open-window rhythm (60 s) these tests count ticks by; focus has its own test.
  vi.spyOn(document, 'hasFocus').mockReturnValue(false)
  $liveEconIntervalSecs.set(60)
  $econStatus.set({})
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useAutoRefresh', () => {
  it('reports the mount run and every timer tick as silent; the button and a forced reload are not', async () => {
    const seen: Array<{ force: boolean; silent: boolean }> = []

    const load = vi.fn(async ({ force }: { force: boolean }) => {
      seen.push({ force, silent: status()!.silent })
    })

    const { rerender, result } = renderHook(({ key }) => useAutoRefresh('email', SLUG, load, [], key), {
      initialProps: { key: 0 }
    })

    await act(async () => undefined)
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    rerender({ key: 1 })
    await act(async () => undefined)
    await act(async () => {
      await result.current.reload()
    })

    expect(seen).toEqual([
      { force: false, silent: true },
      { force: false, silent: true },
      { force: true, silent: false },
      { force: true, silent: false }
    ])
    expect(status()!.refreshing).toBe(false)
  })

  it('a silent tick overlapping a forced run neither hides nor ends its "refreshing…"', async () => {
    const answers: Array<() => void> = []

    const load = vi.fn(
      () =>
        new Promise<void>(resolve => {
          answers.push(resolve)
        })
    )

    const { result } = renderHook(() => useAutoRefresh('email', SLUG, load, [], 0))
    const text = () => statusText(status()!, 'email', 60_000)

    await act(async () => {
      answers.shift()!()
    })
    expect(status()!.refreshing).toBe(false)

    let forced: Promise<void> = Promise.resolve()

    act(() => {
      forced = result.current.reload()
    })
    expect(text()).toBe('refreshing…')

    // A timer tick starts while the forced run is out: still the owner's.
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    expect(load).toHaveBeenCalledTimes(3)
    expect(text()).toBe('refreshing…')

    // The tick lands first: the forced run is still out.
    await act(async () => {
      answers.pop()!()
    })
    expect(text()).toBe('refreshing…')
    expect(status()!.refreshing).toBe(true)

    await act(async () => {
      answers.shift()!()
      await forced
    })
    expect(status()!.refreshing).toBe(false)
    expect(text()).toMatch(/^updated /)
  })

  it('a forced run that lands first leaves a still-running tick silent', async () => {
    const answers: Array<() => void> = []

    const load = vi.fn(
      () =>
        new Promise<void>(resolve => {
          answers.push(resolve)
        })
    )

    const { result } = renderHook(() => useAutoRefresh('email', SLUG, load, [], 0))

    await act(async () => {
      answers.shift()!()
    })
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    act(() => {
      void result.current.reload()
    })
    expect(status()).toMatchObject({ refreshing: true, silent: false })

    await act(async () => {
      answers.pop()!()
    })
    expect(status()).toMatchObject({ refreshing: true, silent: true })

    await act(async () => {
      answers.shift()!()
    })
    expect(status()).toMatchObject({ refreshing: false, silent: true })
  })

  it('a window closed mid forced read reopens on its last words, never "refreshing…"', async () => {
    let finish!: () => void

    const pending = new Promise<void>(resolve => {
      finish = resolve
    })

    let next = () => Promise.resolve()
    const first = renderHook(() => useAutoRefresh('email', SLUG, () => next(), [], 0))

    await act(async () => undefined)
    next = () => pending
    await act(async () => {
      void first.result.current.reload()
    })
    expect(status()).toMatchObject({ refreshing: true, silent: false })

    first.unmount()
    expect(status()).toMatchObject({ refreshing: false, silent: true })

    next = () => Promise.resolve()
    const painted: string[] = []

    renderHook(() => {
      painted.push(statusText(useEconStatus('email', SLUG), 'email', 60_000))
      useAutoRefresh('email', SLUG, () => next(), [], 0)
    })
    await act(async () => undefined)
    await act(async () => {
      finish()
      await pending
    })

    expect(painted.length).toBeGreaterThan(0)
    expect(painted).not.toContain('refreshing…')
    expect(status()!.refreshing).toBe(false)
  })

  it('a new slug stops counting the old one: its forced read no longer spins the new header', async () => {
    let finish!: () => void

    const pending = new Promise<void>(resolve => {
      finish = resolve
    })

    let next = () => Promise.resolve()

    const { rerender, result } = renderHook(({ slug }) => useAutoRefresh('email', slug, () => next(), [], 0), {
      initialProps: { slug: SLUG }
    })

    await act(async () => undefined)
    next = () => pending
    await act(async () => {
      void result.current.reload()
    })
    next = () => Promise.resolve()
    rerender({ slug: 'inft-other' })
    await act(async () => undefined)

    expect(status()!.refreshing).toBe(false)
    expect($econStatus.get()['email:inft-other']).toMatchObject({ refreshing: false, silent: true })

    await act(async () => {
      finish()
      await pending
    })
  })

  it('a read that fails with no words says "read failed", never the last "updated" line', async () => {
    const failures: unknown[] = [new Error(''), new Error('   '), '', undefined]
    let fail: unknown = null

    const load = vi.fn(async () => {
      if (fail !== null) {
        throw fail
      }
    })

    const { result } = renderHook(() => useAutoRefresh('email', SLUG, load, []))

    await act(async () => undefined)
    expect(statusText(status()!, 'email', 60_000)).toMatch(/^updated /)

    for (const thrown of failures) {
      fail = thrown
      await act(async () => {
        await result.current.reload()
      })
      expect(status()!.error).toBe(thrown === undefined ? 'undefined' : READ_FAILED_TEXT)
      fail = null
      await act(async () => {
        await result.current.reload()
      })
      expect(status()!.error).toBeNull()
    }
  })

  it('ticks at the open-window period (60 s) while the document is hidden — R3d', async () => {
    const load = vi.fn(async () => undefined)

    renderHook(() => useAutoRefresh('email', SLUG, load, [], 0))
    await act(async () => undefined)
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    await act(async () => {
      vi.advanceTimersByTime(180_000)
    })
    expect(load).toHaveBeenCalledTimes(4)
    expect(liveCadenceSecs('email', SLUG)).toBe(60)
  })

  it('ticks every 20 s while on screen and focused, and reads at once on focus — R3d', async () => {
    vi.spyOn(window.document, 'hasFocus').mockReturnValue(true)
    const load = vi.fn(async () => undefined)

    renderHook(() => useAutoRefresh('email', SLUG, load, [], 0))
    await act(async () => undefined)
    expect(liveCadenceSecs('email', SLUG)).toBe(20)
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    expect(load).toHaveBeenCalledTimes(4)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(load).toHaveBeenCalledTimes(5)
  })

  it('only the frontmost focused window ticks every 20 s; the open ones behind it every 60 s — R3d r2', async () => {
    vi.spyOn(window.document, 'hasFocus').mockReturnValue(true)
    resetLiveCadence()

    const loads = {
      wallet: vi.fn(async () => undefined),
      bank: vi.fn(async () => undefined),
      email: vi.fn(async () => undefined)
    }

    renderHook(() => useAutoRefresh('wallet', SLUG, loads.wallet, [], 0))
    renderHook(() => useAutoRefresh('bank', SLUG, loads.bank, [], 0))
    const email = renderHook(() => useAutoRefresh('email', SLUG, loads.email, [], 0))
    await act(async () => undefined)

    expect(frontEconApp()).toBe('email')
    expect([liveCadenceSecs('email', SLUG), liveCadenceSecs('wallet', SLUG), liveCadenceSecs('bank', SLUG)]).toEqual([
      20, 60, 60
    ])

    const before = Object.values(loads).reduce((sum, load) => sum + load.mock.calls.length, 0)

    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })

    const ticks = Object.values(loads).reduce((sum, load) => sum + load.mock.calls.length, 0) - before

    expect(ticks).toBeLessThanOrEqual(5)

    await act(async () => {
      raiseEconApp('wallet')
    })
    expect([liveCadenceSecs('wallet', SLUG), liveCadenceSecs('email', SLUG)]).toEqual([20, 60])

    // The front window closes: the one raised before it takes the focused rhythm.
    await act(async () => {
      raiseEconApp('email')
    })
    email.unmount()
    expect(frontEconApp()).toBe('wallet')
    expect(liveCadenceSecs('wallet', SLUG)).toBe(20)
  })

  it('read TTLs follow the live period, capped by the read and floored at 10 s — R3d r2', () => {
    expect(cadenceTtlMs(20, 55_000)).toBe(15_000)
    expect(cadenceTtlMs(60, 30_000)).toBe(30_000)
    expect(cadenceTtlMs(120, 55_000)).toBe(55_000)
    expect(cadenceTtlMs(5, 55_000)).toBe(10_000)
  })

  it('a prefetch never holds the dock, and a closed app is kept warm every 120 s — R3d', async () => {
    resetLiveCadence()
    const warm = vi.fn(() => new Promise<void>(() => undefined))

    await parallelPrefetch('wallet', warm)('inft-1', SLUG)
    expect(warm).toHaveBeenCalledTimes(1)
    expect(liveCadenceSecs('wallet', SLUG)).toBe(120)
    await act(async () => {
      vi.advanceTimersByTime(110_000)
    })
    expect(warm).toHaveBeenCalledTimes(1)
    await act(async () => {
      vi.advanceTimersByTime(20_000)
    })
    expect(warm).toHaveBeenCalledTimes(2)
    resetLiveCadence()
  })
})

describe('background refresh stays silent (U3p1-T1)', () => {
  it('three minutes open — ticks, focus, blur, hide, a stage swap, a reopen, slow reads — never read "refreshing…"', async () => {
    vi.spyOn(window.document, 'hasFocus').mockReturnValue(true)
    resetLiveCadence()
    const out: Array<{ at: number; resolve: () => void }> = []

    const load = vi.fn(
      () =>
        new Promise<void>(resolve => {
          out.push({ at: Date.now(), resolve })
        })
    )

    const seen = new Set<string>()
    let loud = 0

    const look = () => {
      const current = status()!

      seen.add(statusText(current, 'email', 20_000))
      loud += current.refreshing && !current.silent ? 1 : 0
    }

    const view = renderHook(({ inft }) => useAutoRefresh('email', SLUG, load, [inft], 0), {
      initialProps: { inft: 6 }
    })

    for (let second = 1; second <= 180; second += 1) {
      await act(async () => {
        vi.advanceTimersByTime(1_000)

        // Reads take 1–6 s, so ticks and focus reads overlap one another.
        while (out.length > 0 && Date.now() - out[0].at >= 1_000 + (second % 6) * 1_000) {
          out.shift()!.resolve()
        }

        if (second % 7 === 0) {
          window.dispatchEvent(new Event(second % 14 === 0 ? 'blur' : 'focus'))
        }

        if (second % 25 === 0) {
          document.dispatchEvent(new Event('visibilitychange'))
        }
      })

      if (second === 90) {
        view.rerender({ inft: 7 })
      }

      if (second === 120) {
        view.unmount()
        renderHook(() => useAutoRefresh('email', SLUG, load, [7], 0))
      }

      look()
    }

    expect(load.mock.calls.length).toBeGreaterThan(9)
    expect(loud).toBe(0)
    expect([...seen].filter(text => /refreshing/i.test(text))).toEqual([])
    out.forEach(run => run.resolve())
    resetLiveCadence()
  })
})

describe('closed apps while a dock window is focused (U4p1-T2)', () => {
  it('warm every 10 minutes instead of every 2, and at 2 again once no window is focused', async () => {
    resetLiveCadence()
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const warm = vi.fn(() => Promise.resolve())
    const view = renderHook(() => useAutoRefresh('email', SLUG, () => Promise.resolve(), [SLUG], 0))

    raiseEconApp('email')
    await parallelPrefetch('wallet', warm)('inft-1', SLUG)
    expect(warm).toHaveBeenCalledTimes(1)
    await act(async () => {
      vi.advanceTimersByTime(FOCUSED_WARM_MS - 20_000)
    })
    expect(warm).toHaveBeenCalledTimes(1)
    await act(async () => {
      vi.advanceTimersByTime(30_000)
    })
    expect(warm).toHaveBeenCalledTimes(2)
    focus.mockReturnValue(false)
    await act(async () => {
      vi.advanceTimersByTime(130_000)
    })
    expect(warm).toHaveBeenCalledTimes(3)
    view.unmount()
    focus.mockRestore()
    resetLiveCadence()
  })
})

describe('reportEconStatus / statusText', () => {
  it('an identical patch publishes nothing (no header re-render)', () => {
    reportEconStatus('email', SLUG, { snapshotAt: 5 })
    const before = $econStatus.get()

    reportEconStatus('email', SLUG, { snapshotAt: 5 })
    expect($econStatus.get()).toBe(before)
  })

  it('keeps the last words through a silent run and names new mail inside one period', () => {
    const now = Date.now()

    const idle = {
      refreshing: false,
      silent: true,
      updatedAt: now - 5_000,
      changedAt: 0,
      snapshotAt: 0,
      stage: null,
      dataAt: 0,
      error: null
    }

    expect(statusText(idle, 'email', 60_000)).toMatch(/^updated /)
    expect(statusText({ ...idle, refreshing: true }, 'email', 60_000)).toBe(statusText(idle, 'email', 60_000))
    expect(statusText({ ...idle, refreshing: true, silent: false }, 'email', 60_000)).toBe('refreshing…')
    expect(statusText({ ...idle, changedAt: now - 2_000 }, 'email', 60_000)).toMatch(/^new mail /)
    expect(statusText({ ...idle, changedAt: now - 120_000 }, 'email', 60_000)).toMatch(/^updated /)
    expect(statusText({ ...idle, error: 'Sign-in required' }, 'email', 60_000)).toBe('Sign-in required')
    expect(statusText({ ...idle, error: '' }, 'email', 60_000)).toBe(READ_FAILED_TEXT)
    expect(statusText({ ...idle, error: ' \n ' }, 'email', 60_000)).toBe(READ_FAILED_TEXT)
  })
})

describe('the header status line', () => {
  it('holds every routine text inside its width floor (econ.css)', () => {
    const css = readFileSync(ECON_CSS, 'utf8')
    const floor = Number(/\.iecon__status-text\s*\{[^}]*?min-width:\s*(\d+)ch/.exec(css)?.[1])
    const now = Date.now()

    const base = {
      refreshing: false,
      silent: true,
      updatedAt: 0,
      changedAt: 0,
      snapshotAt: 0,
      stage: null,
      dataAt: 0,
      error: null
    }

    const routine = [
      statusText({ ...base, snapshotAt: now - 3 * 3_600_000, updatedAt: now - 3 * 3_600_000 }, 'email', 60_000, now),
      statusText({ ...base, refreshing: true, silent: false }, 'email', 60_000, now),
      statusText({ ...base, updatedAt: now - 59_000 }, 'email', 60_000, now),
      statusText({ ...base, updatedAt: now - 59 * 60_000 }, 'wallet', 60_000, now),
      statusText({ ...base, updatedAt: now - 30_000, changedAt: now - 30_000 }, 'email', 60_000, now)
    ]

    expect(routine[0]).toBe(SAVED_MAIL_TEXT)
    expect(floor).toBeGreaterThan(0)
    expect(Math.max(...routine.map(text => text.length))).toBeLessThanOrEqual(floor)
  })

  it('lets the identity pill give way inside itself (address first), never past its edge', () => {
    const css = readFileSync(ECON_CSS, 'utf8')
    const text = /\.iecon__identity > b,\s*\.iecon__identity > b \+ span\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    const address = /\}\s*\.iecon__identity > b \+ span\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    const dot = /\.iecon__identity-state\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''

    expect(text).toMatch(/min-width:\s*0/)
    expect(text).toMatch(/text-overflow:\s*ellipsis/)
    expect(text).toMatch(/overflow:\s*hidden/)
    expect(address).toMatch(/flex-shrink:\s*\d+/)
    expect(dot).toMatch(/flex:\s*none/)
  })

  it('yields its floor to the window before the title wraps or the iNFT name hides', () => {
    const css = readFileSync(ECON_CSS, 'utf8')
    const title = /\.ic-win__head h2\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    const head = /\.iecon__head\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    const base = /\.iecon__status-text\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    const windowed = /\.iecon__head \.iecon__status-text\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    const share = /max-width:\s*max\(12ch, 100cqw - (\d+)px\)/.exec(windowed)?.[1]

    expect(title).toMatch(/flex:\s*none/)
    expect(title).toMatch(/white-space:\s*nowrap/)
    expect(head).toMatch(/container-type:\s*inline-size/)
    // Outside a window head (no query container) the fixed 32ch floor stands.
    expect(base).toMatch(/min-width:\s*32ch/)
    expect(base).toMatch(/text-overflow:\s*ellipsis/)
    expect(base).toMatch(/overflow:\s*hidden/)
    // Floor and cap are one share of the header: below it the width is fixed by the window alone.
    expect(share).toBeDefined()
    expect(windowed).toContain(`min-width: min(32ch, max(12ch, 100cqw - ${share}px))`)
    expect(windowed).not.toMatch(/\b(em|ex|%)\b/)
  })

  it('pulses a 2 px live dot on a token duration', () => {
    const css = readFileSync(ECON_CSS, 'utf8')
    const dot = /\.iecon__status-dot\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    const live = /\.iecon__status-dot--live\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''

    expect(dot).toMatch(/width:\s*2px/)
    expect(dot).toMatch(/height:\s*2px/)
    expect(live).toMatch(/animation:\s*iecon-live-pulse var\(--e-live-pulse\)/)
    expect(live).not.toMatch(/\d(ms|s)\b/)
  })
})
