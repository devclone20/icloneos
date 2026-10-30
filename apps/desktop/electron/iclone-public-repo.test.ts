import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  latestReleaseAssetUrl,
  PUBLIC_LATEST_RELEASE_URL,
  PUBLIC_REPOSITORY,
  releaseTagUrl
} from '../src/iclone-shared/public-repo'

import { APP_UPDATE_FEED } from './iclone-app-update'
import { RELEASES_URL } from './iclone-doctor-checks'

const DESKTOP = path.resolve(__dirname, '..')
// The icloneOS layer the app ships as extraResources (skills, plugins, contracts, runtime pin).
const ICLONE = path.resolve(DESKTOP, '..', '..', 'iclone')
const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'))

// Spelled in two halves so this file is not itself a hit of the scan below.
const ARCHIVED_RELEASES_REPO = ['iclone-os', 'releases'].join('-')

const SOURCE = /\.(c|m)?[jt]sx?$/
const TEXT = /\.(c|m)?[jt]sx?$|\.(md|json|ya?ml|txt|toml|sh|py|html|css)$/

function shippedFiles(dir: string, kind: RegExp = SOURCE): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : shippedFiles(full, kind)
    }

    return kind.test(entry.name) && !/\.test\.[cm]?[jt]sx?$/.test(entry.name) ? [full] : []
  })
}

describe('the app reads releases from devclone20/icloneos only', () => {
  it('pins the feed owner/repo: build.publish, the repository field, the logged feed and every release link agree', () => {
    expect(PUBLIC_REPOSITORY).toBe('devclone20/icloneos')
    expect(pkg.build.publish).toEqual([
      { provider: 'github', owner: 'devclone20', repo: 'icloneos', releaseType: 'release' }
    ])
    // electron-builder falls back to `repository` when a token selects the github provider without build.publish.
    expect(pkg.repository.url).toBe('git+https://github.com/devclone20/icloneos.git')
    expect(APP_UPDATE_FEED).toBe('github:devclone20/icloneos/latest-mac.yml')
    expect(RELEASES_URL).toBe('https://github.com/devclone20/icloneos/releases/latest')
    expect(PUBLIC_LATEST_RELEASE_URL).toBe(RELEASES_URL)
    expect(releaseTagUrl('0.0.3')).toBe('https://github.com/devclone20/icloneos/releases/tag/v0.0.3')
    expect(latestReleaseAssetUrl('runtime.json')).toBe(
      'https://github.com/devclone20/icloneos/releases/latest/download/runtime.json'
    )
  })

  it('the release script reads its rollback reference from the public repo', () => {
    const script = fs.readFileSync(path.join(DESKTOP, 'scripts', 'release-mac.mjs'), 'utf8')
    const feed = /^export const FEED_LATEST = '([^']+)'$/m.exec(script)?.[1]

    expect(feed).toBe('https://github.com/devclone20/icloneos/releases/latest/download/latest-mac.yml')
  })

  it('never contacts the archived releases repo: no shipped source, release script or iclone/ resource names it', () => {
    const scanned = [
      ...shippedFiles(path.join(DESKTOP, 'electron')),
      ...shippedFiles(path.join(DESKTOP, 'src')),
      ...shippedFiles(path.join(DESKTOP, 'scripts')),
      ...shippedFiles(ICLONE, TEXT)
    ]

    const hits = scanned
      .filter(file => fs.readFileSync(file, 'utf8').includes(ARCHIVED_RELEASES_REPO))
      .map(file => path.relative(DESKTOP, file))

    expect(scanned.some(file => file.startsWith(ICLONE + path.sep))).toBe(true)
    expect(scanned.some(file => file.includes(`${path.sep}scripts${path.sep}release-mac.mjs`))).toBe(true)
    expect(hits).toEqual([])
    expect(JSON.stringify(pkg)).not.toContain(ARCHIVED_RELEASES_REPO)
  })

  it('the shipped iclone/ layer never names the private development repo (the public snapshot carries it)', () => {
    const privateRepo = new RegExp(`devclone20/${['iclone', 'os'].join('-')}(?![\\w.-])`)

    const hits = shippedFiles(ICLONE, TEXT)
      .filter(file => privateRepo.test(fs.readFileSync(file, 'utf8')))
      .map(file => path.relative(DESKTOP, file))

    expect(hits).toEqual([])
  })
})
