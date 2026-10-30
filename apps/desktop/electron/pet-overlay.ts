// The pop-out pet window (V3-P): a transparent, frameless, always-on-top window that hosts only the pixel pet.
//
// It holds NO gateway connection. The main renderer is the single source of truth and pushes the pet's state here
// over IPC; the overlay answers with a handful of control messages. Every channel is fenced twice:
//   1. the P7 seam — `isTrustedSender(event, channel)` must answer exactly `true` (the app's own renderer, top
//      frame, its own URL); anything else (false, undefined, a throw) is a refusal: fail closed;
//   2. the role — the open/close/state/prompt-result channels answer only the main window's renderer, and the
//      overlay's own channels (control, bounds, click-through, focusable) only the overlay's renderer.
// Payloads are checked by shape (finite numbers, a closed set of control types) before anything is touched.
import { pathToFileURL } from 'node:url'

import { BrowserWindow, ipcMain, screen } from 'electron'

import { petPromptId, petPromptResult, type PetPromptResult, petPromptText } from '../src/iclone-shared/pet-prompt'

import { createAppSenderGuard } from './ipc-sender-guard'
import { DEV_SERVER, IS_MAC, PRELOAD_PATH } from './main/env'
import { rememberLog } from './main/log'
import { resolveRendererIndex } from './main/runtime'
import { loadWindowUrl } from './main/shell-open'
import { wireCommonWindowHandlers, wireWindowReveal } from './main/windows'
import { installWindowRendererLifecycle } from './window-renderer-lifecycle'

export const PET_OVERLAY_CHANNELS = {
  close: 'hermes:pet-overlay:close',
  control: 'hermes:pet-overlay:control',
  focusable: 'hermes:pet-overlay:set-focusable',
  ignoreMouse: 'hermes:pet-overlay:ignore-mouse',
  open: 'hermes:pet-overlay:open',
  promptHandoff: 'hermes:pet-overlay:prompt-handoff',
  promptResult: 'hermes:pet-overlay:prompt-result',
  setBounds: 'hermes:pet-overlay:set-bounds',
  state: 'hermes:pet-overlay:state'
} as const

const CONTROL_TYPES = new Set(['bounds', 'open-app', 'pop-in', 'ready', 'scale', 'submit', 'toggle-app'])
const MIN_SIZE = 80
const MAX_SIZE = 1600
/** The overlay counts as on a display when at least this much of it (px, each way) lies inside a work area. */
const MIN_VISIBLE_PX = 40
/** Submits waiting on the main renderer's answer, at most (the overlay sends one at a time; this only bounds a flood). */
const MAX_IN_FLIGHT = 16

interface OverlayBounds {
  x: number
  y: number
  width: number
  height: number
}

interface ContentsLike {
  send: (channel: string, payload?: unknown) => void
}

interface Point {
  x: number
  y: number
}

interface OverlayWindowLike {
  isDestroyed: () => boolean
  close: () => void
  showInactive: () => void
  setBounds: (bounds: OverlayBounds) => void
  getSize: () => number[]
  isResizable: () => boolean
  setResizable: (resizable: boolean) => void
  setIgnoreMouseEvents: (ignore: boolean, options?: { forward: boolean }) => void
  setFocusable: (focusable: boolean) => void
  focus: () => void
  webContents: ContentsLike
}

/** The main renderer's contents: Electron's WebContents events, read to notice its page going away under a submit. */
interface MainContentsLike extends ContentsLike {
  /** The main window's UI zoom (its CSS px → screen DIP); absent or odd: 1. */
  getZoomFactor?: () => number
  // Method syntax on purpose: Electron's `on` is a list of per-event overloads, matched here one event at a time.
  on?(
    event: 'destroyed' | 'did-start-navigation' | 'render-process-gone',
    listener: (details: unknown) => void
  ): unknown
}

interface MainWindowLike {
  isDestroyed: () => boolean
  isMinimized: () => boolean
  isVisible: () => boolean
  minimize: () => void
  restore: () => void
  show: () => void
  focus: () => void
  getContentBounds: () => OverlayBounds
  webContents: MainContentsLike
}

interface IpcMainLike {
  handle: (channel: string, listener: (event: any, ...args: any[]) => unknown) => void
  on: (channel: string, listener: (event: any, ...args: any[]) => void) => void
}

type SenderGuard = (event: any, channel: string) => boolean

/** The part of Electron's `screen` the overlay reads: where the connected displays' work areas are. */
interface ScreenLike {
  getAllDisplays: () => { workArea: OverlayBounds }[]
  getPrimaryDisplay: () => { workArea: OverlayBounds }
}

interface PetOverlayDeps {
  ipcMain: IpcMainLike
  getMainWindow: () => MainWindowLike | null
  isTrustedSender: SenderGuard
  /** Create (and start loading) the overlay window at these screen bounds. */
  spawnWindow: (bounds: OverlayBounds, onClosed: () => void) => OverlayWindowLike
  screen: ScreenLike
  log: (line: string) => void
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const clampSize = (n: number) => Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(n)))

/** A bounds payload, checked and rounded: null for anything that is not four finite numbers. */
export function sanitizeBounds(value: unknown): null | OverlayBounds {
  const b = value as Partial<OverlayBounds> | null

  if (!b || typeof b !== 'object' || !finite(b.x) || !finite(b.y) || !finite(b.width) || !finite(b.height)) {
    return null
  }

  return { height: clampSize(b.height), width: clampSize(b.width), x: Math.round(b.x), y: Math.round(b.y) }
}

/** A point payload, checked: null for anything that is not two finite numbers. */
function sanitizePoint(value: unknown): null | Point {
  const p = value as Partial<Point> | null

  return p && typeof p === 'object' && finite(p.x) && finite(p.y) ? { x: p.x, y: p.y } : null
}

/**
 * R4-F1: a fresh pop-out's screen bounds. The request is in the main window's viewport CSS px; the overlay draws at
 * zoom 1 (its CSS px are screen DIP). `anchor` is where the pet stands (its feet, bottom-centre) in the viewport, and
 * its offset inside `bounds` is in the overlay's own units — so the anchor is converted with the main window's zoom
 * and the window is hung from it: the pet lands where it stood at any zoom. No anchor: the window's bottom-centre.
 */
export function popOutScreenBounds(
  bounds: OverlayBounds,
  anchor: null | Point,
  content: OverlayBounds,
  zoom: unknown
): OverlayBounds {
  const z = finite(zoom) && zoom > 0 ? zoom : 1
  const a = anchor ?? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height }

  return {
    ...bounds,
    x: Math.round(content.x + a.x * z - (a.x - bounds.x)),
    y: Math.round(content.y + a.y * z - (a.y - bounds.y))
  }
}

const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))

/** Whether enough of `b` lies inside one of the connected displays' work areas to be seen and grabbed. */
export function onSomeDisplay(b: OverlayBounds, displays: readonly { workArea: OverlayBounds }[]): boolean {
  const needX = Math.min(MIN_VISIBLE_PX, b.width)
  const needY = Math.min(MIN_VISIBLE_PX, b.height)

  return displays.some(({ workArea: w }) => {
    const ox = overlap(b.x, b.x + b.width, w.x, w.x + w.width)
    const oy = overlap(b.y, b.y + b.height, w.y, w.y + w.height)

    return ox >= needX && oy >= needY
  })
}

/** The same size, moved (the least it takes) fully inside the primary display's work area. */
function ontoPrimary(b: OverlayBounds, primary: OverlayBounds): OverlayBounds {
  const width = Math.min(b.width, primary.width)
  const height = Math.min(b.height, primary.height)
  const clamp = (v: number, lo: number, hi: number) => Math.round(Math.min(Math.max(v, lo), hi))

  return {
    height,
    width,
    x: clamp(b.x, primary.x, primary.x + primary.width - width),
    y: clamp(b.y, primary.y, primary.y + primary.height - height)
  }
}

/** Install the overlay's IPC with injected collaborators (the tests drive this directly). Returns the closer. */
export function installPetOverlay({
  ipcMain,
  getMainWindow,
  isTrustedSender,
  spawnWindow,
  screen,
  log
}: PetOverlayDeps) {
  let overlay: null | OverlayWindowLike = null

  const live = (win: null | { isDestroyed: () => boolean }): boolean => Boolean(win && !win.isDestroyed())

  /** The P7 seam, fail closed: only an explicit `true` lets a message through. */
  const trusted = (event: unknown, channel: string): boolean => {
    try {
      return isTrustedSender(event, channel) === true
    } catch {
      return false
    }
  }

  const senderOf = (event: unknown) => (event as { sender?: unknown } | null)?.sender

  const fromMain = (event: unknown) => {
    const main = getMainWindow()

    return live(main) && senderOf(event) === main!.webContents
  }

  const fromOverlay = (event: unknown) => live(overlay) && senderOf(event) === overlay!.webContents

  const refuse = (channel: string) => log(`[pet-overlay] refused ${channel}`)

  // Submits forwarded to the main renderer and not answered yet, each with the contents it went to and whether that
  // renderer has handed the text on to the session (R4-F2: it says so, and waits for main's ack, before the first
  // byte leaves). That renderer can go away under one (its window closed, a reload, a crash): each one it held is then
  // answered at once — refused/not-sent if it never handed the text on, `unknown` (may have been sent) if it did — so
  // the prompt box never waits on an answer that cannot come, keeps its text, and is never told a sent message was not.
  const inFlight = new Map<number, { to: MainContentsLike; handedOff: boolean }>()
  const watched = new WeakSet<MainContentsLike>()

  const answerOverlay = (result: PetPromptResult) => {
    if (live(overlay)) {
      overlay!.webContents.send(PET_OVERLAY_CHANNELS.promptResult, result)
    }
  }

  const notSent = (id: number) => answerOverlay({ id, outcome: 'refused', reason: 'not-sent' })

  const dropInFlight = (contents: MainContentsLike) => {
    for (const [id, entry] of [...inFlight]) {
      if (entry.to === contents) {
        inFlight.delete(id)

        if (entry.handedOff) {
          answerOverlay({ id, outcome: 'unknown' })
        } else {
          notSent(id)
        }
      }
    }
  }

  const watchMain = (contents: MainContentsLike) => {
    if (watched.has(contents) || typeof contents.on !== 'function') {
      return
    }

    watched.add(contents)
    contents.on('destroyed', () => dropInFlight(contents))
    contents.on('render-process-gone', () => dropInFlight(contents))
    // A new document in the main frame (a reload): the page that took the submit is gone. A route change (same
    // document) is not.
    contents.on('did-start-navigation', (details: unknown) => {
      const nav = details as { isMainFrame?: unknown; isSameDocument?: unknown } | undefined

      if (nav?.isMainFrame === true && nav.isSameDocument !== true) {
        dropInFlight(contents)
      }
    })
  }

  const close = () => {
    if (live(overlay)) {
      overlay!.close()
    }

    overlay = null
    inFlight.clear()
  }

  ipcMain.handle(PET_OVERLAY_CHANNELS.open, (event, request: unknown) => {
    if (!trusted(event, PET_OVERLAY_CHANNELS.open) || !fromMain(event)) {
      refuse(PET_OVERLAY_CHANNELS.open)

      return null
    }

    const req = request as { anchor?: unknown; bounds?: unknown; screen?: unknown } | null
    const bounds = sanitizeBounds(req?.bounds)

    if (!bounds) {
      return { ok: false }
    }

    let target = bounds
    const main = getMainWindow()

    // A fresh pop-out arrives in the main window's viewport space (CSS px at its UI zoom): converted to the screen so
    // the pet lands where it stood (R4-F1). A remembered spot is already in screen space.
    if (req?.screen !== true && live(main)) {
      let zoom: unknown = 1

      try {
        zoom = main!.webContents.getZoomFactor?.()
      } catch {
        // No zoom to read: 1.
      }

      target = popOutScreenBounds(bounds, sanitizePoint(req?.anchor), main!.getContentBounds(), zoom)
    }

    // A remembered spot on a display that is gone (unplugged, rearranged): no window nobody can see or grab. The
    // renderer keeps the pet in the window and remembers this reset spot on the primary display for next time.
    let displays: { workArea: OverlayBounds }[] = []

    try {
      displays = screen.getAllDisplays()

      if (!onSomeDisplay(target, displays)) {
        const reset = ontoPrimary(target, screen.getPrimaryDisplay().workArea)
        log(`[pet-overlay] remembered spot is off every display — reset onto the primary one`)

        return { bounds: reset, ok: false, reason: 'off-screen' }
      }
    } catch {
      // No display information (headless): open where asked.
    }

    try {
      if (live(overlay)) {
        overlay!.setBounds(target)
        overlay!.showInactive()
      } else {
        overlay = spawnWindow(target, () => {
          overlay = null
          inFlight.clear()
          // Closed on its own (⌘W, a crash): the main renderer brings the pet back in.
          const m = getMainWindow()

          if (live(m)) {
            m!.webContents.send(PET_OVERLAY_CHANNELS.control, { type: 'pop-in' })
          }
        })
      }
    } catch (error) {
      overlay = null
      log(`[pet-overlay] the window failed to open: ${error instanceof Error ? error.message : String(error)}`)

      return { ok: false, reason: 'failed' }
    }

    return { bounds: target, ok: true }
  })

  ipcMain.handle(PET_OVERLAY_CHANNELS.close, event => {
    if (!trusted(event, PET_OVERLAY_CHANNELS.close) || !fromMain(event)) {
      refuse(PET_OVERLAY_CHANNELS.close)

      return null
    }

    close()

    return { ok: true }
  })

  // Main renderer → overlay: the pet's state, forwarded as-is to the overlay's renderer only.
  ipcMain.on(PET_OVERLAY_CHANNELS.state, (event, payload: unknown) => {
    if (!trusted(event, PET_OVERLAY_CHANNELS.state) || !fromMain(event)) {
      refuse(PET_OVERLAY_CHANNELS.state)

      return
    }

    if (live(overlay) && payload && typeof payload === 'object') {
      overlay!.webContents.send(PET_OVERLAY_CHANNELS.state, payload)
    }
  })

  // Main renderer: it is about to hand submit `id` on to the session (send or queue). Recorded before the renderer goes
  // on (it awaits this answer): from here a lost renderer means "may have been sent". Only the renderer the submit went
  // to may mark it; `true` = recorded.
  ipcMain.handle(PET_OVERLAY_CHANNELS.promptHandoff, (event, value: unknown) => {
    if (!trusted(event, PET_OVERLAY_CHANNELS.promptHandoff) || !fromMain(event)) {
      refuse(PET_OVERLAY_CHANNELS.promptHandoff)

      return false
    }

    const id = petPromptId(value)
    const entry = id === null ? undefined : inFlight.get(id)

    if (!entry || entry.to !== senderOf(event)) {
      return false
    }

    entry.handedOff = true

    return true
  })

  // Main renderer → overlay: what became of a message from the prompt box (sent, queued, or refused with a reason),
  // rebuilt from a closed set before it crosses — the overlay clears its text only on sent/queued.
  ipcMain.on(PET_OVERLAY_CHANNELS.promptResult, (event, value: unknown) => {
    if (!trusted(event, PET_OVERLAY_CHANNELS.promptResult) || !fromMain(event)) {
      refuse(PET_OVERLAY_CHANNELS.promptResult)

      return
    }

    const result = petPromptResult(value)

    // `unknown` is main's own answer (a renderer lost after the hand-off), never the renderer's.
    if (result && result.outcome !== 'unknown') {
      inFlight.delete(result.id)
      answerOverlay(result)
    }
  })

  // Overlay: a drag or a zoom moved/resized the window. The window is created non-resizable (no stray edge-drag on
  // a transparent panel), which on Windows/Linux also blocks a programmatic resize: flip it on for the change only.
  ipcMain.on(PET_OVERLAY_CHANNELS.setBounds, (event, value: unknown) => {
    if (!trusted(event, PET_OVERLAY_CHANNELS.setBounds) || !fromOverlay(event)) {
      refuse(PET_OVERLAY_CHANNELS.setBounds)

      return
    }

    const bounds = sanitizeBounds(value)

    if (!bounds) {
      return
    }

    const win = overlay!
    const [w, h] = win.getSize()
    const resizing = bounds.width !== w || bounds.height !== h

    if (resizing && !win.isResizable()) {
      win.setResizable(true)
    }

    win.setBounds(bounds)

    if (resizing) {
      win.setResizable(false)
    }
  })

  // Overlay: click-through everywhere but the pet's own pixels.
  ipcMain.on(PET_OVERLAY_CHANNELS.ignoreMouse, (event, ignore: unknown) => {
    if (!trusted(event, PET_OVERLAY_CHANNELS.ignoreMouse) || !fromOverlay(event)) {
      refuse(PET_OVERLAY_CHANNELS.ignoreMouse)

      return
    }

    overlay!.setIgnoreMouseEvents(ignore === true, { forward: true })
  })

  // Overlay: the prompt box needs the keyboard. The overlay is a non-activating panel (it never takes the app's
  // ⌘-Tab anchor); it becomes focusable only while its prompt box is open, and goes back when it closes.
  ipcMain.on(PET_OVERLAY_CHANNELS.focusable, (event, focusable: unknown) => {
    if (!trusted(event, PET_OVERLAY_CHANNELS.focusable) || !fromOverlay(event)) {
      refuse(PET_OVERLAY_CHANNELS.focusable)

      return
    }

    overlay!.setFocusable(focusable === true)

    if (focusable === true) {
      overlay!.focus()
    }
  })

  // Overlay → main renderer: the control messages (a closed set).
  ipcMain.on(PET_OVERLAY_CHANNELS.control, (event, payload: unknown) => {
    if (!trusted(event, PET_OVERLAY_CHANNELS.control) || !fromOverlay(event)) {
      refuse(PET_OVERLAY_CHANNELS.control)

      return
    }

    const type = (payload as { type?: unknown } | null)?.type
    const main = getMainWindow()

    if (typeof type !== 'string' || !CONTROL_TYPES.has(type)) {
      return
    }

    // The prompt box: a message for the current session, which the main renderer's pet sender sends (or queues, or
    // refuses) and answers on prompt-result. Main forwards only a checked, rebuilt payload — the submit's id and a
    // non-blank string within the cap — and does not raise the app. No main renderer to take it (its window closed —
    // macOS keeps the app and the pet): answered refused/not-sent at once.
    if (type === 'submit') {
      const text = petPromptText((payload as { text?: unknown }).text)
      const id = petPromptId((payload as { id?: unknown }).id)

      if (text === null || id === null) {
        refuse(`${PET_OVERLAY_CHANNELS.control} submit`)

        return
      }

      if (!live(main)) {
        log('[pet-overlay] submit with no main window — answered not-sent')
        notSent(id)

        return
      }

      if (inFlight.size >= MAX_IN_FLIGHT) {
        inFlight.delete(inFlight.keys().next().value!)
      }

      inFlight.set(id, { handedOff: false, to: main!.webContents })
      watchMain(main!.webContents)
      main!.webContents.send(PET_OVERLAY_CHANNELS.control, { id, text, type: 'submit' })

      return
    }

    if (!live(main)) {
      return
    }

    // Double-click: hide the app if it is up front, bring it back if it is minimised or buried. Pure window control.
    if (type === 'toggle-app') {
      if (main!.isMinimized() || !main!.isVisible()) {
        main!.show()
        main!.focus()
      } else {
        main!.minimize()
      }

      return
    }

    // The unread marker: raise the app before the renderer opens the latest session.
    if (type === 'open-app') {
      if (main!.isMinimized()) {
        main!.restore()
      }

      main!.show()
      main!.focus()
    }

    main!.webContents.send(PET_OVERLAY_CHANNELS.control, payload)
  })

  return { close }
}

function overlayUrl(): string {
  if (DEV_SERVER) {
    return `${DEV_SERVER.endsWith('/') ? DEV_SERVER.slice(0, -1) : DEV_SERVER}/?win=pet#/`
  }

  return `${pathToFileURL(resolveRendererIndex()).toString()}?win=pet#/`
}

/** The real window: the old pet overlay's flags (transparent, frameless, always on top, non-activating panel). */
function spawnOverlayWindow(bounds: OverlayBounds, onClosed: () => void): BrowserWindow {
  const win = new BrowserWindow({
    ...bounds,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    focusable: false,
    frame: false,
    fullscreenable: false,
    hasShadow: false,
    hiddenInMissionControl: IS_MAC,
    maximizable: false,
    minimizable: false,
    movable: true,
    resizable: false,
    show: false,
    // macOS: an NSPanel keeps the app (not this helper) as the Dock/⌘-Tab anchor; elsewhere skip the taskbar.
    skipTaskbar: !IS_MAC,
    transparent: true,
    type: IS_MAC ? 'panel' : undefined,
    webPreferences: {
      // Chromium's background throttling stays ON (R4-F3). The pop-out is its own visible window, so it keeps
      // breathing while the app is minimised or unfocused; when the pop-out itself is hidden or occluded,
      // `document.visibilityState` turns 'hidden' and the pet's clock sleeps. A static `false` would pin it to
      // 'visible' forever (see stream-throttle.ts) and keep an unseen pet drawing.
      contextIsolation: true,
      devTools: true,
      nodeIntegration: false,
      preload: PRELOAD_PATH,
      sandbox: true
    }
  })

  win.setAlwaysOnTop(true, IS_MAC ? 'floating' : 'screen-saver')

  try {
    win.setVisibleOnAllWorkspaces(
      true,
      IS_MAC ? { skipTransformProcessType: true, visibleOnFullScreen: true } : undefined
    )
  } catch {
    // Not supported everywhere — best effort.
  }

  // The pet sizes its own window: global UI zoom would crop it.
  wireCommonWindowHandlers(win, { zoom: false })
  wireWindowReveal(win, { show: () => win.showInactive() })
  installWindowRendererLifecycle(win, { callbacks: { log: rememberLog }, kind: 'overlay' })
  win.on('closed', onClosed)
  // A dead renderer would leave an invisible click-eater over the desktop: destroy the window instead.
  win.webContents.on('render-process-gone', (_event, details) => {
    rememberLog(`[pet-overlay] renderer gone (${details.reason}) — destroying the window`)

    if (!win.isDestroyed()) {
      win.destroy()
    }
  })
  loadWindowUrl(win, overlayUrl(), 'Pet overlay')

  return win
}

/** main.ts's one call: the real ipcMain and window, guarded by the P7 seam (the app's own renderer only). */
export function registerPetOverlay(getMainWindow: () => MainWindowLike | null) {
  return installPetOverlay({
    getMainWindow,
    ipcMain,
    isTrustedSender: createAppSenderGuard({
      devServer: DEV_SERVER,
      log: rememberLog,
      rendererIndexPath: resolveRendererIndex
    }),
    log: rememberLog,
    screen,
    spawnWindow: spawnOverlayWindow
  })
}
