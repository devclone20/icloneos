// Quick Entry: the global-shortcut prompt window.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { app, BrowserWindow, globalShortcut, screen } from 'electron'

import { errorMessage } from '../../src/iclone-shared/errors'
import { createQuickEntryShortcut, quickEntryWindowBounds, sanitizeQuickEntrySettings } from '../quick-entry'
import { attachRendererConsoleCapture } from '../renderer-log'
import { installWindowRendererLifecycle } from '../window-renderer-lifecycle'
import { zoomWiringForWindowKind } from '../zoom'

import { DEV_SERVER, IS_MAC, PRELOAD_PATH } from './env'
import { rememberLog } from './log'
import { resolveRendererIndex } from './runtime'
import { loadWindowUrl } from './shell-open'
import { windowsState } from './state'
import { wireCommonWindowHandlers, wireWindowReveal } from './windows'

// ── Quick Entry ─────────────────────────────────────────────────────────────
//
// A global shortcut summons a small frameless always-on-top composer from
// anywhere, so a prompt can be fired without raising the whole app. The window
// carries NO gateway connection: it hands its text to us, we forward it to the
// PRIMARY renderer, and that renderer submits through the same prompt path the
// normal composer uses (see store/quick-entry + hooks/use-quick-entry-bridge).
//
// Main owns the OS registration and the persisted preference (it must restore
// the shortcut on a cold launch without the renderer ever visiting Settings),
// same authority split as keep-awake. Registration failure is surfaced, never
// swallowed: a chord another app already owns comes back as `error: 'taken'`.
const QUICK_ENTRY_CONFIG_PATH = path.join(app.getPath('userData'), 'quick-entry.json')

export function readQuickEntrySettings() {
  try {
    return sanitizeQuickEntrySettings(JSON.parse(fs.readFileSync(QUICK_ENTRY_CONFIG_PATH, 'utf8')))
  } catch {
    // Missing / unreadable / malformed → shipped defaults (enabled, default chord).
    return sanitizeQuickEntrySettings(undefined)
  }
}

export function writeQuickEntrySettings(settings: unknown) {
  try {
    fs.mkdirSync(path.dirname(QUICK_ENTRY_CONFIG_PATH), { recursive: true })
    fs.writeFileSync(QUICK_ENTRY_CONFIG_PATH, JSON.stringify(settings, null, 2), 'utf8')
  } catch (error) {
    rememberLog(`[quick-entry] write failed: ${errorMessage(error)}`)
  }
}

function quickEntryUrl() {
  if (DEV_SERVER) {
    return `${DEV_SERVER.endsWith('/') ? DEV_SERVER.slice(0, -1) : DEV_SERVER}/?win=quick#/`
  }

  return `${pathToFileURL(resolveRendererIndex()).toString()}?win=quick#/`
}

function spawnQuickEntryWindow() {
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const bounds = quickEntryWindowBounds(display?.workArea)

  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // On Windows/Linux keep the helper out
    // of the taskbar/alt-tab list; on macOS use an NSPanel so the frameless
    // capture window never becomes the app's cmd-tab anchor.
    skipTaskbar: !IS_MAC,
    hasShadow: true,
    alwaysOnTop: true,
    type: IS_MAC ? 'panel' : undefined,
    hiddenInMissionControl: IS_MAC,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: true
    }
  })

  win.setAlwaysOnTop(true, IS_MAC ? 'floating' : 'screen-saver')
  win.setHiddenInMissionControl?.(true)

  try {
    win.setVisibleOnAllWorkspaces(
      true,
      IS_MAC ? { visibleOnFullScreen: true, skipTransformProcessType: true } : undefined
    )
  } catch {
    // Not supported everywhere — best effort.
  }

  // Opts out of global UI zoom: it sizes its own OS window and a zoomed
  // composer would overflow it.
  wireCommonWindowHandlers(win, zoomWiringForWindowKind('quickEntry'))

  // Log-only renderer lifecycle (#81290): a dead quick-entry window must never
  // resurrect itself over the app, but its loss belongs in desktop.log.
  installWindowRendererLifecycle(win, { kind: 'quick', callbacks: { log: rememberLog } })

  // Hide on blur. The window must never hold the user's focus captive — losing
  // focus is the cheapest, least surprising dismiss (matches Spotlight).
  win.on('blur', () => {
    if (!win.isDestroyed()) {
      win.hide()
    }
  })

  win.on('closed', () => {
    if (windowsState.quickEntryWindow === win) {
      windowsState.quickEntryWindow = null
    }
  })

  // Replay the last known gateway state as soon as the page can hear it — a
  // freshly spawned quick window must not sit "disconnected" when the primary
  // renderer already reported a live gateway.
  win.webContents.on('did-finish-load', () => {
    if (!win.isDestroyed() && windowsState.quickEntryLastState) {
      win.webContents.send('hermes:quick-entry:state', windowsState.quickEntryLastState)
    }
  })

  attachRendererConsoleCapture(win, 'quick-entry', rememberLog)
  loadWindowUrl(win, quickEntryUrl(), 'Quick entry')

  return win
}

// Move the (already-open) window to the display the cursor is on, so the chord
// summons it where the user is looking rather than where they last were.
function repositionQuickEntryWindow(win: BrowserWindow) {
  try {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    win.setBounds(quickEntryWindowBounds(display?.workArea))
  } catch (error) {
    rememberLog(`[quick-entry] reposition failed: ${errorMessage(error)}`)
  }
}

function showQuickEntryWindow() {
  if (!windowsState.quickEntryWindow || windowsState.quickEntryWindow.isDestroyed()) {
    // Reveal the window this call created, not whatever `quickEntryWindow`
    // points at by the time the event lands.
    const win = spawnQuickEntryWindow()
    windowsState.quickEntryWindow = win

    wireWindowReveal(win, {
      show: () => {
        win.show()
        win.focus()
      }
    })

    return
  }

  repositionQuickEntryWindow(windowsState.quickEntryWindow)
  windowsState.quickEntryWindow.show()
  windowsState.quickEntryWindow.focus()
  // Re-summoned: tell the renderer to clear any stale draft and refocus.
  windowsState.quickEntryWindow.webContents.send('hermes:quick-entry:shown')
}

export function hideQuickEntryWindow() {
  if (windowsState.quickEntryWindow && !windowsState.quickEntryWindow.isDestroyed()) {
    windowsState.quickEntryWindow.hide()
  }
}

// The chord toggles: pressing it while the composer is up puts it away, so one
// gesture does exactly one thing in both directions.
function toggleQuickEntryWindow() {
  if (
    windowsState.quickEntryWindow &&
    !windowsState.quickEntryWindow.isDestroyed() &&
    windowsState.quickEntryWindow.isVisible()
  ) {
    hideQuickEntryWindow()

    return
  }

  showQuickEntryWindow()
}

export const quickEntryShortcut = createQuickEntryShortcut(globalShortcut, toggleQuickEntryWindow)

export function applyQuickEntrySettings(settings: Parameters<typeof quickEntryShortcut.apply>[0]) {
  const state = quickEntryShortcut.apply(settings)

  if (!settings.enabled) {
    // Turning the feature off must not leave an orphan always-on-top window.
    if (windowsState.quickEntryWindow && !windowsState.quickEntryWindow.isDestroyed()) {
      windowsState.quickEntryWindow.close()
    }

    windowsState.quickEntryWindow = null
  }

  if (state.error === 'taken') {
    rememberLog(`[quick-entry] shortcut ${state.shortcut} is already taken by another application`)
  } else if (state.error === 'invalid') {
    rememberLog(`[quick-entry] shortcut ${state.shortcut} is not a valid accelerator`)
  }

  return { ...state, enabled: settings.enabled }
}

export function closeQuickEntryWindow() {
  quickEntryShortcut.dispose()

  if (windowsState.quickEntryWindow && !windowsState.quickEntryWindow.isDestroyed()) {
    windowsState.quickEntryWindow.close()
  }

  windowsState.quickEntryWindow = null
}
