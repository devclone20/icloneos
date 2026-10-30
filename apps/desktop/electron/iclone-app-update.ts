/**
 * iclone-app-update.ts
 *
 * The signed app's own update path (electron-updater, GitHub provider on the
 * public releases repo) and the release-facing identity around it: the one
 * version line every surface shows, the About copyright, the deep-link scheme
 * and the first-launch move to /Applications.
 *
 * One state machine (`createAppUpdate`) lives in main and is pushed to every
 * window (`emit`); the renderer draws the notification toast, the Settings →
 * Updates page and About's button from it. Nothing downloads or installs
 * without a click (P7), and the restart is the app's own quitAndInstall.
 *
 * Two updaters touch this install: this one replaces the .app bundle, the
 * runtime alignment (R1) moves the Hermes checkout under HERMES_HOME. They
 * never run at once — no quitAndInstall while the runtime's update marker is
 * live, and no runtime hand-off while an app update is downloading or
 * downloaded (`blocksRuntimeHandoff`).
 *
 * Nothing here imports electron or electron-updater: main.ts passes them in,
 * so every rule is unit-tested against fakes.
 */

import fs from 'node:fs'
import path from 'node:path'

import type { AppUpdater } from 'electron-updater'

import { errorMessage } from '../src/iclone-shared/errors'
import { formatBytes } from '../src/iclone-shared/format'
import { asFiniteNumber } from '../src/iclone-shared/guards'
import { PUBLIC_REPOSITORY, releaseTagUrl } from '../src/iclone-shared/public-repo'
import { displayVersion } from '../src/iclone-shared/version'

import type {
  AppUpdateErrorKind,
  AppUpdateLogEntry,
  AppUpdatePhase,
  AppUpdateProgress,
  AppUpdateRestartResult,
  AppUpdateState
} from './app-update-ipc'

/** String literals survive bundling (comments do not); the release gate looks for this tag. */
export const APP_UPDATE_LOG_TAG = '[iclone-app-update]'

/**
 * The feed electron-updater reads for a darwin build of this app (from 0.0.3: the public full-release repo, and only it).
 * The feed itself comes from build.publish in package.json (app-update.yml); this string is what the log names, and a test pins the two equal.
 */
export const APP_UPDATE_FEED = `github:${PUBLIC_REPOSITORY}/latest-mac.yml`

export const APP_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Download progress reaches the windows at most 4 times a second (with margin for IPC jitter). */
export const APP_UPDATE_PROGRESS_MIN_MS = 300

/** Squirrel.Mac runs only inside quitAndInstall(): an app still alive this long after it did not install. */
export const APP_UPDATE_INSTALL_WATCHDOG_MS = 90_000

/** Owner test hook (contract decision 9): the only update env var a packaged build honours. */
export const PRERELEASE_ENV = 'ICLONE_UPDATE_ALLOW_PRERELEASE'

export const APP_COPYRIGHT = 'Copyright © 2026 CLONE FRAME · built on Hermes by Nous Research'

interface CancelToken {
  cancel: () => void
}

export interface UpdaterLike {
  allowDowngrade: boolean
  allowPrerelease: boolean
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  checkForUpdates: () => Promise<unknown>
  downloadUpdate: (token?: any) => Promise<unknown>
  on: (...args: Parameters<AppUpdater['on']>) => unknown
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void
}

type AppUpdateNotice = 'available' | 'restart'

interface AppUpdateDeps {
  /** What a restart would interrupt right now (a turn in flight), or null. */
  activeWork?: () => null | string
  /** electron-updater's CancellationToken; without it a download cannot be cancelled. */
  createCancelToken?: () => CancelToken
  /** The running app's version (app.getVersion()). */
  currentVersion: string
  /** Every state change, for the windows. */
  emit?: (state: AppUpdateState) => void
  env: Record<string, string | undefined>
  /** False when this build ships no electron-updater feed (no app-update.yml): no check, no timer. */
  hasFeed?: () => boolean
  /** The last row of our update log, to report a restart that did not install. */
  lastInstall?: AppUpdateLogEntry | null
  log: (line: string) => void
  /** A system notification; main applies the consent gate. */
  notify?: (notice: AppUpdateNotice, version: string) => void
  now?: () => number
  /** Our update log: the `installing` row when a restart begins an install, its `failed` row if the app survives it. */
  onInstall?: (entry: AppUpdateLogEntry) => void
  /** Brings a window to Settings → Updates; false when there is no window to show it in. */
  reveal?: () => boolean
  /** True while the runtime updater's HERMES_HOME marker is live. */
  runtimeUpdateInFlight: () => boolean
  timers?: {
    clearInterval: (handle: any) => void
    clearTimeout?: (handle: any) => void
    setInterval: (fn: () => void, ms: number) => any
    setTimeout?: (fn: () => void, ms: number) => any
  }
  updater: UpdaterLike
  /** True when one of the app's windows has focus (no second notification then). */
  windowFocused?: () => boolean
}

/** What a user-started check (menu, About) found. */
type ManualCheckOutcome =
  'available' | 'blocked-runtime' | 'downloaded' | 'downloading' | 'error' | 'inactive' | 'installing' | 'up-to-date'

interface ManualCheckResult {
  error?: string
  outcome: ManualCheckOutcome
  version: null | string
}

export interface AppUpdateController {
  blocksRuntimeHandoff: () => boolean
  cancel: () => boolean
  check: () => Promise<void>
  /** A check whenever the last answer is older than the 6-hour cadence (power resume). */
  checkIfStale: () => void
  /** A user-started check, reporting what it found. Never prompts. */
  checkNow: () => Promise<ManualCheckResult>
  /** True exactly once after `restart` began an install: the quit it triggers skips the active-work prompt. */
  consumeInstallLatch: () => boolean
  download: () => boolean
  hasFeed: () => boolean
  restart: (options?: { confirmed?: boolean }) => AppUpdateRestartResult
  reveal: () => boolean
  start: () => void
  state: () => AppUpdateState
  stop: () => void
}

interface NotificationLike {
  // Two call signatures, not one union parameter: Electron's Notification.on is a set of overloads whose FIRST is
  // 'action', and a single-signature target is checked against that one — so the union form rejects the real
  // Notification under strict. Overloads describe exactly the two events we subscribe to.
  on: {
    (event: 'click', listener: () => void): unknown
    (event: 'close', listener: () => void): unknown
  }
  show: () => void
}

interface AppUpdateNotifierDeps {
  /** The OS supports notifications and the user's consent allows them. */
  allowed: () => boolean
  create: (options: { body: string; title: string }) => NotificationLike
  log: (line: string) => void
  /** A click brings a window to Settings → Updates. */
  reveal: () => void
}

/** The system notification for each notice. */
export function createAppUpdateNotifier(deps: AppUpdateNotifierDeps) {
  // A notification nobody references can be collected before it is clicked: each one is held until it closes.
  const held = new Set<NotificationLike>()

  const notify = (notice: AppUpdateNotice, version: string) => {
    const allowed = deps.allowed()
    deps.log(`${APP_UPDATE_LOG_TAG} notification ${notice} ${version} (${allowed ? 'shown' : 'not allowed'})`)

    if (!allowed) {
      return
    }

    const shown = displayVersion(version)

    const notification = deps.create(
      notice === 'available'
        ? { body: 'Open Settings → Updates to update.', title: `iclone os v${shown} is ready to download` }
        : { body: `iclone os v${shown} is downloaded and ready to install.`, title: 'Restart to finish updating' }
    )

    const release = () => held.delete(notification)
    held.add(notification)
    notification.on('click', () => {
      release()
      deps.reveal()
    })
    notification.on('close', release)
    notification.show()
  }

  return { held: () => held.size, notify }
}

/** No runtime hand-off while an app bundle is on its way in. */
export function appUpdateBlocksRuntimeHandoff(phase: AppUpdatePhase): boolean {
  return phase === 'downloading' || phase === 'downloaded' || phase === 'installing'
}

/** No bundle swap while the runtime updater owns the install. */
export function runtimeMarkerBlocksAppInstall(runtimeUpdateInFlight: boolean): boolean {
  return runtimeUpdateInFlight
}

function infoField(info: unknown, key: string): unknown {
  return info && typeof info === 'object' ? (info as Record<string, unknown>)[key] : undefined
}

function versionOf(info: unknown): null | string {
  const v = infoField(info, 'version')

  return typeof v === 'string' && v ? v : null
}

function sizeOf(info: unknown): number {
  const files = infoField(info, 'files')
  const first = Array.isArray(files) ? (files[0] as unknown) : undefined
  const size = infoField(first, 'size')

  return typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : 0
}

function errorCode(err: unknown): string {
  const code = infoField(err, 'code')

  return typeof code === 'string' ? code : ''
}

const HTTP_STATUS = /\bHttpError: (\d{3})\b/
const LATEST_RELEASE_WRAPPER = /Unable to find latest version on GitHub/

/**
 * GitHub has no `releases/latest` until a FULL (non-pre-release) release exists: that is "up to date".
 * Measured 2026-10-18 on the real feed: electron-updater 6.8.9 wraps it as ERR_UPDATER_INVALID_RELEASE_FEED
 * "Cannot parse releases feed: … Unable to find latest version on GitHub … HttpError: 406". The same wrapper
 * carries every other releases/latest failure (403 rate limit, 429, 5xx): only 404 and that 406 mean "none yet".
 */
export function isNoFullRelease(err: unknown): boolean {
  // Offline wraps in the same "Unable to find latest version" sentence: only an answer from GitHub counts.
  if (classifyAppUpdateError(err) === 'offline') {
    return false
  }

  const message = errorMessage(err)
  const status = HTTP_STATUS.exec(message)?.[1]

  if (status === undefined) {
    // A feed GitHub served and electron-updater parsed, listing no version at all.
    return errorCode(err) === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' || /No published versions on GitHub/.test(message)
  }

  return status === '404' || (status === '406' && LATEST_RELEASE_WRAPPER.test(message))
}

const OFFLINE_CODES = new Set(['EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'ENOTFOUND', 'ETIMEDOUT'])

export function classifyAppUpdateError(err: unknown): Exclude<AppUpdateErrorKind, 'blocked-runtime' | 'install'> {
  const code = errorCode(err)
  const message = errorMessage(err)

  if (code === 'ENOSPC' || /ENOSPC|no space left/i.test(message)) {
    return 'disk'
  }

  if (
    OFFLINE_CODES.has(code) ||
    /net::ERR_|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|getaddrinfo/i.test(message)
  ) {
    return 'offline'
  }

  if (/sha512|checksum|code signature|not signed|signature/i.test(message)) {
    return 'verify'
  }

  if (/translocat|read-only (?:volume|file system)|Applications folder/i.test(message)) {
    return 'location'
  }

  return 'feed'
}

/** The plain sentence a user reads for each failure; never a raw error and never "unknown". */
export function appUpdateErrorText(kind: AppUpdateErrorKind, current: string, size = 0): string {
  const still = `You're still on v${displayVersion(current)}.`

  switch (kind) {
    case 'offline':
      return "Can't reach the update server. iclone os will try again in 6 hours."

    case 'feed':
      return "The update server didn't answer as expected. Try again later."

    case 'verify':
      return `The download couldn't be verified, so nothing was installed. ${still}`

    case 'disk':
      return size > 0
        ? `Not enough free space to download the update (${formatBytes(size, { base: 1000, maxUnit: 'GB', minUnit: 'MB' })} needed).`
        : 'Not enough free space to download the update.'

    case 'location':
      return 'Move iclone os to Applications to install updates.'

    case 'blocked-runtime':
      return 'Finishing a runtime update first — restart will be offered next.'

    case 'install':
      return `The update didn't install. ${still} Try again.`
  }
}

function isCancellation(err: unknown): boolean {
  return infoField(err, 'name') === 'CancellationError' || errorMessage(err) === 'cancelled'
}

function progressOf(raw: unknown, previous: AppUpdateProgress | null, fallbackTotal: number): AppUpdateProgress {
  const positive = (key: string) => Math.max(0, asFiniteNumber(infoField(raw, key)) ?? 0)
  const percent = Math.min(100, Math.max(previous?.percent ?? 0, Math.floor(positive('percent'))))

  return {
    done: Math.max(previous?.done ?? 0, positive('transferred')),
    percent,
    total: positive('total') || fallbackTotal
  }
}

export function createAppUpdate(deps: AppUpdateDeps): AppUpdateController {
  const { updater, log } = deps
  const timers = deps.timers ?? { clearInterval, setInterval }
  const setLater = deps.timers?.setTimeout ?? setTimeout
  const clearLater = deps.timers?.clearTimeout ?? clearTimeout
  const now = deps.now ?? Date.now
  const allowPrerelease = deps.env[PRERELEASE_ENV] === '1'
  const hasFeed = () => (deps.hasFeed ? deps.hasFeed() : true)
  const current = deps.currentVersion
  const notified = new Set<string>()
  let timer: any = null
  let feedSkipped = false
  let size = 0
  let token: CancelToken | null = null
  let cancelRequested = false
  let installLatch = false
  let installWatchdog: any = null
  let lastPushAt = 0

  const failedInstall = deps.lastInstall?.result === 'failed'

  let state: AppUpdateState = {
    checkedAt: null,
    current,
    error: failedInstall ? { kind: 'install', text: appUpdateErrorText('install', current) } : null,
    next: null,
    phase: failedInstall ? 'error' : 'idle',
    progress: null,
    releaseUrl: null
  }

  const snapshot = (): AppUpdateState => ({ ...state, progress: state.progress ? { ...state.progress } : null })

  const set = (patch: Partial<AppUpdateState>, push = true) => {
    state = { ...state, ...patch }

    if (push) {
      lastPushAt = now()
      deps.emit?.(snapshot())
    }
  }

  const releaseUrl = releaseTagUrl
  const busy = () => appUpdateBlocksRuntimeHandoff(state.phase)

  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.allowDowngrade = false
  updater.allowPrerelease = allowPrerelease
  log(`${APP_UPDATE_LOG_TAG} feed ${APP_UPDATE_FEED}; autoDownload off; checks every 6 h`)

  if (allowPrerelease) {
    log(`${APP_UPDATE_LOG_TAG} ${PRERELEASE_ENV}=1: pre-releases on the signed feed are offered`)
  }

  const failCheck = (err: unknown) => {
    if (isNoFullRelease(err)) {
      log(`${APP_UPDATE_LOG_TAG} feed has no full release; up to date`)
      set({ checkedAt: now(), error: null, next: null, phase: 'up-to-date' })

      return
    }

    const kind = classifyAppUpdateError(err)
    log(`${APP_UPDATE_LOG_TAG} check failed (${kind}): ${errorMessage(err)}`)
    set({ error: { kind, text: appUpdateErrorText(kind, current, size) }, phase: 'error' })
  }

  const failDownload = (err: unknown) => {
    token = null

    if (cancelRequested || isCancellation(err)) {
      cancelRequested = false
      log(`${APP_UPDATE_LOG_TAG} download cancelled`)
      set({ error: null, phase: state.next ? 'available' : 'idle', progress: null })

      return
    }

    const kind = classifyAppUpdateError(err)
    log(`${APP_UPDATE_LOG_TAG} download failed (${kind}): ${errorMessage(err)}`)
    set({ error: { kind, text: appUpdateErrorText(kind, current, size) }, phase: 'error', progress: null })
  }

  const clearInstallWatchdog = () => {
    if (installWatchdog) {
      clearLater(installWatchdog)
      installWatchdog = null
    }
  }

  // The app is still running after quitAndInstall: Squirrel refused the bundle, or the quit never came.
  const failInstall = (err: unknown) => {
    installLatch = false
    clearInstallWatchdog()
    const kind = classifyAppUpdateError(err) === 'verify' ? 'verify' : 'install'
    const text = appUpdateErrorText(kind, current)
    log(`${APP_UPDATE_LOG_TAG} install of ${state.next} failed (${kind}): ${errorMessage(err)}`)
    set({ error: { kind, text }, phase: 'error', progress: null })

    if (state.next) {
      deps.onInstall?.({ at: now(), error: errorMessage(err), from: current, result: 'failed', to: state.next })
    }
  }

  const blockedError = () => ({
    kind: 'blocked-runtime' as const,
    text: appUpdateErrorText('blocked-runtime', current)
  })

  updater.on('checking-for-update', () => {
    if (!busy() && state.phase !== 'checking') {
      set({ error: null, phase: 'checking' })
    }
  })
  updater.on('update-not-available', () => {
    if (!busy()) {
      set({ checkedAt: now(), error: null, next: null, phase: 'up-to-date', releaseUrl: null })
    }
  })
  updater.on('update-available', (info: unknown) => {
    const version = versionOf(info)

    if (!version || (busy() && state.next === version)) {
      return
    }

    size = sizeOf(info)
    log(`${APP_UPDATE_LOG_TAG} ${version} available`)
    set({
      checkedAt: now(),
      error: null,
      next: version,
      phase: 'available',
      progress: null,
      releaseUrl: releaseUrl(version)
    })

    if (!notified.has(version)) {
      notified.add(version)
      deps.notify?.('available', version)
    }
  })
  updater.on('download-progress', (raw: unknown) => {
    if (state.phase !== 'downloading') {
      return
    }

    const previous = state.progress
    const progress = progressOf(raw, previous, size)
    const moved = progress.percent !== (previous?.percent ?? -1)
    // The throttle never swallows the last step: the bar shows 100 % before "Restart to update".
    const due = progress.percent >= 100 || now() - lastPushAt >= APP_UPDATE_PROGRESS_MIN_MS
    set({ progress }, moved && due)
  })
  updater.on('update-downloaded', (info: unknown) => {
    const version = versionOf(info) ?? state.next
    token = null
    log(`${APP_UPDATE_LOG_TAG} ${version} downloaded and verified`)
    const total = state.progress?.total || size
    set({
      error: deps.runtimeUpdateInFlight() ? blockedError() : null,
      next: version,
      phase: 'downloaded',
      progress: { done: total, percent: 100, total }
    })

    if (version && !(deps.windowFocused?.() ?? false)) {
      deps.notify?.('restart', version)
    }
  })
  updater.on('error', (err: unknown) => {
    if (state.phase === 'downloading') {
      failDownload(err)
    } else if (state.phase === 'checking') {
      failCheck(err)
    } else if (state.phase === 'installing') {
      failInstall(err)
    } else {
      // A failed check must not forget a bundle that is already downloaded.
      log(`${APP_UPDATE_LOG_TAG} error (${state.phase}): ${errorMessage(err)}`)
    }
  })

  const check = async () => {
    if (!hasFeed()) {
      set({ phase: 'inactive' })

      return
    }

    if (busy()) {
      if (state.phase === 'downloaded') {
        set({ error: deps.runtimeUpdateInFlight() ? blockedError() : null })
      }

      return
    }

    set({ error: null, phase: 'checking' })
    let result: unknown

    try {
      result = await updater.checkForUpdates()
    } catch (err) {
      if (state.phase === 'checking') {
        failCheck(err)
      }

      return
    }

    // electron-updater resolves null when this build has no feed (no app-update.yml, not packaged).
    if (result == null) {
      log(`${APP_UPDATE_LOG_TAG} check skipped: this build has no update feed`)
      set({ phase: 'inactive' })
    } else if (state.phase === 'checking') {
      set({ checkedAt: now(), phase: 'up-to-date' })
    }
  }

  const checkNow = async (): Promise<ManualCheckResult> => {
    log(`${APP_UPDATE_LOG_TAG} check requested (phase ${state.phase})`)

    if (state.phase === 'downloading' || state.phase === 'installing') {
      return { outcome: state.phase, version: state.next }
    }

    if (state.phase === 'downloaded') {
      return { outcome: deps.runtimeUpdateInFlight() ? 'blocked-runtime' : 'downloaded', version: state.next }
    }

    await check()
    const after = state as AppUpdateState

    switch (after.phase) {
      case 'available':
        return { outcome: 'available', version: after.next }

      case 'inactive':
        return { outcome: 'inactive', version: null }

      case 'up-to-date':
        return { outcome: 'up-to-date', version: null }

      default:
        return { error: after.error?.text ?? appUpdateErrorText('feed', current), outcome: 'error', version: null }
    }
  }

  const download = () => {
    if (state.phase !== 'available' || !state.next) {
      return false
    }

    cancelRequested = false
    token = deps.createCancelToken?.() ?? null
    log(`${APP_UPDATE_LOG_TAG} downloading ${state.next}`)
    set({ error: null, phase: 'downloading', progress: { done: 0, percent: 0, total: size } })
    updater.downloadUpdate(token ?? undefined).catch(err => {
      if (state.phase === 'downloading') {
        failDownload(err)
      }
    })

    return true
  }

  const cancel = () => {
    if (state.phase !== 'downloading' || !token) {
      return false
    }

    cancelRequested = true
    token.cancel()
    log(`${APP_UPDATE_LOG_TAG} download cancel requested`)

    return true
  }

  const restart = ({ confirmed = false }: { confirmed?: boolean } = {}): AppUpdateRestartResult => {
    const next = state.next

    if (state.phase !== 'downloaded' || !next) {
      return { outcome: 'not-downloaded' }
    }

    if (runtimeMarkerBlocksAppInstall(deps.runtimeUpdateInFlight())) {
      log(`${APP_UPDATE_LOG_TAG} ${next} downloaded; install deferred while the runtime update runs`)
      set({ error: blockedError() })

      return { outcome: 'blocked-runtime' }
    }

    const work = confirmed ? null : (deps.activeWork?.() ?? null)

    if (work) {
      return { detail: work, outcome: 'active-work' }
    }

    installLatch = true
    set({ error: null, phase: 'installing' })
    deps.onInstall?.({ at: now(), from: current, result: 'installing', to: next })
    log(`${APP_UPDATE_LOG_TAG} restarting to install ${next}`)
    updater.quitAndInstall(false, true)
    installWatchdog = setLater(() => {
      installWatchdog = null

      if (state.phase === 'installing') {
        failInstall(new Error(`still running ${APP_UPDATE_INSTALL_WATCHDOG_MS / 1000} s after quitAndInstall`))
      }
    }, APP_UPDATE_INSTALL_WATCHDOG_MS)
    installWatchdog?.unref?.()

    return { outcome: 'installing' }
  }

  return {
    blocksRuntimeHandoff: busy,
    cancel,
    check,
    checkIfStale: () => {
      if (timer && (state.checkedAt === null || now() - state.checkedAt > APP_UPDATE_CHECK_INTERVAL_MS)) {
        void check()
      }
    },
    checkNow,
    consumeInstallLatch: () => {
      const was = installLatch
      installLatch = false

      return was
    },
    download,
    hasFeed,
    restart,
    reveal: () => deps.reveal?.() ?? false,
    start: () => {
      if (timer || feedSkipped) {
        return
      }

      if (!hasFeed()) {
        feedSkipped = true
        log(`${APP_UPDATE_LOG_TAG} check skipped: this build has no update feed (app-update.yml)`)
        set({ phase: 'inactive' })

        return
      }

      void check()
      timer = timers.setInterval(() => void check(), APP_UPDATE_CHECK_INTERVAL_MS)
      timer?.unref?.()
    },
    state: snapshot,
    stop: () => {
      clearInstallWatchdog()

      if (timer) {
        timers.clearInterval(timer)
        timer = null
      }
    }
  }
}

/** electron-builder writes `Resources/app-update.yml` only when the build has a publish feed. */
export function appUpdateFeedPresent(resourcesPath: null | string | undefined, exists = fs.existsSync): boolean {
  return Boolean(resourcesPath) && exists(path.join(String(resourcesPath), 'app-update.yml'))
}

// ---------------------------------------------------------------------------
// One truthful version (contract decision 11)
// ---------------------------------------------------------------------------

/** `iclone os 0.0.3 · Hermes runtime 0.17.0` — the app's own version in the owner's three-number form
 *  (src/iclone-shared/version.ts), the runtime's as a separate field. */
export function versionLine(appVersion: string, runtimeVersion: null | string | undefined): string {
  const shown = displayVersion(appVersion)

  return runtimeVersion ? `iclone os ${shown} · Hermes runtime ${runtimeVersion}` : `iclone os ${shown}`
}

/** The runtime's `__version__` from its checkout, or null — never the app's version standing in for it. */
export function readRuntimeVersion(runtimeRoot: null | string | undefined): null | string {
  if (!runtimeRoot) {
    return null
  }

  try {
    const raw = fs.readFileSync(path.join(runtimeRoot, 'hermes_cli', '__init__.py'), 'utf8')
    const match = raw.match(/__version__\s*=\s*["']([^"']+)["']/)

    return match ? match[1] : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Deep-link scheme (contract decision 20)
// ---------------------------------------------------------------------------

/** Packaged builds own only `iclone://`; `hermes://` (and `hermes-dev://`) stay dev-only. */
export function deepLinkSchemes(isPackaged: boolean, devServer: boolean): { accept: string[]; register: string } {
  if (isPackaged) {
    return { accept: ['iclone'], register: 'iclone' }
  }

  return devServer
    ? { accept: ['hermes-dev', 'hermes'], register: 'hermes-dev' }
    : { accept: ['hermes'], register: 'hermes' }
}

// ---------------------------------------------------------------------------
// First launch outside /Applications (contract decision 19)
// ---------------------------------------------------------------------------

interface MoveToApplicationsDeps {
  app: {
    isInApplicationsFolder: () => boolean
    moveToApplicationsFolder: (options?: { conflictHandler?: (kind: string) => boolean }) => boolean
  }
  /** Asks the user (synchronously, before any window or bootstrap); never moved without a yes. */
  confirm: () => boolean
  /** A file under userData; its presence records "not now" so the offer is made once. */
  declineMarker: string
  /** The running bundle's executable (app.getPath('exe')): only a downloaded copy is offered the move. */
  exePath: string
  /** The user's home directory (for ~/Downloads). */
  home: string
  isPackaged: boolean
  log: (line: string) => void
  platform: string
}

/**
 * Only a copy the user just DOWNLOADED is offered the move: a mounted DMG (/Volumes/…), App Translocation (macOS runs
 * a quarantined app from a random read-only path) or ~/Downloads. A build folder, a test VM share or a copy someone put
 * elsewhere on purpose is never touched — 2026-10-07 a build launched from its build folder replaced the owner's
 * installed app.
 */
export function isDownloadedCopy(exePath: string, home: string): boolean {
  return (
    exePath.startsWith('/Volumes/') ||
    exePath.includes('/AppTranslocation/') ||
    exePath.startsWith(`${home.replace(/\/+$/, '')}/Downloads/`)
  )
}

type MoveOutcome = 'declined' | 'failed' | 'inside' | 'moved' | 'skipped'

export function offerMoveToApplications(deps: MoveToApplicationsDeps): MoveOutcome {
  if (!deps.isPackaged || deps.platform !== 'darwin') {
    return 'skipped'
  }

  // Covers the mounted DMG and App Translocation: both report false here.
  if (deps.app.isInApplicationsFolder()) {
    return 'inside'
  }

  if (fs.existsSync(deps.declineMarker) || !isDownloadedCopy(deps.exePath, deps.home)) {
    return 'skipped'
  }

  if (!deps.confirm()) {
    try {
      fs.mkdirSync(path.dirname(deps.declineMarker), { recursive: true })
      fs.writeFileSync(deps.declineMarker, `${new Date().toISOString()}\n`)
    } catch {
      void 0
    }

    deps.log(`${APP_UPDATE_LOG_TAG} move to /Applications declined`)

    return 'declined'
  }

  try {
    // An existing copy in /Applications is NEVER replaced from here (running or not): the user's installed app is
    // theirs to replace, through an update or by dragging the new one in themselves.
    const moved = deps.app.moveToApplicationsFolder({ conflictHandler: () => false })
    deps.log(`${APP_UPDATE_LOG_TAG} move to /Applications ${moved ? 'done; relaunching' : 'refused'}`)

    return moved ? 'moved' : 'failed'
  } catch (err) {
    deps.log(`${APP_UPDATE_LOG_TAG} move to /Applications failed: ${errorMessage(err)}`)

    return 'failed'
  }
}

export const MOVE_TO_APPLICATIONS_PROMPT = {
  type: 'question' as const,
  buttons: ['Move to Applications', 'Not Now'],
  defaultId: 0,
  cancelId: 1,
  message: 'Move iclone os to your Applications folder?',
  detail:
    'Updates install only into the copy in Applications. Run from the disk image or Downloads, iclone os stays on this version.'
}

// ---------------------------------------------------------------------------
// App menu: "Check for Updates…"
// ---------------------------------------------------------------------------

interface ManualCheckDialog {
  buttons: string[]
  cancelId: number
  defaultId: number
  detail: string
  message: string
  type: 'error' | 'info' | 'warning'
}

export const RUNTIME_UPDATES_BUTTON = 'Hermes Runtime…'
export const DOWNLOAD_BUTTON = 'Download'
export const RESTART_BUTTON = 'Restart to Update'

/**
 * The native reply to a menu check, used only when no window can show Settings → Updates.
 * Null when the install is already under way.
 */
export function manualCheckDialog(result: ManualCheckResult, currentLine: string): ManualCheckDialog | null {
  const next = result.version ? `iclone os ${displayVersion(result.version)}` : 'The update'
  const ok = { buttons: ['OK'], cancelId: 0, defaultId: 0 }

  switch (result.outcome) {
    case 'installing':
      return null

    case 'available':
      return {
        type: 'info',
        buttons: [DOWNLOAD_BUTTON, 'Later'],
        cancelId: 1,
        defaultId: 0,
        message: `${next} is available`,
        detail: 'The update downloads in the background; you choose when to restart.'
      }

    case 'downloaded':
      return {
        type: 'info',
        buttons: [RESTART_BUTTON, 'Later'],
        cancelId: 1,
        defaultId: 0,
        message: `${next} is ready to install`,
        detail: 'iclone os will quit, install the update and reopen. Unsaved input in open windows is lost.'
      }

    case 'up-to-date':
      return {
        type: 'info',
        buttons: ['OK', RUNTIME_UPDATES_BUTTON],
        cancelId: 0,
        defaultId: 0,
        message: 'iclone os is up to date',
        detail: `You have ${currentLine}. The Hermes runtime updates separately.`
      }

    case 'downloading':
      return {
        ...ok,
        type: 'info',
        message: `${next} is downloading`,
        detail: 'You choose when to restart once it is ready.'
      }

    case 'blocked-runtime':
      return {
        ...ok,
        type: 'info',
        message: `${next} is ready to install`,
        detail: 'It installs after the Hermes runtime update finishes.'
      }

    case 'inactive':
      return {
        ...ok,
        type: 'info',
        message: 'This copy of iclone os does not update itself',
        detail: `You have ${currentLine}. Only the signed release installed in Applications receives updates.`
      }

    case 'error':
      return {
        ...ok,
        type: 'warning',
        message: 'Could not check for updates',
        detail: `${result.error ?? "The update server didn't answer as expected. Try again later."}\n\nYou have ${currentLine}.`
      }
  }
}

interface CheckForUpdatesMenuDeps {
  /** Null in dev builds and off macOS, where electron-updater is not wired. */
  controller: () => AppUpdateController | null
  currentVersionLine: () => string
  log: (line: string) => void
  /** The renderer's update overlay — the runtime's updates, and the dev build's only path. */
  openRuntimeUpdates: () => void
  showMessageBox: (options: ManualCheckDialog) => Promise<{ response: number }>
}

/**
 * The app menu item: opens Settings → Updates and runs the check there; native dialogs only
 * when no window exists. One check at a time, so repeated clicks never stack dialogs.
 */
export function checkForUpdatesMenuItem(deps: CheckForUpdatesMenuDeps): { click: () => Promise<void>; label: string } {
  let running = false

  const click = async () => {
    const controller = deps.controller()

    if (!controller) {
      deps.log(`${APP_UPDATE_LOG_TAG} app updater not wired in this build; opening the runtime updates overlay`)
      deps.openRuntimeUpdates()

      return
    }

    if (running) {
      deps.log(`${APP_UPDATE_LOG_TAG} check already running; menu click ignored`)

      return
    }

    running = true

    try {
      const shown = controller.reveal()
      const result = await controller.checkNow()
      deps.log(`${APP_UPDATE_LOG_TAG} menu check: ${result.outcome}${result.version ? ` ${result.version}` : ''}`)
      const dialog = shown ? null : manualCheckDialog(result, deps.currentVersionLine())

      if (dialog) {
        const { response } = await deps.showMessageBox(dialog)
        const button = dialog.buttons[response]

        if (button === RUNTIME_UPDATES_BUTTON) {
          deps.openRuntimeUpdates()
        } else if (button === DOWNLOAD_BUTTON) {
          controller.download()
        } else if (button === RESTART_BUTTON) {
          controller.restart({ confirmed: true })
        }
      }
    } catch (err) {
      deps.log(`${APP_UPDATE_LOG_TAG} menu check failed: ${errorMessage(err)}`)
    } finally {
      running = false
    }
  }

  return { click, label: 'Check for Updates…' }
}
