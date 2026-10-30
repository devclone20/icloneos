import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CHROMIUM_WEBGL_CAP,
  createGpuLeasePool,
  GPU_CONTEXT_TOTAL_CAP,
  type GpuAcceleration,
  HIDDEN_GRACE_MS,
  IDLE_FRAME_MS,
  type LeaseAddon,
  type LeaseTerminal,
  LOSS_COOLDOWN_MS,
  runContextSafeLoop,
  TERMINAL_WEBGL_BUDGET,
  type WebglLease
} from './gpu-lease'

vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }))

interface FakeGl {
  getExtension(name: string): null | { loseContext(): void }
  isContextLost(): boolean
}

class FakeAddon implements LeaseAddon {
  canvas: HTMLCanvasElement | null = null
  private lost = false
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly log: string[],
    private readonly failCreate: boolean
  ) {}

  activate(terminal: { element?: HTMLElement }) {
    if (this.failCreate) {
      throw new Error('WebGL2 not supported')
    }

    const gl: FakeGl = {
      getExtension: name =>
        name === 'WEBGL_lose_context'
          ? {
              loseContext: () => {
                this.log.push('loseContext')
                this.lost = true
              }
            }
          : null,
      isContextLost: () => this.lost
    }

    const canvas = document.createElement('canvas')

    canvas.getContext = ((type: string) => (type === 'webgl2' ? gl : null)) as unknown as typeof canvas.getContext
    terminal.element?.appendChild(canvas)
    this.canvas = canvas
  }

  dispose() {
    this.log.push('dispose')
    this.canvas?.remove()
  }

  /** The browser killed the context and xterm gave up restoring it. */
  loseFromBrowser() {
    this.lost = true

    for (const listener of [...this.listeners]) {
      listener()
    }
  }

  onContextLoss = (listener: () => void) => {
    this.listeners.add(listener)

    return {
      dispose: () => {
        this.listeners.delete(listener)
      }
    }
  }
}

interface Mounted {
  changes: () => number
  lease: WebglLease
  ref: { current: FakeAddon | null }
  term: LeaseTerminal<FakeAddon> & { element: HTMLElement; refresh: ReturnType<typeof vi.fn> }
}

function setup(
  options: { budget?: number; failCreate?: () => boolean; preference?: GpuAcceleration; totalCap?: number } = {}
) {
  const log: string[] = []
  const created: FakeAddon[] = []
  const atlasPasses = vi.fn()

  const pool = createGpuLeasePool<FakeAddon>({
    budget: options.budget,
    createAddon: () => {
      const addon = new FakeAddon(log, options.failCreate?.() ?? false)

      created.push(addon)

      return addon
    },
    readPreference: () => options.preference ?? 'auto',
    requestAtlasRebuild: atlasPasses,
    totalCap: options.totalCap
  })

  const mount = (id?: string): Mounted => {
    const host = document.createElement('div')
    const element = document.createElement('div')

    if (id) {
      host.setAttribute('data-it-host', id)
    }

    host.appendChild(element)

    const term = {
      cols: 80,
      element,
      loadAddon: (addon: FakeAddon) => addon.activate({ element }),
      refresh: vi.fn(),
      rows: 24
    }

    const ref: { current: FakeAddon | null } = { current: null }
    let changes = 0

    const lease = pool.lease(term, ref, () => {
      changes++
    })

    return { changes: () => changes, lease, ref, term }
  }

  const holders = (all: Mounted[]) => all.filter(m => m.ref.current !== null)

  return { atlasPasses, created, holders, log, mount, pool }
}

describe('gpu lease', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('only visible terminals acquire, and onRendererChange fires on every renderer switch', () => {
    const { mount } = setup()
    const a = mount()

    expect(a.ref.current).toBeNull()
    a.lease.setVisible(true)
    expect(a.ref.current).not.toBeNull()
    expect(a.changes()).toBe(1)

    a.lease.setVisible(false)
    vi.advanceTimersByTime(HIDDEN_GRACE_MS)
    expect(a.ref.current).toBeNull()
    expect(a.changes()).toBe(2)

    a.lease.setVisible(true)
    expect(a.ref.current).not.toBeNull()
    expect(a.changes()).toBe(3)
  })

  it('a hidden terminal keeps its context through the 3 s grace, then releases it', () => {
    const { mount } = setup()
    const a = mount()

    a.lease.setVisible(true)
    const addon = a.ref.current

    a.lease.setVisible(false)
    vi.advanceTimersByTime(HIDDEN_GRACE_MS - 1)
    expect(a.ref.current).toBe(addon)

    // Back inside the grace: the same context, no renderer switch.
    a.lease.setVisible(true)
    vi.advanceTimersByTime(HIDDEN_GRACE_MS * 2)
    expect(a.ref.current).toBe(addon)
    expect(a.changes()).toBe(1)

    a.lease.setVisible(false)
    vi.advanceTimersByTime(HIDDEN_GRACE_MS)
    expect(a.ref.current).toBeNull()
  })

  it('releases deterministically: loseContext is called after dispose', () => {
    const { log, mount } = setup()
    const a = mount()

    a.lease.setVisible(true)
    const canvas = a.ref.current?.canvas

    a.lease.setVisible(false)
    vi.advanceTimersByTime(HIDDEN_GRACE_MS)

    expect(log).toEqual(['dispose', 'loseContext'])
    expect(canvas?.isConnected).toBe(false)
  })

  it('the focused terminal comes first: focus promotes it past the budget', () => {
    const { holders, mount } = setup({ budget: 2 })
    const [a, b, c] = [mount(), mount(), mount()]

    // Unfocused, the most recently shown win: a new split gets the context.
    for (const pane of [a, b, c]) {
      pane.lease.setVisible(true)
    }

    expect(holders([a, b, c])).toEqual([b, c])

    a.lease.touch()
    expect(holders([a, b, c])).toEqual([a, c])
  })

  it('LRU: past the budget the least recently focused visible terminal falls back to DOM', () => {
    const { holders, log, mount } = setup({ budget: 2 })
    const [a, b, c] = [mount(), mount(), mount()]

    for (const pane of [a, b, c]) {
      pane.lease.setVisible(true)
      pane.lease.touch()
    }

    // c focused last, then b; a is the least recently used.
    expect(a.ref.current).toBeNull()
    expect(holders([a, b, c])).toEqual([b, c])

    a.lease.touch()
    expect(b.ref.current).toBeNull()
    expect(holders([a, b, c])).toEqual([a, c])
    expect(log.filter(entry => entry === 'loseContext')).toHaveLength(2)
  })

  it('budget cap: never more than the budget, and reserveGpuContext holders count against the total cap', () => {
    const { holders, mount, pool } = setup({ totalCap: TERMINAL_WEBGL_BUDGET + 2 })
    const panes = Array.from({ length: 12 }, () => mount())

    panes.forEach(pane => pane.lease.setVisible(true))
    expect(holders(panes)).toHaveLength(TERMINAL_WEBGL_BUDGET)

    const releaseStage = pool.reserve('stage3d')
    const releaseOther = pool.reserve('preview')

    expect(holders(panes)).toHaveLength(TERMINAL_WEBGL_BUDGET)

    const releaseThird = pool.reserve('third')

    expect(holders(panes)).toHaveLength(TERMINAL_WEBGL_BUDGET - 1)

    releaseThird()
    releaseThird()
    expect(holders(panes)).toHaveLength(TERMINAL_WEBGL_BUDGET)
    releaseStage()
    releaseOther()
    expect(holders(panes)).toHaveLength(TERMINAL_WEBGL_BUDGET)
  })

  it('budget: hidden holders still in their grace yield to a newly visible terminal', () => {
    const { holders, mount } = setup({ budget: 2 })
    const [a, b, c] = [mount(), mount(), mount()]

    a.lease.setVisible(true)
    b.lease.setVisible(true)
    a.lease.setVisible(false)
    b.lease.setVisible(false)
    expect(holders([a, b])).toHaveLength(2)

    c.lease.setVisible(true)
    expect(c.ref.current).not.toBeNull()
    // The most recently hidden keeps the remaining slot.
    expect(holders([a, b, c])).toEqual([b, c])
  })

  it('context loss: DOM fallback, then re-acquire after the 10 s cooldown', () => {
    const { mount } = setup()
    const a = mount()

    a.lease.setVisible(true)
    a.ref.current?.loseFromBrowser()
    expect(a.ref.current).toBeNull()
    expect(a.changes()).toBe(2)

    a.lease.touch()
    vi.advanceTimersByTime(LOSS_COOLDOWN_MS - 1)
    expect(a.ref.current).toBeNull()

    vi.advanceTimersByTime(1)
    expect(a.ref.current).not.toBeNull()
    expect(a.changes()).toBe(3)
  })

  it('cooldown: three losses within a minute keep the terminal on DOM for the session', () => {
    const { mount } = setup()
    const a = mount()

    a.lease.setVisible(true)

    for (let loss = 0; loss < 3; loss++) {
      a.ref.current?.loseFromBrowser()
      vi.advanceTimersByTime(LOSS_COOLDOWN_MS)
    }

    expect(a.ref.current).toBeNull()
    vi.advanceTimersByTime(LOSS_COOLDOWN_MS * 10)
    a.lease.touch()
    expect(a.ref.current).toBeNull()
  })

  it('latch: a failed context creation puts the whole session on DOM', () => {
    let fail = false
    const { holders, mount } = setup({ failCreate: () => fail })
    const a = mount()
    const b = mount()

    a.lease.setVisible(true)
    expect(a.ref.current).not.toBeNull()

    fail = true
    b.lease.setVisible(true)
    expect(holders([a, b])).toEqual([])

    fail = false
    const c = mount()

    c.lease.setVisible(true)
    expect(c.ref.current).toBeNull()
  })

  it('latch: evictions and context losses never latch the session', () => {
    const { holders, mount } = setup({ budget: 1 })
    const a = mount()
    const b = mount()

    a.lease.setVisible(true)
    b.lease.setVisible(true)
    b.lease.touch()
    expect(holders([a, b])).toEqual([b])

    b.ref.current?.loseFromBrowser()
    expect(a.ref.current).not.toBeNull()

    const c = mount()

    c.lease.setVisible(true)
    c.lease.touch()
    expect(c.ref.current).not.toBeNull()
  })

  it('dispose releases at once and hands the slot to a waiting terminal', () => {
    const { log, mount } = setup({ budget: 1 })
    const a = mount()
    const b = mount()

    a.lease.setVisible(true)
    a.lease.touch()
    b.lease.setVisible(true)
    expect(b.ref.current).toBeNull()

    a.lease.dispose()
    expect(log).toEqual(['dispose', 'loseContext'])
    expect(a.changes()).toBe(1)
    expect(b.ref.current).not.toBeNull()
  })

  it('gpuAcceleration off keeps every terminal on DOM until it is turned back on', () => {
    const { mount, pool } = setup({ preference: 'off' })
    const a = mount()

    a.lease.setVisible(true)
    expect(a.ref.current).toBeNull()

    pool.setPreference('auto')
    expect(a.ref.current).not.toBeNull()
  })

  it('dev seam: leases, live contexts, force and a full rebuild by host id', () => {
    const { atlasPasses, mount, pool } = setup()
    const a = mount('pane-a')
    const seam = pool.devSeam()

    a.lease.setVisible(true)
    expect(seam.liveContexts()).toBe(1)
    expect(seam.leases()).toEqual([{ focusedAt: 0, id: 'pane-a', losses: 0, renderer: 'webgl', visible: true }])

    expect(seam.rebuild('pane-a')).toBe(true)
    expect(atlasPasses).toHaveBeenCalledTimes(1)
    expect(a.term.refresh).toHaveBeenCalledWith(0, 23)

    expect(seam.force('pane-a', 'dom')).toBe(true)
    expect(seam.liveContexts()).toBe(0)
    expect(seam.leases()[0].renderer).toBe('dom')
    expect(seam.force('missing', 'webgl')).toBe(false)
  })

  it('dev seam rebuild never clears the shared atlas for one pane (AD2)', () => {
    const { atlasPasses, mount, pool } = setup()
    const a = mount('pane-a')
    const b = mount('pane-b')
    const seam = pool.devSeam()
    const handleResize = vi.fn()

    a.lease.setVisible(true)
    b.lease.setVisible(true)
    Object.assign(a.term, { _core: { _renderService: { handleResize } } })

    // With xterm's render service: a model rebuild of that pane only.
    expect(seam.rebuild('pane-a')).toBe(true)
    expect(handleResize).toHaveBeenCalledWith(80, 24)
    expect(a.term.refresh).toHaveBeenCalledWith(0, 23)
    expect(atlasPasses).not.toHaveBeenCalled()
    expect(b.term.refresh).not.toHaveBeenCalled()

    // Without it: the coordinated pass over every mounted terminal, never a local clear.
    expect(seam.rebuild('pane-b')).toBe(true)
    expect(atlasPasses).toHaveBeenCalledTimes(1)
    expect(b.term.refresh).toHaveBeenCalledWith(0, 23)
    expect(handleResize).toHaveBeenCalledTimes(1)
  })

  it('churn: with the stage reserved, split/close cycles stay under the caps and lose every released context', () => {
    const { created, log, mount, pool } = setup()
    const seam = pool.devSeam()
    const releaseStage = pool.reserve('stage3d')
    const base = mount()
    let peak = 0

    const sample = () => {
      peak = Math.max(peak, seam.liveContexts())
    }

    base.lease.setVisible(true)

    for (let i = 0; i < 40; i++) {
      const pane = mount()

      pane.lease.setVisible(true)
      pane.lease.touch()
      sample()
      pane.lease.dispose()
      sample()
    }

    let shown = [base]

    for (let burst = 0; burst < 3; burst++) {
      shown.forEach(pane => pane.lease.setVisible(false))
      shown = Array.from({ length: 6 }, () => mount())
      shown.forEach(pane => {
        pane.lease.setVisible(true)
        sample()
      })
    }

    vi.advanceTimersByTime(HIDDEN_GRACE_MS + 1)
    sample()

    expect(peak).toBeLessThanOrEqual(TERMINAL_WEBGL_BUDGET)
    expect(peak + 1).toBeLessThanOrEqual(Math.min(GPU_CONTEXT_TOTAL_CAP, CHROMIUM_WEBGL_CAP))
    expect(seam.liveContexts()).toBe(6)
    // Nothing waits on GC: every context that is not live was lost explicitly.
    expect(log.filter(entry => entry === 'loseContext')).toHaveLength(created.length - 6)
    releaseStage()
  })
})

describe('stage frame loop', () => {
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0

  const flush = () => {
    const due = [...frames.values()]

    frames.clear()
    due.forEach(callback => callback(0))
  }

  const lose = (canvas: HTMLCanvasElement) => {
    const event = new Event('webglcontextlost', { cancelable: true })

    canvas.dispatchEvent(event)

    return event
  }

  beforeEach(() => {
    frames.clear()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback)

      return nextFrame
    })
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
      frames.delete(handle)
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('a context loss stops the loop; a restore rebuilds and restarts it, every cycle', () => {
    const canvas = document.createElement('canvas')
    const frame = vi.fn()
    const rebuild = vi.fn()
    const stop = runContextSafeLoop(canvas, frame, rebuild)

    flush()
    flush()
    expect(frame).toHaveBeenCalledTimes(2)

    // preventDefault is what makes the browser hand the context back.
    expect(lose(canvas).defaultPrevented).toBe(true)
    expect(frames.size).toBe(0)
    flush()
    expect(frame).toHaveBeenCalledTimes(2)
    expect(rebuild).not.toHaveBeenCalled()

    canvas.dispatchEvent(new Event('webglcontextrestored'))
    expect(rebuild).toHaveBeenCalledTimes(1)
    flush()
    flush()
    expect(frame).toHaveBeenCalledTimes(4)

    for (let cycle = 0; cycle < 3; cycle++) {
      lose(canvas)
      canvas.dispatchEvent(new Event('webglcontextrestored'))
    }

    canvas.dispatchEvent(new Event('webglcontextrestored'))
    expect(rebuild).toHaveBeenCalledTimes(5)
    // Never two loops, however the events interleave.
    expect(frames.size).toBe(1)
    flush()
    expect(frame).toHaveBeenCalledTimes(5)

    stop()
    expect(frames.size).toBe(0)
    canvas.dispatchEvent(new Event('webglcontextrestored'))
    expect(lose(canvas).defaultPrevented).toBe(false)
    flush()
    expect(rebuild).toHaveBeenCalledTimes(5)
    expect(frame).toHaveBeenCalledTimes(5)
  })
  it('an idle budget draws on the vsyncs that close 1000/30 ms; busy draws on every vsync', () => {
    const canvas = document.createElement('canvas')
    const frame = vi.fn()
    let busy = false
    const stop = runContextSafeLoop(canvas, frame, () => undefined, { busy: () => busy })

    const vsyncs = (hz: number, count: number, from = 0) => {
      for (let i = 0; i < count; i++) {
        const due = [...frames.values()]

        frames.clear()
        due.forEach(callback => callback(from + (i * 1000) / hz))
      }
    }

    vsyncs(120, 120)
    expect(frame).toHaveBeenCalledTimes(30)
    frame.mockClear()
    vsyncs(60, 60, 2000)
    expect(frame).toHaveBeenCalledTimes(30)
    frame.mockClear()
    busy = true
    vsyncs(120, 120, 4000)
    expect(frame).toHaveBeenCalledTimes(120)
    expect(IDLE_FRAME_MS).toBeCloseTo(33.33, 1)
    stop()
    expect(frames.size).toBe(0)
  })
})
