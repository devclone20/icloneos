/**
 * v0.0.7 CF1 (critic B-M1) — the F7 guard's full scan runs in a worker thread (hardlinks-walker.ts, hardlinks-walk.ts).
 * Proves: the worker's records are the in-process walk's, byte for byte; the bundled worker (the packaged app's form,
 * an eval'd CommonJS script) gives the same; main's event loop stays mostly idle while a scan runs; and a worker that
 * dies, throws, posts an error or is stopped fails the check closed (refused, never ok).
 *
 * CF7: the worker KEEPS the tree (a `TreeResident`): a tree past IN_PROCESS_MAX_DIRS folders stays in its worker and
 * answers `apply` and `walk` there; a small one is handed over once and held in process. A resident that dies, or
 * answers out of protocol, rejects the update, the check and the start (never ok), and the next check scans again.
 */
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'

import { build, type BuildOptions } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'

import { checkBeforeStart, createHardlinkGuard } from './hardlinks'
import {
  BACKGROUND_REST_RATIO,
  oneVolume,
  scanOf,
  type TreeRecords,
  UNSTATABLE,
  WALK_TASK,
  walkTree,
  walkTreeSync
} from './hardlinks-walk'
import {
  IN_PROCESS_MAX_DIRS,
  liveWalkWorkers,
  residentInProcess,
  type StartWalkWorker,
  WALK_WORKER_HEAP_MB,
  walkInWorker
} from './hardlinks-walker'

const dirs: string[] = []
const closers: Array<() => void> = []

// TRI-3: a test tree here is up to 120 000 folders (I7) or 50 000 files (V-1, CF1). Removing it with rmSync blocked
// this hook past vitest's 10 s default under full-suite load and failed tests whose assertions had passed. The removal
// is async (off the loop) with its own bound; no assertion changes.
afterEach(async () => {
  closers.splice(0).forEach(close => close())
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
}, 120_000)

/** A project of `folders` x `perFolder` files, with one inside-only hard link. */
function project(folders: number, perFolder: number) {
  const top = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cf1-walk-')))
  const root = path.join(top, 'project')

  dirs.push(top)

  for (let folder = 0; folder < folders; folder += 1) {
    const dir = path.join(root, `d${folder % 16}`, `e${folder}`)

    mkdirSync(dir, { recursive: true })

    for (let file = 0; file < perFolder; file += 1) {
      writeFileSync(path.join(dir, `f${file}`), 'x')
    }
  }

  linkSync(path.join(root, 'd0', 'e0', 'f0'), path.join(root, 'd1', 'e1', 'linked'))

  return { top, root }
}

/** The worker's records, through its one test door, released after. */
async function recordsOf(root: string, options: Parameters<typeof walkInWorker>[1] = {}): Promise<TreeRecords> {
  const resident = await walkInWorker(root, options)

  try {
    return await resident.dump()
  } finally {
    resident.release()
  }
}

const evalWorker =
  (code: string): StartWalkWorker =>
  async () =>
    new Worker(code, { eval: true, env: {} })

const guardOf = (top: string, walkFull?: Parameters<typeof createHardlinkGuard>[0]['walkFull']) => {
  const guard = createHardlinkGuard({ ackFile: path.join(top, 'userdata', 'acks.json'), fsEvents: null, walkFull })

  closers.push(() => guard.close())

  return guard
}

describe('CF1: the full scan in a worker thread', () => {
  it('the worker returns exactly the records the in-process walk makes (Map, bigint identities, links)', async () => {
    const { root } = project(40, 5)
    const progress: number[] = []
    const resident = await walkInWorker(root, { onProgress: dirs => progress.push(dirs) })
    const inProcess = (await walkTree(root, null)).records

    expect(await resident.dump()).toEqual(inProcess)
    expect(resident.scan).toEqual(scanOf(inProcess))
    expect(resident.oneVolume).toBe(oneVolume(root, inProcess))
    expect(progress.at(-1)).toBe(inProcess.size)
    resident.release()
    expect(liveWalkWorkers()).toBe(0)
  })

  it('the bundled worker (dist/hardlinks-walk-worker.cjs, eval’d as the packaged app does) gives the same records', async () => {
    const { root } = project(20, 3)
    // The script's own options (an untyped .mjs, so read through a specifier the checker does not resolve).
    const script = '../../scripts/bundle-electron-main.mjs'
    const bundler: { bundleOptions?: unknown } = await import(script)

    expect(bundler.bundleOptions).toEqual(expect.any(Function))

    const options = (bundler.bundleOptions as (o: { logLevel: string }) => Record<string, BuildOptions>)({
      logLevel: 'silent'
    }).walkWorker

    const { outputFiles = [] } = await build({ ...options, write: false })
    const code = outputFiles[0].text

    const records = await recordsOf(root, {
      start: async scanned =>
        new Worker(code, { eval: true, env: {}, workerData: { icloneTask: WALK_TASK, root: scanned } })
    })

    expect(records).toEqual((await walkTree(root, null)).records)
  }, 60_000)

  it('main’s event loop stays mostly idle while the worker scans 20 000 files (in-process: busy)', async () => {
    const { root } = project(2_000, 10)

    const measure = async (walk: () => Promise<unknown>) => {
      const before = performance.eventLoopUtilization()

      await walk()

      return performance.eventLoopUtilization(before).utilization
    }

    const inProcess = await measure(() => walkTree(root, null))
    const inWorker = await measure(() => recordsOf(root))

    expect(inProcess).toBeGreaterThan(0.5)
    expect(inWorker).toBeLessThan(0.25)
  }, 120_000)
})

describe('CF4 (B2-m3): the background refresh walks paced, the first scan flat out', () => {
  it('a background-paced walk makes exactly the records of the fast one, with fewer calls in flight and rests', async () => {
    const { root } = project(60, 4)
    const paces: Array<string | undefined> = []

    const recording: StartWalkWorker = async (scanned, pace) => {
      paces.push(pace)

      return new Worker(new URL('./hardlinks-walk.ts', import.meta.url), {
        workerData: { icloneTask: WALK_TASK, root: scanned, pace },
        env: {}
      })
    }

    const background = await recordsOf(root, { pace: 'background', start: recording })
    const fast = await recordsOf(root, { start: recording })

    expect(paces).toEqual(['background', 'fast'])
    expect(background).toEqual(fast)
    expect(background).toEqual((await walkTree(root, null)).records)
    expect(background).toEqual(walkTreeSync(root))
    expect(BACKGROUND_REST_RATIO).toBeGreaterThanOrEqual(3)
  })

  it('CF4b: the sync walk gives the async walk’s records on every outcome (unlistable, unstatable child, links, symlinks, fifo, gone root)', async () => {
    const { top, root } = project(12, 3)
    const locked = path.join(root, 'd2', 'locked')
    const listOnly = path.join(root, 'd3', 'list-only')

    mkdirSync(path.join(locked, 'inner'), { recursive: true })
    mkdirSync(listOnly)
    writeFileSync(path.join(listOnly, 'hidden'), 'x')
    symlinkSync(path.join(root, 'd0'), path.join(root, 'd4', 'to-d0'))
    symlinkSync('/nowhere', path.join(root, 'd4', 'dangling'))
    execFileSync('/usr/bin/mkfifo', [path.join(root, 'd5', 'pipe')])
    linkSync(path.join(root, 'd0', 'e0', 'f1'), path.join(root, 'd6', 'second'))
    chmodSync(locked, 0o000)
    chmodSync(listOnly, 0o400)
    closers.push(() => {
      chmodSync(locked, 0o700)
      chmodSync(listOnly, 0o700)
    })

    const sync = walkTreeSync(root)
    const pooled = (await walkTree(root, null)).records

    expect(sync).toEqual(pooled)

    const lockedRecord = sync.get(locked)
    const listOnlyRecord = sync.get(listOnly)

    expect(lockedRecord !== UNSTATABLE && lockedRecord?.unscannable).toBe(true)
    expect(listOnlyRecord !== UNSTATABLE && listOnlyRecord?.unscannable).toBe(true)
    expect([...sync.values()].some(record => record !== UNSTATABLE && record.links.length > 0)).toBe(true)
    expect(walkTreeSync(path.join(top, 'gone'))).toEqual((await walkTree(path.join(top, 'gone'), null)).records)
    expect(walkTreeSync(path.join(top, 'gone')).size).toBe(0)
  })

  it('the guard runs its first scan fast (no pace asked; the refresh asks background: hardlinks.fsevents.test.ts)', async () => {
    const { top, root } = project(8, 2)
    const asked: Array<string | undefined> = []

    const guard = guardOf(top, (scanned, options) => {
      asked.push(options.pace)

      return walkInWorker(scanned, options)
    })

    expect(await guard.check(root, 'build')).toMatchObject({ ok: true })
    expect(asked).toEqual([undefined])
  })
})

describe('CF4 (B2-n4): a refused group carries its files to the pane, not only three', () => {
  it('five linked files under one folder: the sentence names three, the group all five', async () => {
    const { top, root } = project(2, 1)
    const outside = path.join(top, 'outside')

    mkdirSync(outside)

    for (let index = 0; index < 5; index += 1) {
      writeFileSync(path.join(outside, `s${index}`), 's')
      linkSync(path.join(outside, `s${index}`), path.join(root, 'd0', 'e0', `l${index}`))
    }

    const result = await guardOf(top).check(root, 'build')

    expect(result).toMatchObject({ ok: false, block: { kind: 'hard-links', count: 5 } })

    const block = 'block' in result ? result.block : null

    expect(block?.paths).toHaveLength(3)
    expect(block?.groups?.[0]?.paths).toHaveLength(5)
  })
})

describe('CF1: a walk worker that fails is a refused check, never ok', () => {
  for (const [name, code, message] of [
    ['exits before its answer', 'process.exit(3)', 'exited (3) before its answer'],
    ['throws', 'throw new Error("boom")', 'the walk worker failed: boom'],
    [
      'posts an error',
      'require("node:worker_threads").parentPort.postMessage({ type: "error", message: "EIO" })',
      'the walk failed: EIO'
    ],
    [
      'posts a malformed answer',
      'require("node:worker_threads").parentPort.postMessage({ type: "done", records: [] })',
      'the walk failed: no summary'
    ]
  ] as const) {
    it(`a worker that ${name}: walkInWorker rejects, the check rejects, the start is refused`, async () => {
      const { top, root } = project(3, 1)

      await expect(walkInWorker(root, { start: evalWorker(code) })).rejects.toThrow(message)

      const guard = guardOf(top, (scanned, options) => walkInWorker(scanned, { ...options, start: evalWorker(code) }))

      await expect(guard.check(root, 'build')).rejects.toThrow(message)
      expect(await checkBeforeStart(guard, root, 'build', 5_000)).toMatchObject({ ok: false, unanswered: 'error' })
      expect(liveWalkWorkers()).toBe(0)
    })
  }

  it('the guard’s close stops a walk in flight: it rejects and no worker is left', async () => {
    const { top, root } = project(3, 1)

    const guard = guardOf(top, (scanned, options) =>
      walkInWorker(scanned, { ...options, start: evalWorker('setInterval(() => undefined, 1000)') })
    )

    const pending = guard.check(root)

    await new Promise(resolve => setTimeout(resolve, 100))
    expect(liveWalkWorkers()).toBe(1)
    guard.close()
    await expect(pending).rejects.toThrow('the walk was stopped')
    expect(liveWalkWorkers()).toBe(0)
  })

  it('a worker that cannot start rejects the walk', async () => {
    const { root } = project(3, 1)

    await expect(
      walkInWorker(root, {
        start: async () => {
          throw new Error('no worker')
        }
      })
    ).rejects.toThrow('no worker')
  })
})

describe('CF7: the worker keeps the tree; main holds the summary', () => {
  /** A worker that posts a well-formed `done` and then answers every request as `tail` says. */
  const residentWorker = (tail: string) =>
    evalWorker(
      [
        'const { parentPort } = require("node:worker_threads")',
        'parentPort.postMessage({ type: "done", dirs: 1, scan: { files: 0, dirs: 1, linked: [], unscannable: [] }, oneVolume: true })',
        `parentPort.on("message", request => { ${tail} })`
      ].join('\n')
    )

  it('a tree past IN_PROCESS_MAX_DIRS folders stays in its worker; a small one is handed over and no worker is left', async () => {
    const large = project(IN_PROCESS_MAX_DIRS + 50, 1)
    const small = project(6, 1)

    const held = await walkInWorker(large.root)

    expect(liveWalkWorkers()).toBe(1)
    expect(held.scan.dirs).toBeGreaterThan(IN_PROCESS_MAX_DIRS)

    const handedOver = await walkInWorker(small.root)

    expect(liveWalkWorkers()).toBe(1)
    expect(handedOver.scan).toEqual(scanOf((await walkTree(small.root, null)).records))

    // The threshold is the seam: the same small tree stays in a worker when asked to.
    const forced = await walkInWorker(small.root, { inProcessMaxDirs: 0 })

    expect(liveWalkWorkers()).toBe(2)
    expect(forced.scan).toEqual(handedOver.scan)

    held.release()
    forced.release()
    handedOver.release()
    expect(liveWalkWorkers()).toBe(0)
    expect(held.alive).toBe(false)
    await expect(held.apply([])).rejects.toThrow('released')
  }, 120_000)

  it('the resident answers a dirty folder and an incremental walk with a verdict, and the summary follows it (worker and in process alike)', async () => {
    const { top, root } = project(10, 2)
    const outside = path.join(top, 'outside')

    mkdirSync(outside)
    writeFileSync(path.join(outside, 'secret'), 's')

    for (const inProcessMaxDirs of [0, IN_PROCESS_MAX_DIRS]) {
      const resident = await walkInWorker(root, { inProcessMaxDirs })
      const before = { ...resident.scan, linked: [...resident.scan.linked] }

      // A new file in one folder: the folder is dirty, the answer stands, the file count moves.
      writeFileSync(path.join(root, 'd3', 'e3', `extra-${inProcessMaxDirs}`), 'x')
      expect(await resident.apply([path.join(root, 'd3', 'e3')])).toMatchObject({
        placed: true,
        stands: true,
        cached: false
      })
      expect(resident.scan.files).toBe(before.files + 1)
      expect(resident.scan.linked).toEqual(before.linked)
      expect(await resident.dump()).toEqual((await walkTree(root, null)).records)

      // Nothing moved: cached.
      expect(await resident.apply([path.join(root, 'd3', 'e3')])).toMatchObject({
        placed: true,
        stands: true,
        cached: true
      })
      expect(await resident.walk()).toMatchObject({ placed: true, stands: true, cached: true })

      // A link planted from outside: the answer does not stand, and the summary is untouched (I2).
      const planted = path.join(root, 'd4', 'e4', 'planted')

      linkSync(path.join(outside, 'secret'), planted)
      expect(await resident.apply([path.join(root, 'd4', 'e4')])).toEqual({ placed: true, stands: false })
      expect(resident.scan.linked).toEqual(before.linked)
      expect(await resident.walk()).toEqual({ placed: true, stands: false })
      expect(resident.scan.linked).toEqual(before.linked)
      // ... and a folder it cannot place cannot be vouched for.
      expect(await resident.apply([path.join(top, 'outside')])).toEqual({ placed: false })
      unlinkSync(planted)
      expect(await resident.walk()).toMatchObject({ placed: true, stands: true, cached: false })
      resident.release()
    }

    expect(liveWalkWorkers()).toBe(0)
  }, 60_000)

  for (const [name, tail, message, dead] of [
    ['dies on a request', 'process.exit(5)', 'exited (5)', true],
    // An error for one request fails that request alone; the tree stays (the guard still drops its answer).
    [
      'answers with an error',
      'parentPort.postMessage({ type: "error", id: request.id, message: "EIO" })',
      'EIO',
      false
    ],
    [
      'answers a request never made',
      'parentPort.postMessage({ type: "answer", id: 99, verdict: { placed: false } })',
      'never made',
      true
    ],
    [
      'answers a malformed verdict',
      'parentPort.postMessage({ type: "answer", id: request.id, verdict: { placed: true, stands: true } })',
      'malformed verdict',
      true
    ],
    [
      'corrects a ctime past the linked set',
      'parentPort.postMessage({ type: "answer", id: request.id, verdict: { placed: true, stands: true, cached: false, files: 1, dirs: 1, oneVolume: true, ctimes: [[0, 1]] } })',
      'malformed verdict',
      true
    ],
    ['sends an unknown message', 'parentPort.postMessage({ type: "page", entries: [] })', 'unknown message', true]
  ] as const) {
    it(`a resident that ${name}: the update rejects${dead ? ' and the tree is dead' : ''}; the guard drops it and a full scan decides (I3)`, async () => {
      const { top, root } = project(3, 1)
      let starts = 0

      const resident = await walkInWorker(root, { start: residentWorker(tail), inProcessMaxDirs: 0 })

      await expect(resident.apply([root])).rejects.toThrow(message)
      expect(resident.alive).toBe(!dead)
      expect(liveWalkWorkers()).toBe(dead ? 0 : 1)
      resident.release()
      expect(liveWalkWorkers()).toBe(0)

      const guard = guardOf(top, (scanned, options) => {
        starts += 1

        return walkInWorker(scanned, {
          ...options,
          start: starts === 1 ? residentWorker(tail) : undefined,
          inProcessMaxDirs: starts === 1 ? 0 : undefined
        })
      })

      expect(await guard.check(root, 'build')).toMatchObject({ ok: true })
      expect(starts).toBe(1)
      writeFileSync(path.join(root, 'd0', 'e0', 'touched'), 'x')
      // The dead tree answers nothing: a full scan (the second walk) decides, and reads the real tree.
      expect(await checkBeforeStart(guard, root, 'build', 5_000)).toMatchObject({ ok: true, cached: false, files: 5 })
      expect(starts).toBe(2)
      guard.close()
      expect(liveWalkWorkers()).toBe(0)
    })
  }

  it('stopped before its done (the guard closes, a fast walk promotes a paced one): it rejects, nothing resolves', async () => {
    const stop = new AbortController()

    // Progress forever: the walk never completes until it is stopped.
    const start = evalWorker(
      [
        'const { parentPort } = require("node:worker_threads")',
        'let at = 0',
        'setInterval(() => parentPort.postMessage({ type: "progress", dirs: at++ }), 10)'
      ].join('\n')
    )

    const pending = walkInWorker('/r', { start, signal: stop.signal })

    await new Promise(resolve => setTimeout(resolve, 100))
    stop.abort()
    await expect(pending).rejects.toThrow('the walk was stopped')
    expect(liveWalkWorkers()).toBe(0)
  })

  it('a done that disagrees with its own summary, or carries none, rejects', async () => {
    const start = (done: string) => evalWorker(`require("node:worker_threads").parentPort.postMessage(${done})`)

    await expect(
      walkInWorker('/r', {
        start: start(
          '{ type: "done", dirs: 2, scan: { files: 0, dirs: 1, linked: [], unscannable: [] }, oneVolume: true }'
        )
      })
    ).rejects.toThrow('not the 2 it said')
    await expect(walkInWorker('/r', { start: start('{ type: "done", dirs: 1 }') })).rejects.toThrow('no summary')
    expect(liveWalkWorkers()).toBe(0)
  })

  it('the signal after done releases the resident (the guard’s close)', async () => {
    const { root } = project(IN_PROCESS_MAX_DIRS + 20, 1)
    const stop = new AbortController()
    const resident = await walkInWorker(root, { signal: stop.signal })

    expect(liveWalkWorkers()).toBe(1)
    stop.abort()
    expect(resident.alive).toBe(false)
    expect(liveWalkWorkers()).toBe(0)
  }, 60_000)
})

describe('CF7 round 2 (B6-M1, I6): an in-process tree that grows past its bound is handed to a worker', () => {
  /** `count` more folders under `root`, each with a file. */
  const grow = (root: string, count: number, tag: string) => {
    for (let index = 0; index < count; index += 1) {
      const dir = path.join(root, `g${tag}`, `h${index % 32}`, `i${index}`)

      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, 'f'), 'x')
    }
  }

  it('the model: an update that reaches more folders than maxDirs throws TreeOutgrown and the resident is dead', async () => {
    const { root } = project(4, 1)
    const resident = residentInProcess(root, (await walkTree(root, null)).records, 40)

    grow(root, 100, 'a')
    await expect(resident.apply([root])).rejects.toThrow('outgrew 40 folders')
    expect(resident.alive).toBe(false)
    await expect(resident.walk()).rejects.toThrow('released')

    // The same bound on the incremental walk.
    const again = residentInProcess(root, (await walkTree(root, null)).records, 40)

    grow(root, 10, 'b')
    await expect(again.walk()).rejects.toThrow('outgrew 40 folders')
    expect(again.alive).toBe(false)
  })

  it('the guard: the next check after the growth scans the root in a worker, which keeps it; the drop is counted', async () => {
    const { top, root } = project(4, 1)
    const drops: Array<{ why: string; count: number }> = []
    const measured: string[] = []

    const guard = createHardlinkGuard({
      ackFile: path.join(top, 'userdata', 'acks.json'),
      fsEvents: null,
      onMeasure: (_root, how) => measured.push(how),
      onTreeDropped: event => drops.push({ why: event.why, count: event.count }),
      walkFull: (scanned, options) => walkInWorker(scanned, { ...options, inProcessMaxDirs: 60 })
    })

    closers.push(() => guard.close())
    expect(await guard.check(root, 'build')).toMatchObject({ ok: true })
    expect(liveWalkWorkers()).toBe(0)

    grow(root, 300, 'c')
    expect(await guard.check(root, 'build')).toMatchObject({ ok: true, cached: false })
    expect(measured.at(-1)).toBe('full')
    expect(drops).toEqual([{ why: 'outgrown', count: 1 }])
    // From here the tree is a worker's: a further growth is walked there, never on main.
    expect(liveWalkWorkers()).toBe(1)
    grow(root, 300, 'd')
    expect(await guard.check(root, 'build')).toMatchObject({ ok: true, cached: false })
    expect(measured.at(-1)).toBe('walk')
    expect(drops).toHaveLength(1)
    guard.close()
    expect(liveWalkWorkers()).toBe(0)
  }, 60_000)
})

describe('CF1 (B-m1): the root is resolved asynchronously, and a moved folder on its path is measured anew', () => {
  it('a symlinked ancestor repointed between two checks: the second check measures the new real root (refused)', async () => {
    const top = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cf1-moved-')))

    dirs.push(top)

    for (const side of ['a', 'b']) {
      mkdirSync(path.join(top, side, 'project', 'src'), { recursive: true })
      writeFileSync(path.join(top, side, 'project', 'src', 'f'), 'x')
    }

    writeFileSync(path.join(top, 'secret'), 's')
    linkSync(path.join(top, 'secret'), path.join(top, 'b', 'project', 'src', 'linked'))
    symlinkSync(path.join(top, 'a'), path.join(top, 'via'))

    const guard = guardOf(top)
    const spelled = path.join(top, 'via', 'project')

    expect(await guard.check(spelled)).toMatchObject({ ok: true })

    unlinkSync(path.join(top, 'via'))
    symlinkSync(path.join(top, 'b'), path.join(top, 'via'))

    expect(await guard.check(spelled)).toMatchObject({
      ok: false,
      block: { root: path.join(top, 'b', 'project'), kind: 'hard-links' }
    })
  })
})

describe('I7 (F-8): the walk worker heap cap fails closed', () => {
  /** A cap a small tree's walk fits in and a 120 000-folder tree's (~80 MB at ~650 B a folder) does not. */
  const SMALL_HEAP_MB = 24
  const BIG_DIRS = 120_000

  it('a tree past the cap kills only its worker: the check rejects, the start is refused with the reason, the app runs on', async () => {
    expect(WALK_WORKER_HEAP_MB).toBe(4_096)

    const top = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'i7-heap-')))
    const big = path.join(top, 'big')
    const small = path.join(top, 'small')

    dirs.push(top)

    for (let folder = 0; folder < BIG_DIRS; folder += 1) {
      mkdirSync(path.join(big, `d${folder % 200}`, `e${folder}`), { recursive: true })
    }

    for (let folder = 0; folder < 50; folder += 1) {
      mkdirSync(path.join(small, `d${folder}`), { recursive: true })
    }

    const guard = guardOf(top, (root, options) => walkInWorker(root, { ...options, heapMb: SMALL_HEAP_MB }))
    const refused = await checkBeforeStart(guard, big, 'build', 120_000)

    expect(refused).toMatchObject({ ok: false, unanswered: 'error' })
    // The exact sentence: the cap named with its size, then Node's own ERR_WORKER_OUT_OF_MEMORY message, so a
    // generic "the walk worker failed" (the OOM code not recognised) or a wrong cap cannot pass.
    expect('detail' in refused ? refused.detail : '').toBe(
      `the walk worker passed its ${SMALL_HEAP_MB} MB heap cap (the project's folder tree is too large to hold): Worker terminated due to reaching memory limit: JS heap out of memory`
    )
    expect(liveWalkWorkers()).toBe(0)
    // The same guard, the same process: another root is checked and passes.
    expect(await guard.check(small)).toMatchObject({ ok: true, dirs: 51 })
    // Asked again, the big root is refused again (never a pass from a partial tree).
    expect(await checkBeforeStart(guard, big, 'build', 120_000)).toMatchObject({ ok: false, unanswered: 'error' })
  }, 240_000)
})
