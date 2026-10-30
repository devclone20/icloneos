// The main window.
import { pathToFileURL } from 'node:url'

import { app, BrowserWindow, nativeTheme, screen } from 'electron'

import { errorMessage } from '../../src/iclone-shared/errors'
import { missingRendererAssets } from '../renderer-bundle'
import { loadRendererLoadErrorPage } from '../renderer-load-error-page'
import { attachRendererConsoleCapture } from '../renderer-log'
import { chatWindowWebPreferences } from '../session-windows'
import type { ThrottleWindowLike } from '../stream-throttle'
import { installWindowRendererLifecycle } from '../window-renderer-lifecycle'
import {
  bindGeometryPersistence,
  computeWindowOptions,
  MIN_HEIGHT as WINDOW_MIN_HEIGHT,
  MIN_WIDTH as WINDOW_MIN_WIDTH
} from '../window-state'
import {
  alreadyHasNoSandbox,
  buildNoSandboxRelaunchArgs,
  fallbackMarker,
  markerAfterSuccessfulBoot,
  shouldRelaunchForRendererSandboxCrashLoop,
  writeSandboxMarker
} from '../windows-sandbox-fallback'
import { zoomWiringForWindowKind } from '../zoom'

import { getAppIconPath } from './app-identity'
import { exitAfterBackendShutdown } from './backend-pool'
import { RENDERER_RELOAD_MAX, RENDERER_RELOAD_WINDOW_MS, rendererReloadTimesRef, streamThrottle } from './backend-state'
import { broadcastBootProgress } from './boot-progress'
import { readWindowState, schedulePersistWindowState } from './desktop-settings'
import { DEV_SERVER, IS_MAC, IS_WINDOWS, PRELOAD_PATH } from './env'
import { rememberLog } from './log'
import { resolveRendererIndex } from './runtime'
import { loadWindowUrl } from './shell-open'
import { startHermes } from './start-hermes'
import { deepLinkState, sandboxState, windowsState } from './state'
import {
  applyTitleBarOverlay,
  chatWindowSurfaceOptions,
  getTitleBarOverlayOptions,
  translucencyBackedWindows
} from './theme'
import { WINDOW_BUTTON_POSITION } from './window-chrome'
import { sendWindowStateChanged } from './window-events'
import { wakeIndicatorController, wireCommonWindowHandlers, wireWindowReveal } from './windows'

let nativeThemeListenerInstalled = false

export function createWindow() {
  const icon = getAppIconPath()
  const savedWindowState = readWindowState()
  windowsState.mainWindow = new BrowserWindow({
    ...computeWindowOptions(savedWindowState, screen.getAllDisplays()),
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    title: 'iclone os',
    // Frameless title bar on every platform so the renderer can paint the
    // "hide sidebar" button (and other left-side titlebar tools) flush with
    // the top edge — matching the macOS layout where the traffic lights sit
    // inside the same band. On Windows/Linux, titleBarOverlay tells Electron
    // to paint native min/max/close in the top-right of the renderer; on
    // macOS it just reserves a content inset alongside the traffic lights.
    titleBarStyle: 'hidden',
    titleBarOverlay: getTitleBarOverlayOptions(),
    trafficLightPosition: IS_MAC ? WINDOW_BUTTON_POSITION : undefined,
    ...chatWindowSurfaceOptions(),
    icon,
    // Hidden until the first themed paint so macOS `vibrancy` (which ignores
    // `backgroundColor` and follows the OS appearance) can't flash a light
    // material before the renderer paints the app theme. See createSessionWindow.
    show: false,
    // Shared with the secondary session windows (chatWindowWebPreferences);
    // stream-aware throttling is applied per-window via streamThrottle so a
    // live answer keeps painting while the window is blurred or minimized,
    // without pinning visibilityState to 'visible' at idle. See
    // session-windows.ts and stream-throttle.ts.
    webPreferences: chatWindowWebPreferences(PRELOAD_PATH)
  })

  const createdMainWindow = windowsState.mainWindow

  // Chat-surface registration: see applyWindowTranslucency.
  translucencyBackedWindows.add(windowsState.mainWindow)

  if (IS_MAC) {
    windowsState.mainWindow.setWindowButtonPosition?.(WINDOW_BUTTON_POSITION)

    if (icon) {
      app.dock?.setIcon(icon)
    }
  }

  if (!IS_MAC) {
    if (!nativeThemeListenerInstalled) {
      nativeThemeListenerInstalled = true
      nativeTheme.on('updated', () => {
        for (const win of BrowserWindow.getAllWindows()) {
          applyTitleBarOverlay(win)
        }
      })
    }
  }

  if (savedWindowState?.isMaximized) {
    windowsState.mainWindow.maximize()
  }

  const revealController = wireWindowReveal(createdMainWindow, {
    onRevealed: () => {
      // Persist geometry as soon as the window is visible so a crash before the
      // first clean resize/move/close still captures the restored bounds (#56726).
      schedulePersistWindowState()

      // #38216: clear the mid-boot marker only after a window is actually usable.
      // Keep sticky `fallback` when we launched with --no-sandbox so the next
      // Start Menu click does not re-enter the GPU FATAL crash loop. The marker
      // records the app version so the next update re-probes the sandbox.
      if (IS_WINDOWS) {
        try {
          writeSandboxMarker(
            app.getPath('userData'),
            markerAfterSuccessfulBoot({
              fallbackActive: sandboxState.windowsSandboxFallbackSticky,
              reason: sandboxState.windowsSandboxFallbackReason,
              appVersion: app.getVersion()
            })
          )
        } catch (error) {
          rememberLog(`[sandbox] marker update after main-window reveal failed: ${errorMessage(error) || error}`)
        }
      }
    }
  })

  // Under Playwright testing, instantly show the window: `ready-to-show`
  // doesn't fire in some testing envs, and the suite can't wait out the
  // production fallback.
  if (process.env.TEST_WORKER_INDEX !== undefined) {
    revealController.reveal()
  }

  // The will-* fullscreen events are missing from Electron's typings; the listeners predate them.
  const fullScreenEvents = windowsState.mainWindow as NodeJS.EventEmitter
  fullScreenEvents.on('will-enter-full-screen', () => sendWindowStateChanged(true))
  windowsState.mainWindow.on('enter-full-screen', () => sendWindowStateChanged(true))
  fullScreenEvents.on('will-leave-full-screen', () => sendWindowStateChanged(false))
  windowsState.mainWindow.on('leave-full-screen', () => sendWindowStateChanged(false))
  windowsState.mainWindow.on('minimize', () => sendWindowStateChanged())
  windowsState.mainWindow.on('restore', () => sendWindowStateChanged())
  windowsState.mainWindow.on('hide', () => sendWindowStateChanged())
  windowsState.mainWindow.on('show', () => sendWindowStateChanged())

  // Reopen where the user left off. close is the backstop, flushed
  // synchronously before the window is gone.
  bindGeometryPersistence(windowsState.mainWindow, schedulePersistWindowState)
  windowsState.mainWindow.on('maximize', schedulePersistWindowState)
  windowsState.mainWindow.on('unmaximize', schedulePersistWindowState)
  windowsState.mainWindow.on('close', () => schedulePersistWindowState.flush())

  // the closed wrapper remains truthy, so clear only the window this callback owns.
  windowsState.mainWindow.on('closed', () => {
    wakeIndicatorController.close()

    if (windowsState.mainWindow === createdMainWindow) {
      windowsState.mainWindow = null
      // the replacement renderer must register before queued links can be delivered.
      deepLinkState._rendererReadyForDeepLink = false
    }
  })

  streamThrottle.register(windowsState.mainWindow as ThrottleWindowLike)
  wireCommonWindowHandlers(windowsState.mainWindow, zoomWiringForWindowKind('chat'))

  // Per-window renderer lifecycle diagnostics + recovery (#81290). The reload
  // policy (crashed/oom → bounded reload via the shared rolling budget, then
  // the #38216 Windows sandbox relaunch check on suppression) is the same
  // policy this window used before it moved into the shared helper, so a
  // crashed peer renderer now logs and recovers exactly like the primary one.
  installWindowRendererLifecycle(windowsState.mainWindow, {
    kind: 'main',
    callbacks: {
      log: rememberLog,
      reload: () => {
        windowsState.mainWindow?.webContents.reload()
      },
      onCrashLoopSuppressed: details => {
        // #38216 renderer flavor (same recovery as #56726, credit @Sahil-SS9):
        // a deterministic Windows renderer crash loop with the sandbox
        // breakpoint signature gets one --no-sandbox relaunch instead of a
        // dead window. Gated on the exit code so unrelated crash loops don't
        // silently drop the sandbox.
        if (
          !shouldRelaunchForRendererSandboxCrashLoop({
            reason: details?.reason,
            exitCode: details?.exitCode,
            alreadyNoSandbox:
              sandboxState.windowsSandboxFallbackActive || alreadyHasNoSandbox(process.argv, process.env),
            relaunchAttempted: sandboxState.windowsNoSandboxRelaunchAttempted
          })
        ) {
          return
        }

        sandboxState.windowsNoSandboxRelaunchAttempted = true
        sandboxState.windowsSandboxFallbackActive = true
        sandboxState.windowsSandboxFallbackSticky = true
        sandboxState.windowsSandboxFallbackReason = 'renderer-crash-loop'

        try {
          writeSandboxMarker(app.getPath('userData'), fallbackMarker('renderer-crash-loop', app.getVersion()))
        } catch {
          void 0
        }

        rememberLog('[renderer] Windows sandbox crash loop detected; relaunching once with --no-sandbox (#38216)')

        try {
          app.relaunch({ args: buildNoSandboxRelaunchArgs(process.argv.slice(1)) })
          void exitAfterBackendShutdown(0)
        } catch (err) {
          rememberLog(`[renderer] --no-sandbox relaunch failed: ${errorMessage(err) || err}`)
        }
      },
      // #95575: a renderer that repeatedly fails to load (torn bundle after
      // an update, file locked by AV, missing index.html) used to sit on a
      // white screen with only a desktop.log line. Once the bounded reload
      // budget is exhausted, put the VISIBLE error page in the window so the
      // user sees what is wrong and how to repair it.
      onFailedLoadBudgetExhausted: details => {
        rememberLog(
          `[renderer:main] load-failure budget exhausted; loading visible error page` +
            `${details?.errorCode === undefined ? '' : ` code=${String(details.errorCode)}`}`
        )
        const win = windowsState.mainWindow

        if (!win) {
          return
        }

        void loadRendererLoadErrorPage(win, {
          errorCode: details?.errorCode,
          url: details?.url,
          errorDescription: 'The desktop renderer failed to load repeatedly after the update.',
          repairHint: 'hermes desktop --force-build',
          reloadUrl: DEV_SERVER || pathToFileURL(resolveRendererIndex()).toString()
        })
      }
    },
    reloadWindowMs: RENDERER_RELOAD_WINDOW_MS,
    reloadMax: RENDERER_RELOAD_MAX,
    recentReloadTimesRef: rendererReloadTimesRef,
    reloadOnFailedLoad: true
  })

  // Electron always passes the event first. The canonical (Electron 36+) shape
  // is (event, messageDetails); the deprecated positional shape is
  // (event, level, message, line, sourceId). Handled in renderer-log.ts, which
  // every renderer-content window shares (#79428: crashes in secondary/HUD/
  // quick-entry windows used to vanish without a trace).
  attachRendererConsoleCapture(windowsState.mainWindow, 'main', rememberLog)

  // #95575: a torn renderer bundle (update replaced the app while its files
  // were locked) loads fine and then dies on the first lazy import — a white
  // screen with no error surface. resolveRendererIndex already logs the torn
  // copies; here we refuse to load one into the PRIMARY window and put the
  // visible repair page in it instead. The Reload button re-attempts the
  // bundle in case the file lock cleared since boot.
  const rendererIndex = DEV_SERVER ? null : resolveRendererIndex()
  const tornAssets = rendererIndex ? missingRendererAssets(rendererIndex) : []

  if (!DEV_SERVER && rendererIndex && tornAssets.length > 0) {
    rememberLog(
      `[renderer] primary window: chosen renderer bundle ${rendererIndex} is incomplete ` +
        `(${tornAssets.length} missing asset(s)); loading visible repair page instead of a white screen`
    )
    void loadRendererLoadErrorPage(windowsState.mainWindow, {
      errorCode: 'ERR_FILE_NOT_FOUND',
      errorDescription: `The desktop renderer bundle is incomplete after the last update (${tornAssets.length} missing file(s)).`,
      missingAssets: tornAssets,
      repairHint: 'hermes desktop --force-build',
      reloadUrl: pathToFileURL(rendererIndex).toString()
    })
  } else {
    loadWindowUrl(
      windowsState.mainWindow,
      DEV_SERVER || pathToFileURL(rendererIndex || resolveRendererIndex()).toString(),
      'Renderer'
    )
  }

  // Start the Python backend NOW, in parallel with the renderer load — not on
  // did-finish-load. The backend cold boot (spawn → port announce → /api/status)
  // is the dominant startup cost, and serializing it behind Chromium's load
  // added the whole renderer load time to first-usable-composer. The promise is
  // shared (backendConnectionState), so the renderer's getConnection() joins
  // this in-flight boot instead of duplicating it; early boot-progress events
  // the renderer misses are recovered by its getBootProgress() pull on mount.
  startHermes().catch(error => rememberLog(error.stack || error.message))

  windowsState.mainWindow.webContents.once('did-finish-load', () => {
    // Zoom restore is handled by wireCommonWindowHandlers (shared with session
    // windows); no need to reapply it here.
    broadcastBootProgress()
    sendWindowStateChanged()
  })
}
