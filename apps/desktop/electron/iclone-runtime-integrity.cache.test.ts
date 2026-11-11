/**
 * L4-01: the runtime check before every spawn never freezes the main thread, and its per-file cache never lets a changed
 * file through. Real artifact of the compiled pin, temp trees only (never ~/.hermes, never the network).
 *
 * - a second check with nothing changed opens no file of the runtime (every digest comes from its unchanged stamp);
 * - after a cached pass, a same-size edit whose mtime is put back with utimes is still caught (its ctime moved), an
 *   added file never runs, a removed file is caught.
 * The 30 000-file event-loop gate is perf-v007/runtime-integrity.perf.test.ts (alone in its fork: it measures time).
 */
import fs from 'node:fs'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { DigestCache } from './iclone-runtime-digest'
import { RUNTIME_SOURCE_MARKER } from './iclone-runtime-integrity'
import {
  canBuildPinnedArtifact,
  dependencyLayout,
  type RuntimeFixture,
  runtimeFixture
} from './iclone-runtime-integrity.test-helpers'

const SUITE = process.platform !== 'win32' && canBuildPinnedArtifact() ? describe : describe.skip

/** The racy window of the digest cache (2 s) plus margin: a file changed this recently is hashed again, never trusted. */
const PAST_RACY_WINDOW_MS = 2_100

let fx: RuntimeFixture

beforeAll(async () => {
  if (canBuildPinnedArtifact()) {
    fx = await runtimeFixture()
  }
}, 120_000)

afterAll(async () => {
  if (fx?.tmp) {
    await fs.promises.rm(fx.tmp, { force: true, recursive: true })
  }
}, 300_000)

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Files of the runtime opened while `work` runs (opening is the only way the check reads a file's bytes). */
async function filesOpened<T>(root: string, work: () => Promise<T>): Promise<{ opened: string[]; result: T }> {
  const open = vi.spyOn(fs.promises, 'open')

  try {
    const result = await work()

    return { opened: open.mock.calls.map(call => String(call[0])).filter(file => file.startsWith(root)), result }
  } finally {
    open.mockRestore()
  }
}

/**
 * A time utimes can set to the exact nanosecond (a double of seconds holds .5 exactly) and not on a whole second (a
 * whole-second stamp is never trusted, see iclone-runtime-digest.ts), so the edit below can restore it bit for bit.
 */
const EXACT_TIME_S = 1_700_000_000.5

/** Before the cached pass: the file's atime/mtime set to EXACT_TIME_S (sameSizeEdit restores exactly that). */
function pinTimes(file: string): void {
  fs.utimesSync(file, EXACT_TIME_S, EXACT_TIME_S)
}

/** One byte flipped in place: same size, same inode; then atime/mtime put back to the nanosecond. Only ctime can tell. */
function sameSizeEdit(file: string): void {
  const before = fs.lstatSync(file, { bigint: true })
  expect(before.mtimeNs).toBe(1_700_000_000_500_000_000n)

  const bytes = fs.readFileSync(file)
  const at = bytes.indexOf(0x0a) > 0 ? bytes.indexOf(0x0a) - 1 : 0
  bytes[at] = bytes[at] === 0x23 ? 0x20 : 0x23
  fs.writeFileSync(file, bytes)
  fs.utimesSync(file, EXACT_TIME_S, EXACT_TIME_S)

  const after = fs.lstatSync(file, { bigint: true })
  expect(after.size).toBe(before.size)
  expect(after.ino).toBe(before.ino)
  expect(after.dev).toBe(before.dev)
  expect(after.mode).toBe(before.mode)
  expect(after.mtimeNs).toBe(before.mtimeNs)
  expect(after.ctimeNs).not.toBe(before.ctimeNs)
}

SUITE('L4-01: the runtime check trusts a digest only while its file keeps its stamp', { timeout: 300_000 }, () => {
  it('after a cached pass: a same-size edit with its mtime put back is caught (dependency refused, runtime file repaired)', async () => {
    const root = await fx.managedTree('same-stamp-tamper')
    const policy = path.join(root, 'hermes_cli', 'iclone_policy_env.py')
    const dependency = path.join(dependencyLayout(root).site, 'yaml.py')
    pinTimes(policy)
    pinTimes(dependency)
    const digests = new DigestCache()
    await pause(PAST_RACY_WINDOW_MS)
    expect((await fx.run(root, { digests })).action).toBe('verified')
    const hashed = digests.hashedFiles
    const again = await filesOpened(root, () => fx.run(root, { digests }))
    expect(again.result.action).toBe('verified')
    // The pass the edit must beat really trusted the stamps: no runtime file was opened, nothing hashed again.
    expect(again.opened).toEqual([])
    expect(digests.hashedFiles).toBe(hashed)

    const shipped = fs.readFileSync(policy)
    sameSizeEdit(policy)

    const repaired = await fx.run(root, { digests })
    expect(repaired.action).toBe('repaired')
    expect(repaired.repaired).toEqual(['hermes_cli/iclone_policy_env.py'])
    expect(fs.readFileSync(policy)).toEqual(shipped)

    expect((await fx.run(root, { digests })).action).toBe('verified')
    sameSizeEdit(dependency)
    await expect(fx.run(root, { digests })).rejects.toThrow(/Python environment changed or are missing .*yaml\.py/)
  })

  it('after a cached pass: a checkout (verify only) with a same-size edit and its mtime put back is refused', async () => {
    const root = await fx.managedTree('same-stamp-checkout')
    fs.rmSync(path.join(root, RUNTIME_SOURCE_MARKER))
    fs.mkdirSync(path.join(root, '.git'))
    pinTimes(path.join(root, 'tools', 'approval.py'))
    const digests = new DigestCache()
    await pause(PAST_RACY_WINDOW_MS)
    expect((await fx.run(root, { digests })).action).toBe('verified-checkout')

    sameSizeEdit(path.join(root, 'tools', 'approval.py'))
    await expect(fx.run(root, { digests })).rejects.toThrow(/git checkout that differs .*tools\/approval\.py/)
  })

  it('after a cached pass: an added file never runs (removed before the verdict); a removed file is caught', async () => {
    const root = await fx.managedTree('added-removed')
    const { site } = dependencyLayout(root)
    const digests = new DigestCache()
    await pause(PAST_RACY_WINDOW_MS)
    expect((await fx.run(root, { digests })).action).toBe('verified')

    fs.writeFileSync(path.join(root, 'sitecustomize.py'), 'planted\n')
    fs.writeFileSync(path.join(site, 'zz_planted.pth'), 'import os\n')
    expect((await fx.run(root, { digests })).action).toBe('verified')
    expect(fs.existsSync(path.join(root, 'sitecustomize.py'))).toBe(false)
    expect(fs.existsSync(path.join(site, 'zz_planted.pth'))).toBe(false)

    fs.rmSync(path.join(root, 'tools', 'approval.py'))
    const repaired = await fx.run(root, { digests })
    expect(repaired.action).toBe('repaired')
    expect(repaired.repaired).toEqual(['tools/approval.py'])

    fs.rmSync(path.join(site, 'yaml.py'))
    await expect(fx.run(root, { digests })).rejects.toThrow(/Python environment changed or are missing .*yaml\.py/)
  })
})
