/**
 * Unit tests for the pure window-state geometry helpers. These cover the logic
 * that protects the user: garbage rejection, off-screen fallback, oversized
 * clamping, and the debounce that collapses mid-drag write storms.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { describe, expect, it, test, vi } from 'vitest'

import {
  bindGeometryPersistence,
  bindStage3dOpener,
  computeWindowOptions,
  debounce,
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  displayMatching,
  growIntoWorkArea,
  installDisplayAwareMinimumOn,
  MIN_HEIGHT,
  MIN_WIDTH,
  minWindowSize,
  onScreen,
  PANE_MIN_WIDTH,
  sanitizeWindowState,
  stage3dWindowBounds,
  type WorkAreaLike
} from './window-state'

// A single 1920×1080 monitor (work area trimmed for the taskbar).
const PRIMARY = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }]
// A laptop panel left behind after a bigger external monitor is unplugged.
const LAPTOP = [{ workArea: { x: 0, y: 0, width: 1366, height: 728 } }]

// ─── sanitizeWindowState ───────────────────────────────────────────────────

test('sanitizeWindowState rejects missing/garbage input', () => {
  for (const bad of [
    null,
    undefined,
    'nope',
    42,
    {},
    { width: 'x', height: 800 },
    { width: NaN, height: 800 },
    { width: 1000 }
  ]) {
    assert.equal(sanitizeWindowState(bad), null)
  }
})

test('sanitizeWindowState keeps a valid full state and rounds HiDPI fractions', () => {
  assert.deepEqual(sanitizeWindowState({ x: 100.6, y: 50.2, width: 1400.4, height: 900.7, isMaximized: true }), {
    x: 101,
    y: 50,
    width: 1400,
    height: 901,
    isMaximized: true
  })
})

test('sanitizeWindowState floors size to the minimums', () => {
  const state = sanitizeWindowState({ width: 10, height: 10 })
  assert.ok(state)
  assert.equal(state.width, MIN_WIDTH)
  assert.equal(state.height, MIN_HEIGHT)
})

test('sanitizeWindowState drops a partial position but keeps the size', () => {
  assert.deepEqual(sanitizeWindowState({ x: 100, width: 1400, height: 900 }), {
    width: 1400,
    height: 900,
    isMaximized: false
  })
})

test('sanitizeWindowState treats isMaximized strictly', () => {
  const state = sanitizeWindowState({ width: 1400, height: 900, isMaximized: 'yes' })
  assert.ok(state)
  assert.equal(state.isMaximized, false)
})

// ─── onScreen ──────────────────────────────────────────────────────────────

test('onScreen accepts a window on the primary or a secondary display', () => {
  const dual = [...PRIMARY, { workArea: { x: 1920, y: 0, width: 2560, height: 1400 } }]
  assert.equal(onScreen({ x: 100, y: 100, width: 1220, height: 800 }, PRIMARY), true)
  assert.equal(onScreen({ x: 2200, y: 200, width: 1220, height: 800 }, dual), true)
})

test('onScreen rejects off-screen, slivers, and bad input', () => {
  assert.equal(onScreen({ x: 3000, y: 100, width: 1220, height: 800 }, PRIMARY), false) // past right edge
  assert.equal(onScreen({ x: 100, y: -900, width: 1220, height: 800 }, PRIMARY), false) // above top
  assert.equal(onScreen({ x: 1910, y: 100, width: 1220, height: 800 }, PRIMARY), false) // ~10px sliver
  assert.equal(onScreen({ x: 0, y: 0, width: 1220, height: 800 }, []), false)
  assert.equal(onScreen({ x: 0, y: 0, width: 1220, height: 800 }, null), false)
})

// ─── computeWindowOptions ──────────────────────────────────────────────────

test('computeWindowOptions falls back to defaults with no saved state', () => {
  assert.deepEqual(computeWindowOptions(null, PRIMARY), { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT })
})

test('computeWindowOptions restores an on-screen position', () => {
  const saved = sanitizeWindowState({ x: 200, y: 150, width: 1400, height: 900 })
  assert.deepEqual(computeWindowOptions(saved, PRIMARY), { width: 1400, height: 900, x: 200, y: 150 })
})

test('computeWindowOptions keeps the size but drops an off-screen position', () => {
  const saved = sanitizeWindowState({ x: 5000, y: 150, width: 1400, height: 900 })
  assert.deepEqual(computeWindowOptions(saved, PRIMARY), { width: 1400, height: 900 })
})

test('computeWindowOptions clamps a size larger than the only display', () => {
  const saved = sanitizeWindowState({ width: 2560, height: 1440 })
  assert.deepEqual(computeWindowOptions(saved, LAPTOP), { width: 1366, height: 728 })
})

test('computeWindowOptions keeps the MIN floor on a sub-minimum display', () => {
  // v0.0.9 F6: the floors are 375 × 300 now (the live minimum is a share of the display); a 480-tall display fits.
  const tiny = [{ workArea: { x: 0, y: 0, width: 360, height: 240 } }]
  const saved = sanitizeWindowState({ width: 2000, height: 1500 })
  assert.deepEqual(computeWindowOptions(saved, tiny), { width: MIN_WIDTH, height: MIN_HEIGHT })
})

test('computeWindowOptions does not clamp when displays are unknown', () => {
  const saved = sanitizeWindowState({ width: 2560, height: 1440 })
  assert.deepEqual(computeWindowOptions(saved, []), { width: 2560, height: 1440 })
})

// ─── debounce ──────────────────────────────────────────────────────────────

test('debounce coalesces a burst into one trailing run', () => {
  vi.useFakeTimers()
  let calls = 0

  const d = debounce(() => {
    calls += 1
  }, 250)

  d()
  d()
  d()
  assert.equal(calls, 0)
  vi.advanceTimersByTime(249)
  assert.equal(calls, 0)
  vi.advanceTimersByTime(1)
  assert.equal(calls, 1)

  vi.useRealTimers()
})

test('debounce.flush runs now and cancels the pending timer', () => {
  vi.useFakeTimers()
  let calls = 0

  const d = debounce(() => {
    calls += 1
  }, 250)

  d()
  d.flush()
  assert.equal(calls, 1)
  vi.advanceTimersByTime(1000)
  assert.equal(calls, 1)

  vi.useRealTimers()
})

// ─── bindGeometryPersistence ───────────────────────────────────────────────

test('bindGeometryPersistence saves on drag and on resize', () => {
  const win = new EventEmitter()
  let saves = 0

  bindGeometryPersistence(win, () => {
    saves += 1
  })

  win.emit('move')
  win.emit('resize')
  assert.equal(saves, 2)
})

// The regression this exists for: `moved`/`resized` never fire on Linux, so a
// window bound only to those pretends to persist and silently forgets its place
// every launch. A window that emits nothing else must still save.
test('a window that never emits moved/resized still saves its geometry', () => {
  const win = new EventEmitter()
  let saves = 0

  bindGeometryPersistence(win, () => {
    saves += 1
  })

  win.emit('move')
  assert.ok(saves > 0)
})

// ─── v0.0.9 F6: the minimum follows the display ─────────────────────────────
// Fails on the code before F6: the minimum was a fixed 400 × 620 and none of these helpers existed.

// Work areas in points (macOS "looks like" sizes; the menu bar is outside the work area unless noted).
const MAC_14 = { x: 0, y: 0, width: 1512, height: 982 }
const MAC_16 = { x: 0, y: 0, width: 1728, height: 1117 }
const EXTERNAL_4K = { x: 1512, y: -100, width: 1920, height: 1055 }
const SMALL_1280 = { x: 0, y: 24, width: 1280, height: 776 }

test('minWindowSize: ⅓ of the usable width (never under 375) × ½ of the usable height', () => {
  assert.deepEqual(minWindowSize(MAC_14), { width: 504, height: 491 })
  assert.deepEqual(minWindowSize(MAC_16), { width: 576, height: 559 })
  assert.deepEqual(minWindowSize(EXTERNAL_4K), { width: 640, height: 528 })
  assert.deepEqual(minWindowSize(SMALL_1280), { width: 427, height: 388 })
})

test('minWindowSize never goes under one 375-pt pane, and falls back to the floors without a display', () => {
  assert.equal(PANE_MIN_WIDTH, 375)
  assert.equal(minWindowSize({ x: 0, y: 0, width: 900, height: 700 }).width, 375)
  assert.deepEqual(minWindowSize(null), { width: MIN_WIDTH, height: MIN_HEIGHT })
})

test('display switch 14″ → external 4K → 14″: the minimum is re-measured on the display holding the centre', () => {
  const displays = [{ workArea: MAC_14 }, { workArea: EXTERNAL_4K }]
  const onLaptop = { x: 200, y: 100, width: 700, height: 600 }
  const onExternal = { x: 2000, y: 100, width: 700, height: 600 }
  // Straddling, with its centre on the external display.
  const straddling = { x: 1300, y: 100, width: 700, height: 600 }

  assert.deepEqual(minWindowSize(displayMatching(onLaptop, displays)?.workArea), { width: 504, height: 491 })
  assert.deepEqual(minWindowSize(displayMatching(onExternal, displays)?.workArea), { width: 640, height: 528 })
  assert.deepEqual(minWindowSize(displayMatching(straddling, displays)?.workArea), { width: 640, height: 528 })
  assert.deepEqual(minWindowSize(displayMatching(onLaptop, displays)?.workArea), { width: 504, height: 491 })
})

test('growIntoWorkArea: a window below the new minimum grows inside its own work area, never onto another display', () => {
  // Moved to the 4K at 600 × 500: under 640 × 528.
  const grown = growIntoWorkArea({ x: 3220, y: 400, width: 600, height: 500 }, minWindowSize(EXTERNAL_4K), EXTERNAL_4K)

  assert.ok(grown)
  assert.equal(grown.width, 640)
  assert.equal(grown.height, 528)
  // Growing pushed the right edge past the work area: it slides back in.
  assert.ok(grown.x + grown.width <= EXTERNAL_4K.x + EXTERNAL_4K.width)
  assert.ok(grown.x >= EXTERNAL_4K.x)
  assert.ok(grown.y + grown.height <= EXTERNAL_4K.y + EXTERNAL_4K.height)
})

test('growIntoWorkArea leaves a window that already satisfies the minimum alone', () => {
  assert.equal(growIntoWorkArea({ x: 0, y: 0, width: 800, height: 600 }, minWindowSize(MAC_14), MAC_14), null)
})

test('back on the 14″ the 4K-sized window is above the laptop minimum: nothing to grow', () => {
  assert.equal(growIntoWorkArea({ x: 100, y: 50, width: 640, height: 528 }, minWindowSize(MAC_14), MAC_14), null)
})

test('stage3dWindowBounds: ⅔ of the work area, on the side opposite the main window (⅓ + ⅔ at the minimum)', () => {
  const main = { x: 0, y: 0, width: 504, height: 982 }
  const right = stage3dWindowBounds(main, MAC_14, null, [{ workArea: MAC_14 }])

  assert.deepEqual(right, { x: 1512 - 1008, y: 0, width: 1008, height: 982 })
  assert.equal(main.width + right.width, MAC_14.width)

  const mainOnRight = { x: 1008, y: 0, width: 504, height: 982 }

  assert.deepEqual(stage3dWindowBounds(mainOnRight, MAC_14, null, [{ workArea: MAC_14 }]), {
    x: 0,
    y: 0,
    width: 1008,
    height: 982
  })
})

test('stage3dWindowBounds: a saved on-screen position (suffix stage3d) wins, kept above the minimum', () => {
  const saved = sanitizeWindowState({ x: 300, y: 80, width: 400, height: 300 })
  const bounds = stage3dWindowBounds(null, MAC_14, saved, [{ workArea: MAC_14 }])

  assert.deepEqual(bounds, { x: 300, y: 80, width: 504, height: 491 })
})

test('stage3dWindowBounds: a saved position on a display that is gone falls back to ⅔', () => {
  const saved = sanitizeWindowState({ x: 5000, y: 80, width: 900, height: 700 })

  assert.equal(stage3dWindowBounds(null, MAC_14, saved, [{ workArea: MAC_14 }]).width, 1008)
})

// v0.0.9 Q (tests-perf 10): the display-aware minimum and the 3D window's opener wiring, with fake windows/screens.
describe('installDisplayAwareMinimumOn — listeners, minimum, no resize when maximized', () => {
  function fakes(options: { maximized?: boolean; bounds?: WorkAreaLike } = {}) {
    const winListeners = new Map<string, () => void>()
    const screenListeners = new Map<string, Set<() => void>>()
    const area = { x: 0, y: 0, width: 1500, height: 1000 }
    let min = [0, 0]

    const win = {
      destroyed: false,
      bounds: options.bounds ?? { x: 10, y: 10, width: 400, height: 300 },
      isDestroyed() {
        return this.destroyed
      },
      getBounds() {
        return this.bounds
      },
      getMinimumSize: () => min,
      setMinimumSize: vi.fn((w: number, h: number) => {
        min = [w, h]
      }),
      isMaximized: () => options.maximized === true,
      isFullScreen: () => false,
      isMinimized: () => false,
      setBounds: vi.fn(),
      on: (event: string, fn: () => void) => winListeners.set(event, fn),
      once: (event: string, fn: () => void) => winListeners.set(event, fn)
    }

    const displays = {
      area,
      getDisplayMatching: () => ({ workArea: area }),
      on: (event: string, fn: () => void) => {
        screenListeners.set(event, (screenListeners.get(event) ?? new Set()).add(fn))
      },
      removeListener: (event: string, fn: () => void) => screenListeners.get(event)?.delete(fn)
    }

    const count = () => [...screenListeners.values()].reduce((n, set) => n + set.size, 0)

    return { count, displays, screenListeners, win, winListeners }
  }

  it('three screen listeners while open, none after the window closes', () => {
    const f = fakes()

    installDisplayAwareMinimumOn(f.win, f.displays, fn => fn)
    expect(f.count()).toBe(3)
    f.winListeners.get('closed')!()
    expect(f.count()).toBe(0)
  })

  it('a display metrics change re-applies the minimum of that display', () => {
    const f = fakes()

    installDisplayAwareMinimumOn(f.win, f.displays, fn => fn)
    f.win.setMinimumSize.mockClear()
    f.displays.area.width = 3000
    f.displays.area.height = 2000

    for (const fn of f.screenListeners.get('display-metrics-changed')!) {
      fn()
    }

    expect(f.win.setMinimumSize).toHaveBeenCalledWith(...Object.values(minWindowSize(f.displays.area)))
  })

  it('a window below its minimum grows, but never while maximized', () => {
    const grown = fakes()

    installDisplayAwareMinimumOn(grown.win, grown.displays, fn => fn)
    expect(grown.win.setBounds).toHaveBeenCalled()

    const maximized = fakes({ maximized: true })

    installDisplayAwareMinimumOn(maximized.win, maximized.displays, fn => fn)
    expect(maximized.win.setMinimumSize).toHaveBeenCalled()
    expect(maximized.win.setBounds).not.toHaveBeenCalled()
  })

  it('a move is debounced through the given scheduler, and a destroyed window is left alone', () => {
    const f = fakes()
    const pending: (() => void)[] = []

    installDisplayAwareMinimumOn(f.win, f.displays, fn => () => pending.push(fn))
    f.win.setMinimumSize.mockClear()
    f.winListeners.get('move')!()
    expect(f.win.setMinimumSize).not.toHaveBeenCalled()
    f.win.destroyed = true
    pending.forEach(fn => fn())
    expect(f.win.setMinimumSize).not.toHaveBeenCalled()
  })
})

describe('bindStage3dOpener — the 3D window follows its opener and cleans up after itself', () => {
  function opener() {
    const contents = new Map<string, () => void>()
    const own = new Map<string, () => void>()

    return {
      contents,
      own,
      destroyed: false,
      isDestroyed() {
        return this.destroyed
      },
      once: (event: string, fn: () => void) => own.set(event, fn),
      removeListener: (event: string) => own.delete(event),
      webContents: {
        on: (event: string, fn: () => void) => contents.set(event, fn),
        removeListener: (event: string) => contents.delete(event)
      }
    }
  }

  it('closes on the opener navigating, losing its renderer or closing; removes every listener on close', () => {
    for (const trigger of ['did-navigate', 'render-process-gone', 'closed']) {
      const o = opener()
      const winListeners = new Map<string, () => void>()
      const close = vi.fn()

      bindStage3dOpener({ on: (event: string, fn: () => void) => winListeners.set(event, fn) }, o, close)
      ;(o.contents.get(trigger) ?? o.own.get(trigger))!()
      expect(close, trigger).toHaveBeenCalledOnce()

      winListeners.get('closed')!()
      expect(o.contents.size + o.own.size, trigger).toBe(0)
    }
  })

  it('no opener (or a destroyed one): nothing is bound', () => {
    const close = vi.fn()
    const on = vi.fn()

    bindStage3dOpener({ on }, null, close)

    const dead = opener()

    dead.destroyed = true
    bindStage3dOpener({ on }, dead, close)
    expect(on).not.toHaveBeenCalled()
    expect(dead.contents.size).toBe(0)
  })
})
