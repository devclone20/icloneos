/**
 * V3-S r3 (m-d), r4b (lead ruling 38, revised): a runtime tree is managed iff its path is the app's runtime folder for
 * the pinned runtime, its manifest is the one the signed app pins, and its stamp names that runtime and this app —
 * with no git work tree in the way. No key, no keychain. Temp dirs only.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  gitWorkTreeAt,
  ICLONE_MANAGED_FILE,
  type ManagedPin,
  managedRuntime,
  managedStampFor,
  readManagedStamp,
  refreshStampAppVersion,
  RUNTIME_MANIFEST_FILE,
  writeManagedStamp
} from './iclone-managed-runtime'

const temps: string[] = []

function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3s-managed-'))
  temps.push(dir)

  return dir
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

const LOCK = 'c'.repeat(64)
const MANIFEST = '{"files":{"hermes_cli/main.py":"0123"}}\n'
const MANIFEST_SHA = createHash('sha256').update(MANIFEST).digest('hex')
const STAMP = () => managedStampFor({ appVersion: '0.0.3', lockHash: LOCK, runtimeSha: '1'.repeat(40) })

/** A tree as V3-RT installs it at `root`: the release's manifest and the app's stamp. */
function install(root: string, manifest = MANIFEST): string {
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, RUNTIME_MANIFEST_FILE), manifest)
  writeManagedStamp(root, STAMP())

  return root
}

const pinFor = (root: string, over: Partial<ManagedPin> = {}): ManagedPin => ({
  appVersion: '0.0.3',
  lockHash: LOCK,
  manifestSha256: MANIFEST_SHA,
  root,
  ...over
})

describe('the managed stamp', () => {
  it('round-trips what the installer writes: install id, lock hash, runtime sha, app version', () => {
    const root = temp()
    const stamp = STAMP()
    writeManagedStamp(root, stamp)

    expect(readManagedStamp(root)).toEqual(stamp)
    expect(stamp.installId).toMatch(/^[0-9a-f-]{36}$/)
    expect(STAMP().installId).not.toBe(stamp.installId)
  })

  it('anything else is no stamp: missing, malformed, a bad hash, an old schema, a symlink, oversized', () => {
    const cases: Array<(root: string) => void> = [
      () => undefined,
      root => fs.writeFileSync(path.join(root, ICLONE_MANAGED_FILE), '{'),
      root => fs.writeFileSync(path.join(root, ICLONE_MANAGED_FILE), JSON.stringify({ ...STAMP(), lockHash: 'x' })),
      root => fs.writeFileSync(path.join(root, ICLONE_MANAGED_FILE), JSON.stringify({ ...STAMP(), schema: 1 })),
      root => {
        const real = temp()
        writeManagedStamp(real, STAMP())
        fs.symlinkSync(path.join(real, ICLONE_MANAGED_FILE), path.join(root, ICLONE_MANAGED_FILE))
      },
      root =>
        fs.writeFileSync(path.join(root, ICLONE_MANAGED_FILE), JSON.stringify({ ...STAMP(), pad: 'x'.repeat(5000) }))
    ]

    for (const plant of cases) {
      const root = temp()
      fs.writeFileSync(path.join(root, RUNTIME_MANIFEST_FILE), MANIFEST)
      plant(root)

      expect(readManagedStamp(root)).toBeNull()
      expect(managedRuntime(root, [], pinFor(root))).toMatchObject({ managed: false })
    }
  })
})

describe('ruling 38 (revised): managed = the pinned path + the pinned manifest + a stamp naming them, no key', () => {
  it('the legitimate tree is managed', () => {
    const root = install(path.join(temp(), 'hermes-runtime', LOCK))

    expect(managedRuntime(root, [], pinFor(root))).toMatchObject({ managed: true })
  })

  it('a forged stamp beside a manifest that is not the release’s (or none) ⇒ not managed', () => {
    const forged = install(path.join(temp(), 'hermes-runtime', LOCK), '{"files":{"evil.py":"x"}}\n')
    const bare = path.join(temp(), 'hermes-runtime', LOCK)
    fs.mkdirSync(bare, { recursive: true })
    writeManagedStamp(bare, STAMP())

    expect(managedRuntime(forged, [], pinFor(forged))).toMatchObject({
      managed: false,
      reason: expect.stringMatching(/has a runtime manifest other than this release's/)
    })
    expect(managedRuntime(bare, [], pinFor(bare))).toMatchObject({
      managed: false,
      reason: expect.stringMatching(/has no runtime manifest of this release's/)
    })
  })

  it('the right manifest and stamp at the wrong path (~/.hermes/hermes-agent, a sibling, a link) ⇒ not managed', () => {
    const home = temp()
    const pinned = path.join(temp(), 'hermes-runtime', LOCK)
    const copy = install(path.join(home, '.hermes', 'hermes-agent'))
    const link = path.join(temp(), 'hermes-runtime')
    fs.mkdirSync(link)
    fs.symlinkSync(copy, path.join(link, LOCK))

    expect(managedRuntime(copy, [], pinFor(pinned))).toMatchObject({
      managed: false,
      reason: expect.stringMatching(/is not the app's runtime folder/)
    })
    expect(managedRuntime(`${pinned}-x`, [], pinFor(pinned))).toMatchObject({ managed: false })
    expect(managedRuntime(path.join(link, LOCK), [], pinFor(path.join(link, LOCK)))).toMatchObject({
      managed: false,
      reason: expect.stringMatching(/is a symbolic link/)
    })
  })

  it('a stamp naming another runtime, or a release that pins no manifest ⇒ not managed', () => {
    const root = install(path.join(temp(), 'hermes-runtime', LOCK))

    expect(managedRuntime(root, [], pinFor(root, { lockHash: 'e'.repeat(64) }))).toMatchObject({
      managed: false,
      reason: expect.stringMatching(/installed from runtime cccccccccccc, not this release's eeeeeeeeeeee/)
    })
    expect(managedRuntime(root, [], pinFor(root, { manifestSha256: null }))).toMatchObject({
      managed: false,
      reason: 'this release pins no runtime manifest'
    })
  })

  it('m-d″: the app version is informational — an older app’s stamp is still managed; refreshing touches the stamp only', () => {
    const root = install(path.join(temp(), 'hermes-runtime', LOCK))
    fs.writeFileSync(path.join(root, 'main.py'), '# runtime\n')
    const verdict = managedRuntime(root, [], pinFor(root, { appVersion: '0.0.4' }))

    expect(verdict).toMatchObject({ managed: true, stamp: { appVersion: '0.0.3' } })

    const before = fs.statSync(path.join(root, 'main.py')).mtimeMs
    const stamp = readManagedStamp(root)!

    expect(refreshStampAppVersion(root, stamp, '0.0.4')).toBe(true)
    expect(readManagedStamp(root)).toEqual({ ...stamp, appVersion: '0.0.4' })
    expect(refreshStampAppVersion(root, readManagedStamp(root)!, '0.0.4')).toBe(false)
    expect(fs.statSync(path.join(root, 'main.py')).mtimeMs).toBe(before)
  })

  it('the stamp file carries no secret and nothing is signed (no key exists to lose or to unlock)', () => {
    const root = install(temp())
    const raw = JSON.parse(fs.readFileSync(path.join(root, ICLONE_MANAGED_FILE), 'utf8')) as Record<string, unknown>

    expect(Object.keys(raw).sort()).toEqual([
      'appVersion',
      'installId',
      'installedAt',
      'lockHash',
      'runtimeSha',
      'schema'
    ])
  })
})

describe('gitWorkTreeAt', () => {
  it('finds a .git (directory or file) from the plugin folder up to the runtime root, or inside the plugin folder', () => {
    const root = temp()
    const plugin = path.join(root, 'plugins', 'iclone-permissions')
    fs.mkdirSync(path.join(plugin, 'sub'), { recursive: true })

    expect(gitWorkTreeAt(root, plugin)).toBeNull()

    fs.writeFileSync(path.join(plugin, 'sub', '.git'), 'gitdir: /elsewhere\n')
    expect(gitWorkTreeAt(root, plugin)).toBe(path.join(plugin, 'sub', '.git'))
    fs.rmSync(path.join(plugin, 'sub', '.git'))

    fs.mkdirSync(path.join(root, 'plugins', '.git'))
    expect(gitWorkTreeAt(root, plugin)).toBe(path.join(root, 'plugins', '.git'))
    fs.rmSync(path.join(root, 'plugins', '.git'), { recursive: true })

    fs.mkdirSync(path.join(root, '.git'))
    expect(gitWorkTreeAt(root, plugin)).toBe(path.join(root, '.git'))
    expect(managedRuntime(install(root), [plugin], pinFor(root))).toMatchObject({
      managed: false,
      reason: expect.stringMatching(/makes it a git work tree/)
    })
  })

  it('stops AT the runtime root: a repository above it (the owner’s home is one) does not count', () => {
    const home = temp()
    fs.mkdirSync(path.join(home, '.git'))
    const root = path.join(home, 'Library', 'hermes-runtime', LOCK)
    const plugin = path.join(root, 'plugins', 'iclone-permissions')
    fs.mkdirSync(plugin, { recursive: true })
    install(root)

    expect(gitWorkTreeAt(root, plugin)).toBeNull()
    expect(managedRuntime(root, [plugin], pinFor(root))).toMatchObject({ managed: true })
  })
})
