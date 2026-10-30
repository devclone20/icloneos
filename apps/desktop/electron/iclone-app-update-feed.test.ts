import { describe, expect, it, vi } from 'vitest'

import { appUpdateFeedPresent, createAppUpdate } from './iclone-app-update'

function controller(hasFeed: boolean) {
  const logs: string[] = []

  const updater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => null),
    on: vi.fn(),
    quitAndInstall: vi.fn()
  }

  const timers = { clearInterval: vi.fn(), setInterval: vi.fn(() => 1) }

  const app = createAppUpdate({
    currentVersion: '0.0.2',
    env: {},
    hasFeed: () => hasFeed,
    log: line => logs.push(line),
    runtimeUpdateInFlight: () => false,
    timers,
    updater: updater as never
  })

  return { app, logs, timers, updater }
}

describe('iclone-app-update hasFeed (R7 RC1 in R1)', () => {
  it('a build without app-update.yml logs one skip line, starts no timer and checkNow is inactive', async () => {
    const { app, logs, timers, updater } = controller(false)

    app.start()
    app.start()
    expect(timers.setInterval).not.toHaveBeenCalled()
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    expect(logs.filter(line => /check skipped/.test(line))).toHaveLength(1)
    await expect(app.checkNow()).resolves.toEqual({ outcome: 'inactive', version: null })
    expect(app.hasFeed()).toBe(false)
  })

  it('a build with a feed keeps the 6 h timer', () => {
    const { app, timers } = controller(true)

    app.start()
    expect(timers.setInterval).toHaveBeenCalledTimes(1)
  })

  it('appUpdateFeedPresent looks for Resources/app-update.yml', () => {
    expect(appUpdateFeedPresent('/R', p => p === '/R/app-update.yml')).toBe(true)
    expect(appUpdateFeedPresent('/R', () => false)).toBe(false)
    expect(appUpdateFeedPresent(undefined, () => true)).toBe(false)
  })
})
