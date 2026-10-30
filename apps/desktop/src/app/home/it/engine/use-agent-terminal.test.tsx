import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as GpuLease from '@/app/home/gpu-lease'

import { useAgentTerminal } from './use-agent-terminal'

const xterm = vi.hoisted(() => ({
  attachCustomKeyEventHandler: vi.fn(),
  clearSelection: vi.fn(),
  dispose: vi.fn(),
  focus: vi.fn(),
  getSelection: vi.fn(() => ''),
  loadAddon: vi.fn(),
  onSelectionChange: vi.fn(() => ({ dispose: vi.fn() })),
  open: vi.fn(),
  refresh: vi.fn(),
  write: vi.fn()
}))

const addons = vi.hoisted(() => ({
  fits: [] as Array<() => void>
}))

interface FakeLease {
  dispose: ReturnType<typeof vi.fn>
  onRendererChange: () => void
  ref: { current: unknown }
  setVisible: ReturnType<typeof vi.fn>
  touch: ReturnType<typeof vi.fn>
}

// jsdom has no WebGL: the lease is the seam, and the hook only has to drive it.
const leases = vi.hoisted(() => [] as FakeLease[])

// Routes leaseTerminalWebgl through a real lease pool when a test sets it.
const realLease = vi.hoisted(() => ({
  current: null as ((term: never, ref: never, onRendererChange: () => void) => unknown) | null
}))

const terminalRegistrations = vi.hoisted(() => ({
  makeTerminalReader: vi.fn(() => vi.fn()),
  registerReader: vi.fn(() => vi.fn()),
  registerWriter: vi.fn(() => vi.fn())
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    readonly buffer = { active: {} }
    readonly cols = 80
    element: HTMLElement | undefined
    readonly rows = 24
    readonly unicode = { activeVersion: '6' }
    options: Record<string, unknown>

    constructor(options: Record<string, unknown>) {
      this.options = { ...options }
    }

    attachCustomKeyEventHandler = xterm.attachCustomKeyEventHandler
    clearSelection = xterm.clearSelection
    dispose = xterm.dispose
    focus = xterm.focus
    getSelection = xterm.getSelection
    loadAddon = (addon: { activate?: (term: unknown) => void }) => {
      xterm.loadAddon(addon)
      addon.activate?.(this)
    }

    onRender = vi.fn(() => ({ dispose: vi.fn() }))
    onSelectionChange = xterm.onSelectionChange
    open = (host: HTMLElement) => {
      this.element = host
      xterm.open(host)
    }

    refresh = xterm.refresh
    write = xterm.write
  }
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()

    constructor() {
      addons.fits.push(this.fit)
    }
  }
}))

vi.mock('@xterm/addon-unicode11', () => ({
  Unicode11Addon: class {}
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {}
}))

// The real lease pool imports the addon; jsdom cannot run its WebGL.
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {}
}))

vi.mock('@/app/home/gpu-lease', () => ({
  leaseTerminalWebgl: vi.fn((term: never, ref: never, onRendererChange: () => void) => {
    if (realLease.current) {
      return realLease.current(term, ref, onRendererChange)
    }

    const lease: FakeLease = {
      dispose: vi.fn(),
      onRendererChange,
      ref,
      setVisible: vi.fn(),
      touch: vi.fn()
    }

    leases.push(lease)

    return lease
  })
}))

vi.mock('@/components/ui/copy-button', () => ({
  writeClipboardText: vi.fn()
}))

vi.mock('@/lib/haptics', () => ({
  triggerHaptic: vi.fn()
}))

vi.mock('@/themes/context', () => ({
  useTheme: () => ({
    renderedMode: 'dark',
    theme: { terminal: {} },
    themeName: 'test'
  })
}))

vi.mock('./agent-terminal-stream', () => ({
  registerAgentTerminalWriter: terminalRegistrations.registerWriter
}))

vi.mock('./buffer', () => ({
  makeTerminalReader: terminalRegistrations.makeTerminalReader,
  registerTerminalReader: terminalRegistrations.registerReader
}))

// The slice of WebglAddon the lease and the atlas drive. A lost context reaches
// the lease the way the real addon reports it, minus its restore wait.
class FakeWebglAddon {
  readonly canvas = globalThis.document.createElement('canvas')
  clearTextureAtlas = vi.fn()
  dispose = vi.fn(() => this.canvas.remove())
  private readonly lossListeners = new Set<() => void>()

  activate(term: { element?: HTMLElement }) {
    term.element?.append(this.canvas)
    this.canvas.addEventListener('webglcontextlost', () => this.lossListeners.forEach(listener => listener()))
  }

  onAddTextureAtlasCanvas = () => ({ dispose: vi.fn() })
  onChangeTextureAtlas = () => ({ dispose: vi.fn() })

  onContextLoss(listener: () => void) {
    this.lossListeners.add(listener)

    return { dispose: () => this.lossListeners.delete(listener) }
  }

  onRemoveTextureAtlasCanvas = () => ({ dispose: vi.fn() })
}

function Harness({ active = false, focused }: { active?: boolean; focused?: boolean }) {
  const { hostRef } = useAgentTerminal({ active, focused, id: 'agent-tab', procId: 'proc-1' })

  return <div data-testid="host" ref={hostRef} />
}

// jsdom lays nothing out; give the host a real box so the fit path runs.
function sizeHost(container: HTMLElement) {
  const host = container.querySelector('[data-testid="host"]') as HTMLElement

  Object.defineProperty(host, 'clientWidth', { configurable: true, value: 800 })
  Object.defineProperty(host, 'clientHeight', { configurable: true, value: 400 })
}

describe('useAgentTerminal', () => {
  let resolveFontLoad!: (faces: FontFace[]) => void
  let resizeObserverConstructor = vi.fn<() => void>()

  beforeEach(() => {
    const pendingFontLoad = new Promise<FontFace[]>(resolve => {
      resolveFontLoad = resolve
    })

    Object.defineProperty(globalThis.document, 'fonts', {
      configurable: true,
      value: { load: vi.fn(() => pendingFontLoad) }
    })

    resizeObserverConstructor = vi.fn<() => void>()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor() {
          resizeObserverConstructor()
        }

        disconnect = vi.fn()
        observe = vi.fn()
        unobserve = vi.fn()
      } as unknown as typeof ResizeObserver
    )
  })

  afterEach(() => {
    addons.fits.length = 0
    leases.length = 0
    realLease.current = null
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    Reflect.deleteProperty(globalThis.document, 'fonts')
  })

  it('unmounts safely while initial font preparation is pending', async () => {
    const { unmount } = render(<Harness />)

    await waitFor(() => expect(globalThis.document.fonts.load).toHaveBeenCalledTimes(3))

    expect(() => unmount()).not.toThrow()
    expect(xterm.dispose).toHaveBeenCalledOnce()
    expect(resizeObserverConstructor).not.toHaveBeenCalled()

    await act(async () => {
      resolveFontLoad([])
      await Promise.resolve()
    })

    expect(xterm.open).not.toHaveBeenCalled()
    expect(resizeObserverConstructor).not.toHaveBeenCalled()
    expect(terminalRegistrations.registerWriter).not.toHaveBeenCalled()
    expect(terminalRegistrations.registerReader).not.toHaveBeenCalled()
  })

  it('leases WebGL from mount: visibility follows `active`, focus ranks it, unmount releases', async () => {
    const { container, rerender, unmount } = render(<Harness />)

    sizeHost(container)
    await act(async () => {
      resolveFontLoad([])
      await Promise.resolve()
    })
    await waitFor(() => expect(leases).toHaveLength(1))

    const [lease] = leases

    expect(lease.setVisible).toHaveBeenLastCalledWith(false)
    expect(lease.touch).not.toHaveBeenCalled()

    rerender(<Harness active />)
    expect(lease.setVisible).toHaveBeenLastCalledWith(true)
    expect(lease.touch).toHaveBeenCalledOnce()

    rerender(<Harness active focused={false} />)
    rerender(<Harness focused={false} />)
    expect(lease.setVisible).toHaveBeenLastCalledWith(false)
    expect(lease.touch).toHaveBeenCalledOnce()

    unmount()
    expect(lease.dispose).toHaveBeenCalledOnce()
    expect(xterm.dispose).toHaveBeenCalledOnce()
  })

  it('redraws without clearing the shared WebGL atlas on activation', async () => {
    const { container, rerender } = render(<Harness />)

    sizeHost(container)
    await act(async () => {
      resolveFontLoad([])
      await Promise.resolve()
    })
    await waitFor(() => expect(leases).toHaveLength(1))

    const clearTextureAtlas = vi.fn()

    leases[0].ref.current = { clearTextureAtlas }
    rerender(<Harness active />)

    await waitFor(() => expect(xterm.refresh).toHaveBeenCalledWith(0, 23))
    expect(clearTextureAtlas).not.toHaveBeenCalled()
  })

  it('refits, then redraws every row on every renderer switch', async () => {
    const { container } = render(<Harness active />)

    sizeHost(container)
    await act(async () => {
      resolveFontLoad([])
      await Promise.resolve()
    })
    await waitFor(() => expect(leases).toHaveLength(1))
    expect(leases[0].setVisible).toHaveBeenLastCalledWith(true)

    const fit = addons.fits[0] as ReturnType<typeof vi.fn>
    const fitsBeforeSwitch = fit.mock.calls.length

    xterm.refresh.mockClear()
    act(() => leases[0].onRendererChange())

    expect(fit.mock.calls.length).toBe(fitsBeforeSwitch + 1)
    expect(xterm.refresh).toHaveBeenCalledWith(0, 23)
  })

  it('falls back to the DOM renderer and redraws every row on a WebGL context loss', async () => {
    const { createGpuLeasePool } = await vi.importActual<typeof GpuLease>('@/app/home/gpu-lease')
    const webglAddons: FakeWebglAddon[] = []
    const refs: Array<{ current: unknown }> = []

    const pool = createGpuLeasePool<FakeWebglAddon>({
      createAddon: () => {
        const addon = new FakeWebglAddon()

        webglAddons.push(addon)

        return addon
      },
      readPreference: () => 'auto',
      requestAtlasRebuild: vi.fn(),
      writePreference: vi.fn()
    })

    realLease.current = (term, ref, onRendererChange) => {
      refs.push(ref)

      return pool.lease(term, ref, onRendererChange)
    }

    const { container, unmount } = render(<Harness active />)

    sizeHost(container)
    await act(async () => {
      resolveFontLoad([])
      await Promise.resolve()
    })
    await waitFor(() => expect(refs[0]?.current).toBeInstanceOf(FakeWebglAddon))

    const [webgl] = webglAddons
    const fit = addons.fits[0] as ReturnType<typeof vi.fn>
    const fitsBeforeLoss = fit.mock.calls.length

    expect(container.querySelector('canvas')).toBe(webgl.canvas)
    xterm.refresh.mockClear()

    act(() => {
      webgl.canvas.dispatchEvent(new Event('webglcontextlost'))
    })

    // DOM fallback: the lost addon is disposed with its canvas, and the loss cooldown keeps WebGL off.
    expect(webgl.dispose).toHaveBeenCalledOnce()
    expect(refs[0].current).toBeNull()
    expect(container.querySelector('canvas')).toBeNull()
    expect(webglAddons).toHaveLength(1)
    expect(pool.devSeam().leases()).toEqual([expect.objectContaining({ losses: 1, renderer: 'dom', visible: true })])
    // Repaint: the DOM renderer is refit and every row redrawn.
    expect(fit.mock.calls.length).toBe(fitsBeforeLoss + 1)
    expect(xterm.refresh).toHaveBeenCalledWith(0, 23)

    unmount()
  })
})
