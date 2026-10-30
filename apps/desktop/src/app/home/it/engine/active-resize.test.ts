import type { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  observeActiveTerminalResize,
  scheduleRendererCanvasSync,
  stopRendererCanvasSync,
  syncRendererCanvas
} from './active-resize'

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

function installRaf() {
  let nextId = 1
  const frames = new Map<number, FrameRequestCallback>()

  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextId++
    frames.set(id, callback)

    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))

  return {
    flush() {
      const pending = [...frames.entries()]
      frames.clear()
      pending.forEach(([, callback]) => callback(0))
    },
    pending: () => frames.size
  }
}

describe('observeActiveTerminalResize', () => {
  it('fits once on activation and coalesces later resize bursts', () => {
    const raf = installRaf()
    const resize = { current: null as ResizeObserverCallback | null }
    const disconnect = vi.fn()

    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resize.current = callback
        }

        disconnect = disconnect
        observe = vi.fn((target: Element) => {
          resize.current?.([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver)
        })
        unobserve = vi.fn()
      } as unknown as typeof ResizeObserver
    )

    const onFit = vi.fn()
    const onActivate = vi.fn()
    const host = document.createElement('div')
    const dispose = observeActiveTerminalResize(host, { onActivate, onFit })

    // ResizeObserver's initial delivery is absorbed by the activation frame.
    expect(raf.pending()).toBe(1)
    raf.flush()
    expect(onFit).toHaveBeenCalledTimes(1)
    expect(onActivate).toHaveBeenCalledTimes(1)

    resize.current?.([], {} as ResizeObserver)
    resize.current?.([], {} as ResizeObserver)
    resize.current?.([], {} as ResizeObserver)
    expect(raf.pending()).toBe(1)
    raf.flush()
    expect(onFit).toHaveBeenCalledTimes(2)

    dispose()
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('cancels activation without fitting when hidden before the first frame', () => {
    const raf = installRaf()

    vi.stubGlobal(
      'ResizeObserver',
      class {
        disconnect = vi.fn()
        observe = vi.fn()
        unobserve = vi.fn()
      } as unknown as typeof ResizeObserver
    )

    const onFit = vi.fn()

    const dispose = observeActiveTerminalResize(document.createElement('div'), {
      onActivate: vi.fn(),
      onFit
    })

    dispose()

    raf.flush()
    expect(onFit).not.toHaveBeenCalled()
  })

  it('absorbs a real browser-style initial resize delivered after activation', () => {
    const raf = installRaf()
    const resize = { current: null as ResizeObserverCallback | null }

    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resize.current = callback
        }

        disconnect = vi.fn()
        observe = vi.fn()
        unobserve = vi.fn()
      } as unknown as typeof ResizeObserver
    )

    const onFit = vi.fn()
    observeActiveTerminalResize(document.createElement('div'), { onActivate: vi.fn(), onFit })

    raf.flush()
    expect(onFit).toHaveBeenCalledTimes(1)

    // Browser initial delivery: the activation fit already covered this size.
    resize.current?.([], {} as ResizeObserver)
    expect(raf.pending()).toBe(0)

    // A later real resize schedules exactly one fit.
    resize.current?.([], {} as ResizeObserver)
    expect(raf.pending()).toBe(1)
    raf.flush()
    expect(onFit).toHaveBeenCalledTimes(2)
  })

  it('reuses a first-mount fit without fitting again on activation', () => {
    const raf = installRaf()

    vi.stubGlobal(
      'ResizeObserver',
      class {
        disconnect = vi.fn()
        observe = vi.fn()
        unobserve = vi.fn()
      } as unknown as typeof ResizeObserver
    )

    const onActivate = vi.fn()
    const onFit = vi.fn()

    observeActiveTerminalResize(document.createElement('div'), {
      fitOnActivate: false,
      onActivate,
      onFit
    })

    raf.flush()

    expect(onActivate).toHaveBeenCalledOnce()
    expect(onFit).not.toHaveBeenCalled()
  })
})

describe('syncRendererCanvas', () => {
  // A WebGL pane: the renderer's canvas plus its link layer, both under .xterm-screen.
  const mountTerminal = (backing: Array<[number, number]>) => {
    const element = document.createElement('div')
    const screen = document.createElement('div')
    const refresh = vi.fn()
    const handleResize = vi.fn()
    const renders = new Set<() => void>()

    screen.className = 'xterm-screen'
    element.append(screen)
    document.body.append(element)

    const addCanvas = ([width, height]: [number, number]) => {
      const canvas = document.createElement('canvas')

      canvas.width = width
      canvas.height = height
      canvas.style.width = '550px'
      canvas.style.height = '677px'
      screen.append(canvas)

      return canvas
    }

    const canvases = backing.map(addCanvas)

    const term = {
      _core: { _renderService: { dimensions: { device: { canvas: { height: 1218, width: 990 } } }, handleResize } },
      cols: 110,
      element,
      onRender: (listener: () => void) => {
        renders.add(listener)

        return { dispose: () => renders.delete(listener) }
      },
      refresh,
      rows: 38
    } as unknown as Terminal

    const render = () => renders.forEach(listener => listener())

    return { addCanvas, canvases, handleResize, refresh, render, renders, term }
  }

  const entry = (target: Element, box: [number, number] | null) =>
    ({
      devicePixelContentBoxSize: box ? [{ blockSize: box[1], inlineSize: box[0] }] : undefined,
      target
    }) as unknown as ResizeObserverEntry

  // One device-pixel-content-box observer; deliver() plays the browser's delivery for fresh observations.
  const installBoxObserver = () => {
    const state = {
      disconnects: 0,
      fresh: [] as Element[],
      observed: new Set<Element>(),
      options: [] as unknown[],
      callback: null as ResizeObserverCallback | null
    }

    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          state.callback = callback
        }

        disconnect = vi.fn(() => {
          state.disconnects++
          state.observed.clear()
        })
        observe = vi.fn((target: Element, options?: ResizeObserverOptions) => {
          state.observed.add(target)
          state.fresh.push(target)
          state.options.push(options?.box)
        })
        unobserve = vi.fn((target: Element) => state.observed.delete(target))
      } as unknown as typeof ResizeObserver
    )

    const deliver = (box: [number, number]) => {
      const targets = state.fresh.filter(target => state.observed.has(target))

      state.fresh = []
      state.callback?.(
        targets.map(target => entry(target, box)),
        {} as ResizeObserver
      )
    }

    return { deliver, state }
  }

  it('stopRendererCanvasSync releases the whole watch of a closing pane', () => {
    const { state } = installBoxObserver()
    const { renders, term } = mountTerminal([[990, 1219]])
    const cancel = vi.spyOn(window, 'cancelAnimationFrame')

    scheduleRendererCanvasSync(term)
    expect(renders.size).toBe(1)

    stopRendererCanvasSync(term)

    expect(state.disconnects).toBe(1)
    expect(renders.size).toBe(0)
    expect(cancel).toHaveBeenCalled()

    // A second stop (the active effect's own cleanup) is a no-op, not a throw.
    expect(() => stopRendererCanvasSync(term)).not.toThrow()
    expect(state.disconnects).toBe(1)
  })

  it('adopts the snapped box for a split pane whose stores were reset to the device dims', () => {
    const { canvases, handleResize, refresh, term } = mountTerminal([
      [990, 1218],
      [990, 1218]
    ])

    expect(
      syncRendererCanvas(
        term,
        canvases.map(canvas => entry(canvas, [990, 1219]))
      )
    ).toBe(true)
    expect(canvases.map(canvas => [canvas.width, canvas.height])).toEqual([
      [990, 1219],
      [990, 1219]
    ])
    // One full viewport redraw, and never a rebuild back to the device dims.
    expect(refresh).toHaveBeenCalledExactlyOnceWith(0, 37)
    expect(handleResize).not.toHaveBeenCalled()
  })

  it('leaves stores that already match their device-pixel box alone', () => {
    const { canvases, refresh, term } = mountTerminal([
      [990, 1219],
      [990, 1219]
    ])

    expect(
      syncRendererCanvas(
        term,
        canvases.map(canvas => entry(canvas, [990, 1219]))
      )
    ).toBe(false)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('skips missing boxes, hidden 0x0 boxes and detached canvases', () => {
    const { canvases, refresh, term } = mountTerminal([
      [990, 1218],
      [990, 1218],
      [990, 1218]
    ])

    canvases[2].remove()

    expect(
      syncRendererCanvas(term, [entry(canvases[0], null), entry(canvases[1], [0, 0]), entry(canvases[2], [990, 1219])])
    ).toBe(false)
    expect(canvases.every(canvas => canvas.height === 1218)).toBe(true)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('observes every canvas device-pixel box once, one frame after the latest fit of a burst', () => {
    const raf = installRaf()
    const { deliver, state } = installBoxObserver()

    const { canvases, refresh, term } = mountTerminal([
      [990, 1218],
      [990, 1218]
    ])

    scheduleRendererCanvasSync(term)
    scheduleRendererCanvasSync(term)

    expect(raf.pending()).toBe(1)
    expect(state.observed.size).toBe(0)

    raf.flush()

    expect([...state.observed]).toEqual(canvases)
    expect(state.options).toEqual(['device-pixel-content-box', 'device-pixel-content-box'])

    deliver([990, 1219])

    expect(canvases.map(canvas => canvas.height)).toEqual([1219, 1219])
    expect(refresh).toHaveBeenCalledOnce()
    expect(raf.pending()).toBe(0)
  })

  it('re-adopts the box after a handleResize resets the store while the box stays put', () => {
    const raf = installRaf()
    const { deliver } = installBoxObserver()
    const { canvases, handleResize, refresh, render, term } = mountTerminal([[990, 1218]])

    scheduleRendererCanvasSync(term)
    raf.flush()
    deliver([990, 1219])
    refresh.mockClear()

    // A clean rebuild at the same CSS size: no observer reports it, the next render does.
    canvases[0].height = 1218
    render()

    expect(canvases[0].height).toBe(1219)
    expect(refresh).toHaveBeenCalledExactlyOnceWith(0, 37)

    render()

    expect(refresh).toHaveBeenCalledOnce()
    expect(handleResize).not.toHaveBeenCalled()
  })

  it('never forces a box measured at another CSS size; the next fit re-observes for a fresh one', () => {
    const raf = installRaf()
    const { deliver, state } = installBoxObserver()
    const { canvases, render, term } = mountTerminal([[990, 1218]])

    scheduleRendererCanvasSync(term)
    raf.flush()
    deliver([990, 1219])

    // A resize: new device dims and CSS size, box not delivered yet.
    canvases[0].width = 1008
    canvases[0].height = 1254
    canvases[0].style.height = '697px'
    render()

    expect([canvases[0].width, canvases[0].height]).toEqual([1008, 1254])

    scheduleRendererCanvasSync(term)
    raf.flush()

    expect(state.fresh).toEqual(canvases)

    deliver([1008, 1255])

    expect(canvases[0].height).toBe(1255)
  })

  it('watches the canvas a renderer switch adds, and stops with the terminal visibility', () => {
    const raf = installRaf()
    const { deliver, state } = installBoxObserver()
    const { addCanvas, canvases, render, renders, term } = mountTerminal([])

    scheduleRendererCanvasSync(term)
    raf.flush()

    expect(state.observed.size).toBe(0)

    canvases.push(addCanvas([990, 1218]))
    scheduleRendererCanvasSync(term)
    raf.flush()
    deliver([990, 1219])

    expect(canvases[0].height).toBe(1219)

    scheduleRendererCanvasSync(term)
    stopRendererCanvasSync(term)
    canvases[0].height = 1218
    render()

    expect(raf.pending()).toBe(0)
    expect(state.disconnects).toBe(1)
    expect(renders.size).toBe(0)
    expect(canvases[0].height).toBe(1218)
  })
})
