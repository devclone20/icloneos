// IPC: active work, title-bar theme, native theme and translucency.
import { BrowserWindow, ipcMain, nativeTheme } from 'electron'

import { normalizeActiveWork } from '../quit-guard'
import {
  glassActive,
  normalizeState as normalizeTranslucency,
  vibrancyFor as vibrancyForTranslucency,
  windowOpacityFor
} from '../translucency'

import type { activeWorkByWebContents, updateStreamThrottleFromActiveWork } from './backend-state'
import { GLASS_SUPPORTED, TRANSLUCENCY_SUPPORTED } from './env'
import type { lateBound, windowsState } from './state'
import {
  applyTitleBarOverlay,
  applyWindowTranslucency,
  isHexColor,
  THEME_SOURCES,
  writePersistedThemeSource,
  writePersistedTranslucency
} from './theme'
import type { themeState } from './theme'

interface AppearanceIpcDeps {
  activeWorkByWebContents: typeof activeWorkByWebContents
  lateBound: typeof lateBound
  themeState: typeof themeState
  updateStreamThrottleFromActiveWork: typeof updateStreamThrottleFromActiveWork
  windowsState: typeof windowsState
}

function scheduleTranslucencyWrite({
  themeState,
  windowsState
}: Pick<AppearanceIpcDeps, 'themeState' | 'windowsState'>) {
  if (windowsState.translucencyWriteTimer) {
    clearTimeout(windowsState.translucencyWriteTimer)
  }

  windowsState.translucencyWriteTimer = setTimeout(() => {
    windowsState.translucencyWriteTimer = null
    writePersistedTranslucency(themeState.translucencyState)
  }, 250)
}

export function registerAppearanceIpc({
  activeWorkByWebContents,
  lateBound,
  themeState,
  updateStreamThrottleFromActiveWork,
  windowsState
}: AppearanceIpcDeps): void {
  ipcMain.on('hermes:active-work', (event, payload) => {
    const id = event.sender.id

    if (!activeWorkByWebContents.has(id)) {
      event.sender.once('destroyed', () => {
        activeWorkByWebContents.delete(id)
        updateStreamThrottleFromActiveWork()
      })
    }

    activeWorkByWebContents.set(id, normalizeActiveWork(payload))
    updateStreamThrottleFromActiveWork()
  })

  ipcMain.on('hermes:titlebar-theme', (_event, payload) => {
    if (!payload || !isHexColor(payload.background) || !isHexColor(payload.foreground)) {
      return
    }

    windowsState.rendererTitleBarTheme = {
      background: payload.background,
      foreground: payload.foreground
    }

    // Repaint the native (Windows/Linux) titlebar overlay on every open chat
    // window, not just the primary — instance peers and session windows share the
    // one app theme. applyTitleBarOverlay no-ops on frameless windows.
    for (const win of BrowserWindow.getAllWindows()) {
      applyTitleBarOverlay(win)
    }
  })

  // Pin the native appearance to the app theme (see NATIVE_THEME_CONFIG_PATH).
  ipcMain.on('hermes:native-theme', (_event, mode) => {
    if (!THEME_SOURCES.has(mode)) {
      return
    }

    if (nativeTheme.themeSource !== mode) {
      nativeTheme.themeSource = mode
      writePersistedThemeSource(mode)
    }
  })

  // Answered synchronously so preload can publish the verdict before the
  // renderer's first script — see the note there on why it cannot decide this
  // itself. Registered at module scope, which runs long before any window.
  ipcMain.on('hermes:translucency:support', event => {
    event.returnValue = { glass: GLASS_SUPPORTED, translucency: TRANSLUCENCY_SUPPORTED }
  })

  ipcMain.on('hermes:translucency', (_event, payload) => {
    const next = normalizeTranslucency(payload, GLASS_SUPPORTED)
    const previous = themeState.translucencyState

    if (
      next.intensity === previous.intensity &&
      next.fade === previous.fade &&
      next.mode === previous.mode &&
      next.material === previous.material &&
      next.scope === previous.scope
    ) {
      return
    }

    themeState.translucencyState = next

    // Which native properties actually moved. `scope` is renderer-only (which
    // surfaces thin), so it never appears here.
    const changed = {
      // The backing follows whether glass is ON, not the intensity behind it.
      backing: glassActive(previous) !== glassActive(next),
      material: vibrancyForTranslucency(previous) !== vibrancyForTranslucency(next),
      opacity: windowOpacityFor(previous) !== windowOpacityFor(next)
    }

    scheduleTranslucencyWrite({ themeState, windowsState })

    // The HUD's frost reads the same setting but answers on its own terms (see
    // hudFrostFor) — and it is a transparent window, so it is deliberately not
    // in the chat fan-out below. It self-diffs, so an unrelated change costs
    // nothing native.
    lateBound.hudIpc?.applyHudFrost()

    if (changed.backing || changed.material || changed.opacity) {
      for (const win of BrowserWindow.getAllWindows()) {
        applyWindowTranslucency(win, changed)
      }
    }
  })
}
