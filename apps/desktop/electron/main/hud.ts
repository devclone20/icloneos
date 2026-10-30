// HUD mode: the chrome-free floating chat window.
import fs from 'node:fs'
import path from 'node:path'

import { app, BrowserWindow, globalShortcut, screen, systemPreferences } from 'electron'

import { errorMessage } from '../../src/iclone-shared/errors'
import { cursorPointInWindow } from '../hud-cursor'
import { startHudGameOverlayWatch } from '../hud-game-overlay'
import { applyHudResetBounds, defaultHudBounds } from '../hud-geometry'
import { applyHudElectronOverlay, promoteHudOverlay } from '../hud-overlay'
import { snapHudBounds } from '../hud-snap'
import { createHudSnapShortcut } from '../hud-snap-shortcut'
import { buildHudWindowUrl } from '../hud-url'
import { resolveHudWindowing } from '../hud-windowing'
import { consentAllows } from '../iclone-consent'
import { writeFileAtomicSync } from '../lib/atomic-write'
import { attachRendererConsoleCapture } from '../renderer-log'
import { chatWindowWebPreferences } from '../session-windows'
import type { ThrottleWindowLike } from '../stream-throttle'
import { enumerateWindowsFrontToBack, enumerationFailed } from '../window-below'
import { installWindowRendererLifecycle } from '../window-renderer-lifecycle'
import { bindGeometryPersistence, debounce } from '../window-state'
import { zoomWiringForWindowKind } from '../zoom'

import { streamThrottle } from './backend-state'
import { APP_NAME, DEV_SERVER, IS_MAC, PRELOAD_PATH } from './env'
import { rememberLog } from './log'
import { resolveRendererIndex } from './runtime'
import { loadWindowUrl } from './shell-open'
import { windowsState } from './state'
import { focusWindow, wireCommonWindowHandlers, wireWindowReveal } from './windows'

const HUD_WINDOW_TITLE = `${APP_NAME} HUD`

// Whether the main window was visible when HUD mode was entered, so exiting
// puts the desktop back as it was rather than raising a window the user had
// already minimized.
let hudRestoreMainWindow = false

// The profile the live HUD renderer booted against (rides hudUrl's query
// string). A renderer adopts its backend once at boot, so a retarget onto a
// session from a DIFFERENT profile cannot be a same-window `goto` — the HUD
// must be respawned against the new profile's backend (see openHudWindow).
let hudProfile: string | null = null

// A wide, short bar parked near the bottom of the active display — the shape
// of a game chat frame, and where one belongs. Defaults only: once the user
// moves or resizes the HUD, hud-state.json wins (same pattern as the main
// window's window-state.json).
const HUD_STATE_PATH = path.join(app.getPath('userData'), 'hud-state.json')

function readHudState() {
  try {
    const raw = JSON.parse(fs.readFileSync(HUD_STATE_PATH, 'utf8'))

    if (
      [raw?.x, raw?.y, raw?.width, raw?.height].every(v => Number.isFinite(v)) &&
      raw.width >= 380 &&
      raw.height >= 160
    ) {
      return raw
    }
  } catch {
    // First run / unreadable — fall through to defaults.
  }

  return null
}

function persistHudState() {
  if (!windowsState.hudWindow || windowsState.hudWindow.isDestroyed()) {
    return
  }

  try {
    const { x, y, width, height } = windowsState.hudWindow.getNormalBounds()
    fs.mkdirSync(path.dirname(HUD_STATE_PATH), { recursive: true })
    writeFileAtomicSync(HUD_STATE_PATH, JSON.stringify({ x, y, width, height }, null, 2))
  } catch (err) {
    rememberLog(`[hud-state] persist failed: ${errorMessage(err) || err}`)
  }
}

export function resetHudWindowLayout(): boolean {
  if (!windowsState.hudWindow || windowsState.hudWindow.isDestroyed()) {
    return false
  }

  const win = windowsState.hudWindow
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const bounds = defaultHudBounds(display?.workArea)

  if (!applyHudResetBounds(win, bounds)) {
    rememberLog('[hud-state] reset layout failed while applying native bounds')

    return false
  }

  persistHudState()

  return true
}

const schedulePersistHudState = debounce(persistHudState, 250)

// How often Linux gets told where the cursor is. Fast enough that the bar is
// solid before a click lands after the pointer arrives, cheap enough to leave
// running for as long as the HUD is open — it is one `getCursorScreenPoint()`
// and, when the answer has not changed, nothing else.
const HUD_CURSOR_POLL_MS = 60

// Snap-to-pointer — global ⌘⇧G while the HUD is open (tap, not hold).
const HUD_SNAP_ANCHOR_Y = 48

function hudWindowing() {
  return resolveHudWindowing(process.platform, process.env, process.argv)
}

function applyHudSnapToPointer() {
  if (!windowsState.hudWindow || windowsState.hudWindow.isDestroyed() || !hudWindowing().clientPlacement) {
    return
  }

  const cursor = screen.getCursorScreenPoint()
  const bounds = windowsState.hudWindow.getBounds()
  const display = screen.getDisplayNearestPoint(cursor)
  const workArea = display?.workArea ?? bounds
  const anchor = { x: Math.round(bounds.width / 2), y: HUD_SNAP_ANCHOR_Y }

  const origin = snapHudBounds(
    cursor,
    anchor,
    { width: bounds.width, height: bounds.height },
    windowsState.hudWindow.webContents.getZoomFactor(),
    workArea
  )

  // setBounds — NOT setPosition alone: on Windows, a transparent frameless
  // window silently grows ~1px per setPosition call (see move-by handler).
  // On native Wayland the compositor ignores the position half; the snap
  // shortcut is therefore a documented no-op there.
  windowsState.hudWindow.setBounds({
    x: origin.x,
    y: origin.y,
    width: bounds.width,
    height: bounds.height
  })
}

export const hudSnapShortcut = createHudSnapShortcut(globalShortcut, applyHudSnapToPointer)

function registerHudSnapShortcut() {
  if (!hudSnapShortcut.register()) {
    rememberLog('[hud] snap shortcut unavailable — CommandOrControl+Shift+G may be owned by another app')
  }
}

/**
 * Feed the HUD renderer the cursor position on Linux.
 *
 * Everywhere else the renderer learns this from mousemove, which keeps arriving
 * while the window ignores the mouse because we pass `{ forward: true }`. That
 * option is macOS/Windows only. Without it a Linux HUD stops hearing the
 * pointer the moment it turns click-through, so it can never notice the pointer
 * coming back and stays transparent — the bar is there, and clicking it hits
 * whatever is behind. Main can still see the cursor, so it says so.
 *
 * Deliberately the same decision, just a different source for one input: the
 * renderer runs its usual hit test on the point it is handed. Re-deciding
 * anything here would put a second, drifting copy of the click-through rules in
 * the main process.
 */
function startHudCursorFeed(win: BrowserWindow) {
  const windowing = hudWindowing()

  if (!windowing.cursorFeed) {
    if (!windowing.ignoreMouse) {
      try {
        win.setIgnoreMouseEvents(false)
      } catch {
        // best effort
      }
    }

    return
  }

  let last: string | null = null

  const timer = setInterval(() => {
    if (win.isDestroyed() || !win.isVisible()) {
      return
    }

    const point = cursorPointInWindow(screen.getCursorScreenPoint(), win.getBounds(), win.webContents.getZoomFactor())

    // Off-window is a real answer (it is what hands the mouse back), so it is
    // sent — once. Only an unchanged answer is dropped, to keep an idle cursor
    // from waking the renderer 16 times a second.
    const key = point ? `${Math.round(point.x)},${Math.round(point.y)}` : 'out'

    if (key === last) {
      return
    }

    last = key
    win.webContents.send('hermes:hud:cursor', point)
  }, HUD_CURSOR_POLL_MS)

  win.on('closed', () => clearInterval(timer))
}

/**
 * Watch for a fullscreen app under the HUD (the Discord-style game overlay
 * cue) and feed the answer to its renderer. Pure detection lives in
 * hud-game-overlay.ts; enumeration is the same front-to-back walk the
 * read_window_below tool uses. The renderer answers with the low-opacity
 * treatment (`data-hud-game`), so main stays out of the styling business.
 */
function startHudGameOverlayFeed(win: BrowserWindow) {
  // Consent is re-read on every tick: switching Screen recording off in Settings › Privacy stops the titles at once.
  const titlesAvailable = () =>
    consentAllows('screen') && (IS_MAC ? systemPreferences.getMediaAccessStatus?.('screen') === 'granted' : true)

  let last = { active: false, app: '' }

  const push = (state: { active: boolean; app: string }) => {
    if (!win.isDestroyed()) {
      win.webContents.send('hermes:hud:game-overlay', state)
    }
  }

  // Replay the latest state to every load of this window. The watch pushes only
  // on CHANGE and its first tick fires the moment the window is created — well
  // before the renderer has mounted its listener — so a HUD opened over a game
  // that is already fullscreen would hear the one and only message before it
  // could receive it, then sit at "no game" forever while main was certain it
  // had reported one. (Same reason quick entry caches its last state push.)
  // did-finish-load also covers HMR full reloads during development.
  win.webContents.on('did-finish-load', () => push(last))

  // The watch gives up after two failed enumerations and never says so, which
  // is how a HUD that cannot see the screen at all — no game cue, and
  // read_window_below failing beside it — leaves nothing in the log to explain
  // itself. Report the reason once; the null keeps the watch's contract.
  let reported = false

  const enumerate = async () => {
    const windows = await enumerateWindowsFrontToBack(process.pid, titlesAvailable())

    if (!enumerationFailed(windows)) {
      return windows
    }

    if (!reported) {
      reported = true
      console.warn(`[hermes] HUD cannot enumerate windows: ${windows.reason}`)
    }

    return null
  }

  const dispose = startHudGameOverlayWatch({
    enumerate,
    displayBounds: () => screen.getDisplayMatching(win.getBounds()).bounds,
    selfPid: process.pid,
    send: state => {
      last = state
      push(state)
    }
  })

  win.on('closed', dispose)
}

function hudBounds() {
  // Remembered spot first — validated against the LIVE displays so a HUD
  // parked on an unplugged monitor comes back on-screen instead of lost.
  const saved = readHudState()

  if (saved) {
    const onScreen = screen.getAllDisplays().some(d => {
      const a = d.workArea

      return (
        saved.x < a.x + a.width - 40 &&
        saved.x + saved.width > a.x + 40 &&
        saved.y < a.y + a.height - 40 &&
        saved.y + saved.height > a.y + 40
      )
    })

    if (onScreen) {
      return saved
    }
  }

  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const area = display?.workArea

  return defaultHudBounds(area)
}

function hudUrl(sessionId: string | null, profile: string | null) {
  // The profile rides the query string next to `win=hud` (BEFORE the '#', so
  // HashRouter never sees it). The HUD renderer's gateway boot reads it and
  // adopts that backend instead of the primary — without it, a HUD opened on a
  // non-primary profile's conversation resolves the session id against the
  // wrong backend and falls back to the default profile's last session.
  return buildHudWindowUrl(sessionId, {
    devServer: DEV_SERVER,
    profile,
    rendererIndexPath: DEV_SERVER ? undefined : resolveRendererIndex()
  })
}

// Tell every window whether the HUD is up, so a toggle in any of them reads
// the truth even when the HUD is closed from its own side (⌘W / its exit row).
// Carries the HUD's session so the app window can re-home onto it on the way
// out (see hudSessionId).
function broadcastHudState(open: boolean) {
  const payload = { open, sessionId: windowsState.hudSessionId }

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('hermes:hud:changed', payload)
    }
  }
}

function spawnHudWindow(sessionId: string | null, profile: string | null) {
  const win = new BrowserWindow({
    ...hudBounds(),
    minWidth: 380,
    minHeight: 160,
    title: HUD_WINDOW_TITLE,
    frame: false,
    transparent: true,
    // NOT resizable. A transparent frameless window on Windows keeps a
    // system-level edge resize hot-zone while `resizable` is on — the OS
    // interprets pointer capture near the edge as a resize gesture, so the
    // window grows a few px every drag (worse at >100% DPI scaling). The
    // composer drag calls setPosition, which must move the window, not resize
    // it. Resizing is done by the renderer's edge/corner handles through
    // `hermes:hud:set-bounds`, which flips resizable on for the call.
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // Same rationale as quick entry: on Windows/Linux keep the helper out
    // of the taskbar/alt-tab list; on macOS use an NSPanel so the frameless
    // window never becomes the app's cmd-tab anchor.
    skipTaskbar: !IS_MAC,
    hasShadow: false,
    alwaysOnTop: true,
    type: IS_MAC ? 'panel' : undefined,
    // Clips the vibrancy layer to the HUD's silhouette rather than a hard
    // rectangle — the frost stops where the window's corners do.
    roundedCorners: true,
    // Vibrancy must keep rendering while the window is BLURRED: streaming under
    // another app is the whole feature, and the default 'followWindow' kills
    // the frost the moment something else takes focus.
    visualEffectState: 'active',
    hiddenInMissionControl: IS_MAC,
    show: false,
    backgroundColor: '#00000000',
    // The full chat webPreferences — this window streams a real transcript, so
    // it needs everything a chat window needs (preload bridge, autoplay for
    // voice, the shared throttling contract).
    webPreferences: chatWindowWebPreferences(PRELOAD_PATH)
  })

  applyHudElectronOverlay(win, process.platform)
  win.setHiddenInMissionControl?.(true)

  // Linux intentionally starts on ONE virtual desktop. During a renderer
  // grab, hermes:hud:workspace-transfer temporarily makes the X11 window
  // sticky; releasing it assigns the HUD to KDE's then-current desktop.

  // Streaming into a window that is ALWAYS blurred (the user is in another
  // app) is the entire feature, so it gets the same stream-aware unthrottling
  // every chat window does.
  streamThrottle.register(win as ThrottleWindowLike)
  wireCommonWindowHandlers(win, zoomWiringForWindowKind('chat'))

  // Remember where the user parks and sizes it (debounced — these fire many
  // times mid-drag).
  bindGeometryPersistence(win, schedulePersistHudState)

  startHudCursorFeed(win)
  startHudGameOverlayFeed(win)

  wireWindowReveal(win, {
    show: () => {
      win.show()
      win.focus()
    },
    onRevealed: () => {
      // Step the app aside: the HUD IS the surface now.
      if (hudRestoreMainWindow && windowsState.mainWindow && !windowsState.mainWindow.isDestroyed()) {
        windowsState.mainWindow.hide()
      }

      // Compositor overlay adapters (Hyprland float+pin today). Electron
      // alwaysOnTop is already set; this is the dialect some WMs actually hear.
      void promoteHudOverlay({ title: HUD_WINDOW_TITLE })
    }
  })

  win.on('closed', () => {
    if (windowsState.hudWindow === win) {
      windowsState.hudWindow = null
    }

    // Closed from its own side (⌘W) — closeHudWindow()'s dispose() never ran,
    // so the global snap shortcut would otherwise stay registered (and stuck
    // taken) with no HUD left to apply it to. dispose() is idempotent, so
    // this is safe even if closeHudWindow() already released it.
    hudSnapShortcut.dispose()

    // Put the app back so the user is never left with no surface, and
    // correct every window's toggle.
    restoreMainWindowFromHud()
    broadcastHudState(false)
  })

  attachRendererConsoleCapture(win, 'hud', rememberLog)
  // Log-only lifecycle (#81290): the HUD is a compact auxiliary surface the
  // user can re-toggle; a dead renderer should be diagnosable, not resurrected.
  installWindowRendererLifecycle(win, { kind: 'hud', callbacks: { log: rememberLog } })

  // …but a DEAD renderer must not keep the window. The HUD is transparent,
  // frameless and alwaysOnTop, and its mouse click-through is armed by its
  // own renderer per mousemove — with that renderer gone the window is an
  // invisible input surface floating over everything, eating clicks it can
  // never answer, while the main window sits hidden beneath it. The user
  // sees "the app is frozen". Destroying the window restores the main one
  // through the ordinary 'closed' path; re-toggling HUD spawns a fresh pair.
  win.webContents.on('render-process-gone', (_event, details) => {
    rememberLog(
      `[hud] renderer gone (${details.reason}) — destroying the HUD window so it cannot strand an invisible always-on-top surface`
    )

    if (!win.isDestroyed()) {
      win.destroy()
    }
  })

  loadWindowUrl(win, hudUrl(sessionId, profile), 'HUD')

  return win
}

// Put the app window back the way HUD mode found it.
function restoreMainWindowFromHud() {
  if (!hudRestoreMainWindow) {
    return
  }

  hudRestoreMainWindow = false

  if (windowsState.mainWindow && !windowsState.mainWindow.isDestroyed()) {
    windowsState.mainWindow.show()
  }
}

export function openHudWindow(sessionId: string | null, profile: string | null) {
  const profileKey = typeof profile === 'string' && profile.trim() ? profile.trim() : null

  if (windowsState.hudWindow && !windowsState.hudWindow.isDestroyed()) {
    // Pointed at another PROFILE: the live renderer is bound to the old
    // profile's backend, and a renderer adopts its backend exactly once at
    // boot — an in-place goto would resolve the id against the wrong backend
    // (the #82285 fallback). Respawn against the right one.
    if (profileKey && hudProfile !== profileKey) {
      const win = windowsState.hudWindow
      windowsState.hudWindow = null
      win.removeAllListeners('closed')
      win.destroy()

      windowsState.hudSessionId = sessionId || null
      hudProfile = profileKey
      windowsState.hudWindow = spawnHudWindow(sessionId, profileKey)
      broadcastHudState(true)
      registerHudSnapShortcut()

      return windowsState.hudWindow
    }

    // Already up, but pointed somewhere else — switch it rather than just
    // raising it. Asking for HUD mode from another tab means "put THIS
    // conversation in the HUD", and a plain focus leaves the wrong one there.
    if (sessionId && sessionId !== windowsState.hudSessionId) {
      windowsState.hudSessionId = sessionId
      windowsState.hudWindow.webContents.send('hermes:hud:goto', sessionId)
      // Keep every window's idea of where the HUD is pointed in step, so the
      // toggle keeps reading "switch" vs "dismiss" correctly.
      broadcastHudState(true)
    }

    focusWindow(windowsState.hudWindow)

    return windowsState.hudWindow
  }

  hudRestoreMainWindow = Boolean(
    windowsState.mainWindow && !windowsState.mainWindow.isDestroyed() && windowsState.mainWindow.isVisible()
  )
  windowsState.hudSessionId = sessionId || null
  hudProfile = profileKey
  windowsState.hudWindow = spawnHudWindow(sessionId, profileKey)
  broadcastHudState(true)
  registerHudSnapShortcut()

  return windowsState.hudWindow
}

export function closeHudWindow() {
  hudSnapShortcut.dispose()

  const win = windowsState.hudWindow
  windowsState.hudWindow = null

  if (win && !win.isDestroyed()) {
    // Null'd first so the 'closed' handler doesn't broadcast a second time.
    win.removeAllListeners('closed')
    win.close()
  }

  restoreMainWindowFromHud()
  broadcastHudState(false)

  if (windowsState.mainWindow && !windowsState.mainWindow.isDestroyed()) {
    focusWindow(windowsState.mainWindow)
  }
}
