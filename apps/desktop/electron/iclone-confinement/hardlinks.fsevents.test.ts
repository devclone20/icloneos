/**
 * v0.0.7 V-1b — the F7 hard-link guard answers a warm check from an FSEvents stream: only the folders the stream
 * named are listed again, and a healthy stream with nothing dirty is the cached answer with no folder walked. These
 * tests prove what voids the stream (each loss flag, an error, a path outside the root, a failed barrier, a folder
 * it cannot place) and that every void falls back to the V-1 walk, which still finds a link planted with no event at
 * all. The real-stream tests prove a link planted just before a check is refused by that same pre-check (the
 * barrier), and one planted before a run's exit is in the post-exit answer (T3). Real files in a temp dir.
 */
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import {
  checkBeforeStart,
  createHardlinkGuard,
  type HardlinkMeasure,
  refreshCadence,
  type RefreshPhase,
  residentDirsBudgetFor,
  WORKER_BASE_DIRS
} from './hardlinks'
import { createFsEventsSource, FSE, type FsEventHandler, type FsEventsSource } from './hardlinks-fsevents'
import type { WalkPace } from './hardlinks-walk'
import { liveWalkWorkers, walkInWorker } from './hardlinks-walker'
import { type IcloneFsevents, loadIcloneFsevents } from './iclone-fsevents'
import { realOrSelf } from './profiles'

/** Directory `lstat`s: the walk and the relist stat folders with `bigint` (and nothing else does). */
const counts = vi.hoisted(() => ({ dirLstat: 0 }))

vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof FsPromises>()

  const lstat = ((file: Parameters<typeof real.lstat>[0], options?: { bigint?: boolean }) => {
    if (options?.bigint) {
      counts.dirLstat += 1
    }

    return real.lstat(file, options as never)
  }) as typeof real.lstat

  return { ...real, default: { ...real, lstat }, lstat }
})

const dirs: string[] = []
const guards: Array<{ close(): void }> = []

// A 300 000-file fixture (V1B_FIXTURE_FILES) takes longer than the default hook timeout to remove.
afterEach(() => {
  guards.splice(0).forEach(guard => guard.close())
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }))
}, 300_000)

interface FakeStream {
  path: string
  onEvent: FsEventHandler
  onError: (error: unknown) => void
  stopped: boolean
}

function fakeSource() {
  const streams: FakeStream[] = []
  let id = 1_000

  const state = {
    barrierFails: false,
    barriers: 0,
    volumeTrusted: true,
    /** I7: a barrier on the stream of `holdPath` waits for `barrierHold` (a check held mid-flight). */
    barrierHold: null as Promise<void> | null,
    holdPath: null as string | null
  }

  const source: FsEventsSource = {
    async watch(watchedPath, onEvent, onError) {
      const stream: FakeStream = { path: watchedPath, onEvent, onError, stopped: false }

      streams.push(stream)

      return {
        stop: () => {
          stream.stopped = true
        },
        async barrier() {
          state.barriers += 1

          if (state.barrierHold && watchedPath === state.holdPath) {
            await state.barrierHold
          }

          if (state.barrierFails || stream.stopped) {
            throw new Error('canary not delivered')
          }

          return { id: (id += 1), ms: 0 }
        }
      }
    },
    trustedVolume: async () => state.volumeTrusted,
    close() {}
  }

  const live = () => streams.filter(stream => !stream.stopped)

  return {
    source,
    state,
    live,
    emit: (eventPath: string, flags: number) => live().forEach(stream => stream.onEvent(eventPath, flags, (id += 1)))
  }
}

interface WorldOptions {
  now?: () => Date
  choice?: 'always' | 'cost'
  onFullScan?: () => void
  onRefreshWalk?: (root: string, pace: WalkPace) => Promise<void>
  walkFull?: Parameters<typeof createHardlinkGuard>[0]['walkFull']
  refreshStallMs?: number
  idleReleaseMs?: number
}

function world(fsEvents: FsEventsSource | null, files = 40, options: WorldOptions = {}) {
  const root = realOrSelf(mkdtempSync(path.join(os.tmpdir(), 'v007-v1b-')))
  const project = path.join(root, 'project')
  const outside = path.join(root, 'outside')

  dirs.push(root)
  mkdirSync(path.join(project, 'src', 'deep'), { recursive: true })
  mkdirSync(path.join(project, 'lib'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(path.join(outside, 'secret'), 'outside-secret\n')

  for (let index = 0; index < files; index += 1) {
    const dir = path.join(project, 'tree', `d${index % Math.max(20, Math.floor(files / 10))}`)

    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, `f${index}`), 'x')
  }

  const measured: HardlinkMeasure[] = []
  const scans: string[] = []
  const refreshes: RefreshPhase[] = []
  let onInstalled: (() => void) | null = null

  const guard = createHardlinkGuard({
    ackFile: path.join(root, 'userdata', 'acks.json'),
    fsEvents,
    fsEventsChoice: options.choice ?? 'always',
    now: options.now,
    onMeasure: (_root, how) => measured.push(how),
    onFullScan: dir => {
      scans.push(dir)
      options.onFullScan?.()
    },
    onRefreshWalk: options.onRefreshWalk,
    walkFull: options.walkFull,
    refreshStallMs: options.refreshStallMs,
    idleReleaseMs: options.idleReleaseMs,
    onRefresh: (_root, phase) => {
      refreshes.push(phase)

      if (phase === 'installed') {
        onInstalled?.()
      }
    }
  })

  guards.push(guard)

  const installed = () =>
    new Promise<void>(resolve => {
      onInstalled = resolve
    })

  return { project, outside, guard, measured, scans, refreshes, installed }
}

/** A warm guard: its first check started the stream before the full scan, so the next is answered from it. */
async function warm(fake: ReturnType<typeof fakeSource>, files?: number) {
  const w = world(fake.source, files)

  expect((await w.guard.check(w.project)).ok).toBe(true)
  expect(await w.guard.check(w.project)).toMatchObject({ ok: true, cached: true })
  expect(w.measured.at(-1)).toBe('events-cached')

  return w
}

describe('V-1b: a warm check answered from the stream', () => {
  it('no change: the cached answer, with no folder stat-ed', async () => {
    const fake = fakeSource()
    const w = await warm(fake, 400)

    counts.dirLstat = 0

    for (let index = 0; index < 20; index += 1) {
      expect(await w.guard.check(w.project)).toMatchObject({ ok: true, cached: true })
    }

    expect(counts.dirLstat).toBe(0)
    expect(w.measured.slice(-20).every(how => how === 'events-cached')).toBe(true)
  })

  it('an edit re-lists only the folder the stream named', async () => {
    const fake = fakeSource()
    const w = await warm(fake, 400)
    const file = path.join(w.project, 'src', 'deep', 'new.txt')

    writeFileSync(file, 'x')
    fake.emit(file, FSE.ItemIsFile)
    counts.dirLstat = 0

    expect(await w.guard.check(w.project)).toMatchObject({ ok: true, cached: false })
    expect(w.measured.at(-1)).toBe('events')
    expect(counts.dirLstat).toBe(1)
  })

  it('a link the stream names is refused (the full scan decides it)', async () => {
    const fake = fakeSource()
    const w = await warm(fake)
    const planted = path.join(w.project, 'src', 'deep', 'planted')

    linkSync(path.join(w.outside, 'secret'), planted)
    fake.emit(planted, FSE.ItemIsFile)

    expect(await w.guard.check(w.project)).toMatchObject({ ok: false, block: { kind: 'hard-links', paths: [planted] } })
    expect(w.measured.at(-1)).toBe('full')
  })

  it('a folder replaced by another of the same name is walked whole', async () => {
    const fake = fakeSource()
    const w = await warm(fake)
    const lib = path.join(w.project, 'lib')
    const swapped = path.join(w.project, 'swap')

    mkdirSync(path.join(swapped, 'inner'), { recursive: true })
    linkSync(path.join(w.outside, 'secret'), path.join(swapped, 'inner', 'x'))
    renameSync(lib, path.join(w.project, 'lib-old'))
    renameSync(swapped, lib)
    // Only the parent is named: the relist must notice `lib` is another folder now.
    fake.emit(path.join(w.project, 'lib-old'), FSE.ItemIsFile)

    expect(await w.guard.check(w.project)).toMatchObject({
      ok: false,
      block: { paths: [path.join(lib, 'inner', 'x')] }
    })
  })

  it('a folder the relist cannot place falls back to the walk', async () => {
    const fake = fakeSource()
    const w = await warm(fake)
    const nowhere = path.join(w.project, 'unknown', 'deeper')

    mkdirSync(nowhere, { recursive: true })
    fake.emit(path.join(nowhere, 'f'), FSE.ItemIsFile)

    expect((await w.guard.check(w.project)).ok).toBe(true)
    expect(w.measured.at(-1)).toBe('walk')
  })
})

describe('V-1b: whatever voids the stream, the walk decides (a link planted with no event is found)', () => {
  const plantSilently = (w: ReturnType<typeof world>) => {
    const planted = path.join(w.project, 'src', 'deep', 'silent')

    linkSync(path.join(w.outside, 'secret'), planted)

    return planted
  }

  const expectWalkFinds = async (w: ReturnType<typeof world>, planted: string) => {
    const before = w.measured.length

    expect(await w.guard.check(w.project)).toMatchObject({ ok: false, block: { paths: [planted] } })
    expect(w.measured.slice(before)).toEqual(['full'])
  }

  const losses: Array<[string, number]> = [
    ['MustScanSubDirs', FSE.MustScanSubDirs],
    ['UserDropped', FSE.UserDropped],
    ['KernelDropped', FSE.KernelDropped],
    ['EventIdsWrapped', FSE.EventIdsWrapped],
    ['RootChanged', FSE.RootChanged],
    ['Mount', FSE.Mount],
    ['Unmount', FSE.Unmount]
  ]

  for (const [name, flag] of losses) {
    it(`${name}`, async () => {
      const fake = fakeSource()
      const w = await warm(fake)
      const planted = plantSilently(w)

      fake.emit(w.project, flag)
      expect(fake.live()).toHaveLength(0)
      await expectWalkFinds(w, planted)
    })
  }

  it('a stream error', async () => {
    const fake = fakeSource()
    const w = await warm(fake)
    const planted = plantSilently(w)

    fake.live()[0].onError(new Error('stream failed'))
    await expectWalkFinds(w, planted)
  })

  it('an event outside the root', async () => {
    const fake = fakeSource()
    const w = await warm(fake)
    const planted = plantSilently(w)

    fake.emit(path.join(w.outside, 'secret'), FSE.ItemIsFile)
    await expectWalkFinds(w, planted)
  })

  it('a barrier that fails', async () => {
    const fake = fakeSource()
    const w = await warm(fake)
    const planted = plantSilently(w)

    fake.state.barrierFails = true
    await expectWalkFinds(w, planted)
  })

  it('a stream that cannot start', async () => {
    const fake = fakeSource()

    fake.source.watch = async () => {
      throw new Error('could not watch')
    }

    const w = world(fake.source)

    expect((await w.guard.check(w.project)).ok).toBe(true)

    const planted = plantSilently(w)

    await expectWalkFinds(w, planted)
  })

  it('a volume that is not a local APFS/HFS+ mount by type NAME (L1-3): no stream at all', async () => {
    const fake = fakeSource()

    fake.state.volumeTrusted = false

    const w = world(fake.source)

    expect((await w.guard.check(w.project)).ok).toBe(true)
    expect(fake.live()).toHaveLength(0)
    await expectWalkFinds(w, plantSilently(w))
  })

  it('T3 (L1-2, ms rounding): a link made within the exit millisecond is in the post-exit answer', async () => {
    const w = world(null)

    expect((await w.guard.check(w.project)).ok).toBe(true)

    const planted = path.join(w.project, 'src', 'same-ms')

    linkSync(path.join(w.outside, 'secret'), planted)

    // Date.now() is whole ms and the link's ctime has a fraction: the exit taken in the same ms as the link.
    const exitedAt = Math.floor(lstatSync(planted).ctimeMs)

    expect(await w.guard.check(w.project, undefined, exitedAt)).toMatchObject({
      ok: false,
      appeared: { paths: [planted] }
    })
  })

  it('no FSEvents at all (not macOS, or the module does not load): the V-1 walk', async () => {
    expect(createFsEventsSource(null)).toBeNull()

    const w = world(null)

    expect((await w.guard.check(w.project)).ok).toBe(true)
    expect(await w.guard.check(w.project)).toMatchObject({ ok: true, cached: true })

    const planted = plantSilently(w)

    await expectWalkFinds(w, planted)
    expect(w.measured.some(how => how.startsWith('events'))).toBe(false)
  })
})

const ADDON = process.platform === 'darwin' ? loadIcloneFsevents() : null
const REAL = ADDON !== null

describe.skipIf(!REAL)('FSEV: the real stream (own addon, same-stream canary barrier)', () => {
  const source = REAL ? createFsEventsSource() : null
  const barriers: number[] = []

  const timed: FsEventsSource | null = source && {
    async watch(watchedPath, onEvent, onError) {
      const watch = await source.watch(watchedPath, onEvent, onError)

      return {
        stop: watch.stop,
        async barrier() {
          const result = await watch.barrier()

          barriers.push(result.ms)

          return result
        }
      }
    },
    trustedVolume: dir => source.trustedVolume(dir),
    close: () => source.close()
  }

  afterAll(() => {
    source?.close()
  })

  /** Warm to the stream: the first check starts it, and checks follow until one is answered from it. */
  async function warmReal(files: number) {
    const w = world(timed, files)

    expect((await w.guard.check(w.project)).ok).toBe(true)

    for (let attempt = 0; attempt < 20 && w.measured.at(-1) !== 'events-cached'; attempt += 1) {
      expect((await w.guard.check(w.project)).ok).toBe(true)
    }

    expect(w.measured.at(-1)).toBe('events-cached')

    return w
  }

  it('no change: no folder stat-ed; the guard works < 5 ms beside the barrier wait', async () => {
    const files = Number(process.env.V1B_FIXTURE_FILES ?? 20_000)
    const w = await warmReal(files)
    const work: number[] = []

    counts.dirLstat = 0

    for (let index = 0; index < 10; index += 1) {
      const started = performance.now()
      const before = barriers.length
      const result = await w.guard.check(w.project)

      expect(result).toMatchObject({ ok: true, cached: true })
      expect(barriers.length).toBe(before + 1)
      work.push(performance.now() - started - barriers.at(-1)!)
    }

    console.log(
      `[V-1b] ${files} files: guard work ms ${work.map(ms => ms.toFixed(2)).join(' ')}; barrier ms ${barriers
        .slice(-10)
        .map(ms => ms.toFixed(0))
        .join(' ')}`
    )
    expect(counts.dirLstat).toBe(0)
    expect(Math.max(...work)).toBeLessThan(5)
  }, 120_000)

  it('L1-1: a root stream FSEvents took but that delivers nothing (dead without a signal) is never trusted', async () => {
    const addon = ADDON as IcloneFsevents
    const decoy = realOrSelf(mkdtempSync(path.join(os.tmpdir(), 'v007-fsev-decoy-')))
    // The stream starts (no throw) but on a decoy: nothing of the root and no canary is ever delivered to it.
    const deadAddon: IcloneFsevents = { ...addon, start: (_paths, onEvents) => addon.start(decoy, onEvents) }
    const dead = createFsEventsSource(deadAddon)!
    const w = world(dead, 200)

    dirs.push(decoy)

    try {
      expect((await w.guard.check(w.project)).ok).toBe(true)

      const planted = path.join(w.project, 'src', 'deep', 'planted')

      linkSync(path.join(w.outside, 'secret'), planted)
      await new Promise(resolve => setTimeout(resolve, 3_000))

      expect(await w.guard.check(w.project)).toMatchObject({ ok: false, block: { paths: [planted] } })
      expect(await w.guard.check(w.project, undefined, Date.now())).toMatchObject({
        ok: false,
        appeared: { paths: [planted] }
      })
      expect(w.measured).not.toContain('events-cached')
      expect(w.measured).not.toContain('events')
    } finally {
      w.guard.close()
      dead.close()
    }
  }, 60_000)

  it('a stream stopped under the guard (flush refused) is never trusted either', async () => {
    const addon = ADDON as IcloneFsevents

    const stopping: IcloneFsevents = {
      ...addon,
      start: (paths, onEvents) => {
        const handle = addon.start(paths, onEvents)

        addon.stop(handle)

        return handle
      }
    }

    const stoppedSource = createFsEventsSource(stopping)!
    const w = world(stoppedSource, 200)

    try {
      expect((await w.guard.check(w.project)).ok).toBe(true)

      const planted = path.join(w.project, 'src', 'deep', 'planted-stopped')

      linkSync(path.join(w.outside, 'secret'), planted)
      expect(await w.guard.check(w.project)).toMatchObject({ ok: false, block: { paths: [planted] } })
      expect(w.measured).not.toContain('events-cached')
    } finally {
      w.guard.close()
      stoppedSource.close()
    }
  }, 60_000)

  it('a link planted 3 s before a pre-check is refused by that pre-check', async () => {
    const w = await warmReal(200)
    const planted = path.join(w.project, 'src', 'deep', 'three-seconds')

    linkSync(path.join(w.outside, 'secret'), planted)
    await new Promise(resolve => setTimeout(resolve, 3_000))

    expect(await w.guard.check(w.project)).toMatchObject({ ok: false, block: { paths: [planted] } })
  }, 60_000)

  it('a link planted just before a pre-check is refused by that pre-check', async () => {
    const w = await warmReal(200)
    const planted = path.join(w.project, 'src', 'deep', 'just-before')

    linkSync(path.join(w.outside, 'secret'), planted)

    expect(await w.guard.check(w.project)).toMatchObject({ ok: false, block: { paths: [planted] } })
  }, 60_000)

  it('T3: a link planted before the exit is in the post-exit answer, and the next start is refused', async () => {
    const w = await warmReal(200)
    const planted = path.join(w.project, 'src', 'late')

    linkSync(path.join(w.outside, 'secret'), planted)

    const exitedAt = Date.now() + 1

    const after = await w.guard.check(w.project, undefined, exitedAt)

    expect(after).toMatchObject({ ok: false, appeared: { paths: [planted] } })
    expect(await w.guard.check(w.project)).toMatchObject({ ok: false, block: { paths: [planted] } })
    expect(existsSync(planted)).toBe(true)
  }, 60_000)
})

describe("V-1b: the age bound and prewarm never put a full scan inside a command's check", () => {
  const MIN = 60_000

  function clocked() {
    let at = Date.parse('2026-11-10T12:00:00Z')

    return { now: () => new Date(at), set: (ms: number) => (at = Date.parse('2026-11-10T12:00:00Z') + ms) }
  }

  it('a background scan started at 4 min answers the check at 5 min + 1 s: no walk or scan on the check path', async () => {
    const fake = fakeSource()
    const clock = clocked()
    const w = world(fake.source, 400, { now: clock.now })

    expect((await w.guard.check(w.project)).ok).toBe(true)
    clock.set(4 * MIN + 1_000)

    const installed = w.installed()

    expect(await w.guard.check(w.project)).toMatchObject({ ok: true, cached: true })
    expect(w.refreshes).toEqual(['started'])
    await installed

    clock.set(5 * MIN + 1_000)

    const scansBefore = w.scans.length
    const measuredBefore = w.measured.length
    const barriersBefore = fake.state.barriers

    counts.dirLstat = 0
    expect(await w.guard.check(w.project)).toMatchObject({ ok: true, cached: true })
    expect(w.measured.slice(measuredBefore)).toEqual(['events-cached'])
    expect(w.scans.length).toBe(scansBefore)
    expect(counts.dirLstat).toBe(0)
    expect(fake.state.barriers).toBe(barriersBefore + 1)
  })

  it('a refresh that fell behind is waited for, and the stale scan never answers', async () => {
    const fake = fakeSource()
    const clock = clocked()
    const w = world(fake.source, 40, { now: clock.now })

    expect((await w.guard.check(w.project)).ok).toBe(true)

    // Planted with no event: only a scan made after it can see it; the stale cached answer says ok.
    const planted = path.join(w.project, 'src', 'deep', 'silent')

    linkSync(path.join(w.outside, 'secret'), planted)
    clock.set(5 * MIN + 1_000)

    expect(await w.guard.check(w.project)).toMatchObject({ ok: false, block: { paths: [planted] } })
    expect(w.refreshes).toEqual(['started', 'installed'])
  })

  it('a running refresh past the bound is promoted by the check (never waited on paced), not duplicated', async () => {
    const fake = fakeSource()
    const clock = clocked()
    const w = world(fake.source, 40, { now: clock.now })

    expect((await w.guard.check(w.project)).ok).toBe(true)
    clock.set(4 * MIN + 30_000)
    expect((await w.guard.check(w.project)).ok).toBe(true)
    clock.set(5 * MIN + 1_000)
    expect((await w.guard.check(w.project)).ok).toBe(true)
    expect(w.refreshes.filter(phase => phase === 'started')).toHaveLength(1)
    expect(w.measured.at(-1)).not.toBe('full')
  })

  it('a change made while the background scan runs stays dirty for the next check', async () => {
    const fake = fakeSource()
    const clock = clocked()
    const w = world(fake.source, 400, { now: clock.now })

    expect((await w.guard.check(w.project)).ok).toBe(true)
    clock.set(4 * MIN + 1_000)

    const installed = w.installed()

    expect((await w.guard.check(w.project)).ok).toBe(true)

    // Named while the scan runs; the scan may have listed the folder before the link was made.
    const planted = path.join(w.project, 'src', 'deep', 'during')

    linkSync(path.join(w.outside, 'secret'), planted)
    fake.emit(planted, FSE.ItemIsFile)
    await installed

    expect(await w.guard.check(w.project)).toMatchObject({ ok: false, block: { paths: [planted] } })
  })

  /** A root whose first full scan "takes" 3 min (the clock moves while it runs), then a background scan held open. */
  async function slowRoot() {
    const fake = fakeSource()
    const clock = clocked()
    let release: () => void = () => undefined
    const held = new Promise<void>(resolve => (release = resolve))
    let first = true
    const paces: WalkPace[] = []

    const w = world(fake.source, 40, {
      now: clock.now,
      onFullScan: () => {
        if (first) {
          first = false
          clock.set(3 * MIN)
        }
      },
      onRefreshWalk: (_root, pace) => {
        paces.push(pace)

        return pace === 'background' ? held : Promise.resolve()
      }
    })

    expect((await w.guard.check(w.project)).ok).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 20))
    // CF4: a 3-min scan estimates a 36-min background one: the bound is at its 30-min ceiling. CF5 (B3-n4): the
    // interval never falls below 3 scan lengths (108 min), so no background scan runs back to back with the last.
    expect(w.refreshes).toEqual([])

    return { w, clock, release, paces }
  }

  it('a slow scan (3 min) never makes a check wait while the last completed scan is within the 30-min ceiling', async () => {
    const { w, clock, release } = await slowRoot()

    // 29 min after the scan began: within the bound. The held scan is never waited for (it would hang).
    clock.set(29 * MIN)
    expect(await w.guard.check(w.project)).toMatchObject({ ok: true, cached: true })
    expect(w.measured.at(-1)).toBe('events-cached')
    expect(w.refreshes).toEqual([])
    release()
  })

  it('CF5: a check beyond the bound (the 30-min ceiling) runs its own full-speed scan, never the paced one', async () => {
    const { w, clock, release, paces } = await slowRoot()

    clock.set(30 * MIN + 1_000)
    expect(await w.guard.check(w.project)).toMatchObject({ ok: true })
    expect(w.refreshes).toEqual(['started', 'installed'])
    expect(paces).toEqual(['fast'])
    expect(w.scans).toHaveLength(1)
    release()
  })

  /** CF5 (B3-M1): a root whose paced walk outlasts any start deadline (on the owner's 520k tree it took 47 s against
   *  the 30 s deadline; here it ends only when aborted), and whose full-speed walk is the real worker. */
  function pacedPastTheDeadline() {
    const fake = fakeSource()
    const clock = clocked()
    const paces: WalkPace[] = []
    let aborted = 0

    const w = world(fake.source, 40, {
      now: clock.now,
      walkFull: (scanned, options) => {
        paces.push(options.pace ?? 'fast')

        if (options.pace !== 'background') {
          return walkInWorker(scanned, options)
        }

        return new Promise((_resolve, reject) =>
          options.signal.addEventListener(
            'abort',
            () => {
              aborted += 1
              reject(new Error('the walk was stopped'))
            },
            { once: true }
          )
        )
      }
    })

    return { w, clock, paces, aborted: () => aborted }
  }

  it('CF5 B3-M1 (fake clock): after a sleep 31 min past the bound (no refresh ran), the first command is answered at full speed', async () => {
    const { w, clock, paces } = pacedPastTheDeadline()

    expect((await w.guard.check(w.project)).ok).toBe(true)
    // The lid closes: Date jumps past the 5-min bound by 31 min; the scheduled refresh's timer has not run.
    clock.set(5 * MIN + 31 * MIN)

    const answer = await checkBeforeStart(w.guard, w.project, 'build', 3_000)

    expect(answer).toMatchObject({ ok: true })
    expect(paces).toEqual(['fast', 'fast'])
    expect(w.refreshes).toEqual(['started', 'installed'])
  })

  it('CF5 B3-M1 (fake clock): a paced refresh running when a command needs it is promoted: aborted, and a full-speed scan answers', async () => {
    const { w, clock, paces, aborted } = pacedPastTheDeadline()

    expect((await w.guard.check(w.project)).ok).toBe(true)
    // Past the 4-min interval: this check answers from the stream and starts the paced refresh (nobody waits on it).
    clock.set(4 * MIN + 1_000)
    expect(await w.guard.check(w.project)).toMatchObject({ ok: true, cached: true })
    expect(paces).toEqual(['fast', 'background'])

    clock.set(5 * MIN + 31 * MIN)

    const answer = await checkBeforeStart(w.guard, w.project, 'build', 3_000)

    expect(answer).toMatchObject({ ok: true })
    expect(paces).toEqual(['fast', 'background', 'fast'])
    expect(aborted()).toBe(1)
    expect(w.refreshes).toEqual(['started', 'promoted', 'installed'])

    // The answer is the fast scan's: the next check inside the bound is the cached one, with no new scan.
    expect(await w.guard.check(w.project)).toMatchObject({ ok: true, cached: true })
    expect(paces).toHaveLength(3)
  })

  /** A2: a refresh whose walk has listed the tree (`listed`) and is held before it answers (`release`); a full scan a
   *  check makes may be told to fail once (`failNext`). Every other walk is the real worker. */
  function heldRefresh(options: { pace?: WalkPace; refreshStallMs?: number } = {}) {
    const fake = fakeSource()
    const clock = clocked()
    const state = { failNext: false }
    let listed: () => void = () => undefined
    let release: () => void = () => undefined
    const hasListed = new Promise<void>(resolve => (listed = resolve))
    const held = new Promise<void>(resolve => (release = resolve))
    const holdPace = options.pace ?? 'background'

    const w = world(fake.source, 40, {
      now: clock.now,
      walkFull: async (scanned, walk) => {
        if ((walk.pace ?? 'fast') === holdPace && walk.pace !== undefined) {
          const records = await walkInWorker(scanned, walk)

          listed()
          await held

          return records
        }

        if (state.failNext) {
          state.failNext = false
          throw new Error('the walk worker failed')
        }

        return walkInWorker(scanned, walk)
      }
    })

    return { fake, clock, w, state, hasListed, release }
  }

  it('A2-M1 (pins the bound re-check): a refresh the Mac slept through never answers; the walk decides', async () => {
    const { clock, w, hasListed, release } = heldRefresh({ pace: 'fast' })

    expect((await w.guard.check(w.project)).ok).toBe(true)
    clock.set(5 * MIN + 1_000)

    // Past the bound: the check's own full-speed scan starts at 5 min + 1 s ...
    const answer = w.guard.check(w.project)

    await hasListed
    // ... and the lid closes while it runs: it answers 34 min after it began, past the 5-min bound.
    clock.set(39 * MIN)
    release()
    expect(await answer).toMatchObject({ ok: true })
    expect(w.measured.at(-1)).toBe('full')
    expect(w.scans).toHaveLength(2)
  })

  it('A2-M2 (pins the tap): a link planted inside while a refresh runs, whose folder a failed check took, is refused after the install', async () => {
    const { fake, clock, w, state, hasListed, release } = heldRefresh()

    expect((await w.guard.check(w.project)).ok).toBe(true)
    clock.set(4 * MIN + 1_000)
    expect(await w.guard.check(w.project)).toMatchObject({ ok: true, cached: true })
    await hasListed

    // The refresh listed every folder; now a link is planted in one of them and the stream names it.
    const planted = path.join(w.project, 'src', 'deep', 'during-refresh')

    linkSync(path.join(w.outside, 'secret'), planted)
    fake.emit(planted, FSE.ItemIsFile)

    // A check takes the dirty folder, and its full scan fails (a worker that dies): refused, nothing cached.
    state.failNext = true
    await expect(w.guard.check(w.project)).rejects.toThrow(/failed/)

    const installed = w.installed()

    release()
    await installed
    // The refresh's records predate the link: only the folders it was told about (its tap) make the next check see it.
    expect(await w.guard.check(w.project)).toMatchObject({ ok: false, block: { paths: [planted] } })
  })

  it('A2-m1: an older refresh never replaces a newer scan the guard made meanwhile', async () => {
    const { fake, clock, w, hasListed, release } = heldRefresh()

    expect((await w.guard.check(w.project)).ok).toBe(true)
    clock.set(4 * MIN + 1_000)
    expect(await w.guard.check(w.project)).toMatchObject({ ok: true, cached: true })
    await hasListed

    const planted = path.join(w.project, 'src', 'deep', 'newer')

    linkSync(path.join(w.outside, 'secret'), planted)
    fake.emit(planted, FSE.ItemIsFile)
    clock.set(4 * MIN + 30_000)
    // This check's full scan began after the refresh: it is the newer answer.
    expect(await w.guard.check(w.project)).toMatchObject({ ok: false, block: { paths: [planted] } })
    expect(w.measured.at(-1)).toBe('full')
    release()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(w.refreshes).toEqual(['started'])
    expect(await w.guard.check(w.project)).toMatchObject({ ok: false, block: { paths: [planted] } })
  })

  it('A2-m2: a waited-on refresh whose worker hangs refuses the check at its stall bound, and frees the root', async () => {
    const fake = fakeSource()
    const clock = clocked()
    let hang = false

    const w = world(fake.source, 40, {
      now: clock.now,
      refreshStallMs: 200,
      walkFull: (scanned, walk) =>
        hang && walk.pace === 'fast'
          ? new Promise((_resolve, reject) =>
              walk.signal.addEventListener('abort', () => reject(new Error('the walk was stopped')), { once: true })
            )
          : walkInWorker(scanned, walk)
    })

    expect((await w.guard.check(w.project)).ok).toBe(true)
    hang = true
    clock.set(36 * MIN)
    await expect(w.guard.check(w.project)).rejects.toThrow(/no new folder/)
    hang = false
    expect(await w.guard.check(w.project)).toMatchObject({ ok: true })
  })

  it('A3-m3: a background refresh whose tree spans two volumes is never installed; the next check walks', async () => {
    const fake = fakeSource()
    const clock = clocked()
    let background = 0

    const w = world(fake.source, 40, {
      now: clock.now,
      walkFull: async (scanned, options) => {
        const resident = await walkInWorker(scanned, options)

        if (options.pace !== 'background') {
          return resident
        }

        background += 1

        // The same tree, reported as spanning two devices (a mount inside it appeared during the walk).
        return {
          ...resident,
          get oneVolume() {
            return false
          }
        } as typeof resident
      }
    })

    expect((await w.guard.check(w.project)).ok).toBe(true)
    clock.set(4 * MIN + 1_000)

    const installed = Promise.race([
      w.installed().then(() => 'installed'),
      new Promise(resolve => setTimeout(() => resolve('not installed'), 1_500))
    ])

    expect((await w.guard.check(w.project)).ok).toBe(true)
    expect(await installed).toBe('not installed')
    expect(background).toBe(1)
    expect(w.refreshes).not.toContain('installed')
    // The cached answer still stands from the first scan; the voided refresh changed nothing on it.
    expect(await w.guard.check(w.project)).toMatchObject({ ok: true })
    expect(w.measured.at(-1)).toBe('events-cached')
  })

  it('I7 (B6-n1): a root not checked for IDLE_RELEASE_MS is released at its refresh tick (tree, stream, timer); the next check scans anew', async () => {
    const fake = fakeSource()
    const clock = clocked()
    const realSetTimeout = globalThis.setTimeout
    let refreshTick = null as (() => void) | null

    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, ms?: number, ...rest: unknown[]) => {
      if ((ms ?? 0) >= MIN) {
        refreshTick = handler

        return realSetTimeout(() => undefined, 0)
      }

      return realSetTimeout(handler, ms, ...rest)
    }) as typeof setTimeout)

    try {
      const w = world(fake.source, 40, { now: clock.now, idleReleaseMs: 10 * MIN })

      expect((await w.guard.check(w.project)).ok).toBe(true)
      expect(refreshTick).not.toBeNull()
      expect(fake.live()).toHaveLength(1)

      // 31 min with no check: the tick releases instead of refreshing.
      clock.set(31 * MIN)
      refreshTick?.()
      await new Promise(resolve => realSetTimeout(resolve, 50))
      expect(w.refreshes).toEqual(['released'])
      expect(fake.live()).toHaveLength(0)
      expect(w.scans).toHaveLength(1)

      // The next check: a full scan of its own, a new stream, answered ok.
      expect(await w.guard.check(w.project)).toMatchObject({ ok: true, cached: false })
      expect(w.measured.at(-1)).toBe('full')
      expect(w.scans).toHaveLength(2)
      expect(fake.live()).toHaveLength(1)

      // A root checked within the idle time keeps refreshing.
      clock.set(31 * MIN + 5 * MIN)
      refreshTick?.()
      await new Promise(resolve => realSetTimeout(resolve, 50))
      expect(w.refreshes.slice(1)).toContain('started')
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('I7 (B6-m3): worker trees past the folder budget: the least recently checked root is released and scans again on its next check', async () => {
    const fake = fakeSource()
    const roots: string[] = []
    const measured: HardlinkMeasure[] = []

    const guard = createHardlinkGuard({
      ackFile: path.join(realOrSelf(mkdtempSync(path.join(os.tmpdir(), 'v007-budget-'))), 'acks.json'),
      fsEvents: fake.source,
      fsEventsChoice: 'always',
      // One tree of 25 folders and its worker fit; two do not.
      residentDirsBudget: WORKER_BASE_DIRS + 40,
      onMeasure: (root, how) => {
        roots.push(root)
        measured.push(how)
      },
      // Every tree in a worker (none handed over), so the budget counts them.
      walkFull: (scanned, options) => walkInWorker(scanned, { ...options, inProcessMaxDirs: 0 })
    })

    guards.push(guard)

    const projects = [0, 1, 2].map(index => {
      const root = realOrSelf(mkdtempSync(path.join(os.tmpdir(), `v007-budget-${index}-`)))

      dirs.push(root)

      for (let folder = 0; folder < 24; folder += 1) {
        mkdirSync(path.join(root, `d${folder}`), { recursive: true })
        writeFileSync(path.join(root, `d${folder}`, 'f'), 'x')
      }

      return root
    })

    expect((await guard.check(projects[0])).ok).toBe(true)
    expect((await guard.check(projects[1])).ok).toBe(true)
    expect(liveWalkWorkers()).toBe(1)
    // 2 x (25 + WORKER_BASE_DIRS) > the budget: the first root's tree went. The second stays warm.
    expect(await guard.check(projects[1])).toMatchObject({ ok: true, cached: true })
    // The first root scans again (never answers from the released tree), which releases the second in turn.
    expect(await guard.check(projects[0])).toMatchObject({ ok: true, cached: false })
    expect(measured.at(-1)).toBe('full')
    expect(liveWalkWorkers()).toBe(1)
    expect((await guard.check(projects[2])).ok).toBe(true)
    expect(liveWalkWorkers()).toBe(1)
  })

  /** I7 (M3): a guard of worker trees, every root stream-backed, whose budget holds one 24-folder root. */
  function budgetWorld(
    fake: ReturnType<typeof fakeSource>,
    options: { now?: () => Date; idleReleaseMs?: number } = {}
  ) {
    const top = realOrSelf(mkdtempSync(path.join(os.tmpdir(), 'v007-m3-')))
    const measured: Array<[string, HardlinkMeasure]> = []
    const released: Array<[string, 'budget' | 'idle']> = []
    const phases: Array<[string, RefreshPhase]> = []
    const outside = path.join(top, 'outside')

    dirs.push(top)
    mkdirSync(outside)
    writeFileSync(path.join(outside, 'secret'), 'outside-secret\n')

    const guard = createHardlinkGuard({
      ackFile: path.join(top, 'userdata', 'acks.json'),
      fsEvents: fake.source,
      fsEventsChoice: 'always',
      now: options.now,
      idleReleaseMs: options.idleReleaseMs,
      residentDirsBudget: WORKER_BASE_DIRS + 40,
      onMeasure: (root, how) => measured.push([root, how]),
      onRootReleased: (root, why) => released.push([root, why]),
      onRefresh: (root, phase) => phases.push([root, phase]),
      walkFull: (scanned, walkOptions) => walkInWorker(scanned, { ...walkOptions, inProcessMaxDirs: 0 })
    })

    guards.push(guard)

    const projects = [0, 1, 2].map(index => {
      const root = path.join(top, `p${index}`)

      for (let folder = 0; folder < 24; folder += 1) {
        mkdirSync(path.join(root, `d${folder}`), { recursive: true })
        writeFileSync(path.join(root, `d${folder}`, 'f'), 'x')
      }

      return root
    })

    const plant = (root: string) => {
      const planted = path.join(root, 'd3', 'planted')

      linkSync(path.join(outside, 'secret'), planted)

      return planted
    }

    const howOf = (root: string) => measured.filter(([measuredRoot]) => measuredRoot === root).map(([, how]) => how)

    return { guard, projects, measured, released, phases, plant, howOf }
  }

  /** Captures every refresh tick (a timer of a minute or more) instead of arming it. */
  function captureTicks() {
    const realSetTimeout = globalThis.setTimeout
    const ticks: Array<() => void> = []

    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, ms?: number, ...rest: unknown[]) => {
      if ((ms ?? 0) >= MIN) {
        ticks.push(handler)

        return realSetTimeout(() => undefined, 0)
      }

      return realSetTimeout(handler, ms, ...rest)
    }) as typeof setTimeout)

    return { ticks, settle: (ms = 50) => new Promise(resolve => realSetTimeout(resolve, ms)) }
  }

  it('I7-a (F-1): a budget release is whole: stream, refresh timer and tree go, and its tick never scans it back in', async () => {
    const fake = fakeSource()
    const timers = captureTicks()

    try {
      const b = budgetWorld(fake)
      const [a, other] = b.projects

      expect((await b.guard.check(a)).ok).toBe(true)

      const tickOfA = timers.ticks.at(-1)

      expect(tickOfA).toBeDefined()
      expect((await b.guard.check(other)).ok).toBe(true)
      expect(b.released).toEqual([[a, 'budget']])
      expect(liveWalkWorkers()).toBe(1)
      expect(fake.live().map(stream => stream.path)).toEqual([other])

      // A tick of A armed before its release (a timer that raced its clear): it scans nothing.
      tickOfA?.()
      await timers.settle()
      expect(b.phases.filter(([root, phase]) => root === a && phase === 'started')).toEqual([])
      expect(liveWalkWorkers()).toBe(1)
      expect(await b.guard.check(other)).toMatchObject({ ok: true, cached: true })
      expect(b.howOf(other).at(-1)).toBe('events-cached')
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('I7-b (F-2): a root with a check in flight is never released under it; it goes when its queue settles', async () => {
    const fake = fakeSource()
    const b = budgetWorld(fake)
    const [a, other] = b.projects
    let open = () => undefined as void

    expect((await b.guard.check(a)).ok).toBe(true)
    expect(await b.guard.check(a)).toMatchObject({ ok: true, cached: true })

    fake.state.holdPath = a
    fake.state.barrierHold = new Promise<void>(resolve => {
      open = resolve
    })

    const held = b.guard.check(a)

    await new Promise(resolve => setTimeout(resolve, 20))
    expect((await b.guard.check(other)).ok).toBe(true)
    // Over the budget, but A's check is in flight: both trees stay until it settles.
    expect(liveWalkWorkers()).toBe(2)
    expect(b.released).toEqual([])

    open()
    expect(await held).toMatchObject({ ok: true, cached: true })
    expect(b.howOf(a).at(-1)).toBe('events-cached')
    await new Promise(resolve => setTimeout(resolve, 20))
    // Settled: A (checked before B) is the least recently checked and goes now.
    expect(b.released).toEqual([[a, 'budget']])
    expect(liveWalkWorkers()).toBe(1)
    fake.state.barrierHold = null
    expect(await b.guard.check(a)).toMatchObject({ ok: true, cached: false })
    expect(b.howOf(a).at(-1)).toBe('full')
  })

  it('I7-c (F-4): a prewarm is a use: the tick after it refreshes, it does not release', async () => {
    const fake = fakeSource()
    const clock = clocked()
    const timers = captureTicks()

    try {
      const w = world(fake.source, 40, { now: clock.now, idleReleaseMs: 10 * MIN })

      await w.guard.prewarm(w.project)
      expect(timers.ticks).toHaveLength(1)

      clock.set(5 * MIN)
      timers.ticks[0]()
      await timers.settle()
      expect(w.refreshes).toContain('started')
      expect(w.refreshes).not.toContain('released')
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('I7-d: a link planted while a root is released (idle or by the budget) is refused by its next check (fail closed)', async () => {
    const fake = fakeSource()
    const clock = clocked()
    const timers = captureTicks()

    try {
      const w = world(fake.source, 40, { now: clock.now, idleReleaseMs: 10 * MIN })

      expect((await w.guard.check(w.project)).ok).toBe(true)
      clock.set(31 * MIN)
      timers.ticks.at(-1)?.()
      await timers.settle()
      expect(w.refreshes).toContain('released')

      const planted = path.join(w.project, 'tree', 'd3', 'planted')

      linkSync(path.join(w.outside, 'secret'), planted)
      expect(await w.guard.check(w.project)).toMatchObject({
        ok: false,
        block: { kind: 'hard-links', paths: [planted] }
      })
      expect(w.measured.at(-1)).toBe('full')
    } finally {
      vi.restoreAllMocks()
    }

    const b = budgetWorld(fakeSource())
    const [a, other] = b.projects

    expect((await b.guard.check(a)).ok).toBe(true)
    expect((await b.guard.check(other)).ok).toBe(true)
    expect(b.released).toEqual([[a, 'budget']])

    const planted = b.plant(a)

    expect(await b.guard.check(a)).toMatchObject({ ok: false, block: { kind: 'hard-links', paths: [planted] } })
    expect(b.howOf(a).at(-1)).toBe('full')
  })

  it("I7-e (F-7): a walked root (no stream, no refresh tick) is idle-released at another root's check", async () => {
    const clock = clocked()
    const top = realOrSelf(mkdtempSync(path.join(os.tmpdir(), 'v007-m3-walked-')))
    const released: Array<[string, string]> = []

    dirs.push(top)

    const roots = [0, 1].map(index => {
      const root = path.join(top, `w${index}`)

      mkdirSync(path.join(root, 'd'), { recursive: true })

      return root
    })

    const guard = createHardlinkGuard({
      ackFile: path.join(top, 'userdata', 'acks.json'),
      fsEvents: null,
      now: clock.now,
      idleReleaseMs: 10 * MIN,
      onRootReleased: (root, why) => released.push([root, why]),
      walkFull: (scanned, options) => walkInWorker(scanned, { ...options, inProcessMaxDirs: 0 })
    })

    guards.push(guard)
    expect((await guard.check(roots[0])).ok).toBe(true)
    expect((await guard.check(roots[1])).ok).toBe(true)
    expect(liveWalkWorkers()).toBe(2)

    clock.set(31 * MIN)
    expect((await guard.check(roots[1])).ok).toBe(true)
    expect(released).toEqual([[roots[0], 'idle']])
    expect(liveWalkWorkers()).toBe(1)
  })

  it("I7-f (F-5): the pane's re-measure neither scans a released root back in nor keeps a resident one from going idle", async () => {
    const fake = fakeSource()
    const clock = clocked()
    const b = budgetWorld(fake, { now: clock.now, idleReleaseMs: 10 * MIN })
    const [a, other] = b.projects
    const planted = b.plant(a)

    expect(await b.guard.check(a)).toMatchObject({ ok: false, block: { paths: [planted] } })
    expect((await b.guard.check(other)).ok).toBe(true)
    expect(b.released).toEqual([[a, 'budget']])

    const measuresOfA = b.howOf(a).length

    for (let index = 0; index < 5; index += 1) {
      await b.guard.recheckBlocked(a)
    }

    expect(b.howOf(a)).toHaveLength(measuresOfA)
    expect(liveWalkWorkers()).toBe(1)
    expect(b.guard.blocked().map(view => view.root)).toEqual([a])

    // A resident refused root re-measured by the pane for 31 min is still idle-released (the re-measure is no use).
    expect(await b.guard.check(a)).toMatchObject({ ok: false })
    b.released.length = 0

    for (let index = 1; index <= 40; index += 1) {
      clock.set(index * 47_000)
      await b.guard.recheckBlocked(a)
    }

    expect(b.howOf(a).length).toBeGreaterThan(measuresOfA + 1)
    expect((await b.guard.check(b.projects[2])).ok).toBe(true)
    expect(b.released.filter(([root]) => root === a)).toEqual([[a, 'idle']])
  })

  it("I7-g: the budget is 1/16 of the Mac's memory at 650 B a folder, between 300 000 and 1 500 000", () => {
    const GIB = 1_073_741_824

    expect(residentDirsBudgetFor(8 * GIB)).toBe(825_955)
    expect(residentDirsBudgetFor(36 * GIB)).toBe(1_500_000)
    expect(residentDirsBudgetFor(2 * GIB)).toBe(300_000)
  })

  it('CF4 B2-m3: the cadence follows the scan length: interval max(4 min, 10x), bound max(5 min, interval + 2x), at most 30 min', () => {
    expect(refreshCadence(0)).toEqual({ intervalMs: 4 * MIN, boundMs: 5 * MIN })
    expect(refreshCadence(7_500)).toEqual({ intervalMs: 4 * MIN, boundMs: 5 * MIN })
    expect(refreshCadence(60_000)).toEqual({ intervalMs: 10 * MIN, boundMs: 12 * MIN })
    expect(refreshCadence(5 * MIN)).toEqual({ intervalMs: 20 * MIN, boundMs: 30 * MIN })
    // CF5 (B3-n4): past a 6-min scan the interval is 3 scan lengths (2 of idle between two), never 0.
    expect(refreshCadence(10 * MIN)).toEqual({ intervalMs: 30 * MIN, boundMs: 30 * MIN })
    expect(refreshCadence(20 * MIN)).toEqual({ intervalMs: 60 * MIN, boundMs: 30 * MIN })

    for (let scan = 0; scan <= 60 * MIN; scan += 11_000) {
      expect(refreshCadence(scan).intervalMs - scan).toBeGreaterThanOrEqual(2 * scan)
    }

    // Up to a 6-min scan, the next scheduled scan (one as long, or up to twice as long) completes inside the bound.
    for (let scan = 0; scan <= 6 * MIN; scan += 7_000) {
      const { intervalMs, boundMs } = refreshCadence(scan)

      expect(boundMs - intervalMs).toBeGreaterThanOrEqual(2 * scan)
      expect(intervalMs).toBeGreaterThanOrEqual(Math.min(4 * MIN, 30 * MIN - 2 * scan))
      expect(boundMs).toBeLessThanOrEqual(30 * MIN)
    }
  })

  it('CF4 B2-m3 (fake clock): after a 60 s background scan the next one is due 10 min after it began, and no check waits before it', async () => {
    const fake = fakeSource()
    const clock = clocked()
    const delays: number[] = []
    const realSetTimeout = globalThis.setTimeout
    let refreshStartsAt = 0
    let release: () => void = () => undefined
    let holdNext = false

    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, ms?: number, ...rest: unknown[]) => {
      if ((ms ?? 0) >= MIN) {
        delays.push(ms as number)
      }

      return realSetTimeout(handler, ms, ...rest)
    }) as typeof setTimeout)

    const paces: Array<string | undefined> = []

    const w = world(fake.source, 40, {
      now: clock.now,
      walkFull: (scanned, options) => {
        paces.push(options.pace)

        return walkInWorker(scanned, options)
      },
      onRefreshWalk: async () => {
        if (holdNext) {
          await new Promise<void>(resolve => (release = resolve))

          return
        }

        // The background scan "takes" 60 s on the fake clock.
        clock.set(refreshStartsAt + 60_000)
      }
    })

    try {
      expect((await w.guard.check(w.project)).ok).toBe(true)
      // The first scan took 0 ms of fake time: interval 4 min (scheduled 4 min after it began).
      expect(delays.at(-1)).toBe(4 * MIN)

      const installed = w.installed()

      refreshStartsAt = 4 * MIN + 1_000
      clock.set(refreshStartsAt)
      expect((await w.guard.check(w.project)).ok).toBe(true)
      await installed
      // 60 s long: interval 10 min start to start, so due 9 min after it ended; bound 12 min.
      expect(delays.at(-1)).toBe(9 * MIN)

      // The next background scan is due now and held open: a check up to the 12-min bound answers without it.
      holdNext = true
      clock.set(refreshStartsAt + 10 * MIN)
      expect((await w.guard.check(w.project)).ok).toBe(true)
      clock.set(refreshStartsAt + 12 * MIN - 1_000)
      expect(await w.guard.check(w.project)).toMatchObject({ ok: true, cached: true })
      expect(w.measured.at(-1)).toBe('events-cached')
      // The first scan flat out, the background one paced.
      expect(paces).toEqual([undefined, 'background'])
    } finally {
      release()
      vi.restoreAllMocks()
    }
  })

  it('prewarm, then check: the full scan ran before the command, none on its path', async () => {
    for (const choice of ['always', 'cost'] as const) {
      const fake = fakeSource()
      const w = world(fake.source, 400, { choice })

      await w.guard.prewarm(w.project)
      expect(w.scans).toHaveLength(1)

      expect(await w.guard.check(w.project)).toMatchObject({ ok: true, cached: true })
      expect(w.scans).toHaveLength(1)
      expect(w.measured).not.toContain('full')
    }
  })

  it('prewarm never throws, and a root it could not scan is refused by the check as before', async () => {
    const w = world(null)
    const missing = path.join(w.project, 'nope')

    await expect(w.guard.prewarm(missing)).resolves.toBeUndefined()
    await w.guard.prewarm(w.project)

    const planted = path.join(w.project, 'src', 'deep', 'after-prewarm')

    linkSync(path.join(w.outside, 'secret'), planted)
    expect(await w.guard.check(w.project)).toMatchObject({ ok: false, block: { paths: [planted] } })
  })
})
