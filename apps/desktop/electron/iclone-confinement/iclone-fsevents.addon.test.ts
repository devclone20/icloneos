/**
 * v0.0.7 FSEV — our own FSEvents addon, on the real fseventsd (macOS only; skipped where the addon is not built).
 *
 * Proves what the F7 guard rests on: a start that FSEvents did not take throws (missing, unreadable, not absolute,
 * and fseventsd unreachable under a Seatbelt profile that denies its mach service, the L1-1 case fsevents 2.3.2 hid);
 * the same-stream canary barrier delivers a link made just before it with no sleep, in id order; stop is idempotent and
 * every stream is released (activeCount back to its start).
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { addonCandidates, type FsEventRecord, loadIcloneFsevents } from './iclone-fsevents'

const addon = loadIcloneFsevents()
const temp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'iclone-fsev-test-')))
const baseline = addon?.activeCount() ?? 0

afterAll(() => {
  chmodSync(temp, 0o700)
  rmSync(temp, { recursive: true, force: true })
})

const dir = (name: string) => {
  const made = path.join(temp, name)

  mkdirSync(made, { recursive: true })

  return made
}

const builtAddon = () => addonCandidates().find(candidate => existsSync(candidate)) ?? ''

const until = async (done: () => boolean, ms = 2_000) => {
  const deadline = Date.now() + ms

  while (!done() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }

  return done()
}

describe.skipIf(!addon)('iclone_fsevents addon (real fseventsd)', () => {
  const fse = addon!

  /** Before a stream's first callback the addon reports FSEvents' SinceNow sentinel (2^64 - 1) as its latest id: no
   *  delivered event has an id that high, so it (and null) means "no callback yet", never "past". */
  const SINCE_NOW = 2n ** 64n - 1n

  const deliveredId = (handle: Parameters<typeof fse.stop>[0]): bigint | null => {
    const latest = fse.latestEventId(handle)

    return latest === null || BigInt(latest) >= SINCE_NOW ? null : BigInt(latest)
  }

  /**
   * CF6 (B4-m1): the stream made live and quiet before a drop is armed. A marker folder made in the watched tree (one
   * mkdir is one event: it cannot split over two batches, as a file's create and write can) is delivered to the
   * callback, so the stream has run its callback and its latest id is a real event id, the one the drop wait compares
   * against. Then flush until no event arrives for two rounds, so the armed drop can only take a batch written after
   * it. Returns that id.
   */
  const makeLive = async (
    handle: Parameters<typeof fse.stop>[0],
    marker: string,
    delivered: () => boolean,
    events: () => number
  ): Promise<bigint> => {
    await mkdir(marker)

    const deadline = Date.now() + 5_000

    while (!delivered() && Date.now() < deadline) {
      await fse.flush(handle)
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    expect(delivered()).toBe(true)

    for (let quiet = 0, last = events(); quiet < 2 && Date.now() < deadline;) {
      await fse.flush(handle)
      await new Promise(resolve => setTimeout(resolve, 100))
      quiet = events() === last ? quiet + 1 : 0
      last = events()
    }

    const live = deliveredId(handle)

    expect(live).not.toBeNull()

    return live!
  }

  /**
   * CF5 (A2-m6) + CF6 (B4-m1): the armed drop takes exactly the batch that holds the write. Flush until the stream's
   * latest DELIVERED id (it moves when the callback runs, before the addon drops the batch) passes `live`, the real id
   * of the marker makeLive saw delivered: the dropped batch is behind us, and only then does the test write again.
   */
  const untilDropped = async (handle: Parameters<typeof fse.stop>[0], live: bigint) => {
    const deadline = Date.now() + 5_000
    const past = () => (deliveredId(handle) ?? live) > live

    while (!past() && Date.now() < deadline) {
      await fse.flush(handle)
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    return past()
  }

  it('loads only from its two fixed places', () => {
    expect(addonCandidates().every(candidate => candidate.endsWith('iclone_fsevents.node'))).toBe(true)
    expect(fse.currentEventId()).toMatch(/^[1-9][0-9]*$/)
  })

  it('a start FSEvents did not take throws: missing, unreadable, relative, too many paths', () => {
    const locked = dir('locked')

    chmodSync(locked, 0)

    expect(() => fse.start(path.join(temp, 'missing'), () => undefined)).toThrow(
      expect.objectContaining({ code: 'ENOENT' })
    )
    expect(() => fse.start(locked, () => undefined)).toThrow(expect.objectContaining({ code: 'EACCES' }))
    expect(() => fse.start('relative/path', () => undefined)).toThrow(expect.objectContaining({ code: 'EINVAL' }))
    expect(() => fse.start([temp, temp, temp, temp, temp], () => undefined)).toThrow(/between 1 and 4/)
    expect(() => fse.start([], () => undefined)).toThrow(/between 1 and 4/)
    expect(fse.activeCount()).toBe(baseline)
    chmodSync(locked, 0o700)
  })

  it('throws when fseventsd refuses the stream (Seatbelt denies com.apple.FSEvents), where fsevents 2.3.2 was silent', () => {
    const sandboxed = dir('sandboxed')
    const profile = path.join(temp, 'deny-fsevents.sb')
    const addonPath = builtAddon()

    const script = [
      `const a = require(${JSON.stringify(addonPath)})`,
      'let threw = null',
      `try { a.stop(a.start(${JSON.stringify(sandboxed)}, () => {})) } catch (e) { threw = e.code + ': ' + e.message }`,
      'process.stdout.write(JSON.stringify({ threw }))'
    ].join('\n')

    writeFileSync(profile, '(version 1)(allow default)(deny mach-lookup (global-name "com.apple.FSEvents"))')

    const denied = spawnSync('/usr/bin/sandbox-exec', ['-f', profile, process.execPath, '-e', script], {
      encoding: 'utf8'
    })

    const allowed = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' })

    expect(JSON.parse(denied.stdout)).toEqual({
      threw: expect.stringMatching(/^EFSEVENTS: .*FSEventStreamStart failed/)
    })
    expect(JSON.parse(allowed.stdout)).toEqual({ threw: null })
  })

  it('same-stream canary barrier: a link made right before it is delivered, no sleep, 200 of 200', async () => {
    const root = dir('root')
    const canary = dir('canary')
    const outside = dir('outside')
    const secret = path.join(outside, 'secret')
    const seen = new Set<string>()
    const arrived = new Map<string, () => void>()
    let lastId = 0n
    let ordered = true

    writeFileSync(secret, 's')

    const handle = fse.start([root, canary], (events: FsEventRecord[]) => {
      for (const event of events) {
        const id = BigInt(event.id)

        ordered &&= id > lastId
        lastId = id
        seen.add(event.path)
        arrived.get(event.path)?.()
      }
    })

    try {
      let missed = 0

      for (let index = 0; index < 200; index += 1) {
        const planted = path.join(root, `planted-${index}`)

        linkSync(secret, planted)

        const before = BigInt(fse.currentEventId())
        const name = path.join(canary, `c${index}`)
        let delivered = false

        const landed = new Promise<void>(resolve =>
          arrived.set(name, () => {
            delivered = true
            resolve()
          })
        )

        await writeFile(name, '')

        for (let polls = 0; !delivered && polls < 10_000; polls += 1) {
          await fse.flush(handle)
        }

        await landed
        arrived.delete(name)
        void unlink(name)

        if (!seen.has(planted)) {
          missed += 1
        }

        expect(BigInt(fse.latestEventId(handle) ?? '0')).toBeGreaterThan(before)
      }

      expect(missed).toBe(0)
      expect(ordered).toBe(true)
    } finally {
      fse.stop(handle)
    }
    // 200 sequential barriers with a flush each: 7-10 s alone, > 30 s under the full suite's load (candidate seq on
    // 4c0fb7f79e). The assertion (200 of 200 delivered, in order) is the contract; the time budget is not. Lead ruling
    // 2026-11-11 (DECISOES_LEAD): budget 120 s. Barrier latency itself is gated by PERF.main.links / hardlink-guard.
  }, 120_000)

  it('CF1 (A-m1): a batch the addon cannot hand on is never lost silently — the next batch starts with MustScanSubDirs', async () => {
    const root = dir('dropped')
    const seen: FsEventRecord[] = []
    const handle = fse.start(root, events => seen.push(...events))

    try {
      expect(fse.testDropNextBatch).toEqual(expect.any(Function))

      const live = await makeLive(
        handle,
        path.join(root, 'marker'),
        () => seen.some(event => event.path.endsWith('/marker')),
        () => seen.length
      )

      seen.length = 0
      fse.testDropNextBatch!(handle)
      await mkdir(path.join(root, 'lost'))
      expect(await untilDropped(handle, live)).toBe(true)

      // The batch holding `lost` was dropped: nothing of it reached JS.
      expect(seen.filter(event => event.path.endsWith('/lost'))).toEqual([])

      await writeFile(path.join(root, 'next'), 'x')
      expect(await until(() => seen.some(event => event.path.endsWith('/next')))).toBe(true)

      const next = seen.findIndex(event => event.path.endsWith('/next'))
      const loss = seen.findIndex(event => (event.flags & 0x1) !== 0)

      // The loss is delivered first, on the watched root, before anything of the batch that carried it.
      expect(loss).toBeGreaterThanOrEqual(0)
      expect(loss).toBeLessThan(next)
      expect(seen[loss]).toEqual({ path: root, flags: 0x1, id: '0' })
      expect(seen.filter(event => (event.flags & 0x1) !== 0)).toHaveLength(1)
    } finally {
      fse.stop(handle)
    }
  })

  it('CF1 (A-m1): through the adapter, a dropped batch voids the stream: the barrier never vouches after it', async () => {
    const { createFsEventsSource } = await import('./hardlinks-fsevents')
    const root = dir('dropped-adapter')
    const flags: number[] = []
    let handle: unknown = null
    const start = fse.start.bind(fse)

    // Capture the handle the adapter starts, so the seam can be armed on that very stream.
    const spied = { ...fse, start: ((paths, onEvents) => (handle = start(paths, onEvents))) as typeof fse.start }
    const adapted = createFsEventsSource(spied, { tmpdir: () => dir('dropped-canary') })!

    try {
      const watch = await adapted.watch(
        root,
        (_path, flag) => flags.push(flag),
        () => undefined
      )

      const armed = handle as Parameters<typeof fse.stop>[0]
      const markerAt = flags.length

      // The root's own marker reaches the guard's callback: the stream is live, its latest id a real one.
      const live = await makeLive(
        armed,
        path.join(root, 'marker'),
        () => flags.length > markerAt,
        () => flags.length
      )

      expect(flags.every(flag => (flag & 0x1) === 0)).toBe(true)
      flags.length = 0
      fse.testDropNextBatch!(armed)
      await mkdir(path.join(root, 'planted'))
      expect(await untilDropped(armed, live)).toBe(true)
      // Nothing of the dropped batch reached the guard: no flag at all before the canary's batch.
      expect(flags).toEqual([])
      // The canary's own batch carries the loss first: the guard (hardlinks.ts onEvent) forgets the stream on it.
      await watch.barrier()
      expect(flags.some(flag => (flag & 0x1) !== 0)).toBe(true)
      expect(flags.findIndex(flag => (flag & 0x1) !== 0)).toBe(0)
      watch.stop()
    } finally {
      adapted.close()
    }
  })

  it('volume: the filesystem type by NAME and MNT_LOCAL, off the JS thread (L1-3)', async () => {
    await expect(fse.volume(temp)).resolves.toEqual({ fstypename: 'apfs', local: true })
    await expect(fse.volume('/dev')).resolves.toEqual({ fstypename: 'devfs', local: true })
    await expect(fse.volume(path.join(temp, 'missing', 'x'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(() => fse.volume('relative')).toThrow(expect.objectContaining({ code: 'EINVAL' }))
  })

  it('stop is idempotent, flush after stop rejects, and every stream is released', async () => {
    // A stop releases asynchronously (on the stream's control queue, then the JS thread): the earlier tests' streams first.
    expect(await until(() => fse.activeCount() === baseline)).toBe(true)

    const root = dir('stop')
    const handle = fse.start(root, () => undefined)

    expect(fse.activeCount()).toBe(baseline + 1)
    expect(fse.latestEventId(handle)).toMatch(/^[0-9]+$/)

    fse.stop(handle)
    fse.stop(handle)

    expect(fse.latestEventId(handle)).toBeNull()
    expect(() => fse.flush(handle)).toThrow(expect.objectContaining({ code: 'ESTOPPED' }))
    expect(await until(() => fse.activeCount() === baseline)).toBe(true)
  })

  it('a stream nobody stops is released when its handle is collected', () => {
    const script = [
      `const a = require(${JSON.stringify(builtAddon())})`,
      `;(function () { a.start(${JSON.stringify(dir('collected'))}, () => {}) })()`,
      'const before = a.activeCount()',
      'setTimeout(() => { gc(); setTimeout(() => process.stdout.write(JSON.stringify({ before, after: a.activeCount() })), 200) }, 50)'
    ].join('\n')

    const run = spawnSync(process.execPath, ['--expose-gc', '-e', script], { encoding: 'utf8' })

    expect(JSON.parse(run.stdout)).toEqual({ before: 1, after: 0 })
  })
})
