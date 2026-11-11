/**
 * The Electron half of the Screen record button (electron/screen-record.ts holds every decision; this file only hands it
 * the real desktopCapturer / systemPreferences / disk, the same way Setup registers the app in setup-ipc.ts).
 */
import { randomBytes } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'

import { app, BrowserWindow, desktopCapturer, ipcMain, screen, systemPreferences } from 'electron'

import { consentAllows, type ConsentSenderGuard } from '../iclone-consent'
import { createScreenRecorder, type ScreenCapture, type ScreenGrant, type ScreenRecorder } from '../screen-record'
import { registerTeardown } from '../teardown-registry'

import { finishRemovingFramesSync, removeFramesFolder, sweepOldFrames } from './screen-frames-removal'
import { freshScreenStatus } from './setup-ipc'
import { quitState, windowsState } from './state'

/** Enough for the dedupe to see one typed character on a 5K screen, small enough to compare at once. */
const FINGERPRINT_WIDTH = 640
export const framesRoot = () => path.join(app.getPath('userData'), 'composer-images', 'screen')

function isFrameFile(file: unknown): file is string {
  if (typeof file !== 'string' || !file.endsWith('.png')) {
    return false
  }

  const relative = path.relative(framesRoot(), path.resolve(file))

  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/** The display the app is on, at its own pixels. */
async function captureScreen(): Promise<null | ScreenCapture> {
  const win = windowsState.mainWindow
  const display = win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay()

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor)
    }
  })

  const source = sources.find(s => s.display_id === String(display.id)) ?? sources[0]
  const image = source?.thumbnail

  if (!image || image.isEmpty()) {
    return null
  }

  const small = image.resize({ width: FINGERPRINT_WIDTH, quality: 'good' })
  const { height, width } = small.getSize()

  return { fingerprint: { bytes: small.toBitmap(), height, width }, png: () => image.toPNG() }
}

async function screenGrant(): Promise<ScreenGrant> {
  if (process.platform !== 'darwin') {
    return 'granted'
  }

  const status = systemPreferences.getMediaAccessStatus('screen')

  if (status === 'granted' || status === 'restricted') {
    return status
  }

  // This process's answer is fixed at launch. A new process telling a different story is the macOS restart note.
  return (await freshScreenStatus()) === 'granted' ? 'needs-restart' : 'needs-grant'
}

export function registerScreenRecordIpc(isTrustedSender: ConsentSenderGuard): ScreenRecorder {
  const recorder = createScreenRecorder({
    capture: captureScreen,
    makeFolder: async () => {
      const folder = path.join(framesRoot(), `${new Date().toISOString().replace(/[:.]/g, '-')}_${randomBytes(3).toString('hex')}`)

      await fsp.mkdir(folder, { mode: 0o700, recursive: true })

      return folder
    },
    now: Date.now,
    onChange: status => {
      // The title bar says it in the window; with the window minimized or hidden, the Dock does.
      app.dock?.setBadge(status.recording ? 'REC' : '')

      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('iclone:screen-record:state', status)
        }
      }
    },
    removeFile: file => fsp.rm(file, { force: true }),
    removeFolder: folder => void removeFramesFolder(folder),
    screenConsent: () => consentAllows('screen'),
    screenGrant,
    schedule: (run, ms) => setTimeout(run, ms),
    cancel: handle => clearTimeout(handle as NodeJS.Timeout),
    writeFrame: async (folder, tMs, bytes) => {
      const file = path.join(folder, `screen-t${String(Math.round(tMs / 1000)).padStart(3, '0')}s.png`)

      await fsp.writeFile(file, bytes, { mode: 0o600 })

      return file
    }
  })

  const watched = new WeakSet<BrowserWindow>()

  const stopWithWindow = (event: Electron.IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)

    if (win && !watched.has(win)) {
      watched.add(win)
      // The frames wait in main: the next window this app opens picks them up.
      win.on('close', () => {
        // A quit closes the windows first: its teardown decides, and frames no one saw do not reach a closing window. The
        // quit's own mark, set only once the quit goes on: "Keep Running" leaves it down, and a window closed then stops.
        if (!quitState.quitting) {
          void recorder.stop()
        }
      })
    }
  }

  const trusted = <T>(channel: string, run: (event: Electron.IpcMainInvokeEvent, arg: unknown) => T) => {
    ipcMain.handle(channel, (event, arg) => {
      if (!isTrustedSender(event, channel)) {
        throw new Error(`${channel}: not an app window`)
      }

      return run(event, arg)
    })
  }

  trusted('iclone:screen-record:status', () => ({ ...recorder.status(), consentOn: consentAllows('screen') }))
  trusted('iclone:screen-record:start', event => {
    stopWithWindow(event)

    return recorder.start()
  })
  trusted('iclone:screen-record:stop', async () => {
    await recorder.stop()

    return recorder.status()
  })
  trusted('iclone:screen-record:take', () => recorder.takeResult())
  trusted('iclone:screen-record:discard', (_event, file) => recorder.discardFrame(String(file), isFrameFile))

  registerTeardown('screen recorder', () => recorder.shutdown())
  // After the recorder's stop: the folders its shutdown starts removing are finished here.
  registerTeardown('screen frames removal', finishRemovingFramesSync)
  void sweepOldFrames(framesRoot(), Date.now())

  return recorder
}
