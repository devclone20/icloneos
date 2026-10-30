// IPC: window actions, zoom, quick entry, find-in-page, previews and display state.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { app, BrowserWindow, ipcMain, powerSaveBlocker, systemPreferences } from 'electron'

import { errorMessage } from '../../src/iclone-shared/errors'
import {
  buildTerminalScript,
  resolveTerminalLaunch,
  terminalScriptEnv,
  terminalScriptExtension,
  tuiResumeArgs
} from '../external-terminal'
import { installFoundInPageForwarder, performFindAfterIndexingStarted, stopFind } from '../find-in-page'
import { consentAllows, withScreenDeclined } from '../iclone-consent'
import { microphoneAccess } from '../iclone-setup'
import { createAppSenderGuard } from '../ipc-sender-guard'
import { createKeepAwake } from '../power-save'
import { sanitizeQuickEntrySettings } from '../quick-entry'
import { readWindowBelow } from '../window-below'
import { DEFAULT_ZOOM_LEVEL, percentToZoomLevel, zoomLevelToPercent } from '../zoom'

import { reachablePreviewUrl } from './backend-routing'
import { DEV_SERVER, HERMES_HOME, IS_MAC, REMOTE_DISPLAY_REASON } from './env'
import { findOnPath } from './executables'
import { prepareHermesSpawn } from './iclone-gate'
import { rememberLog } from './log'
import {
  applyQuickEntrySettings,
  hideQuickEntryWindow,
  quickEntryShortcut,
  readQuickEntrySettings,
  writeQuickEntrySettings
} from './quick-entry'
import { resolveRendererIndex, sanitizeWorkspaceCwd } from './runtime'
import { openExternalUrl, openPreviewInBrowser } from './shell-open'
import type { connectionRuntimeState, windowsState } from './state'
import { resolveHermesBackend } from './updates'
import { setAndPersistZoomLevel } from './window-events'
import { createBrowserWindow, createInstanceWindow, createSessionWindow, wakeIndicatorController } from './windows'

interface WindowIpcDeps {
  connectionRuntimeState: typeof connectionRuntimeState
  windowsState: typeof windowsState
}

let previewShortcutActive = false

// Keep-awake: hold the machine awake for long/overnight runs. Main owns the one
// blocker and its persisted state so a cold launch restores it (applied on
// ready — powerSaveBlocker needs the app ready). The renderer toggles it from
// Settings → Advanced over IPC. See store/keep-awake.
const KEEP_AWAKE_CONFIG_PATH = path.join(app.getPath('userData'), 'keep-awake.json')
export const keepAwake = createKeepAwake(powerSaveBlocker)

export function readPersistedKeepAwake() {
  try {
    return JSON.parse(fs.readFileSync(KEEP_AWAKE_CONFIG_PATH, 'utf8')).on === true
  } catch {
    return false
  }
}

// Disable F12 DevTools: maintained in the main process so a cold launch
// restores it before any window is shown (applied on ready). The renderer
// toggles it from Settings → Advanced over IPC. See store/disable-f12.
const DISABLE_F12_CONFIG_PATH = path.join(app.getPath('userData'), 'disable-f12.json')

export function readPersistedDisableF12() {
  try {
    return JSON.parse(fs.readFileSync(DISABLE_F12_CONFIG_PATH, 'utf8')).on === true
  } catch {
    return false
  }
}

// ── Find-in-page (Ctrl/Cmd+F) ─────────────────────────────────────────────
// The desktop supports multiple BrowserWindows (one primary plus any
// per-session secondary windows spawned via `hermes:window:openSession`).
// Find must run against the requesting window, not a global — otherwise
// Cmd+F pressed in a secondary session window would search the primary
// and the match counter would report matches the user can't see. Resolve
// the sender through `BrowserWindow.fromWebContents(event.sender)` and
// forward `found-in-page` results back to that same sender.

// Lazily-installed forwarder per sender webContents. We track one
// uninstall fn per webContents id and prune entries when the sender goes
// away — Electron does not auto-detach webContents listeners on close,
// so the map is the cleanup path.
const foundInPageForwarders = new Map<number, () => void>()

function ensureFoundInPageForwarder(sender: Electron.WebContents): void {
  if (foundInPageForwarders.has(sender.id)) {
    return
  }

  const uninstall = installFoundInPageForwarder(sender)
  foundInPageForwarders.set(sender.id, uninstall)

  sender.once('destroyed', () => {
    foundInPageForwarders.get(sender.id)?.()
    foundInPageForwarders.delete(sender.id)
  })
}

/**
 * The app's one microphone request (the TCC lock's known site): voice input, and the Set up step's Microphone row
 * (V3-ON) — both on the user's own click. Switched OFF in the consent sheet / Settings › Privacy: declined without
 * asking macOS; already granted (V3-ON, ON-4): answered without calling macOS at all.
 */
export function requestMicrophoneAccess(): Promise<boolean> {
  return microphoneAccess({
    consentOn: consentAllows('microphone'),
    mac: IS_MAC && typeof systemPreferences.askForMediaAccess === 'function',
    status: () => systemPreferences.getMediaAccessStatus('microphone'),
    ask: () => systemPreferences.askForMediaAccess('microphone')
  })
}

export function registerWindowIpc({ connectionRuntimeState, windowsState }: WindowIpcDeps): void {
  ipcMain.handle('hermes:get-remote-display-reason', () => REMOTE_DISPLAY_REASON)

  // Renderer-side battery gating seeds from this and stays current via the
  // 'hermes:power-battery' push below.
  ipcMain.handle('hermes:power-battery:get', () => connectionRuntimeState.onBatteryPower === true)

  ipcMain.handle('hermes:window:openSession', async (_event, sessionId, opts) => {
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      return { ok: false, error: 'invalid-session-id' }
    }

    createSessionWindow(sessionId.trim(), { watch: opts?.watch === true })

    return { ok: true }
  })
  ipcMain.handle('hermes:window:openInstance', async () => {
    createInstanceWindow()

    return { ok: true }
  })
  ipcMain.handle('hermes:window:openBrowser', async (_event, tabId) => {
    if (typeof tabId !== 'string' || !tabId.trim()) {
      return { ok: false, error: 'invalid-tab-id' }
    }

    createBrowserWindow(tabId.trim())

    return { ok: true }
  })

  // Hand a session to the user's OWN terminal emulator, running the TUI against
  // it (`hermes --tui --resume <id>`). Not the in-app terminal pane: the point is
  // to continue the chat in the terminal they already live in.
  //
  // The desktop's runtime is usually a venv Python invoked as
  // `python -m hermes_cli.main`, so we resolve the SAME backend the app itself
  // launches and carry its argv + PYTHONPATH into a launcher script rather than
  // hoping a `hermes` exists on the user's interactive PATH. Resolution only —
  // never ensureRuntime(), which would kick off a first-run install from a menu
  // click; an unresolved runtime is reported instead.
  ipcMain.handle('hermes:window:openInTerminal', async (_event, sessionId, opts) => {
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      return { ok: false, error: 'invalid-session-id' }
    }

    try {
      const profile = typeof opts?.profile === 'string' ? opts.profile.trim() : ''
      const backend = resolveHermesBackend(tuiResumeArgs(sessionId.trim(), profile || undefined))

      if (!backend.command) {
        return { ok: false, error: 'Hermes is not installed yet' }
      }

      const { cwd } = sanitizeWorkspaceCwd(opts?.cwd)
      // V3-S r2 (M1): every app-launched Hermes goes through the gate's spawn preparation. A TUI in the user's own
      // terminal app cannot receive its permission key, so this refuses (`[iclone-gate]`, caught below) and no
      // launcher script is written or run.
      await prepareHermesSpawn({ backend, cwd, profile: profile || null, role: 'external-terminal' })
      const scriptDir = path.join(app.getPath('userData'), 'open-in-terminal')
      fs.mkdirSync(scriptDir, { recursive: true })

      const scriptPath = path.join(
        scriptDir,
        `hermes-${crypto.randomBytes(6).toString('hex')}${terminalScriptExtension()}`
      )

      fs.writeFileSync(
        scriptPath,
        buildTerminalScript({
          args: backend.args,
          command: backend.command,
          cwd,
          env: terminalScriptEnv(backend.env, HERMES_HOME)
        }),
        { mode: 0o700 }
      )

      const launch = resolveTerminalLaunch({ findOnPath, scriptPath })

      if (!launch) {
        return { ok: false, error: 'No terminal emulator found' }
      }

      rememberLog(`[terminal] opening session ${sessionId} via ${launch.command}`)

      // Detached + unref'd: the terminal window outlives the desktop app, and
      // never inherits our stdio (a closed pipe would kill the TUI).
      const child = spawn(launch.command, launch.args, { detached: true, stdio: 'ignore' })
      child.unref()

      return { ok: true }
    } catch (error) {
      rememberLog(`[terminal] open in terminal failed: ${errorMessage(error)}`)

      return { ok: false, error: errorMessage(error) }
    }
  })
  ipcMain.handle('hermes:wake-indicator:get', () => wakeIndicatorController.getState())
  ipcMain.on('hermes:wake-indicator:set', (_event, state) => {
    wakeIndicatorController.setState(state)
  })

  // --- Text size (zoom) -------------------------------------------------------
  // The settings UI drives the same clamped zoom scale as the Ctrl/Cmd
  // shortcuts and the View menu. Reads and writes target the asking window.
  ipcMain.handle('hermes:zoom:get', event => {
    const window = BrowserWindow.fromWebContents(event.sender)

    const level = window && !window.isDestroyed() ? window.webContents.getZoomLevel() : DEFAULT_ZOOM_LEVEL

    return { level, percent: zoomLevelToPercent(level) }
  })
  ipcMain.on('hermes:zoom:set-percent', (event, percent) => {
    const window = BrowserWindow.fromWebContents(event.sender)

    if (!window || window.isDestroyed()) {
      return
    }

    setAndPersistZoomLevel(window, percentToZoomLevel(Number(percent)))
  })

  ipcMain.on('hermes:previewShortcutActive', (_event, active) => {
    previewShortcutActive = Boolean(active)
  })

  ipcMain.handle('hermes:requestMicrophoneAccess', requestMicrophoneAccess)

  // read_window_below tool: which OS window is directly underneath this one.
  // Metadata only (app, title, bounds) — never pixels. On macOS, other apps'
  // window titles are gated behind the Screen Recording permission; pass titles
  // through only when it is ALREADY granted, and never prompt for it here.
  ipcMain.handle('hermes:window:readBelow', async event => {
    const win = BrowserWindow.fromWebContents(event.sender)

    if (!win || win.isDestroyed()) {
      return null
    }

    const titlesConsented = consentAllows('screen')

    const titlesAvailable =
      titlesConsented && (IS_MAC ? systemPreferences.getMediaAccessStatus?.('screen') === 'granted' : true)

    const [x, y] = win.getPosition()
    const [width, height] = win.getSize()
    const below = await readWindowBelow(process.pid, { x, y, width, height }, titlesAvailable)

    return titlesConsented ? below : withScreenDeclined(below)
  })

  ipcMain.on('hermes:keep-awake', (_event, on) => {
    const enabled = Boolean(on)
    keepAwake.set(enabled)

    try {
      fs.mkdirSync(path.dirname(KEEP_AWAKE_CONFIG_PATH), { recursive: true })
      fs.writeFileSync(KEEP_AWAKE_CONFIG_PATH, JSON.stringify({ on: enabled }, null, 2), 'utf8')
    } catch (error) {
      rememberLog(`[keep-awake] write failed: ${errorMessage(error)}`)
    }
  })

  // Quick Entry: the renderer reads the live registration state on settings mount
  // and writes the preference back. Main is authoritative — it owns the OS
  // accelerator — so both handlers return the state that ACTUALLY resulted,
  // including `registered: false` + `error: 'taken'` when another app owns the
  // chord. See electron/quick-entry.ts + store/quick-entry.
  ipcMain.handle('hermes:quick-entry:settings:get', async () => {
    const settings = readQuickEntrySettings()
    const state = quickEntryShortcut.current()

    // Ground truth is what the last apply produced; the shortcut we report is the
    // live one (a saved-but-rejected chord still shows what the user asked for).
    return {
      enabled: settings.enabled,
      error: state.error,
      registered: state.registered,
      shortcut: settings.enabled ? state.shortcut : settings.shortcut
    }
  })

  ipcMain.handle('hermes:quick-entry:settings:set', async (_event, patch) => {
    const current = readQuickEntrySettings()

    const next = sanitizeQuickEntrySettings({
      enabled: patch?.enabled === undefined ? current.enabled : patch.enabled === true,
      shortcut: typeof patch?.shortcut === 'string' && patch.shortcut.trim() ? patch.shortcut : current.shortcut
    })

    writeQuickEntrySettings(next)

    return applyQuickEntrySettings(next)
  })

  // Quick window → main → PRIMARY renderer. We never submit here: the renderer
  // owns the one prompt-submit path, and forwarding keeps it that way. The
  // payload is `{ target, text }` — target routing (current chat / a picked
  // session / new) is the renderer's job too.
  ipcMain.on('hermes:quick-entry:submit', (_event, payload) => {
    hideQuickEntryWindow()

    const text = typeof payload?.text === 'string' ? payload.text.trim() : ''

    if (!text) {
      return
    }

    if (!windowsState.mainWindow || windowsState.mainWindow.isDestroyed()) {
      rememberLog('[quick-entry] dropped a submit: no primary window to route it to')

      return
    }

    // Deliberately does NOT raise/focus the main window — the user asked to fire
    // a prompt from wherever they were, not to be yanked into the app.
    windowsState.mainWindow.webContents.send('hermes:quick-entry:submit', {
      target: typeof payload?.target === 'string' && payload.target ? payload.target : 'current',
      text
    })
  })

  // Primary renderer → main → quick window: gateway connection state + the
  // recent-session list for the target picker. Cached so a quick window spawned
  // AFTER the last push still boots from truth instead of "disconnected".
  ipcMain.on('hermes:quick-entry:state', (_event, payload) => {
    windowsState.quickEntryLastState = payload ?? null

    if (windowsState.quickEntryWindow && !windowsState.quickEntryWindow.isDestroyed()) {
      windowsState.quickEntryWindow.webContents.send('hermes:quick-entry:state', payload)
    }
  })

  ipcMain.on('hermes:quick-entry:dismiss', () => hideQuickEntryWindow())

  ipcMain.on('hermes:devtools:disable-f12', (_event, on) => {
    windowsState.f12Blocked = Boolean(on)

    try {
      fs.mkdirSync(path.dirname(DISABLE_F12_CONFIG_PATH), { recursive: true })
      fs.writeFileSync(DISABLE_F12_CONFIG_PATH, JSON.stringify({ on: windowsState.f12Blocked }, null, 2), 'utf8')
    } catch (error) {
      rememberLog(`[disable-f12] write failed: ${errorMessage(error)}`)
    }
  })

  // X1b: opening something in the OS is the app document's call alone (the preload's link router, the renderer's
  // openExternalLink) — never a guest, a sub-frame or another page. Window requests no longer reach the OS at all
  // (app-window-open-policy.ts), so this channel is the only door and it checks who knocks.
  const isAppDocument = createAppSenderGuard({
    devServer: DEV_SERVER,
    rendererIndexPath: resolveRendererIndex,
    log: rememberLog
  })

  ipcMain.handle('hermes:openExternal', (event, url) => {
    if (!isAppDocument(event, 'hermes:openExternal')) {
      throw new Error('Refused: not the app window')
    }

    if (!openExternalUrl(url)) {
      throw new Error('Invalid external URL')
    }
  })

  ipcMain.handle('hermes:find-in-page', async (event, query, options) => {
    const win = BrowserWindow.fromWebContents(event.sender)

    if (!win || win.isDestroyed()) {
      return { count: 0 }
    }

    ensureFoundInPageForwarder(event.sender)
    await performFindAfterIndexingStarted(win.webContents, query, options)

    // The match count still arrives asynchronously via `found-in-page`; this
    // reply only acknowledges that Chromium has begun returning this request.
    return { count: 0 }
  })

  ipcMain.handle('hermes:stop-find-in-page', event => {
    const win = BrowserWindow.fromWebContents(event.sender)

    if (!win || win.isDestroyed()) {
      return
    }

    stopFind(win.webContents)
  })

  // The renderer can't know whether a loopback URL is reachable — only main
  // knows which transport backs this gateway. Ask before loading one.
  ipcMain.handle('hermes:preview:reach', async (event, url) => reachablePreviewUrl(event.sender.id, String(url || '')))

  ipcMain.handle('hermes:openPreviewInBrowser', async (event, url) => {
    if (!isAppDocument(event, 'hermes:openPreviewInBrowser')) {
      throw new Error('Refused: not the app window')
    }

    if (!(await openPreviewInBrowser(url))) {
      throw new Error('Invalid preview URL')
    }
  })
}
