/**
 * The lab's stand-in for electron-updater (dev runs only): a real HTTP read of a local
 * `latest-mac.yml`, a streamed download of the zip it names with the sha512 check, and a
 * quitAndInstall that is recorded, never executed. Honoured only when the app is not packaged
 * and the feed is on the loopback interface.
 */

import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'

import { compareAppVersions } from '../src/iclone-shared/version'

import { APP_UPDATE_LOG_TAG, type UpdaterLike } from './iclone-app-update'

export const LAB_FEED_ENV = 'ICLONE_APP_UPDATE_LAB_FEED'

export function resolveLabFeed(env: Record<string, string | undefined>, isPackaged: boolean): null | string {
  const raw = env[LAB_FEED_ENV]?.trim()

  if (isPackaged || !raw) {
    return null
  }

  try {
    const url = new URL(raw)

    if (url.protocol !== 'http:' || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')) {
      return null
    }

    return url.href.replace(/\/+$/, '')
  } catch {
    return null
  }
}

interface LabFeedEntry {
  path: string
  sha512: string
  size: number
  version: string
}

/** The fields of electron-builder's `latest-mac.yml` the lab needs (first `files` entry). */
export function parseLatestMacYml(text: string): LabFeedEntry | null {
  const field = (name: string) =>
    text.match(new RegExp(`^\\s*-?\\s*${name}:\\s*['"]?([^'"\\n]+?)['"]?\\s*$`, 'm'))?.[1] ?? ''

  const version = field('version')
  const filePath = field('url') || field('path')
  const sha512 = field('sha512')
  const size = Number(field('size'))

  if (!version || !filePath || !sha512) {
    return null
  }

  return { path: filePath, sha512, size: Number.isFinite(size) && size > 0 ? size : 0, version }
}

interface LabCancelToken {
  cancel: () => void
  cancelled: boolean
}

export function createLabCancelToken(): LabCancelToken {
  const token = {
    cancelled: false,
    cancel: () => {
      token.cancelled = true
    }
  }

  return token
}

function updaterError(message: string, code?: string): Error {
  return Object.assign(new Error(message), code ? { code } : {})
}

interface LabUpdaterDeps {
  currentVersion: string
  feed: string
  fetchImpl?: typeof fetch
  log: (line: string) => void
}

export function createLabUpdater(deps: LabUpdaterDeps): UpdaterLike & { installs: () => number } {
  const events = new EventEmitter()
  const fetchImpl = deps.fetchImpl ?? fetch
  let offered: LabFeedEntry | null = null
  let installs = 0

  const fail = (err: Error): never => {
    events.emit('error', err)

    throw err
  }

  const updater = {
    allowDowngrade: false,
    allowPrerelease: false,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    on: (event: string, listener: (...args: any[]) => void) => events.on(event, listener),
    installs: () => installs,
    checkForUpdates: async () => {
      events.emit('checking-for-update')

      const res = await fetchImpl(`${deps.feed}/latest-mac.yml`).catch((err: unknown) =>
        fail(updaterError(`net::ERR_CONNECTION_REFUSED ${String(err)}`))
      )

      if (res.status === 404) {
        fail(updaterError('HttpError: 404 latest-mac.yml', 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'))
      }

      const entry = res.ok ? parseLatestMacYml(await res.text()) : null

      if (!entry) {
        return fail(updaterError(`lab feed answered ${res.status} without a usable latest-mac.yml`))
      }

      const files = [{ sha512: entry.sha512, size: entry.size, url: entry.path }]

      if (compareAppVersions(entry.version, deps.currentVersion) > 0) {
        offered = entry
        events.emit('update-available', { files, version: entry.version })
      } else {
        offered = null
        events.emit('update-not-available', { files, version: entry.version })
      }

      return { updateInfo: { files, version: entry.version } }
    },
    downloadUpdate: async (token?: LabCancelToken) => {
      const entry = offered ?? fail(updaterError('lab: nothing offered to download'))
      const res = await fetchImpl(`${deps.feed}/${entry.path}`)

      if (!res.ok || !res.body) {
        fail(updaterError(`lab download answered ${res.status}`))
      }

      const total = Number(res.headers.get('content-length')) || entry.size
      const hash = createHash('sha512')
      const reader = (res.body as ReadableStream<Uint8Array>).getReader()
      let transferred = 0

      for (;;) {
        if (token?.cancelled) {
          await reader.cancel()
          fail(Object.assign(new Error('cancelled'), { name: 'CancellationError' }))
        }

        const { done, value } = await reader.read()

        if (done) {
          break
        }

        hash.update(value)
        transferred += value.byteLength
        events.emit('download-progress', {
          bytesPerSecond: 0,
          percent: total > 0 ? (transferred / total) * 100 : 0,
          total,
          transferred
        })
      }

      const digest = hash.digest('base64')

      if (digest !== entry.sha512) {
        fail(updaterError(`sha512 checksum mismatch, expected ${entry.sha512}, got ${digest}`))
      }

      events.emit('update-downloaded', {
        files: [{ sha512: entry.sha512, size: total, url: entry.path }],
        version: entry.version
      })

      return []
    },
    quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => {
      installs += 1
      deps.log(`${APP_UPDATE_LOG_TAG} lab: quitAndInstall(${String(isSilent)},${String(isForceRunAfter)})`)
    }
  }

  deps.log(`${APP_UPDATE_LOG_TAG} lab feed ${deps.feed} (dev run; installs are recorded, never executed)`)

  return updater
}
