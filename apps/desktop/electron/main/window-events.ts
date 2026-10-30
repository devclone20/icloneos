// Window chrome events, application menu, shortcuts, zoom, context menu, downloads and permissions.
import path from 'node:path'

import { app, BrowserWindow, webContents as electronWebContents, session } from 'electron'

import { consentAllows, mediaDeclinedByConsent } from '../iclone-consent'
import { decideMediaRequest, isAllowedMediaCheck } from '../packaged-env'
import { previewShortcutDecision } from '../preview-shortcut'
import { nativeOverlayWidth as computeNativeOverlayWidth } from '../titlebar-overlay-width'
import { applyZoomLevel, DEFAULT_ZOOM_LEVEL, ZOOM_STEP, ZOOM_STORAGE_KEY } from '../zoom'

import { readZoomState, writeZoomState } from './desktop-settings'
import { DARWIN_MAJOR, IS_MAC, IS_WINDOWS, IS_WSL } from './env'
import { extensionForMimeType } from './link-metadata'
import { rememberLog } from './log'
import { connectionRuntimeState, windowsState } from './state'
import { WINDOW_BUTTON_POSITION } from './window-chrome'

function getWindowButtonPosition(win = windowsState.mainWindow) {
  if (!IS_MAC) {
    return null
  }

  // Fullscreen hides the traffic lights — treat as no left-side controls so the
  // renderer drops the traffic-light dodge inset and Y nudge.
  if (win?.isFullScreen?.()) {
    return null
  }

  return win?.getWindowButtonPosition?.() || WINDOW_BUTTON_POSITION
}

function getNativeOverlayWidth() {
  return computeNativeOverlayWidth({ isWindows: IS_WINDOWS, isWsl: IS_WSL, isMac: IS_MAC })
}

export function getWindowState(win = windowsState.mainWindow) {
  return {
    isFullscreen: Boolean(win?.isFullScreen?.()),
    isMinimized: Boolean(win?.isMinimized?.()),
    isVisible: Boolean(win?.isVisible?.()),
    nativeOverlayWidth: getNativeOverlayWidth(),
    windowButtonPosition: getWindowButtonPosition(win),
    darwinMajor: IS_MAC ? DARWIN_MAJOR : 0
  }
}

export function sendBackendExit(payload: { code: number | null; signal: NodeJS.Signals | null; error?: string }) {
  // Intentional soft re-home (gateway mode apply) kills the child on purpose —
  // don't surface the "backend stopped" error toast / boot-failure path.
  if (connectionRuntimeState.softRehomeInProgress) {
    return
  }

  if (!windowsState.mainWindow || windowsState.mainWindow.isDestroyed()) {
    return
  }

  const { webContents } = windowsState.mainWindow

  if (!webContents || webContents.isDestroyed()) {
    return
  }

  webContents.send('hermes:backend-exit', payload)
}

export function sendClosePreviewRequested() {
  if (!windowsState.mainWindow || windowsState.mainWindow.isDestroyed()) {
    return
  }

  const { webContents } = windowsState.mainWindow

  if (!webContents || webContents.isDestroyed()) {
    return
  }

  webContents.send('hermes:close-preview-requested')
}

/**
 * Run a browser gesture on the guest page the user is actually in, if any.
 *
 * A `<webview>` guest is its own out-of-process webContents: pointer and focus
 * events inside the page never reach the host document, so NOTHING in the
 * renderer — not `document.activeElement`, not the layout tree's hover/focus
 * ladder — can see that the user is in there. Main can: Electron tracks the
 * focused webContents across processes, which is the definition of a runtime
 * fact it owns.
 *
 * Returns false when focus is in the app's own chrome, where the renderer is
 * the one that knows which pane is active.
 */
function commandFocusedGuest(command: 'back' | 'forward' | 'reload'): boolean {
  const focused = electronWebContents.getFocusedWebContents()

  if (!focused || focused.isDestroyed() || focused.getType() !== 'webview') {
    return false
  }

  const history = focused.navigationHistory

  if (command === 'reload') {
    focused.reload()
  } else if (command === 'back') {
    if (!history.canGoBack()) {
      return true
    }

    history.goBack()
  } else {
    if (!history.canGoForward()) {
      return true
    }

    history.goForward()
  }

  return true
}

/**
 * Ask the renderer to run a browser-navigation gesture on its focused preview
 * pane. `reload` also has an app-level fallback (reload the window); `back` and
 * `forward` mean nothing outside the browser, so the renderer just ignores them.
 */
export function sendPreviewNavCommand(command: 'back' | 'forward' | 'reload') {
  // The user is inside the page itself — main is the only party that can see
  // that, so act here and never round-trip.
  if (commandFocusedGuest(command)) {
    return
  }

  if (!windowsState.mainWindow || windowsState.mainWindow.isDestroyed()) {
    return
  }

  const { webContents } = windowsState.mainWindow

  if (!webContents || webContents.isDestroyed()) {
    return
  }

  webContents.send('hermes:preview-nav', command)
}

/**
 * The native back/forward gestures, which never reach the renderer on their own.
 *
 * - macOS: a two/three-finger swipe. Chromium's own overscroll navigation is
 *   off in an Electron window, so the OS gesture surfaces as this event and
 *   nothing consumes it. Requires "Swipe between pages" in System Settings.
 * - Windows/Linux: the dedicated back/forward buttons on a mouse, delivered as
 *   `WM_APPCOMMAND`.
 */
export function installBrowserNavGestures(window: Electron.BrowserWindow) {
  window.on('swipe', (_event, direction) => {
    if (direction === 'left' || direction === 'right') {
      // Swipe LEFT moves the page left, revealing what's behind it — that's
      // back. Matches Safari, Chrome, and Finder.
      sendPreviewNavCommand(direction === 'left' ? 'back' : 'forward')
    }
  })

  window.on('app-command', (event, command) => {
    if (command !== 'browser-backward' && command !== 'browser-forward') {
      return
    }

    // Claim it either way: unhandled, Chromium walks the HOST document's
    // history, which would navigate the app shell itself.
    event.preventDefault()
    sendPreviewNavCommand(command === 'browser-backward' ? 'back' : 'forward')
  })
}

export function sendOpenFolderRequested() {
  if (!windowsState.mainWindow || windowsState.mainWindow.isDestroyed()) {
    return
  }

  const webContents = windowsState.mainWindow.webContents

  if (!webContents || webContents.isDestroyed()) {
    return
  }

  webContents.send('hermes:open-folder-requested')
}

// Tell the renderer the machine just woke. Sleep silently drops the
// renderer's WebSocket to the local backend; the renderer reconnects on this
// signal so the chat composer doesn't stay stuck on "Starting Hermes...".
export function sendPowerResume() {
  if (!windowsState.mainWindow || windowsState.mainWindow.isDestroyed()) {
    return
  }

  const { webContents } = windowsState.mainWindow

  if (!webContents || webContents.isDestroyed()) {
    return
  }

  webContents.send('hermes:power-resume')
}

export function broadcastBatteryState(next: boolean) {
  if (connectionRuntimeState.onBatteryPower === next) {
    return
  }

  connectionRuntimeState.onBatteryPower = next

  for (const win of BrowserWindow.getAllWindows()) {
    const { webContents } = win

    if (webContents && !webContents.isDestroyed()) {
      webContents.send('hermes:power-battery', next)
    }
  }
}

export function sendOpenUpdatesRequested() {
  if (!windowsState.mainWindow || windowsState.mainWindow.isDestroyed()) {
    return
  }

  const { webContents } = windowsState.mainWindow

  if (!webContents || webContents.isDestroyed()) {
    return
  }

  webContents.send('hermes:open-updates')

  if (!windowsState.mainWindow.isVisible()) {
    windowsState.mainWindow.show()
  }

  windowsState.mainWindow.focus()
}

// Push titlebar/fullscreen chrome state to a window's renderer. Defaults to the
// primary, but any full chat window (primary or a secondary "instance" peer)
// passes itself so its own fullscreen toggle drives its own traffic-light inset.
export function sendWindowStateChanged(nextIsFullscreen?: boolean, target = windowsState.mainWindow) {
  if (!target || target.isDestroyed()) {
    return
  }

  const { webContents } = target

  if (!webContents || webContents.isDestroyed()) {
    return
  }

  const state = getWindowState(target)

  if (typeof nextIsFullscreen === 'boolean') {
    state.isFullscreen = nextIsFullscreen
  }

  webContents.send('hermes:window-state-changed', state)
}

export function toggleDevTools(window: Electron.BrowserWindow) {
  // DevTools is enabled in packaged builds so users can diagnose renderer
  // issues without needing a dev build. Trade-off: tiny attack surface
  // increase versus a much better support story when WS connection or
  // CSP issues surface in the field.
  const { webContents } = window

  if (webContents.isDevToolsOpened()) {
    webContents.closeDevTools()
  } else {
    webContents.openDevTools({ mode: 'detach' })
  }
}

export function installDevToolsShortcut(window: Electron.BrowserWindow) {
  // Only Ctrl+Shift+I (or Cmd+Opt+I on Mac) opens DevTools.
  // F12 is explicitly blocked so Chromium's built-in handler doesn't open it.
  window.webContents.on('before-input-event', (event, input) => {
    const key = input.key.toLowerCase()

    // F12 opens DevTools by default; block only when the user disabled it.
    if (input.key === 'F12') {
      if (windowsState.f12Blocked) {
        event.preventDefault()

        return
      }
      // Not blocked — fall through to open DevTools.
    }

    const isInspectShortcut =
      input.key === 'F12' ||
      (IS_MAC && input.meta && input.alt && key === 'i') ||
      (!IS_MAC && input.control && input.shift && key === 'i')

    if (!isInspectShortcut) {
      return
    }

    event.preventDefault()
    toggleDevTools(window)
  })
}

export function installPreviewShortcut(window: Electron.BrowserWindow) {
  window.webContents.on('before-input-event', (event, input) => {
    // Always claim ⌘W here (the File>Close item deliberately has no
    // accelerator, so nothing else does). The renderer decides tab-vs-window
    // — no `previewShortcutActive` gate, so it works for every closeable tab.
    //
    // ⌘R rides here rather than on the View menu item for the same reason:
    // the application menu only exists on macOS (it is set to null elsewhere,
    // see #77845), so a menu accelerator would leave Windows and Linux with no
    // way to reload a page at all. ⇧⌘R is left alone — that is `forceReload`,
    // the unconditional whole-window escape hatch.
    const { action, claim } = previewShortcutDecision(input, IS_MAC)

    if (!claim) {
      return
    }

    event.preventDefault()

    if (action === 'close') {
      sendClosePreviewRequested()
    } else if (action === 'reload') {
      sendPreviewNavCommand('reload')
    }
  })
}

export function setAndPersistZoomLevel(window: Electron.BrowserWindow | null, zoomLevel: unknown) {
  if (!window || window.isDestroyed()) {
    return
  }

  // Apply + notify in one funnel so the settings UI stays in sync, including
  // changes made via the keyboard shortcuts or the View menu.
  const next = applyZoomLevel(window.webContents, zoomLevel)

  // Primary store: main-process JSON (survives crash recovery — #56726).
  writeZoomState(next)
  // Secondary mirror: renderer localStorage (legacy store; kept in sync so a
  // downgrade or JSON read failure still finds a sane value).
  window.webContents
    .executeJavaScript(
      `try { localStorage.setItem(${JSON.stringify(ZOOM_STORAGE_KEY)}, ${JSON.stringify(String(next))}) } catch {
      void 0
    }`
    )
    .catch(error => rememberLog(`[zoom] persist failed: ${error?.message || error}`))
}

export function restorePersistedZoomLevel(window: Electron.BrowserWindow) {
  if (!window || window.isDestroyed()) {
    return
  }

  // Prefer the JSON file — it survives crash recovery wiping Electron's
  // cache/storage folders (#56726). applyZoomLevel notifies the renderer so
  // the Appearance UI Scale control stays in sync.
  const saved = readZoomState()

  if (saved != null) {
    // Drift-guard: skip when this window already shows the persisted level.
    // Blindly re-applying on every resize/move would race the compositor's
    // surface reconfigure during a Wayland resize storm (Cosmic tiled mode
    // fires one whenever a new session window opens — #84818) and keep the
    // renderer notification stream churning for no gain. The settle-verify
    // chain in installZoomReassertOnWindowEvents re-applies only when the
    // window actually drifted from the persisted level.
    const current = window.webContents?.getZoomLevel?.()

    if (current != null && Math.abs(current - saved) < 1e-9) {
      return
    }

    applyZoomLevel(window.webContents, saved)

    return
  }

  // No JSON yet: paint the shipped default immediately so a fresh install
  // doesn't flash Chromium 100%, then try localStorage for pre-JSON installs
  // and overwrite if a legacy value is there.
  applyZoomLevel(window.webContents, DEFAULT_ZOOM_LEVEL)

  window.webContents
    .executeJavaScript(
      `(() => { try { return localStorage.getItem(${JSON.stringify(ZOOM_STORAGE_KEY)}) } catch { return null } })()`
    )
    .then(stored => {
      if (!window || window.isDestroyed()) {
        return
      }

      const level = stored == null ? DEFAULT_ZOOM_LEVEL : Number(stored)
      const applied = applyZoomLevel(window.webContents, level)
      writeZoomState(applied)
    })
    .catch(error => rememberLog(`[zoom] restore failed: ${error?.message || error}`))
}

export function installZoomShortcuts(window: Electron.BrowserWindow) {
  // Override Ctrl/Cmd + +/-/0 with half Chromium's default zoom step (ZOOM_STEP
  // is 0.1 vs Chromium's 0.2). The menu items handle this on macOS (where the
  // menu is always present), but on Linux/Windows the menu is null and
  // Chromium's default handler would use the full 0.2 step, so we intercept
  // here for consistency. Ctrl/Cmd+0 resets to DEFAULT_ZOOM_LEVEL, not Chromium 0.
  window.webContents.on('before-input-event', (event, input) => {
    const mod = IS_MAC ? input.meta : input.control

    if (!mod || input.alt) {
      return
    }

    const key = input.key

    if (key === '0') {
      if (input.shift) {
        return // Ctrl/Cmd+Shift+0 is not a zoom chord — leave it alone
      }

      event.preventDefault()
      setAndPersistZoomLevel(window, DEFAULT_ZOOM_LEVEL)
    } else if (key === '=' || key === '+') {
      // Zoom-in must accept the shift modifier: on US layouts Plus is
      // physically Shift+=, so Cmd+Plus arrives as Cmd+Shift+'+' (or '='
      // depending on platform). The old blanket shift guard silently
      // dropped keyboard zoom-in on macOS (#43517).
      event.preventDefault()
      setAndPersistZoomLevel(window, window.webContents.getZoomLevel() + ZOOM_STEP)
    } else if (key === '-') {
      if (input.shift) {
        return // Shift+'-' is '_' territory on most layouts, not zoom-out
      }

      event.preventDefault()
      setAndPersistZoomLevel(window, window.webContents.getZoomLevel() - ZOOM_STEP)
    }
  })

  // Ctrl/Cmd + mouse wheel — the standard desktop/browser zoom gesture
  // (#40295). Chromium surfaces it as the main-process 'zoom-changed' event
  // (wheel events are DOM-side, so before-input-event never sees them).
  // Route through the same persist+notify funnel as the keyboard shortcuts
  // so wheel zoom survives restarts and the settings Scale control stays in
  // sync, and use the same half step for consistency.
  window.webContents.on('zoom-changed', (event, zoomDirection) => {
    event.preventDefault()
    const delta = zoomDirection === 'in' ? ZOOM_STEP : -ZOOM_STEP
    setAndPersistZoomLevel(window, window.webContents.getZoomLevel() + delta)
  })
}

/**
 * The custom (renderer) context menu's main-process half.
 *
 * The app popups no native menus: the renderer owns the menu UI so labels
 * are translated with the rest of the app. Main keeps only what Chromium
 * reports here and the renderer cannot see:
 *  - spell-check facts (misspelled word + suggestions) — forwarded so the
 *    renderer appends them to its already-open menu,
 *  - the gesture coordinates — kept for copyImageAt, which needs them.
 */
export const lastContextMenuPoint = new Map<number, { x: number; y: number }>()

export function installContextMenuBridge(window: BrowserWindow) {
  window.webContents.on('context-menu', (_event, params) => {
    lastContextMenuPoint.set(window.webContents.id, { x: params.x, y: params.y })

    const suggestions = Array.isArray(params.dictionarySuggestions) ? params.dictionarySuggestions : []

    if (params.isEditable && params.misspelledWord) {
      window.webContents.send('hermes:context-menu-spellcheck', {
        misspelledWord: params.misspelledWord,
        suggestions
      })
    }
  })
}

// Microphone capture only: the voice composer drives getUserMedia, which
// Chromium gates behind the two session hooks in installMediaPermissions().
// The policy (audio allowed, video always refused) lives in packaged-env.ts;
// macOS TCC still prompts on first use. // iclone-seam: p7-media

// Chromium-initiated downloads (renderer anchor/blob downloads, drag-outs)
// land here. Without a handler the OS save dialog opens with the process cwd
// as the default directory (win-unpacked in packaged installs) and whatever
// extensionless name the anchor carried. Route every download to the user's
// Downloads directory and guarantee a MIME-derived extension.
export function installDownloadHandling() {
  session.defaultSession.on('will-download', (_event, item) => {
    const suggested = item.getFilename() || 'download'
    const hasExtension = Boolean(path.extname(suggested))
    const extension = hasExtension ? '' : extensionForMimeType(item.getMimeType())
    const filename = `${suggested}${extension}`

    try {
      item.setSaveDialogOptions({
        title: 'Save File',
        defaultPath: path.join(app.getPath('downloads'), filename),
        filters:
          extension || /^image\//i.test(item.getMimeType() || '')
            ? [
                { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] },
                { name: 'All Files', extensions: ['*'] }
              ]
            : undefined
      })
    } catch {
      // No Downloads directory to offer — keep Chromium's default prompt.
    }
  })
}

export function installMediaPermissions() {
  // Async request handler: the prompt-style path (most platforms).
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    // Microphone switched OFF in the consent sheet / Settings › Privacy: refuse audio before macOS is asked.
    if (mediaDeclinedByConsent(consentAllows('microphone'), permission, details)) {
      callback(false)

      return
    }

    callback(decideMediaRequest(permission, details)) // iclone-seam: p7-media
  })

  // Synchronous check handler: Chromium consults this for getUserMedia on
  // Windows in addition to (or instead of) the request handler. Without it,
  // the check defaults to false and capture is denied before the request
  // handler ever runs.
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, _origin, details) => {
    if (mediaDeclinedByConsent(consentAllows('microphone'), permission, details)) {
      return false
    }

    return isAllowedMediaCheck(permission) // iclone-seam: p7-media
  })
}
