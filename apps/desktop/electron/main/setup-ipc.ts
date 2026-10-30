/**
 * V3-ON — the Electron half of the Set up step's seam (electron/iclone-setup.ts holds every decision; this file only
 * hands it the real systemPreferences / desktopCapturer / Notification / shell).
 */
import { desktopCapturer, ipcMain, Notification, shell, systemPreferences } from 'electron'

import { consentAllows, type ConsentSenderGuard, type ConsentStore } from '../iclone-consent'
import { registerIcloneSetup, type SetupSystemSeam } from '../iclone-setup'

import { requestMicrophoneAccess } from './window-ipc'

function electronSetupSystemSeam(store: ConsentStore): SetupSystemSeam {
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

      new Notification({ title, body, silent: true }).show()

      return true
    },
    openExternal: url => shell.openExternal(url),
    consentAllows
  }
}

export function registerSetupIpc(isTrustedSender: ConsentSenderGuard, store: ConsentStore): void {
  registerIcloneSetup({
    ipcMain,
    isTrustedSender,
    system: electronSetupSystemSeam(store)
  })
}
