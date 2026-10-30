import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { AppUpdater } from 'electron-updater'
import { describe, expect, it, vi } from 'vitest'

import type { AppUpdateState } from './app-update-ipc'
import {
  APP_UPDATE_CHECK_INTERVAL_MS,
  APP_UPDATE_FEED,
  APP_UPDATE_INSTALL_WATCHDOG_MS,
  APP_UPDATE_LOG_TAG,
  APP_UPDATE_PROGRESS_MIN_MS,
  appUpdateBlocksRuntimeHandoff,
  type AppUpdateController,
  appUpdateErrorText,
  checkForUpdatesMenuItem,
  classifyAppUpdateError,
  createAppUpdate,
  createAppUpdateNotifier,
  deepLinkSchemes,
  DOWNLOAD_BUTTON,
  isDownloadedCopy,
  isNoFullRelease,
  manualCheckDialog,
  offerMoveToApplications,
  PRERELEASE_ENV,
  readRuntimeVersion,
  RESTART_BUTTON,
  RUNTIME_UPDATES_BUTTON,
  runtimeMarkerBlocksAppInstall,
  versionLine
} from './iclone-app-update'

function fakeUpdater() {
  const listeners = new Map<string, ((...args: any[]) => void)[]>()

  return {
    allowDowngrade: true,
    allowPrerelease: true,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    checkForUpdates: vi.fn(async (): Promise<unknown> => ({ updateInfo: {} })),
    downloadUpdate: vi.fn(async (_token?: unknown): Promise<unknown> => []),
    emit(event: string, ...args: unknown[]) {
      for (const fn of listeners.get(event) ?? []) {
        fn(...args)
      }
    },
    // The real `on` is electron-updater's typed emitter; the fake records listeners by name.
    on(...args: Parameters<AppUpdater['on']>) {
      const [event, fn] = args
      listeners.set(event, [...(listeners.get(event) ?? []), fn])
    },
    quitAndInstall: vi.fn()
  }
}

interface SetupOptions {
  activeWork?: () => null | string
  env?: Record<string, string>
  focused?: boolean
  hasFeed?: () => boolean
  lastInstall?: Parameters<typeof createAppUpdate>[0]['lastInstall']
  reveal?: () => boolean
  runtimeBusy?: () => boolean
}

function setup(over: SetupOptions = {}) {
  const updater = fakeUpdater()
  const lines: string[] = []
  const pushes: AppUpdateState[] = []
  const notices: string[] = []
  const installs: unknown[] = []
  const clock = { t: 1_000_000 }
  const tokens: { cancel: ReturnType<typeof vi.fn> }[] = []
  const later: { fn: () => void; ms: number }[] = []

  const timers = {
    clearInterval: vi.fn(),
    clearTimeout: vi.fn(),
    setInterval: vi.fn((_fn: () => void, _ms: number) => ({ unref: vi.fn() })),
    setTimeout: vi.fn((fn: () => void, ms: number) => {
      later.push({ fn, ms })

      return { unref: vi.fn() }
    })
  }

  const ctl = createAppUpdate({
    activeWork: over.activeWork,
    createCancelToken: () => {
      const token = { cancel: vi.fn() }
      tokens.push(token)

      return token
    },
    currentVersion: '0.0.2',
    emit: state => pushes.push(state),
    env: over.env ?? {},
    hasFeed: over.hasFeed,
    lastInstall: over.lastInstall,
    log: line => lines.push(line),
    notify: (notice, version) => notices.push(`${notice} ${version}`),
    now: () => clock.t,
    onInstall: entry => installs.push(entry),
    reveal: over.reveal,
    runtimeUpdateInFlight: over.runtimeBusy ?? (() => false),
    timers,
    updater,
    windowFocused: () => over.focused ?? true
  })

  return { clock, ctl, installs, later, lines, notices, pushes, timers, tokens, updater }
}

/** A check that the feed answers with `version` on offer. */
function offering(version = '0.0.3', over: SetupOptions = {}) {
  const env = setup(over)
  env.updater.checkForUpdates.mockImplementation(async () => {
    env.updater.emit('checking-for-update')
    env.updater.emit('update-available', { files: [{ size: 160_000_000 }], version })

    return { updateInfo: { version } }
  })

  return env
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function httpError(message: string, code?: string) {
  return Object.assign(new Error(message), code ? { code } : {})
}

describe('createAppUpdate — configuration and cadence', () => {
  it('configures electron-updater: no auto download, no install on quit, no downgrade, no pre-releases', () => {
    const { updater, lines } = setup()

    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
    expect(updater.allowDowngrade).toBe(false)
    expect(updater.allowPrerelease).toBe(false)
    expect(lines[0]).toContain(APP_UPDATE_FEED)
    expect(lines[0]).toContain(APP_UPDATE_LOG_TAG)
  })

  it('allows pre-releases only with the owner env set to exactly 1, and logs it', () => {
    expect(setup({ env: { [PRERELEASE_ENV]: 'true' } }).updater.allowPrerelease).toBe(false)
    const on = setup({ env: { [PRERELEASE_ENV]: '1' } })
    expect(on.updater.allowPrerelease).toBe(true)
    expect(on.lines.some(line => line.includes(PRERELEASE_ENV))).toBe(true)
  })

  it('checks at start and every 6 hours; a power resume re-checks only when the last answer is stale', async () => {
    const { clock, ctl, timers, updater } = setup()
    ctl.checkIfStale()
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    ctl.start()
    ctl.start()
    await flush()
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(timers.setInterval).toHaveBeenCalledTimes(1)
    expect(timers.setInterval.mock.calls[0][1]).toBe(APP_UPDATE_CHECK_INTERVAL_MS)
    ctl.checkIfStale()
    await flush()
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    clock.t += APP_UPDATE_CHECK_INTERVAL_MS + 1
    ctl.checkIfStale()
    await flush()
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('a build without a feed is inactive and starts no timer', async () => {
    const { ctl, timers, updater } = setup({ hasFeed: () => false })
    ctl.start()
    expect(ctl.state().phase).toBe('inactive')
    expect(timers.setInterval).not.toHaveBeenCalled()
    await expect(ctl.checkNow()).resolves.toEqual({ outcome: 'inactive', version: null })
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('electron-updater resolving null (no app-update.yml) reads as inactive', async () => {
    const { ctl, updater } = setup()
    updater.checkForUpdates.mockResolvedValue(null)
    await ctl.check()
    expect(ctl.state().phase).toBe('inactive')
  })
})

describe('createAppUpdate — every phase edge', () => {
  it('idle → checking → up-to-date, pushed to the windows with checkedAt', async () => {
    const { ctl, pushes, updater } = setup()
    expect(ctl.state()).toMatchObject({ current: '0.0.2', error: null, next: null, phase: 'idle', progress: null })
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('checking-for-update')
      updater.emit('update-not-available', { version: '0.0.2' })

      return { updateInfo: {} }
    })
    await ctl.check()
    expect(pushes.map(p => p.phase)).toEqual(['checking', 'up-to-date'])
    expect(ctl.state().checkedAt).toBe(1_000_000)
  })

  it('a 404 on releases/latest (only pre-releases published) is up to date, never an error', async () => {
    for (const err of [
      // The shapes GitHubProvider builds: its wrappers carry the HttpError's stack.
      httpError(
        'Unable to find latest version on GitHub (https://github.com/o/r/releases/latest), please ensure a production release exists: HttpError: 404 ',
        'ERR_UPDATER_LATEST_VERSION_NOT_FOUND'
      ),
      httpError('No published versions on GitHub', 'ERR_UPDATER_NO_PUBLISHED_VERSIONS'),
      httpError(
        'Cannot find latest-mac.yml in the latest release artifacts (x): HttpError: 404 ',
        'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
      ),
      httpError('HttpError: 404 \n"method: GET url: https://github.com/devclone20/icloneos/releases/latest"')
    ]) {
      const { ctl, lines, updater } = setup()
      updater.checkForUpdates.mockImplementation(async () => {
        updater.emit('checking-for-update')
        updater.emit('error', err)

        throw err
      })
      await expect(ctl.checkNow()).resolves.toEqual({ outcome: 'up-to-date', version: null })
      expect(ctl.state()).toMatchObject({ error: null, phase: 'up-to-date' })
      expect(lines.some(line => line.includes('feed has no full release'))).toBe(true)
    }
  })

  it('available: one system notification per version, the release page, nothing downloads by itself', async () => {
    const { ctl, notices, updater } = offering('0.0.3')
    await ctl.check()
    await ctl.check()
    expect(ctl.state()).toMatchObject({ next: '0.0.3', phase: 'available' })
    expect(ctl.state().releaseUrl).toBe('https://github.com/devclone20/icloneos/releases/tag/v0.0.3')
    expect(notices).toEqual(['available 0.0.3'])
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('download only on the click; progress is monotonic 0→100 and pushed at most 4 times a second', async () => {
    const { clock, ctl, pushes, updater } = offering('0.0.3')
    expect(ctl.download()).toBe(false)
    await ctl.check()
    expect(ctl.download()).toBe(true)
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(ctl.state()).toMatchObject({ phase: 'downloading', progress: { done: 0, percent: 0, total: 160_000_000 } })
    const before = pushes.length

    // 40 events in one second, one going backwards: at most 4 pushes in that second.
    for (let i = 1; i <= 40; i += 1) {
      clock.t += 25
      updater.emit('download-progress', {
        percent: i === 20 ? 5 : i * 2.4,
        total: 160_000_000,
        transferred: i * 3_840_000
      })
    }

    const progressPushes = pushes.slice(before).map(p => p.progress?.percent ?? -1)
    expect(progressPushes.length).toBeLessThanOrEqual(4)
    expect([...progressPushes].sort((a, b) => a - b)).toEqual(progressPushes)
    expect(ctl.state().progress?.percent).toBe(96)
    updater.emit('download-progress', { percent: 100, total: 160_000_000, transferred: 160_000_000 })
    // Inside the throttle window, yet the bar still gets its 100 % while the phase is downloading.
    expect(pushes.at(-1)).toMatchObject({ phase: 'downloading', progress: { percent: 100 } })
    updater.emit('update-downloaded', { version: '0.0.3' })
    expect(pushes.at(-1)?.progress?.percent).toBe(100)
    expect(ctl.state()).toMatchObject({ next: '0.0.3', phase: 'downloaded', progress: { percent: 100 } })
  })

  it('cancel goes back to available through the cancellation token', async () => {
    const { ctl, tokens, updater } = offering('0.0.3')
    await ctl.check()
    expect(ctl.cancel()).toBe(false)
    ctl.download()
    expect(ctl.cancel()).toBe(true)
    expect(tokens[0].cancel).toHaveBeenCalledTimes(1)
    updater.emit('error', Object.assign(new Error('cancelled'), { name: 'CancellationError' }))
    expect(ctl.state()).toMatchObject({ error: null, next: '0.0.3', phase: 'available', progress: null })
  })

  it('restart: quitAndInstall exactly once with (false, true), the latch passes once, the log row is written', async () => {
    const { ctl, installs, updater } = offering('0.0.3')
    expect(ctl.restart()).toEqual({ outcome: 'not-downloaded' })
    await ctl.check()
    ctl.download()
    updater.emit('update-downloaded', { version: '0.0.3' })
    expect(ctl.consumeInstallLatch()).toBe(false)
    expect(ctl.restart()).toEqual({ outcome: 'installing' })
    expect(ctl.restart()).toEqual({ outcome: 'not-downloaded' })
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
    expect(ctl.state().phase).toBe('installing')
    expect(installs).toEqual([{ at: 1_000_000, from: '0.0.2', result: 'installing', to: '0.0.3' }])
    expect(ctl.consumeInstallLatch()).toBe(true)
    expect(ctl.consumeInstallLatch()).toBe(false)
    expect(ctl.blocksRuntimeHandoff()).toBe(true)
  })

  it('a turn in flight asks in the window first; the confirmed restart installs', async () => {
    const { ctl, updater } = offering('0.0.3', { activeWork: () => 'A reply is still being written.' })
    await ctl.check()
    ctl.download()
    updater.emit('update-downloaded', { version: '0.0.3' })
    expect(ctl.restart()).toEqual({ detail: 'A reply is still being written.', outcome: 'active-work' })
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    expect(ctl.restart({ confirmed: true })).toEqual({ outcome: 'installing' })
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('blocked-runtime: no quitAndInstall while the runtime marker is live; the copy says why', async () => {
    let busy = true
    const { ctl, updater } = offering('0.0.3', { runtimeBusy: () => busy })
    await ctl.check()
    ctl.download()
    updater.emit('update-downloaded', { version: '0.0.3' })
    expect(ctl.state().error?.kind).toBe('blocked-runtime')
    expect(ctl.restart()).toEqual({ outcome: 'blocked-runtime' })
    expect(ctl.state().error?.text).toBe('Finishing a runtime update first — restart will be offered next.')
    await expect(ctl.checkNow()).resolves.toEqual({ outcome: 'blocked-runtime', version: '0.0.3' })
    busy = false
    await ctl.check()
    expect(ctl.state().error).toBeNull()
    expect(ctl.restart()).toEqual({ outcome: 'installing' })
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('a second notification "restart" only when no window has focus', async () => {
    const focused = offering('0.0.3', { focused: true })
    await focused.ctl.check()
    focused.ctl.download()
    focused.updater.emit('update-downloaded', { version: '0.0.3' })
    expect(focused.notices).toEqual(['available 0.0.3'])
    const away = offering('0.0.3', { focused: false })
    await away.ctl.check()
    away.ctl.download()
    away.updater.emit('update-downloaded', { version: '0.0.3' })
    expect(away.notices).toEqual(['available 0.0.3', 'restart 0.0.3'])
  })

  it('never re-checks while downloading; a failed check keeps a downloaded bundle', async () => {
    const { ctl, updater } = offering('0.0.3')
    await ctl.check()
    ctl.download()
    await ctl.check()
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    await expect(ctl.checkNow()).resolves.toEqual({ outcome: 'downloading', version: '0.0.3' })
    updater.emit('update-downloaded', { version: '0.0.3' })
    updater.emit('error', new Error('feed offline'))
    expect(ctl.state().phase).toBe('downloaded')
    await expect(ctl.checkNow()).resolves.toEqual({ outcome: 'downloaded', version: '0.0.3' })
  })

  it('pure exclusion rules', () => {
    expect(appUpdateBlocksRuntimeHandoff('downloading')).toBe(true)
    expect(appUpdateBlocksRuntimeHandoff('downloaded')).toBe(true)
    expect(appUpdateBlocksRuntimeHandoff('installing')).toBe(true)
    expect(appUpdateBlocksRuntimeHandoff('available')).toBe(false)
    expect(runtimeMarkerBlocksAppInstall(true)).toBe(true)
    expect(runtimeMarkerBlocksAppInstall(false)).toBe(false)
  })
})

describe('createAppUpdate — failures in plain copy', () => {
  it('each error kind maps to its sentence; none says "unknown"', () => {
    const cases: [unknown, string][] = [
      [httpError('getaddrinfo ENOTFOUND github.com', 'ENOTFOUND'), 'offline'],
      [httpError('net::ERR_INTERNET_DISCONNECTED'), 'offline'],
      [httpError('connect ETIMEDOUT', 'ETIMEDOUT'), 'offline'],
      [httpError('sha512 checksum mismatch, expected a, got b'), 'verify'],
      [httpError('Code signature at URL did not pass validation'), 'verify'],
      [httpError('ENOSPC: no space left on device', 'ENOSPC'), 'disk'],
      [httpError('Cannot update while running on a read-only volume (translocated)'), 'location'],
      [httpError('Unexpected token < in JSON'), 'feed']
    ]

    for (const [err, kind] of cases) {
      expect(classifyAppUpdateError(err)).toBe(kind)
    }

    const texts = (['offline', 'feed', 'verify', 'disk', 'location', 'blocked-runtime', 'install'] as const).map(kind =>
      appUpdateErrorText(kind, '0.0.2', 160_000_000)
    )

    expect(texts).toEqual([
      "Can't reach the update server. iclone os will try again in 6 hours.",
      "The update server didn't answer as expected. Try again later.",
      "The download couldn't be verified, so nothing was installed. You're still on v0.0.2.",
      'Not enough free space to download the update (160 MB needed).',
      'Move iclone os to Applications to install updates.',
      'Finishing a runtime update first — restart will be offered next.',
      "The update didn't install. You're still on v0.0.2. Try again."
    ])
    expect(texts.join(' ')).not.toMatch(/unknown/i)
    expect(appUpdateErrorText('disk', '0.0.2')).toBe('Not enough free space to download the update.')
    expect(isNoFullRelease(httpError('HttpError: 500'))).toBe(false)
  })

  it('the real feed with no full release yet reads as up to date; offline in the same wrapper stays offline', () => {
    const wrapped = (inner: string) =>
      Object.assign(
        new Error(
          'Cannot parse releases feed: Error: Unable to find latest version on GitHub ' +
            `(https://github.com/devclone20/icloneos/releases/latest), please ensure a production release exists: ${inner}`
        ),
        { code: 'ERR_UPDATER_INVALID_RELEASE_FEED' }
      )

    // Measured 2026-10-18 from an installed 0.0.0.1 against the old releases repo (only a pre-release published).
    expect(isNoFullRelease(wrapped('HttpError: 406 '))).toBe(true)
    expect(isNoFullRelease(wrapped('HttpError: 404 '))).toBe(true)
    expect(
      isNoFullRelease(
        Object.assign(new Error('No published versions on GitHub'), { code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' })
      )
    ).toBe(true)
    expect(isNoFullRelease(wrapped('Error: net::ERR_INTERNET_DISCONNECTED'))).toBe(false)
    expect(classifyAppUpdateError(wrapped('Error: net::ERR_INTERNET_DISCONNECTED'))).toBe('offline')
    expect(
      isNoFullRelease(
        Object.assign(new Error('Cannot parse releases feed: bad XML'), { code: 'ERR_UPDATER_INVALID_RELEASE_FEED' })
      )
    ).toBe(false)
  })

  it('a failed check reports its copy through checkNow and the state', async () => {
    const { ctl, updater } = setup()
    updater.checkForUpdates.mockImplementation(async () => {
      throw httpError('getaddrinfo ENOTFOUND github.com', 'ENOTFOUND')
    })
    const result = await ctl.checkNow()
    expect(result).toEqual({
      error: "Can't reach the update server. iclone os will try again in 6 hours.",
      outcome: 'error',
      version: null
    })
    expect(ctl.state().error?.kind).toBe('offline')
  })

  it('a bad sha512 is the verify copy and leaves no restart', async () => {
    const { ctl, updater } = offering('0.0.3')
    await ctl.check()
    ctl.download()
    updater.emit('error', httpError('sha512 checksum mismatch, expected a, got b'))
    expect(ctl.state()).toMatchObject({ error: { kind: 'verify' }, phase: 'error', progress: null })
    expect(ctl.restart()).toEqual({ outcome: 'not-downloaded' })
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('a rejected download without an error event still fails into its copy', async () => {
    const { ctl, updater } = offering('0.0.3')
    await ctl.check()
    updater.downloadUpdate.mockRejectedValueOnce(httpError('ENOSPC: no space left on device', 'ENOSPC'))
    ctl.download()
    await flush()
    expect(ctl.state().error).toEqual({
      kind: 'disk',
      text: 'Not enough free space to download the update (160 MB needed).'
    })
  })

  it('Squirrel refusing the bundle after "Restart to update": plain copy, Try again, latch dropped, failed row', async () => {
    const { ctl, installs, lines, updater } = offering('0.0.3')
    await ctl.check()
    ctl.download()
    updater.emit('update-downloaded', { version: '0.0.3' })
    expect(ctl.restart()).toEqual({ outcome: 'installing' })
    updater.emit(
      'error',
      httpError(
        'Code signature at URL file:///x did not pass validation: code failed to satisfy specified code requirement(s)'
      )
    )

    expect(ctl.state()).toMatchObject({
      error: {
        kind: 'verify',
        text: "The download couldn't be verified, so nothing was installed. You're still on v0.0.2."
      },
      next: '0.0.3',
      phase: 'error'
    })
    expect(ctl.consumeInstallLatch()).toBe(false)
    expect(ctl.blocksRuntimeHandoff()).toBe(false)
    expect(installs).toEqual([
      { at: 1_000_000, from: '0.0.2', result: 'installing', to: '0.0.3' },
      expect.objectContaining({ from: '0.0.2', result: 'failed', to: '0.0.3' })
    ])
    expect(lines.some(line => line.includes('install of 0.0.3 failed (verify)'))).toBe(true)

    // "Try again" is a check: the release is offered again.
    await ctl.check()
    expect(ctl.state()).toMatchObject({ error: null, next: '0.0.3', phase: 'available' })
  })

  it('any other install error is the install copy', async () => {
    const { ctl, updater } = offering('0.0.3')
    await ctl.check()
    ctl.download()
    updater.emit('update-downloaded', { version: '0.0.3' })
    ctl.restart()
    updater.emit('error', httpError('Squirrel: the update could not be applied'))
    expect(ctl.state()).toMatchObject({
      error: { kind: 'install', text: "The update didn't install. You're still on v0.0.2. Try again." },
      phase: 'error'
    })
  })

  it('the watchdog: still running 90 s after quitAndInstall is a failed install; a quit in time leaves nothing', async () => {
    const { ctl, installs, later, timers, updater } = offering('0.0.3')
    await ctl.check()
    ctl.download()
    updater.emit('update-downloaded', { version: '0.0.3' })
    ctl.restart()
    expect(later).toHaveLength(1)
    expect(later[0]?.ms).toBe(APP_UPDATE_INSTALL_WATCHDOG_MS)
    expect(ctl.state().phase).toBe('installing')

    later[0]?.fn()
    expect(ctl.state()).toMatchObject({ error: { kind: 'install' }, next: '0.0.3', phase: 'error' })
    expect(ctl.consumeInstallLatch()).toBe(false)
    expect(installs.at(-1)).toMatchObject({ result: 'failed', to: '0.0.3' })

    // An error event first clears the watchdog; a late watchdog never fires twice.
    const second = offering('0.0.3')
    await second.ctl.check()
    second.ctl.download()
    second.updater.emit('update-downloaded', { version: '0.0.3' })
    second.ctl.restart()
    second.updater.emit('error', httpError('not signed'))
    expect(second.timers.clearTimeout).toHaveBeenCalledTimes(1)
    second.later[0]?.fn()
    expect(second.installs.filter(row => (row as { result: string }).result === 'failed')).toHaveLength(1)
    expect(timers.clearTimeout).not.toHaveBeenCalled()
  })

  it('only 404 and the measured 406 are "no full release"; 403, 429 and 5xx in the same wrapper are the feed error', async () => {
    const wrapped = (inner: string) =>
      Object.assign(
        new Error(
          'Cannot parse releases feed: Error: Unable to find latest version on GitHub ' +
            `(https://github.com/devclone20/icloneos/releases/latest), please ensure a production release exists: ${inner}`
        ),
        { code: 'ERR_UPDATER_INVALID_RELEASE_FEED' }
      )

    for (const inner of [
      'HttpError: 403 Forbidden "API rate limit exceeded"',
      'HttpError: 429 ',
      'HttpError: 502 Bad Gateway'
    ]) {
      expect(isNoFullRelease(wrapped(inner))).toBe(false)
      expect(classifyAppUpdateError(wrapped(inner))).toBe('feed')
    }

    expect(isNoFullRelease(wrapped('HttpError: 404 Not Found'))).toBe(true)
    expect(isNoFullRelease(wrapped('HttpError: 406 \n"method: GET url: https://github.com/o/r/releases/latest"'))).toBe(
      true
    )
    expect(isNoFullRelease(httpError('HttpError: 406 Not Acceptable'))).toBe(false)
    expect(
      isNoFullRelease(
        httpError(
          'Cannot find latest-mac.yml in the latest release artifacts: HttpError: 404 ',
          'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
        )
      )
    ).toBe(true)
    expect(
      isNoFullRelease(httpError('Unable to find latest version on GitHub', 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND'))
    ).toBe(false)

    const { ctl, updater } = setup()
    updater.checkForUpdates.mockRejectedValueOnce(wrapped('HttpError: 403 Forbidden'))
    await ctl.check()
    expect(ctl.state()).toMatchObject({
      error: { kind: 'feed', text: "The update server didn't answer as expected. Try again later." },
      phase: 'error'
    })
  })

  it('next launch: a restart that did not install starts in the install-failed state', () => {
    const failed = setup({
      lastInstall: { at: 1, error: 'still running 0.0.2', from: '0.0.2', result: 'failed', to: '0.0.3' }
    })

    expect(failed.ctl.state()).toMatchObject({ error: { kind: 'install' }, phase: 'error' })
    const installed = setup({ lastInstall: { at: 1, from: '0.0.1', result: 'installed', to: '0.0.2' } })
    expect(installed.ctl.state()).toMatchObject({ error: null, phase: 'idle' })
  })
})

describe('createAppUpdateNotifier', () => {
  function notifier(allowed = true) {
    const created: { listeners: Map<string, () => void>; options: { body: string; title: string }; shown: number }[] =
      []

    const lines: string[] = []
    const reveal = vi.fn()

    const ctl = createAppUpdateNotifier({
      allowed: () => allowed,
      create: options => {
        const made = { listeners: new Map<string, () => void>(), options, shown: 0 }
        created.push(made)

        return {
          on: (event, listener) => made.listeners.set(event, listener),
          show: () => {
            made.shown += 1
          }
        }
      },
      log: line => lines.push(line),
      reveal
    })

    return { created, ctl, lines, reveal }
  }

  it('holds each notification until its click or close, and the click opens Settings → Updates', () => {
    const { created, ctl, lines, reveal } = notifier()
    ctl.notify('available', '0.0.3')
    ctl.notify('restart', '0.0.3')
    expect(created.map(n => n.options.title)).toEqual([
      'iclone os v0.0.3 is ready to download',
      'Restart to finish updating'
    ])
    expect(created.map(n => n.shown)).toEqual([1, 1])
    expect(ctl.held()).toBe(2)

    created[0]?.listeners.get('click')?.()
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(ctl.held()).toBe(1)
    created[1]?.listeners.get('close')?.()
    expect(ctl.held()).toBe(0)
    expect(lines).toEqual([
      `${APP_UPDATE_LOG_TAG} notification available 0.0.3 (shown)`,
      `${APP_UPDATE_LOG_TAG} notification restart 0.0.3 (shown)`
    ])
  })

  it('without consent: logged, nothing created', () => {
    const { created, ctl, lines } = notifier(false)
    ctl.notify('available', '0.0.3')
    expect(created).toEqual([])
    expect(ctl.held()).toBe(0)
    expect(lines).toEqual([`${APP_UPDATE_LOG_TAG} notification available 0.0.3 (not allowed)`])
  })
})

describe('manualCheckDialog (menu, no window)', () => {
  const line = 'iclone os 0.0.2 · Hermes runtime 0.17.0'

  it('replies with the one version line and offers the next step', () => {
    expect(manualCheckDialog({ outcome: 'up-to-date', version: null }, line)?.detail).toContain(line)
    expect(manualCheckDialog({ outcome: 'inactive', version: null }, line)?.detail).toContain(line)
    expect(manualCheckDialog({ outcome: 'available', version: '0.0.3' }, line)).toMatchObject({
      buttons: [DOWNLOAD_BUTTON, 'Later'],
      message: 'iclone os 0.0.3 is available'
    })
    expect(manualCheckDialog({ outcome: 'downloaded', version: '0.0.3' }, line)?.buttons[0]).toBe(RESTART_BUTTON)
    expect(manualCheckDialog({ error: 'x', outcome: 'error', version: null }, line)?.detail).toContain('x')
  })

  it('stays silent once the install is under way', () => {
    expect(manualCheckDialog({ outcome: 'installing', version: '0.0.3' }, line)).toBeNull()
  })
})

describe('checkForUpdatesMenuItem', () => {
  function menu(controller: AppUpdateController | null, response = 0) {
    const lines: string[] = []
    const openRuntimeUpdates = vi.fn()
    const showMessageBox = vi.fn(async () => ({ response }))

    const item = checkForUpdatesMenuItem({
      controller: () => controller,
      currentVersionLine: () => 'iclone os 1.0.0 · Hermes runtime 0.17.0',
      log: line => lines.push(line),
      openRuntimeUpdates,
      showMessageBox
    })

    return { item, lines, openRuntimeUpdates, showMessageBox }
  }

  it('with a window: opens Settings → Updates, runs the check there, no native dialog', async () => {
    const reveal = vi.fn(() => true)
    const { ctl, updater } = setup({ reveal })
    const { item, showMessageBox } = menu(ctl)
    await item.click()
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('without a window: the native reply; Download and the runtime button act', async () => {
    const plain = setup()
    plain.updater.checkForUpdates.mockImplementation(async () => {
      plain.updater.emit('update-not-available', {})

      return { updateInfo: {} }
    })
    const runtime = menu(plain.ctl, 1)
    await runtime.item.click()
    expect(runtime.showMessageBox).toHaveBeenCalledTimes(1)
    expect(runtime.openRuntimeUpdates).toHaveBeenCalledTimes(1)

    const offered = offering('0.0.3')
    const download = menu(offered.ctl, 0)
    await download.item.click()
    expect(offered.updater.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('one check at a time: a second click while running stacks nothing', async () => {
    const { ctl, updater } = setup()

    let release: (value: unknown) => void = () => {}
    updater.checkForUpdates.mockImplementation(() => new Promise(resolve => (release = resolve)))
    const { item, lines, showMessageBox } = menu(ctl)
    const first = item.click()
    await item.click()
    expect(lines.some(line => line.includes('already running'))).toBe(true)
    updater.emit('update-not-available', {})
    release({ updateInfo: {} })
    await first
    expect(showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('without a wired updater (dev) it opens the runtime overlay and checks nothing', async () => {
    const { item, openRuntimeUpdates, showMessageBox } = menu(null)
    await item.click()
    expect(openRuntimeUpdates).toHaveBeenCalledTimes(1)
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('RUNTIME_UPDATES_BUTTON names the runtime door', () => {
    expect(RUNTIME_UPDATES_BUTTON).toBe('Hermes Runtime…')
    expect(APP_UPDATE_PROGRESS_MIN_MS).toBe(300)
  })
})

describe('version line', () => {
  it('names the app version and the runtime version separately', () => {
    expect(versionLine('1.0.0', '0.17.0')).toBe('iclone os 1.0.0 · Hermes runtime 0.17.0')
    expect(versionLine('0.0.3', null)).toBe('iclone os 0.0.3')
  })

  it('shows three numbers in every user-facing app-update sentence (ruling 0)', () => {
    const fourPart = /\b\d+\.\d+\.\d+\.\d+\b/

    const sentences = [
      versionLine('0.0.3', '0.17.0'),
      appUpdateErrorText('verify', '0.0.3'),
      appUpdateErrorText('install', '0.0.3'),
      manualCheckDialog({ outcome: 'available', version: '0.0.3' }, versionLine('0.0.2', null))?.message ?? ''
    ]

    expect(sentences.join(' ')).not.toMatch(fourPart)
    expect(sentences.join(' ')).toContain('0.0.3')
  })

  it('reads the runtime __version__ and never substitutes the app version', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iclone-ver-'))

    try {
      expect(readRuntimeVersion(root)).toBeNull()
      fs.mkdirSync(path.join(root, 'hermes_cli'))
      fs.writeFileSync(path.join(root, 'hermes_cli', '__init__.py'), '__version__ = "0.17.0"\n')
      expect(readRuntimeVersion(root)).toBe('0.17.0')
      expect(readRuntimeVersion(null)).toBeNull()
    } finally {
      fs.rmSync(root, { force: true, recursive: true })
    }
  })
})

describe('deepLinkSchemes', () => {
  it('packaged builds register and accept only iclone://', () => {
    expect(deepLinkSchemes(true, false)).toEqual({ accept: ['iclone'], register: 'iclone' })
    expect(deepLinkSchemes(true, true)).toEqual({ accept: ['iclone'], register: 'iclone' })
  })

  it('hermes:// stays dev-only', () => {
    expect(deepLinkSchemes(false, true).register).toBe('hermes-dev')
    expect(deepLinkSchemes(false, false).accept).toEqual(['hermes'])
  })
})

describe('offerMoveToApplications', () => {
  function deps(over: Record<string, unknown> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iclone-move-'))

    return {
      dir,
      value: {
        app: {
          isInApplicationsFolder: vi.fn(() => false),
          moveToApplicationsFolder: vi.fn((_options?: { conflictHandler?: (kind: string) => boolean }) => true)
        },
        confirm: vi.fn(() => true),
        declineMarker: path.join(dir, 'declined'),
        exePath: '/Volumes/iclone os/iclone os.app/Contents/MacOS/iclone os',
        home: '/Users/u',
        isPackaged: true,
        log: vi.fn(),
        platform: 'darwin',
        ...over
      }
    }
  }

  it('skips dev builds and other platforms', () => {
    expect(offerMoveToApplications(deps({ isPackaged: false }).value)).toBe('skipped')
    expect(offerMoveToApplications(deps({ platform: 'linux' }).value)).toBe('skipped')
  })

  it('does nothing when already in /Applications', () => {
    const d = deps()

    d.value.app.isInApplicationsFolder.mockReturnValue(true)
    expect(offerMoveToApplications(d.value)).toBe('inside')
    expect(d.value.confirm).not.toHaveBeenCalled()
  })

  it('moves only after a yes, and never replaces an existing /Applications copy', () => {
    const d = deps()

    expect(offerMoveToApplications(d.value)).toBe('moved')
    const handler = d.value.app.moveToApplicationsFolder.mock.calls[0]?.[0]?.conflictHandler

    expect(handler?.('existsAndRunning')).toBe(false)
    expect(handler?.('exists')).toBe(false)
  })

  it('offers the move only to a downloaded copy, never to a build folder (2026-10-07 incident)', () => {
    for (const exePath of [
      '/Users/u/Developer/iclone-os-build/mac-arm64/iclone os.app/Contents/MacOS/iclone os',
      '/Users/u/Desktop/repo/apps/desktop/release/mac-arm64/iclone os.app/Contents/MacOS/iclone os'
    ]) {
      const d = deps({ exePath })

      expect(offerMoveToApplications(d.value)).toBe('skipped')
      expect(d.value.confirm).not.toHaveBeenCalled()
    }

    expect(isDownloadedCopy('/Users/u/Downloads/iclone os.app/Contents/MacOS/iclone os', '/Users/u')).toBe(true)
    expect(
      isDownloadedCopy(
        '/private/var/folders/x/AppTranslocation/ABC/d/iclone os.app/Contents/MacOS/iclone os',
        '/Users/u'
      )
    ).toBe(true)
    expect(isDownloadedCopy('/Volumes/iclone os/iclone os.app/Contents/MacOS/iclone os', '/Users/u')).toBe(true)
  })

  it('a decline is remembered and the offer is not repeated', () => {
    const d = deps({ confirm: vi.fn(() => false) })

    expect(offerMoveToApplications(d.value)).toBe('declined')
    expect(d.value.app.moveToApplicationsFolder).not.toHaveBeenCalled()
    expect(offerMoveToApplications(d.value)).toBe('skipped')
    expect(d.value.confirm).toHaveBeenCalledTimes(1)
    fs.rmSync(d.dir, { force: true, recursive: true })
  })

  it('a failed move is reported, not thrown', () => {
    const d = deps()

    d.value.app.moveToApplicationsFolder.mockImplementation(() => {
      throw new Error('read-only volume')
    })
    expect(offerMoveToApplications(d.value)).toBe('failed')
  })
})
