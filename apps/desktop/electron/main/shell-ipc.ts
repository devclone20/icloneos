// IPC: notifications, default project dir, link titles, favicons and logs.
import fs from 'node:fs'
import path from 'node:path'

import { app, dialog, ipcMain, Notification, shell } from 'electron'

import { errorMessage } from '../../src/iclone-shared/errors'
import { createEventDeduper } from '../event-dedupe'
import { consentAllows } from '../iclone-consent'
import { formatRendererBoundaryReport } from '../renderer-log'

import { fileExists } from './env'
import { fetchLinkTitle, resolveFaviconCached } from './link-metadata'
import { DESKTOP_LOG_PATH, flushDesktopLogBufferSync, hermesLog, rememberLog } from './log'
import { readDefaultProjectDir, resolveHermesCwd, sanitizeWorkspaceCwd, writeDefaultProjectDir } from './runtime'
import type { windowsState } from './state'
import { focusWindow } from './windows'

interface ShellIpcDeps {
  windowsState: typeof windowsState
}

// One deduper per cross-window cue — the choke point every window shares. Main
// handles IPC serially, so the first window to claim a key wins with no race.
const isDuplicateNotification = createEventDeduper()
const claimedAmbientCue = createEventDeduper()

export function registerShellIpc({ windowsState }: ShellIpcDeps): void {
  // A window asks "do I own this ambient cue (turn-end sound / spoken reply)?".
  // The first caller within the window gets true; peers get false and stay quiet.
  ipcMain.handle('hermes:ambient:claim', (_event, key) => !claimedAmbientCue(String(key ?? '')))

  ipcMain.handle('hermes:notify', (_event, payload) => {
    if (!Notification.isSupported() || !consentAllows('notifications')) {
      return false
    }

    // Multiple full windows each run their own renderer throttle, so the same
    // kind+session can arrive here twice. Collapse it at this single choke point.
    // Return true (not false): a notification for the event IS being shown by the
    // first caller, so the settings "send test" success probe stays honest.
    if (isDuplicateNotification(`${payload?.kind ?? ''}:${payload?.sessionId ?? payload?.tag ?? ''}`)) {
      return true
    }

    // Action buttons render only on signed macOS builds; elsewhere they're dropped
    // and the body click still works.
    const actions = Array.isArray(payload?.actions) ? payload.actions : []
    const icon = typeof payload?.icon === 'string' && payload.icon.trim() ? payload.icon.trim() : undefined

    const notification = new Notification({
      title: payload?.title || 'Hermes',
      body: payload?.body || '',
      silent: Boolean(payload?.silent),
      ...(icon ? { icon } : {}),
      actions: actions.map((action: { text?: unknown } | null | undefined) => ({
        type: 'button',
        text: String(action?.text || '')
      }))
    })

    notification.on('click', () => {
      if (!windowsState.mainWindow || windowsState.mainWindow.isDestroyed()) {
        return
      }

      focusWindow(windowsState.mainWindow)

      if (payload?.sessionId) {
        windowsState.mainWindow.webContents.send('hermes:focus-session', payload.sessionId)
      }

      // Plugin / session-less activation — serializable path (+ optional notifyId
      // for renderer callbacks). Same vocabulary as hermes://index-network/….
      if (payload?.activate || payload?.notifyId) {
        windowsState.mainWindow.webContents.send('hermes:notification-activate', {
          activate: payload?.activate,
          notifyId: payload?.notifyId,
          tag: payload?.tag
        })
      }
    })
    notification.on('action', (_actionEvent, index) => {
      if (!windowsState.mainWindow || windowsState.mainWindow.isDestroyed()) {
        return
      }

      const action = actions[index]

      if (!action?.id) {
        return
      }

      // Approvals keep the existing session-scoped channel.
      if (payload?.sessionId && !payload?.notifyId && !payload?.activate) {
        windowsState.mainWindow.webContents.send('hermes:notification-action', {
          sessionId: payload.sessionId,
          actionId: action.id
        })

        return
      }

      focusWindow(windowsState.mainWindow)
      windowsState.mainWindow.webContents.send('hermes:notification-activate', {
        actionId: action.id,
        activate: action.activate || payload?.activate,
        notifyId: payload?.notifyId,
        tag: payload?.tag
      })
    })
    notification.show()

    return true
  })

  // User-configurable default project directory. The renderer reads this on
  // settings mount and seeds the value into the picker; writing back persists
  // it via writeDefaultProjectDir so resolveHermesCwd picks it up on the next
  // session spawn (no app restart needed).
  ipcMain.handle('hermes:setting:defaultProjectDir:get', async () => ({
    dir: readDefaultProjectDir(),
    defaultLabel: app.getPath('home'),
    resolvedCwd: resolveHermesCwd()
  }))

  ipcMain.handle('hermes:workspace:sanitize', async (_event, cwd) => sanitizeWorkspaceCwd(cwd))

  ipcMain.handle('hermes:setting:defaultProjectDir:set', async (_event, dir) => {
    const next = typeof dir === 'string' && dir.trim() ? dir.trim() : null

    if (next) {
      try {
        fs.mkdirSync(next, { recursive: true })
      } catch (error) {
        throw new Error(`Could not create directory: ${errorMessage(error)}`)
      }
    }

    writeDefaultProjectDir(next)

    return { dir: next }
  })

  ipcMain.handle('hermes:setting:defaultProjectDir:pick', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose default project directory',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: readDefaultProjectDir() || app.getPath('home')
    })

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, dir: null }
    }

    return { canceled: false, dir: result.filePaths[0] }
  })

  ipcMain.handle('hermes:fetchLinkTitle', (_event, url) => fetchLinkTitle(url))

  ipcMain.handle('hermes:resolveFavicon', (_event, url) => resolveFaviconCached(url))

  ipcMain.handle('hermes:logs:reveal', async () => {
    try {
      await fs.promises.mkdir(path.dirname(DESKTOP_LOG_PATH), { recursive: true })

      if (!fileExists(DESKTOP_LOG_PATH)) {
        await fs.promises.appendFile(DESKTOP_LOG_PATH, '')
      }

      shell.showItemInFolder(DESKTOP_LOG_PATH)

      return { ok: true, path: DESKTOP_LOG_PATH }
    } catch (error) {
      return { ok: false, path: DESKTOP_LOG_PATH, error: errorMessage(error) }
    }
  })

  ipcMain.handle('hermes:logs:recent', async () => ({ path: DESKTOP_LOG_PATH, lines: hermesLog.slice(-200) }))

  // Renderer error-boundary catches (#79428 defect B): the component stack only
  // exists in renderer memory, so the boundary posts it here and we persist it
  // via the desktop.log pipeline. `on`, not `handle` — the sender may be mid-
  // crash and must not await. Flush immediately: a crashing window can be gone
  // before the debounced flush timer fires.
  ipcMain.on('hermes:logs:renderer-error', (_event, report) => {
    const { label, boundary, message, componentStack } = report && typeof report === 'object' ? report : {}
    rememberLog(formatRendererBoundaryReport(label, boundary, message, componentStack))
    flushDesktopLogBufferSync()
  })
}
