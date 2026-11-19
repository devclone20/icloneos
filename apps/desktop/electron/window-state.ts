/**
 * Pure geometry helpers for window-state.json — restoring the main window's
 * size, position, and maximized flag across launches. Side-effect-free so the
 * part that actually matters (rejecting garbage + off-screen bounds) is
 * unit-testable without booting Electron; main.ts owns the file I/O and the
 * live `screen` displays.
 */

import { clamp } from '../src/iclone-shared/math'

// Defaults mirror the historical hardcoded BrowserWindow size. A fresh install
// (no saved state) is byte-identical to before.
const DEFAULT_WIDTH = 1220
const DEFAULT_HEIGHT = 800
// v0.0.9 F6: the live minimum is no longer a constant — it is a share of the
// display the window is on (minWindowSize below: ⅓ of the work area's width,
// never under 375; ½ of its height). MIN_* are only the absolute floors a
// SAVED size is sanitized to (a window can never be smaller than its smallest
// possible live minimum: 375 wide, and ½ of a 600-pt-tall work area high).
const MIN_WIDTH = 375
const MIN_HEIGHT = 300
/** One pane's minimum (pane-layout.ts PANE_MIN_PX): the window is never narrower. */
const PANE_MIN_WIDTH = 375

// Keep at least this much of the window over a display work area before we trust
// a saved position, so the title bar stays grabbable after a monitor unplugs.
const MIN_VISIBLE = 48

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

interface SanitizedWindowState {
  width: number
  height: number
  isMaximized: boolean
  x?: number
  y?: number
}

// Parse raw JSON → clean state, or null if garbage. width/height are required
// and floored; x/y survive only as a finite pair; isMaximized is strict.
function sanitizeWindowState(raw?: any): SanitizedWindowState | null {
  if (!raw || typeof raw !== 'object' || !finite(raw.width) || !finite(raw.height)) {
    return null
  }

  const state: SanitizedWindowState = {
    width: Math.max(MIN_WIDTH, Math.round(raw.width)),
    height: Math.max(MIN_HEIGHT, Math.round(raw.height)),
    isMaximized: raw.isMaximized === true
  }

  if (finite(raw.x) && finite(raw.y)) {
    state.x = Math.round(raw.x)
    state.y = Math.round(raw.y)
  }

  return state
}

// True when `bounds` overlaps some display's work area by ≥ MIN_VISIBLE on both
// axes. `displays` is Electron's screen.getAllDisplays() shape.
function onScreen(
  bounds: Electron.Rectangle,
  displays: readonly { workArea?: Electron.Rectangle }[] | null | undefined
) {
  if (!Array.isArray(displays)) {
    return false
  }

  return displays.some(({ workArea: a } = {}) => {
    if (!a) {
      return false
    }

    const x = Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x)
    const y = Math.min(bounds.y + bounds.height, a.y + a.height) - Math.max(bounds.y, a.y)

    return x >= MIN_VISIBLE && y >= MIN_VISIBLE
  })
}

interface WindowOptions {
  width: number
  height: number
  x?: number
  y?: number
}

// Sanitized state (or null) → BrowserWindow size/position options. Always sets
// width/height, capped to the largest current display so a size saved on a
// since-disconnected bigger monitor can't exceed any screen the user now has.
// Sets x/y only when still on-screen; otherwise Electron centers the window.
function computeWindowOptions(
  state: SanitizedWindowState | null,
  displays: readonly { workArea?: Electron.Rectangle }[] | null | undefined
): WindowOptions {
  const opts: WindowOptions = {
    width: finite(state?.width) ? state.width : DEFAULT_WIDTH,
    height: finite(state?.height) ? state.height : DEFAULT_HEIGHT
  }

  const cap = (Array.isArray(displays) ? displays : []).reduce(
    (m, { workArea: a } = {}) =>
      a && finite(a.width) && finite(a.height)
        ? { width: Math.max(m.width, a.width), height: Math.max(m.height, a.height) }
        : m,
    { width: 0, height: 0 }
  )

  if (cap.width && cap.height) {
    opts.width = clamp(opts.width, MIN_WIDTH, cap.width)
    opts.height = clamp(opts.height, MIN_HEIGHT, cap.height)
  }

  if (
    state &&
    finite(state.x) &&
    finite(state.y) &&
    onScreen({ x: state.x, y: state.y, width: opts.width, height: opts.height }, displays)
  ) {
    opts.x = state.x
    opts.y = state.y
  }

  return opts
}

// Trailing debounce: collapse a burst of resize/move events (Linux fires many
// mid-drag) into a single run `delayMs` after the last. `.flush()` runs now and
// cancels the pending timer — used on close, before the window is gone.
function debounce(fn: () => void, delayMs?: number) {
  let timer: ReturnType<typeof setTimeout> | undefined

  const debounced = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      fn()
    }, delayMs)
  }

  debounced.flush = () => {
    clearTimeout(timer)
    timer = undefined
    fn()
  }

  return debounced
}

// The geometry events worth persisting from. `moved` and `resized` — the
// settled-once-per-drag pair — are macOS/Windows only (Electron tags them
// `@platform darwin,win32`), so a window bound to those alone never saves its
// place on Linux: the events simply never arrive. `move` and `resize` carry no
// platform tag and fire everywhere. They also fire continuously mid-drag, which
// is what the trailing debounce above is for — and once a burst collapses to a
// single trailing run, the settled events add nothing the debounce hasn't
// already given us.
const GEOMETRY_EVENTS = ['move', 'resize']

// Bind `schedule` to every geometry event, on a BrowserWindow or any emitter
// with `.on`. One call site per window so the platform reasoning above can't be
// half-applied to one window and not the other.
function bindGeometryPersistence(win: { on(event: string, listener: () => void): unknown }, schedule: () => void) {
  for (const event of GEOMETRY_EVENTS) {
    win.on(event, schedule)
  }
}

// ─── v0.0.9 F6: the minimum follows the display ───────────────────────────
//
// Owner rule: a window may shrink to ⅓ of its display's usable width (never
// under one 375-pt pane) and ½ of its usable height. Measured on the work area
// of the display that holds the window's centre (screen.getDisplayMatching).
//   14″ (1512 × 982)            → 504 × 491
//   16″ (1728 × 1117)           → 576 × 559
//   4K at 1920 × 1080 (≈1920 × 1055 usable) → 640 × 528
//   1280 × 800                  → 427 × 400 (388 with the menu bar out of the work area)

interface WorkAreaLike {
  x: number
  y: number
  width: number
  height: number
}

interface SizeLike {
  width: number
  height: number
}

/** The live minimum on a display with this work area. */
function minWindowSize(workArea: null | undefined | WorkAreaLike): SizeLike {
  if (!workArea || !finite(workArea.width) || !finite(workArea.height) || workArea.width <= 0) {
    return { width: MIN_WIDTH, height: MIN_HEIGHT }
  }

  return {
    width: Math.max(PANE_MIN_WIDTH, Math.round(workArea.width / 3)),
    height: Math.max(1, Math.round(workArea.height / 2))
  }
}

/**
 * Bounds below a new minimum grow INTO the work area — never onto another
 * display: the size rises to the minimum (capped by the work area) and the
 * window slides back inside if growing pushed an edge out. Null when the
 * bounds already satisfy the minimum (nothing to do).
 */
function growIntoWorkArea(
  bounds: WorkAreaLike,
  min: SizeLike,
  workArea: null | undefined | WorkAreaLike
): null | WorkAreaLike {
  if (bounds.width >= min.width && bounds.height >= min.height) {
    return null
  }

  const width = Math.max(bounds.width, min.width)
  const height = Math.max(bounds.height, min.height)

  if (!workArea) {
    return { x: bounds.x, y: bounds.y, width, height }
  }

  const fitWidth = Math.min(width, workArea.width)
  const fitHeight = Math.min(height, workArea.height)
  const x = clamp(bounds.x, workArea.x, workArea.x + workArea.width - fitWidth)
  const y = clamp(bounds.y, workArea.y, workArea.y + workArea.height - fitHeight)

  return { x, y, width: fitWidth, height: fitHeight }
}

/** The display a window belongs to: the one whose work area holds its centre, else the most overlap (Electron's
 *  getDisplayMatching rule), for tests and for callers that only have the display list. */
function displayMatching<D extends { workArea?: WorkAreaLike }>(bounds: WorkAreaLike, displays: readonly D[]): D | null {
  const cx = bounds.x + bounds.width / 2
  const cy = bounds.y + bounds.height / 2
  let best: D | null = null
  let bestOverlap = -1

  for (const display of displays) {
    const a = display.workArea

    if (!a) {
      continue
    }

    if (cx >= a.x && cx < a.x + a.width && cy >= a.y && cy < a.y + a.height) {
      return display
    }

    const overlap =
      Math.max(0, Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x)) *
      Math.max(0, Math.min(bounds.y + bounds.height, a.y + a.height) - Math.max(bounds.y, a.y))

    if (overlap > bestOverlap) {
      best = display
      bestOverlap = overlap
    }
  }

  return best
}

/**
 * The 3D iNFT's own window: ⅔ of the work area, full usable height, on the side OPPOSITE the main window (the main
 * window's centre left of the work area's centre → the stage window takes the right). With the main window at its
 * minimum that is ⅓ + ⅔. A saved position (window-state, suffix `stage3d`) wins when it is still on screen.
 */
function stage3dWindowBounds(
  main: null | WorkAreaLike,
  workArea: WorkAreaLike,
  saved: null | SanitizedWindowState,
  displays: readonly { workArea?: Electron.Rectangle }[] | null | undefined
): WorkAreaLike {
  const min = minWindowSize(workArea)

  if (saved && finite(saved.x) && finite(saved.y)) {
    const restored = {
      x: saved.x,
      y: saved.y,
      width: Math.min(Math.max(saved.width, min.width), workArea.width),
      height: Math.min(Math.max(saved.height, min.height), workArea.height)
    }

    if (onScreen(restored, displays)) {
      return restored
    }
  }

  const width = Math.max(min.width, Math.round((workArea.width * 2) / 3))
  const mainCentre = main ? main.x + main.width / 2 : workArea.x
  const onRight = mainCentre <= workArea.x + workArea.width / 2

  return {
    x: onRight ? workArea.x + workArea.width - width : workArea.x,
    y: workArea.y,
    width,
    height: workArea.height
  }
}

/** The parts of a BrowserWindow the display-aware minimum touches (structural, so it unit-tests without Electron). */
interface MinimumWindowLike {
  isDestroyed(): boolean
  getBounds(): WorkAreaLike
  getMinimumSize(): number[]
  setMinimumSize(width: number, height: number): void
  isMaximized(): boolean
  isFullScreen(): boolean
  isMinimized(): boolean
  setBounds(bounds: WorkAreaLike): void
  on(event: 'move', listener: () => void): unknown
  once(event: 'closed', listener: () => void): unknown
}

/** The parts of Electron's `screen` it listens to. */
interface MinimumScreenLike {
  getDisplayMatching(bounds: WorkAreaLike): { workArea: WorkAreaLike } | null | undefined
  on(event: 'display-added' | 'display-metrics-changed' | 'display-removed', listener: () => void): unknown
  removeListener(event: 'display-added' | 'display-metrics-changed' | 'display-removed', listener: () => void): unknown
}

/** v0.0.9 F6: a drag across displays settles once. */
const MIN_SIZE_MOVE_DEBOUNCE_MS = 150

/**
 * v0.0.9 F6 — the minimum follows the display (`minWindowSize`): re-measured when the window moves (debounced) and
 * whenever the displays change. A window left below its new minimum grows into its own work area; maximized,
 * fullscreen and minimized windows keep their bounds (the minimum still updates). The three `screen` listeners go
 * when the window closes (v0.0.9 Q tests-perf 10: proven by window-state.test.ts with a fake window and screen).
 */
function installDisplayAwareMinimumOn(
  win: MinimumWindowLike,
  displays: MinimumScreenLike,
  debounceMove: (fn: () => void) => () => void = fn => debounce(fn, MIN_SIZE_MOVE_DEBOUNCE_MS)
): () => void {
  const apply = () => {
    if (win.isDestroyed()) {
      return
    }

    const bounds = win.getBounds()
    const workArea = displays.getDisplayMatching(bounds)?.workArea
    const min = minWindowSize(workArea)
    const [width, height] = win.getMinimumSize()

    if (width !== min.width || height !== min.height) {
      win.setMinimumSize(min.width, min.height)
    }

    if (win.isMaximized() || win.isFullScreen() || win.isMinimized()) {
      return
    }

    const grown = growIntoWorkArea(bounds, min, workArea)

    if (grown) {
      win.setBounds(grown)
    }
  }

  const onMove = debounceMove(apply)
  const onDisplays = () => apply()

  win.on('move', onMove)
  displays.on('display-metrics-changed', onDisplays)
  displays.on('display-added', onDisplays)
  displays.on('display-removed', onDisplays)

  const dispose = () => {
    displays.removeListener('display-metrics-changed', onDisplays)
    displays.removeListener('display-added', onDisplays)
    displays.removeListener('display-removed', onDisplays)
  }

  win.once('closed', dispose)
  apply()

  return dispose
}

/** The opener side of the 3D window (structural). */
interface OpenerLike {
  isDestroyed(): boolean
  once(event: 'closed', listener: () => void): unknown
  removeListener(event: 'closed', listener: () => void): unknown
  webContents: {
    on(event: 'did-navigate' | 'render-process-gone', listener: () => void): unknown
    removeListener(event: 'did-navigate' | 'render-process-gone', listener: () => void): unknown
  }
}

/**
 * v0.0.9 F6 — the 3D window closes when its opener navigates, loses its renderer or closes (a second stage would
 * mount beside it); every listener it put on the opener is removed when the 3D window closes.
 */
function bindStage3dOpener(
  win: { on(event: 'closed', listener: () => void): unknown },
  opener: OpenerLike | null,
  closeWindow: () => void
): void {
  if (!opener || opener.isDestroyed()) {
    return
  }

  const closeWithOpener = () => closeWindow()

  opener.webContents.on('did-navigate', closeWithOpener)
  opener.webContents.on('render-process-gone', closeWithOpener)
  opener.once('closed', closeWithOpener)

  win.on('closed', () => {
    if (!opener.isDestroyed()) {
      opener.webContents.removeListener('did-navigate', closeWithOpener)
      opener.webContents.removeListener('render-process-gone', closeWithOpener)
      opener.removeListener('closed', closeWithOpener)
    }
  })
}

export {
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
  MIN_SIZE_MOVE_DEBOUNCE_MS,
  MIN_WIDTH,
  minWindowSize,
  onScreen,
  PANE_MIN_WIDTH,
  sanitizeWindowState,
  stage3dWindowBounds
}
export type { SanitizedWindowState, SizeLike, WorkAreaLike }
