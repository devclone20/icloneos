// Secondary windows: session, browser and instance windows, and the About panel.

import { app, BrowserWindow, dialog, Menu, screen } from 'electron'

import { createAppNavigationGuard } from '../app-navigation-policy'
import { createAppWindowOpenHandler } from '../app-window-open-policy'
import {
  BROWSER_WINDOW_HEIGHT,
  BROWSER_WINDOW_MIN_HEIGHT,
  BROWSER_WINDOW_MIN_WIDTH,
  BROWSER_WINDOW_WIDTH,
  buildBrowserWindowUrl
} from '../browser-windows'
import { installFindShortcut } from '../find-in-page'
import { APP_COPYRIGHT, checkForUpdatesMenuItem } from '../iclone-app-update'
import { attachRendererConsoleCapture } from '../renderer-log'
import {
  buildInstanceWindowUrl,
  buildSessionWindowUrl,
  chatWindowWebPreferences,
  createSessionWindowRegistry,
  instanceWindowBounds,
  SESSION_WINDOW_MIN_HEIGHT,
  SESSION_WINDOW_MIN_WIDTH
} from '../session-windows'
import type { ThrottleWindowLike } from '../stream-throttle'
import { createWakeIndicatorWindowController } from '../wake-indicator-window'
import { installWindowRendererLifecycle } from '../window-renderer-lifecycle'
import { createWindowRevealController } from '../window-reveal'
import { computeWindowOptions, MIN_HEIGHT as WINDOW_MIN_HEIGHT, MIN_WIDTH as WINDOW_MIN_WIDTH } from '../window-state'
import {
  DEFAULT_ZOOM_LEVEL,
  installZoomReassertOnNavigation,
  installZoomReassertOnWindowEvents,
  ZOOM_STEP,
  zoomWiringForWindowKind
} from '../zoom'

import { getAppIconPath, icloneVersionLine } from './app-identity'
import { RENDERER_RELOAD_MAX, RENDERER_RELOAD_WINDOW_MS, rendererReloadTimesRef, streamThrottle } from './backend-state'
import { detectRendererSkew, readWindowState } from './desktop-settings'
import { APP_NAME, DEV_SERVER, IS_MAC, PRELOAD_PATH } from './env'
import { rememberLog } from './log'
import { resolveRendererIndex } from './runtime'
import { loadWindowUrl } from './shell-open'
import { quitState, windowsState } from './state'
import { chatWindowSurfaceOptions, getTitleBarOverlayOptions, translucencyBackedWindows } from './theme'
import { WINDOW_BUTTON_POSITION } from './window-chrome'
import {
  installBrowserNavGestures,
  installContextMenuBridge,
  installDevToolsShortcut,
  installPreviewShortcut,
  installZoomShortcuts,
  restorePersistedZoomLevel,
  sendClosePreviewRequested,
  sendOpenFolderRequested,
  sendOpenUpdatesRequested,
  sendPreviewNavCommand,
  sendWindowStateChanged,
  setAndPersistZoomLevel,
  toggleDevTools
} from './window-events'

// Re-resolve the live Hermes version and push it into the native About panel
// just before showing it, so an in-place `hermes update` is reflected without
// an app restart. macOS only — `showAboutPanel()` is a no-op elsewhere, and the
// other platforms don't use this menu item.
function showAboutPanelFresh() {
  void detectRendererSkew().then(skew => {
    app.setAboutPanelOptions({
      applicationName: APP_NAME,
      // iclone-seam: p7-version
      applicationVersion: skew.outOfSync
        ? `${icloneVersionLine()} — app build out of date, update the desktop app`
        : icloneVersionLine(),
      copyright: APP_COPYRIGHT
    })
    app.showAboutPanel()
  })
}

export function buildApplicationMenu() {
  const template: Electron.MenuItemConstructorOptions[] = []

  // iclone-seam: p7-check-for-updates
  const checkForUpdatesItem = checkForUpdatesMenuItem({
    controller: () => quitState.icloneAppUpdate,
    currentVersionLine: () => icloneVersionLine(),
    log: rememberLog,
    openRuntimeUpdates: () => sendOpenUpdatesRequested(),
    showMessageBox: options => dialog.showMessageBox(options)
  })

  if (IS_MAC) {
    template.push({
      label: APP_NAME,
      submenu: [
        { label: `About ${APP_NAME}`, click: () => showAboutPanelFresh() },
        checkForUpdatesItem,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    })
  }

  template.push({
    label: 'File',
    submenu: [
      // No accelerator: ⌘⇧N is a rebindable renderer keybind (session.newWindow);
      // a menu accelerator would fight the rebind panel and (on macOS) be
      // swallowed before the renderer sees it. Here purely for discoverability.
      { click: () => createInstanceWindow(), label: 'New Window' },
      // Same no-accelerator rationale: ⌘O is the rebindable renderer keybind
      // (workspace.openFolder). Clicking runs the same open-folder-as-project
      // flow through the renderer.
      { click: () => sendOpenFolderRequested(), label: 'Open Folder…' },
      { type: 'separator' },
      IS_MAC
        ? {
            // NO accelerator: on macOS a registered ⌘W is consumed by the OS
            // menu before the web contents ever sees it (and registerAccelerator
            // false is a no-op on mac — electron#18295). Leaving it off lets the
            // `before-input-event` handler below intercept ⌘W and route it to the
            // renderer's close-active-tab. Clicking the item still closes the tab
            // (or window) via the same request.
            click: () => sendClosePreviewRequested(),
            label: 'Close'
          }
        : { role: 'quit' }
    ]
  })
  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      // ⌘⇧V is only wired up by this item existing: an accelerator with no menu
      // entry is never translated into an editor command, so the chord was a
      // no-op in every input in the app. The composer inserts plain text on
      // every paste anyway, so this is the same result as ⌘V there — it's the
      // terminal, preview, and other editable surfaces that need the strip.
      { role: 'pasteAndMatchStyle' },
      { role: 'delete' },
      { role: 'selectAll' }
    ]
  })
  template.push({
    label: 'View',
    submenu: [
      // Not `role: 'reload'`: that hard-reloads the RENDERER (every pane, the
      // whole shell) and a focused in-app browser needs ⌘R to mean "reload
      // this page", the way it does in every other browser. ⇧⌘R
      // (`forceReload`) below stays the unconditional escape hatch.
      //
      // No accelerator: ⌘R is claimed in `installPreviewShortcut`, which works
      // on every platform (this menu exists only on macOS). Declaring it here
      // too would fire the item and the input hook for one keypress.
      { click: () => sendPreviewNavCommand('reload'), label: 'Reload' },
      { role: 'forceReload' },
      {
        label: 'Toggle Developer Tools',
        accelerator: process.platform === 'darwin' ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
        click: (_menuItem: Electron.MenuItem, browserWindow: Electron.BaseWindow | undefined) => {
          const target = browserWindow instanceof BrowserWindow ? browserWindow : windowsState.mainWindow

          if (target) {
            toggleDevTools(target)
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Actual Size',
        accelerator: 'CommandOrControl+0',
        click: () => {
          setAndPersistZoomLevel(windowsState.mainWindow, DEFAULT_ZOOM_LEVEL)
        }
      },
      {
        label: 'Zoom In',
        accelerator: 'CommandOrControl+Plus',
        click: () => {
          if (windowsState.mainWindow && !windowsState.mainWindow.isDestroyed()) {
            setAndPersistZoomLevel(
              windowsState.mainWindow,
              windowsState.mainWindow.webContents.getZoomLevel() + ZOOM_STEP
            )
          }
        }
      },
      {
        label: 'Zoom Out',
        accelerator: 'CommandOrControl+-',
        click: () => {
          if (windowsState.mainWindow && !windowsState.mainWindow.isDestroyed()) {
            setAndPersistZoomLevel(
              windowsState.mainWindow,
              windowsState.mainWindow.webContents.getZoomLevel() - ZOOM_STEP
            )
          }
        }
      },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ]
  })
  template.push({
    label: 'Window',
    submenu: IS_MAC
      ? [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }]
      : [{ role: 'minimize' }, { role: 'close' }]
  })
  template.push({
    label: 'Help',
    role: 'help',
    submenu: [checkForUpdatesItem]
  })

  return Menu.buildFromTemplate(template)
}

// Shared navigation guards + window chrome wiring applied to every window
// (the primary plus any secondary session windows). Factored out of
// createWindow() so secondary windows can't drift from the main window's
// security posture: external links open in the OS browser, in-app navigation
// stays confined to the dev server / packaged file URL, and the preview /
// devtools / zoom / context-menu affordances behave identically everywhere.
//
// `zoom` is opt-out for windows that size their own OS window in unzoomed CSS
// px (quick entry): inheriting the global UI zoom would render the content
// larger than its window and crop it. Chat windows keep zoom on.
export function wireCommonWindowHandlers(win: Electron.BrowserWindow, { zoom = true }: { zoom?: boolean } = {}) {
  installPreviewShortcut(win)
  installDevToolsShortcut(win)
  installBrowserNavGestures(win)

  // Claim Ctrl/Cmd+F in the main process — on Pop!_OS / GNOME-based Linux
  // distros the Ctrl+F keydown does not reach the renderer's `view.findInPage`
  // binding (#81727). Routing it through `before-input-event` forwards the
  // intent at the earliest observable point. macOS / Windows keep the
  // renderer's own rebindable keybind, so the hook is Linux-only: installing
  // it elsewhere would make Ctrl/Cmd+F un-rebindable and double-open.
  if (process.platform === 'linux') {
    installFindShortcut(win)
  }

  if (zoom) {
    installZoomShortcuts(win)
    // Re-apply persisted zoom on show/restore/resize/cross-display move
    // (Chromium can drop webContents zoom after these window transitions), on
    // EVERY full load — not once, since crash recovery reloads and would
    // outlive a spent `once` listener (#46429) — and after in-page navigation,
    // where Chromium applies the target hash route's own per-URL zoom record
    // (see installZoomReassertOnNavigation; #48658, #38854, #79863).
    const reassertZoom = () => restorePersistedZoomLevel(win)

    installZoomReassertOnWindowEvents(win, reassertZoom)
    installZoomReassertOnNavigation(win.webContents, reassertZoom)
  }

  installContextMenuBridge(win)
  // X1b: deny, never the system browser — the request may come from any frame of the window (an artifact iframe, an
  // embed). A link the user clicks reaches the OS through the preload's router (external-link-router.ts).
  win.webContents.setWindowOpenHandler(createAppWindowOpenHandler(rememberLog))

  // X1c: the main frame only ever shows the app — no navigation or redirect to another file: page or a remote one
  // (the preload and the bridge would follow it). A link the user clicks opens through the preload's router.
  const guardNavigation = createAppNavigationGuard({
    devServer: DEV_SERVER,
    rendererIndexPath: resolveRendererIndex,
    log: rememberLog
  })

  win.webContents.on('will-navigate', guardNavigation)
  win.webContents.on('will-redirect', guardNavigation)
}

// Every window we open starts with `show: false` so the renderer's first themed
// paint lands before it appears, and `ready-to-show` is what reveals it.
// Electron 40 can drop that event entirely (electron/electron#51972) on
// Linux/Wayland, remote displays and VMs, leaving the window hidden forever even
// though the renderer finished loading. Keep the themed path as the preferred
// reveal, then fall back a few seconds after the renderer loads. `show` and
// `onRevealed` carry the caller's reveal action and post-visible work; whichever
// path wins runs them exactly once.
export function wireWindowReveal(
  win: BrowserWindow,
  { show, onRevealed }: { show?: () => void; onRevealed?: () => void } = {}
) {
  const controller = createWindowRevealController(
    {
      isDestroyed: () => win.isDestroyed(),
      isVisible: () => win.isVisible(),
      show: show ?? (() => win.show())
    },
    { onRevealed }
  )

  win.once('ready-to-show', controller.reveal)
  win.webContents.once('did-finish-load', controller.scheduleFallback)
  win.on('closed', controller.dispose)

  return controller
}

// Secondary "session windows" — one extra OS window per chat so a user can
// work with multiple chats side by side. The registry guarantees one window
// per sessionId (re-opening focuses the existing window) and self-cleans on
// close. The primary mainWindow is never tracked here. Pure logic + the URL
// builder live in session-windows.ts so they stay unit-testable.
const sessionWindows = createSessionWindowRegistry()

export function focusWindow(win: BrowserWindow) {
  if (!win || win.isDestroyed()) {
    return
  }

  if (win.isMinimized()) {
    win.restore()
  }

  if (!win.isVisible()) {
    win.show()
  }

  win.focus()
}

// Wiring shared by every chat-surface window: glass backing, traffic lights, reveal, fullscreen state, stream
// throttling and the common handlers. Chat-surface registration lets applyWindowTranslucency swap the window's
// backing between opaque-themed and alpha-0 when glass toggles.
function wireChatSurfaceWindow(win: BrowserWindow): void {
  translucencyBackedWindows.add(win)

  if (IS_MAC) {
    win.setWindowButtonPosition?.(WINDOW_BUTTON_POSITION)
  }

  wireWindowReveal(win)

  win.on('enter-full-screen', () => sendWindowStateChanged(true))
  win.on('leave-full-screen', () => sendWindowStateChanged(false))

  streamThrottle.register(win as ThrottleWindowLike)
  wireCommonWindowHandlers(win, zoomWiringForWindowKind('chat'))
}

function spawnSecondaryWindow({ sessionId, watch }: { sessionId: string; watch?: boolean }) {
  const icon = getAppIconPath()

  const win = new BrowserWindow({
    width: SESSION_WINDOW_MIN_WIDTH,
    height: SESSION_WINDOW_MIN_HEIGHT,
    minWidth: SESSION_WINDOW_MIN_WIDTH,
    minHeight: SESSION_WINDOW_MIN_HEIGHT,
    title: 'iclone os',
    titleBarStyle: 'hidden',
    titleBarOverlay: getTitleBarOverlayOptions(),
    trafficLightPosition: IS_MAC ? WINDOW_BUTTON_POSITION : undefined,
    ...chatWindowSurfaceOptions(),
    icon,
    // Don't show until the renderer's first themed paint is ready. macOS
    // `vibrancy` ignores `backgroundColor` and paints a translucent OS
    // material (which follows the OS appearance, not the app theme), so a
    // dark-themed app on a light-mode Mac flashes white until the renderer
    // covers it. ready-to-show fires after the boot-time paint in
    // themes/context.tsx, so the window appears already themed.
    show: false,
    webPreferences: chatWindowWebPreferences(PRELOAD_PATH)
  })

  wireChatSurfaceWindow(win)
  attachRendererConsoleCapture(win, 'session-window', rememberLog)

  // Renderer lifecycle diagnostics + recovery (#81290): a dead session-window
  // renderer used to log nothing and stay black; now it logs with its window
  // kind and reloads under the shared crash-loop budget, exactly like the
  // primary window, without touching any other window.
  installWindowRendererLifecycle(win, {
    kind: 'secondary',
    callbacks: {
      log: rememberLog,
      reload: () => {
        win.webContents.reload()
      }
    },
    reloadWindowMs: RENDERER_RELOAD_WINDOW_MS,
    reloadMax: RENDERER_RELOAD_MAX,
    recentReloadTimesRef: rendererReloadTimesRef
  })

  loadWindowUrl(
    win,
    buildSessionWindowUrl(sessionId, {
      devServer: DEV_SERVER,
      rendererIndexPath: DEV_SERVER ? undefined : resolveRendererIndex(),
      watch
    }),
    'Session window'
  )

  return win
}

// Open (or focus) a standalone window for a single chat session.
export function createSessionWindow(sessionId: string, { watch = false } = {}) {
  return sessionWindows.openOrFocus(sessionId, () => spawnSecondaryWindow({ sessionId, watch }))
}

// Popped-out in-app Browser: same webview + address bar as a docked Browser
// tab, in its own OS window. One window per tab id (re-open focuses); closing
// it tells the other renderers so they can dock the tab again.
const browserWindows = createSessionWindowRegistry()

function notifyBrowserPopoutClosed(tabId: string | null | undefined) {
  if (typeof tabId !== 'string' || !tabId) {
    return
  }

  for (const other of BrowserWindow.getAllWindows()) {
    if (!other.isDestroyed()) {
      other.webContents.send('hermes:browser-popout:closed', tabId)
    }
  }
}

function spawnBrowserWindow(tabId: string | null | undefined) {
  const icon = getAppIconPath()

  const win = new BrowserWindow({
    width: BROWSER_WINDOW_WIDTH,
    height: BROWSER_WINDOW_HEIGHT,
    minWidth: BROWSER_WINDOW_MIN_WIDTH,
    minHeight: BROWSER_WINDOW_MIN_HEIGHT,
    title: 'iclone os',
    titleBarStyle: 'hidden',
    titleBarOverlay: getTitleBarOverlayOptions(),
    trafficLightPosition: IS_MAC ? WINDOW_BUTTON_POSITION : undefined,
    ...chatWindowSurfaceOptions(),
    icon,
    show: false,
    webPreferences: chatWindowWebPreferences(PRELOAD_PATH)
  })

  wireChatSurfaceWindow(win)
  attachRendererConsoleCapture(win, 'browser-window', rememberLog)

  installWindowRendererLifecycle(win, {
    kind: 'browser',
    callbacks: {
      log: rememberLog,
      reload: () => {
        win.webContents.reload()
      }
    },
    reloadWindowMs: RENDERER_RELOAD_WINDOW_MS,
    reloadMax: RENDERER_RELOAD_MAX,
    recentReloadTimesRef: rendererReloadTimesRef
  })

  win.on('closed', () => notifyBrowserPopoutClosed(tabId))

  loadWindowUrl(
    win,
    buildBrowserWindowUrl(tabId, {
      devServer: DEV_SERVER,
      rendererIndexPath: DEV_SERVER ? undefined : resolveRendererIndex()
    }),
    'Browser window'
  )

  return win
}

export function createBrowserWindow(tabId: string) {
  return browserWindows.openOrFocus(tabId, () => spawnBrowserWindow(tabId))
}

// Additional full "instance" windows — peers of the primary that render the
// COMPLETE app (sidebar, routing, its own draft) against the shared backend, so
// a user can run multiple GUI windows at once (⌘⇧N / the "New Window" palette
// command). Unlike the compact session windows they carry no `?win` flag; a
// separate `peer=1` marker prevents them from replaying app-launch source
// restoration after joining that shared backend. The primary mainWindow stays
// the notification / deep-link anchor and
// is NOT tracked here. The set holds a strong reference so an open peer isn't
// garbage-collected, and drops it on close.
const instanceWindows = new Set<any>()

// Cascade a new instance off whichever window spawned it so it doesn't land
// exactly on top of its source. Falls back to the persisted primary geometry
// when there's no live source window (e.g. all windows closed on macOS). The
// pure cascade math lives in session-windows.ts (instanceWindowBounds).
function nextInstanceBounds() {
  const source = BrowserWindow.getFocusedWindow() || windowsState.mainWindow
  const fallback = computeWindowOptions(readWindowState(), screen.getAllDisplays())
  const base = source && !source.isDestroyed() ? source.getBounds() : null

  return instanceWindowBounds(base, fallback)
}

// Open a new full-chrome instance window. Mirrors createWindow()'s window
// options (shared chatWindowWebPreferences + streamThrottle registration so a
// streamed answer never stalls in the background) but is a peer, not the
// primary: it never overwrites the mainWindow global, doesn't start the backend
// (the renderer's getConnection() joins the already-running one), and loads the
// plain renderer URL so the full app renders.
export function createInstanceWindow() {
  const icon = getAppIconPath()

  const win = new BrowserWindow({
    ...nextInstanceBounds(),
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    title: 'iclone os',
    titleBarStyle: 'hidden',
    titleBarOverlay: getTitleBarOverlayOptions(),
    trafficLightPosition: IS_MAC ? WINDOW_BUTTON_POSITION : undefined,
    ...chatWindowSurfaceOptions(),
    icon,
    show: false,
    webPreferences: chatWindowWebPreferences(PRELOAD_PATH)
  })

  instanceWindows.add(win)

  // Chat-surface registration: see applyWindowTranslucency.
  translucencyBackedWindows.add(win)

  if (IS_MAC) {
    win.setWindowButtonPosition?.(WINDOW_BUTTON_POSITION)
  }

  wireWindowReveal(win)

  // Per-window fullscreen chrome: send this window its own titlebar inset so its
  // traffic lights hide/show independently of the primary.
  win.on('enter-full-screen', () => sendWindowStateChanged(true, win))
  win.on('leave-full-screen', () => sendWindowStateChanged(false, win))

  streamThrottle.register(win as ThrottleWindowLike)
  wireCommonWindowHandlers(win, zoomWiringForWindowKind('chat'))

  // Renderer lifecycle diagnostics + recovery (#81290), same policy as the
  // primary and session windows: a crashed instance renderer logs with its
  // window kind and reloads under the shared crash-loop budget.
  installWindowRendererLifecycle(win, {
    kind: 'instance',
    callbacks: {
      log: rememberLog,
      reload: () => {
        win.webContents.reload()
      }
    },
    reloadWindowMs: RENDERER_RELOAD_WINDOW_MS,
    reloadMax: RENDERER_RELOAD_MAX,
    recentReloadTimesRef: rendererReloadTimesRef
  })

  win.on('closed', () => {
    instanceWindows.delete(win)
  })

  attachRendererConsoleCapture(win, 'instance', rememberLog)
  loadWindowUrl(
    win,
    buildInstanceWindowUrl({
      devServer: DEV_SERVER,
      rendererIndexPath: DEV_SERVER ? undefined : resolveRendererIndex()
    }),
    'Instance window'
  )

  return win
}

// A macOS-only ambient wake cue. It is deliberately a gateway-less helper
// window: the active renderer owns voice state and sends only the visual phase.
export const wakeIndicatorController = createWakeIndicatorWindowController({
  devServer: DEV_SERVER,
  isMac: IS_MAC,
  loadWindowUrl,
  log: rememberLog,
  preloadPath: PRELOAD_PATH,
  rendererIndex: resolveRendererIndex,
  wireWindow: window => wireCommonWindowHandlers(window, zoomWiringForWindowKind('wakeIndicator'))
})
