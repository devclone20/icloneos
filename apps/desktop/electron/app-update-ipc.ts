/**
 * The app updater's IPC: the renderer asks for the state and the four user actions; main pushes
 * every state change to every window. Handlers take no URL or path from the renderer — the feed
 * is fixed in main.
 *
 * This file is also the wire contract the renderer imports (src/types/iclone-app-update.ts):
 * it imports nothing, so the renderer program pulls in no main-process code.
 */

export type AppUpdatePhase =
  'available' | 'checking' | 'downloaded' | 'downloading' | 'error' | 'idle' | 'inactive' | 'installing' | 'up-to-date'

export type AppUpdateErrorKind = 'blocked-runtime' | 'disk' | 'feed' | 'install' | 'location' | 'offline' | 'verify'

export interface AppUpdateProgress {
  /** Bytes received. */
  done: number
  /** Whole percent, 0–100, never moving backwards within one download. */
  percent: number
  /** Bytes in the download; 0 while the feed has not said. */
  total: number
}

export interface AppUpdateState {
  /** Epoch ms of the last answer from the feed. */
  checkedAt: null | number
  /** The running app's version as electron-updater reads it (semver, e.g. 0.0.2). */
  current: string
  /** Plain copy for the user; never a raw error string. */
  error: null | { kind: AppUpdateErrorKind; text: string }
  /** The version on offer, downloading or downloaded. */
  next: null | string
  phase: AppUpdatePhase
  progress: AppUpdateProgress | null
  /** The release page of `next`, opened by the shell. */
  releaseUrl: null | string
}

export type AppUpdateLogResult = 'failed' | 'installed' | 'installing'

/** One row of OUR per-release update log (userData/app-update-log.json). */
export interface AppUpdateLogEntry {
  /** Epoch ms of the restart that started the install. */
  at: number
  error?: string
  from: string
  result: AppUpdateLogResult
  to: string
}

type AppUpdateRestartOutcome = 'active-work' | 'blocked-runtime' | 'installing' | 'not-downloaded'

export interface AppUpdateRestartResult {
  /** With `active-work`: what a restart would interrupt, for the in-app confirm. */
  detail?: string
  outcome: AppUpdateRestartOutcome
}

/** The controller surface the handlers use (electron/iclone-app-update.ts createAppUpdate). */
interface AppUpdateControllerLike {
  cancel: () => boolean
  download: () => boolean
  restart: (options?: { confirmed?: boolean }) => AppUpdateRestartResult
  state: () => AppUpdateState
}

/** What a renderer reads when main runs no updater (dev without the lab feed, other platforms). */
export function inactiveAppUpdateState(currentVersion: string): AppUpdateState {
  return {
    checkedAt: null,
    current: currentVersion,
    error: null,
    next: null,
    phase: 'inactive',
    progress: null,
    releaseUrl: null
  }
}

export const APP_UPDATE_CHANNELS = {
  cancel: 'iclone:app-update:cancel',
  changed: 'iclone:app-update:changed',
  download: 'iclone:app-update:download',
  log: 'iclone:app-update:log',
  notice: 'iclone:app-update:notice',
  open: 'iclone:app-update:open',
  restart: 'iclone:app-update:restart',
  state: 'iclone:app-update:state'
} as const

interface IpcLike {
  handle: (channel: string, listener: (event: any, ...args: any[]) => unknown) => void
}

interface WindowLike {
  isDestroyed: () => boolean
  webContents: { isDestroyed: () => boolean; send: (channel: string, payload: unknown) => void }
}

interface AppUpdateIpcDeps {
  controller: () => AppUpdateControllerLike | null
  currentVersion: () => string
  ipcMain: IpcLike
  isTrustedSender?: (event: any, channel: string) => boolean
  /** Our update log, oldest first. */
  readLog: () => AppUpdateLogEntry[]
}

export function registerAppUpdateIpc(deps: AppUpdateIpcDeps): void {
  const trusted = (event: unknown, channel: string) => !deps.isTrustedSender || deps.isTrustedSender(event, channel)

  const handle = <T>(channel: string, fallback: T, run: (ctl: AppUpdateControllerLike, payload: unknown) => T) => {
    deps.ipcMain.handle(channel, (event, payload) => {
      if (!trusted(event, channel)) {
        throw new Error(`${channel}: untrusted sender`)
      }

      const ctl = deps.controller()

      return ctl ? run(ctl, payload) : fallback
    })
  }

  deps.ipcMain.handle(APP_UPDATE_CHANNELS.state, event => {
    if (!trusted(event, APP_UPDATE_CHANNELS.state)) {
      throw new Error(`${APP_UPDATE_CHANNELS.state}: untrusted sender`)
    }

    return deps.controller()?.state() ?? inactiveAppUpdateState(deps.currentVersion())
  })
  handle(APP_UPDATE_CHANNELS.download, false, ctl => ctl.download())
  handle(APP_UPDATE_CHANNELS.cancel, false, ctl => ctl.cancel())
  handle<AppUpdateRestartResult>(APP_UPDATE_CHANNELS.restart, { outcome: 'not-downloaded' }, (ctl, payload) =>
    ctl.restart({
      confirmed: Boolean(
        payload && typeof payload === 'object' && (payload as { confirmed?: unknown }).confirmed === true
      )
    })
  )
  deps.ipcMain.handle(APP_UPDATE_CHANNELS.log, event => {
    if (!trusted(event, APP_UPDATE_CHANNELS.log)) {
      throw new Error(`${APP_UPDATE_CHANNELS.log}: untrusted sender`)
    }

    return deps.readLog()
  })
}

/** Sends one push to every live window. */
export function broadcastToWindows(windows: () => readonly WindowLike[], channel: string, payload: unknown): number {
  let sent = 0

  for (const win of windows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload)
      sent += 1
    }
  }

  return sent
}
