import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

import { describe, expect, it, vi } from 'vitest'

import {
  createLabCancelToken,
  createLabUpdater,
  LAB_FEED_ENV,
  parseLatestMacYml,
  resolveLabFeed
} from './app-update-lab'
import { createAppUpdate } from './iclone-app-update'

const ZIP = Buffer.alloc(64 * 1024, 7)
const SHA = createHash('sha512').update(ZIP).digest('base64')

function yml(version: string, sha512 = SHA) {
  return `version: ${version}\nfiles:\n  - url: iclone-os-${version}-arm64-mac.zip\n    sha512: ${sha512}\n    size: ${ZIP.length}\npath: iclone-os-${version}-arm64-mac.zip\nsha512: ${sha512}\nreleaseDate: '2026-10-18T12:00:00.000Z'\n`
}

function fakeFetch(feed: string) {
  return vi.fn(async (url: string) => {
    if (url.endsWith('/latest-mac.yml')) {
      return new Response(feed, { status: 200 })
    }

    const chunks = [ZIP.subarray(0, 16384), ZIP.subarray(16384, 40000), ZIP.subarray(40000)]

    return new Response(
      new ReadableStream({
        pull(controller) {
          const next = chunks.shift()
          next ? controller.enqueue(new Uint8Array(next)) : controller.close()
        }
      }),
      { headers: { 'content-length': String(ZIP.length) }, status: 200 }
    )
  }) as unknown as typeof fetch
}

describe('resolveLabFeed', () => {
  it('honours a loopback http feed only in an unpackaged run', () => {
    expect(resolveLabFeed({ [LAB_FEED_ENV]: 'http://127.0.0.1:47999/' }, false)).toBe('http://127.0.0.1:47999')
    expect(resolveLabFeed({ [LAB_FEED_ENV]: 'http://127.0.0.1:47999' }, true)).toBeNull()
    expect(resolveLabFeed({ [LAB_FEED_ENV]: 'https://evil.example/feed' }, false)).toBeNull()
    expect(resolveLabFeed({ [LAB_FEED_ENV]: 'file:///tmp/x' }, false)).toBeNull()
    expect(resolveLabFeed({ [LAB_FEED_ENV]: 'not a url' }, false)).toBeNull()
    expect(resolveLabFeed({}, false)).toBeNull()
  })
})

describe('parseLatestMacYml', () => {
  it('reads version, file, sha512 and size of the first file', () => {
    expect(parseLatestMacYml(yml('0.0.9'))).toEqual({
      path: 'iclone-os-0.0.9-arm64-mac.zip',
      sha512: SHA,
      size: ZIP.length,
      version: '0.0.9'
    })
    expect(parseLatestMacYml('releaseDate: x')).toBeNull()
  })
})

describe('createLabUpdater through createAppUpdate', () => {
  function lab(feedText: string, currentVersion = '0.0.2') {
    const lines: string[] = []

    const updater = createLabUpdater({
      currentVersion,
      feed: 'http://127.0.0.1:1',
      fetchImpl: fakeFetch(feedText),
      log: l => lines.push(l)
    })

    const ctl = createAppUpdate({
      createCancelToken: createLabCancelToken,
      currentVersion,
      env: {},
      log: l => lines.push(l),
      runtimeUpdateInFlight: () => false,
      updater
    })

    return { ctl, lines, updater }
  }

  it('offers the newer feed version, streams the zip, verifies sha512 and records quitAndInstall', async () => {
    const { ctl, lines, updater } = lab(yml('0.0.9'))
    await ctl.check()
    expect(ctl.state()).toMatchObject({ next: '0.0.9', phase: 'available' })
    ctl.download()
    await vi.waitFor(() => expect(ctl.state().phase).toBe('downloaded'))
    expect(ctl.state().progress).toEqual({ done: ZIP.length, percent: 100, total: ZIP.length })
    expect(ctl.restart()).toEqual({ outcome: 'installing' })
    expect(updater.installs()).toBe(1)
    expect(lines.filter(l => l.includes('lab: quitAndInstall(false,true)'))).toHaveLength(1)
  })

  it('the same version is up to date; a bad sha512 is the verify copy', async () => {
    const same = lab(yml('0.0.2'))
    await same.ctl.check()
    expect(same.ctl.state().phase).toBe('up-to-date')

    const bad = lab(yml('0.0.9', 'AAAA'))
    await bad.ctl.check()
    bad.ctl.download()
    await vi.waitFor(() => expect(bad.ctl.state().phase).toBe('error'))
    expect(bad.ctl.state().error?.kind).toBe('verify')
    expect(bad.updater.installs()).toBe(0)
  })

  it('across the scheme change: the 0.0.0.2-labelled build is offered 0.0.3; 0.0.3 is never offered 0.0.2', async () => {
    for (const installed of ['0.0.2', '0.0.0.2']) {
      const { ctl } = lab(yml('0.0.3'), installed)
      await ctl.check()
      expect(ctl.state()).toMatchObject({ next: '0.0.3', phase: 'available' })
    }

    const newer = lab(yml('0.0.2'), '0.0.3')
    await newer.ctl.check()
    expect(newer.ctl.state().phase).toBe('up-to-date')
  })

  it('electron-updater itself (its own semver) sees the installed 0.0.2 as older than 0.0.3', () => {
    // The shipped "v0.0.0.2" build reports app.getVersion() = package.json "0.0.2" (Finder showed the four-digit label);
    // electron-updater parses that with its bundled semver and offers only a strictly greater feed version.
    const local = createRequire(import.meta.url)

    const semver = createRequire(local.resolve('electron-updater'))('semver') as {
      gt: (a: string, b: string) => boolean
      valid: (v: string) => null | string
    }

    expect(semver.gt('0.0.3', '0.0.2')).toBe(true)
    expect(semver.gt('0.0.2', '0.0.3')).toBe(false)
    expect(semver.valid('0.0.0.2')).toBeNull()
  })

  it('a cancelled download goes back to available', async () => {
    const { ctl } = lab(yml('0.0.9'))
    await ctl.check()
    ctl.download()
    expect(ctl.cancel()).toBe(true)
    await vi.waitFor(() => expect(ctl.state().phase).toBe('available'))
  })

  it('a feed with no latest-mac.yml (404) is up to date', async () => {
    const lines: string[] = []
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 })) as unknown as typeof fetch

    const updater = createLabUpdater({
      currentVersion: '0.0.2',
      feed: 'http://127.0.0.1:1',
      fetchImpl,
      log: l => lines.push(l)
    })

    const ctl = createAppUpdate({
      currentVersion: '0.0.2',
      env: {},
      log: l => lines.push(l),
      runtimeUpdateInFlight: () => false,
      updater
    })

    await ctl.check()
    expect(ctl.state()).toMatchObject({ error: null, phase: 'up-to-date' })
  })
})
