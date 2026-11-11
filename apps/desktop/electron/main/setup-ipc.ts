/**
 * V3-ON — the Electron half of the Set up step's seam (electron/iclone-setup.ts holds every decision; this file only
 * hands it the real systemPreferences / desktopCapturer / Notification / shell).
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { desktopCapturer, dialog, ipcMain, Notification, shell, systemPreferences } from 'electron'

import { consentAllows, type ConsentSenderGuard, type ConsentStore } from '../iclone-consent'
import { parseScreenPreflight, registerIcloneSetup, SCREEN_PREFLIGHT_JXA, type SetupSystemSeam } from '../iclone-setup'
import { createNotificationFailureWatch } from '../notification-failure'

import { rememberLog } from './log'
import { requestMicrophoneAccess } from './window-ipc'

// An unsigned macOS build shows no banner: the failure is logged once and the step still counts as notified.
const watchNotificationFailure = createNotificationFailureWatch(rememberLog)

/** Read-only, fixed binary, fixed script, a clean environment: nothing the renderer sends reaches this line. */
export const freshScreenStatus = () =>
  new Promise<'denied' | 'granted' | null>(resolve => {
    execFile(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', SCREEN_PREFLIGHT_JXA],
      { timeout: 4_000, env: { PATH: '/usr/bin:/bin' } },
      (error, stdout) => resolve(error ? null : parseScreenPreflight(String(stdout)))
    )
  })

/** CFBundleIdentifier from the running bundle's own Info.plist (Electron has no getter for it). */
function readAppBundleId(): string | null {
  try {
    const plist = readFileSync(path.join(path.dirname(process.execPath), '..', 'Info.plist'), 'utf8')

    return /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null
  } catch {
    return null
  }
}

function electronSetupSystemSeam(store: ConsentStore, relaunch: () => void): SetupSystemSeam {
  // Without a record to write to (policy not accepted), this run still remembers its attempt.
  let attemptedThisRun = false

  return {
    platform: process.platform,
    mediaStatus: kind => systemPreferences.getMediaAccessStatus(kind),
    // The app's one microphone request site (voice input's), so the TCC lock keeps a single known site.
    askMicrophone: () => requestMicrophoneAccess(),
    // The only way an app joins the Screen Recording list: one capture attempt. No pixels are kept (0-px thumbnails).
    attemptScreenCapture: async () => {
      await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
    },
    screenAttempted: () => attemptedThisRun || store.screenCaptureAttempted(),
    markScreenAttempted: () => {
      attemptedThisRun = true

      try {
        store.markScreenCaptureAttempt()
      } catch {
        // An unwritable consent.json: the attempt still counts for this run.
      }
    },
    showNotification: (title, body) => {
      if (!Notification.isSupported()) {
        return false
      }

      const notification = new Notification({ title, body, silent: true })

      watchNotificationFailure(notification, 'setup')
      notification.show()

      return true
    },
    openExternal: url => shell.openExternal(url),
    consentAllows,
    freshScreenStatus,
    appBundleId: readAppBundleId,
    confirmRestart: async () => {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        message: 'Restart to use Screen recording',
        detail:
          'macOS has allowed Screen recording, and applies it only when the app starts again. Anything your agent is doing now will stop.',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1
      })

      return response === 0
    },
    relaunch
  }
}

export function registerSetupIpc(isTrustedSender: ConsentSenderGuard, store: ConsentStore, relaunch: () => void): void {
  registerIcloneSetup({
    ipcMain,
    isTrustedSender,
    system: electronSetupSystemSeam(store, relaunch)
  })
}
