import type { Terminal } from '@xterm/xterm'

interface ActiveTerminalResizeOptions {
  fitOnActivate?: boolean
  onActivate: () => void
  onFit: () => void
}

/**
 * Observe one visible xterm host.
 *
 * Inactive terminals never call this helper, so their preserved DOM/PTY stays
 * mounted without paying for ResizeObserver delivery or FitAddon work. The
 * first frame owns activation and ignores the observer's initial delivery;
 * later resize bursts are coalesced to one fit per animation frame.
 */
export function observeActiveTerminalResize(
  host: HTMLElement,
  { fitOnActivate = true, onActivate, onFit }: ActiveTerminalResizeOptions
): () => void {
  let activated = false
  let frame = 0
  let initialResizeDelivered = false
  let stopped = false

  const scheduleFit = () => {
    if (!activated || stopped || frame !== 0) {
      return
    }

    frame = window.requestAnimationFrame(() => {
      frame = 0

      if (!stopped) {
        onFit()
      }
    })
  }

  const observer = new ResizeObserver(() => {
    // ResizeObserver's initial delivery is asynchronous in browsers and may
    // arrive before OR after the activation rAF. Activation already fits the
    // current box, so absorb that first delivery in either ordering.
    if (!initialResizeDelivered) {
      initialResizeDelivered = true

      return
    }

    scheduleFit()
  })

  observer.observe(host)

  frame = window.requestAnimationFrame(() => {
    frame = 0

    if (stopped) {
      return
    }

    activated = true

    if (fitOnActivate) {
      onFit()
    }

    onActivate()
  })

  return () => {
    stopped = true
    observer.disconnect()

    if (frame !== 0) {
      window.cancelAnimationFrame(frame)
      frame = 0
    }
  }
}

type DeviceBox = readonly [width: number, height: number, cssWidth: string, cssHeight: string]

// Each canvas's latest device-pixel box, with the CSS size it was measured at.
const deviceBoxes = new WeakMap<HTMLCanvasElement, DeviceBox>()

// xterm's _setCanvasDevicePixelDimensions: a matching store is left alone.
function adoptDeviceBox(canvas: HTMLCanvasElement, width: number, height: number): boolean {
  if (width <= 0 || height <= 0 || (canvas.width === width && canvas.height === height)) {
    return false
  }

  canvas.width = width
  canvas.height = height

  return true
}

/**
 * Put each observed canvas under a visible terminal's .xterm-screen on its
 * device-pixel-content-box; returns whether a backing store changed.
 *
 * At a fractional DPR the browser snaps a canvas's device-pixel box by where
 * the pane sits (a split left pane A: a 990x1219 box for 990x1218 device
 * dims). The WebGL renderer's own observer adopts that box, so the compositor
 * maps the store 1:1, but it only reports box changes. A changed store gets a
 * full viewport redraw, as in the renderer's _setCanvasDevicePixelDimensions.
 */
export function syncRendererCanvas(term: Terminal, entries: readonly ResizeObserverEntry[]): boolean {
  let changed = false

  for (const entry of entries) {
    const canvas = entry.target
    // Absent where the browser has no device-pixel-content-box support.
    const box = (entry.devicePixelContentBoxSize as readonly ResizeObserverSize[] | undefined)?.[0]

    if (!(canvas instanceof HTMLCanvasElement) || !canvas.isConnected || !box) {
      continue
    }

    deviceBoxes.set(canvas, [box.inlineSize, box.blockSize, canvas.style.width, canvas.style.height])
    changed = adoptDeviceBox(canvas, box.inlineSize, box.blockSize) || changed
  }

  if (changed) {
    term.refresh(0, term.rows - 1)
  }

  return changed
}

/**
 * Re-adopt the known box after a render; returns whether a store changed.
 *
 * A handleResize that keeps the CSS size (a clean rebuild, a char-size or
 * DPR pass) resets the store to the device dims while the box stays put, so
 * no observer reports it. A box measured at another CSS size is stale: the
 * observers deliver the new one after this frame's layout.
 */
function restoreRendererCanvas(term: Terminal, canvases: readonly HTMLCanvasElement[]): boolean {
  let changed = false

  for (const canvas of canvases) {
    const box = deviceBoxes.get(canvas)

    if (box && canvas.isConnected && box[2] === canvas.style.width && box[3] === canvas.style.height) {
      changed = adoptDeviceBox(canvas, box[0], box[1]) || changed
    }
  }

  if (changed) {
    term.refresh(0, term.rows - 1)
  }

  return changed
}

interface CanvasWatch {
  canvases: HTMLCanvasElement[]
  frame: number
  observer: ResizeObserver
  render: { dispose(): void }
}

const canvasWatches = new WeakMap<Terminal, CanvasWatch>()

/**
 * Keep a visible terminal's canvases on their device-pixel box. Called after
 * every visible fit or renderer switch: one frame later (a later fit in the
 * same burst re-arms it) the canvases are re-observed, and a fresh
 * observation always delivers the current box once that frame's layout has
 * snapped it. Between fits, every render re-adopts the known box.
 */
export function scheduleRendererCanvasSync(term: Terminal) {
  if (typeof ResizeObserver === 'undefined') {
    return
  }

  let watch = canvasWatches.get(term)

  if (!watch) {
    const created: CanvasWatch = {
      canvases: [],
      frame: 0,
      observer: new ResizeObserver(entries => syncRendererCanvas(term, entries)),
      render: term.onRender(() => restoreRendererCanvas(term, created.canvases))
    }

    watch = created
    canvasWatches.set(term, watch)
  }

  const current = watch

  window.cancelAnimationFrame(current.frame)
  current.frame = window.requestAnimationFrame(() => {
    const screen = term.element?.isConnected ? term.element.querySelector('.xterm-screen') : null

    current.canvases.forEach(canvas => current.observer.unobserve(canvas))
    current.canvases = screen ? Array.from(screen.querySelectorAll('canvas')) : []

    try {
      current.canvases.forEach(canvas => current.observer.observe(canvas, { box: 'device-pixel-content-box' }))
    } catch {
      // No device-pixel-content-box (non-Chromium): no snapped box to match.
      stopRendererCanvasSync(term)
    }
  })
}

/** Drop a terminal's canvas watch when it stops being visible. */
export function stopRendererCanvasSync(term: Terminal | null | undefined) {
  const watch = term ? canvasWatches.get(term) : undefined

  if (!term || !watch) {
    return
  }

  window.cancelAnimationFrame(watch.frame)
  watch.observer.disconnect()
  watch.render.dispose()
  canvasWatches.delete(term)
}
