// The feed stamp, proven against the updater v0.0.4 ships: the REAL electron-updater 6.8.9 AppUpdater check path
// (doCheckForUpdates → isUpdateAvailable → checkIfUpdateSupported) and its own semver, offline. A stub provider serves
// latest-mac.yml through electron-updater's own parseUpdateInfo; os.release() is simulated; no network, no Electron.
// Runs under `node --test` and under vitest's electron project.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import { feedMinimumSystemVersion, stampFeedMinimum } from './release-mac.mjs'

const { describe, it } = process.env.VITEST ? await import('vitest') : await import('node:test')

const require = createRequire(import.meta.url)
const updaterDir = require.resolve('electron-updater/package.json').replace(/package\.json$/, '')
const fromUpdater = createRequire(require.resolve('electron-updater/package.json'))
const os = fromUpdater('os')
const semver = fromUpdater('semver')
const { AppUpdater } = fromUpdater('./out/AppUpdater.js')
const { parseUpdateInfo } = fromUpdater('./out/providers/Provider.js')

// latest-mac.yml as electron-builder 26.15.3 writes it for v0.0.5 (no minimumSystemVersion).
const FEED = `version: 0.0.5
files:
  - url: iclone-os-0.0.5-mac-arm64.zip
    sha512: ${'Q'.repeat(86)}==
    size: 123456789
path: iclone-os-0.0.5-mac-arm64.zip
sha512: ${'Q'.repeat(86)}==
releaseDate: '2026-11-04T00:00:00.000Z'
`
const STAMPED = stampFeedMinimum(FEED, feedMinimumSystemVersion('13.0'))

/** What a v0.0.4 app's updater answers for this feed on a host whose os.release() is `kernel`. */
async function v004Answers(feedText, kernel) {
  const app = {
    version: '0.0.4',
    name: 'iclone os',
    isPackaged: true,
    appUpdateConfigPath: '/nonexistent/app-update.yml',
    userDataPath: '/nonexistent',
    baseCachePath: '/nonexistent',
    whenReady: async () => {},
    quit: () => {},
    relaunch: () => {},
    onQuit: () => {}
  }
  const updater = new AppUpdater(null, app)

  updater.logger = null
  updater.autoDownload = false
  updater.stagingUserIdPromise = { value: Promise.resolve('offline-proof') }
  updater.clientPromise = Promise.resolve({
    setRequestHeaders: () => {},
    getLatestVersion: async () =>
      parseUpdateInfo(feedText, 'latest-mac.yml', new URL('https://offline.invalid/latest-mac.yml'))
  })

  const release = os.release

  os.release = () => kernel

  try {
    return (await updater.doCheckForUpdates()).isUpdateAvailable
  } finally {
    os.release = release
  }
}

describe('latest-mac.yml minimumSystemVersion — the real electron-updater 6.8.9, offline', () => {
  it('is the updater v0.0.4 ships (6.8.9) with its own semver', () => {
    assert.equal(fromUpdater('./package.json').version, '6.8.9', updaterDir)
    assert.match(fromUpdater('semver/package.json').version, /^7\.7\./)
  })

  it('semver, as the updater compares: a macOS 12 kernel is below 22.0.0, a macOS 13 kernel is not', () => {
    assert.equal(semver.lt('21.6.0', '22.0.0'), true)
    assert.equal(semver.lt('22.1.0', '22.0.0'), false)
    assert.equal(semver.lt('25.0.0', '22.0.0'), false)
    // Why never a macOS number: '13.0' throws (the updater then allows), '13.0.0' is below every kernel.
    assert.throws(() => semver.lt('21.6.0', '13.0'))
    assert.equal(semver.lt('21.6.0', '13.0.0'), false)
  })

  it('stamped feed: macOS 12 (Darwin 21.6.0) is refused; macOS 13 (22.1.0) and later are offered', async () => {
    assert.match(STAMPED, /^minimumSystemVersion: 22\.0\.0$/m)
    assert.equal(await v004Answers(STAMPED, '21.6.0'), false)
    assert.equal(await v004Answers(STAMPED, '21.0.0'), false)
    assert.equal(await v004Answers(STAMPED, '22.1.0'), true)
    assert.equal(await v004Answers(STAMPED, '25.2.0'), true)
  })

  it('the bug it fixes: the unstamped feed is offered to macOS 12; a macOS-numbered value fails open', async () => {
    assert.equal(await v004Answers(FEED, '21.6.0'), true)
    assert.equal(await v004Answers(`${FEED}minimumSystemVersion: '13.0'\n`, '21.6.0'), true)
    assert.equal(await v004Answers(`${FEED}minimumSystemVersion: 13.0.0\n`, '21.6.0'), true)
  })
})
