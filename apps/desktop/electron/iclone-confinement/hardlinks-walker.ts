/**
 * v0.0.7 CF1 (critic B-M1) — main's side of the F7 guard's walk worker (hardlinks-walk.ts): one `worker_threads`
 * Worker per full scan, so the first scan of a root and its background refresh never run their 300 000 `lstat`
 * callbacks on main's event loop.
 *
 * CF7 (critic rounds B4-M1, B5-M1): the worker KEEPS the tree. `walkInWorker` resolves with a `TreeResident`, main's
 * handle on that tree: the summary (hardlinks-walk.ts TreeScan, the size of the linked set, never of the tree), and
 * the two updates a check needs, `apply` (the dirty folders the stream named) and `walk` (every folder stat-ed, in the
 * worker). Each answers a verdict the size of the change; main's summary is corrected in place from it (the counts,
 * the ctimes of the unchanged linked set). The records never cross to main: no copy, no fold, no compare and no
 * install on main's thread is ever the size of the tree, which is what every earlier round found at owner scale.
 *
 * A tree of at most IN_PROCESS_MAX_DIRS folders (a run's scratch, a small project, every test tree) is handed over
 * instead: the worker dumps its records once, is terminated, and the same model (hardlinks-walk.ts TreeState) runs in process.
 * Bounded by the constant, so main's cost is O(1) at owner scale, and a scratch root never keeps a thread.
 * Round 2 (critic B6-M1): the bound holds as the tree GROWS too. An in-process update that reaches more folders than
 * the bound stops at once (`TreeOutgrown`, the tree is dead), and the guard scans the root in a worker, which then
 * keeps it; so main walks at most IN_PROCESS_MAX_DIRS folders in any one update. A worker tree that shrinks is not
 * demoted: it costs a thread, never main's time, and the next full scan of a small root hands over anyway.
 *
 * Where the worker's code comes from, in this order: `hardlinks-walk-worker.cjs` beside the module that runs this
 * (bundle-electron-main.mjs writes it next to dist/electron-main.mjs; read with main's fs, which reads app.asar, and
 * evaluated as the worker's script), else the TypeScript source beside this file (tests and tsx, through Node's own
 * type stripping: the file imports only `node:` modules).
 *
 * Fail closed: a worker that errors, posts an error, exits before its summary, cannot start, or is stopped (quit, the
 * guard's close) rejects the walk. The guard then has no answer for that root, and the start that waits on it is
 * refused (`checkBeforeStart` 'error'); a background refresh is dropped and the next check scans again. Never `ok`.
 * A resident that dies later rejects the update that was waiting on it and every one after; the guard drops that
 * root's answer and scans again. A verdict that does not stand changes nothing on main.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

import { registerTeardown } from '../teardown-registry'

import {
  type RecordEntry,
  TreeOutgrown,
  type TreeRecords,
  type TreeScan,
  TreeState,
  type TreeVerdict,
  UNSTATABLE,
  WALK_TASK,
  type WalkMessage,
  type WalkPace,
  type WalkRequest
} from './hardlinks-walk'

/** The bundled worker's file name (bundle-electron-main.mjs `walkWorker`). */
export const WALK_WORKER_BUNDLE = 'hardlinks-walk-worker.cjs'

/** A tree of at most this many folders is held in process (header): about 2 ms to take in, once. */
export const IN_PROCESS_MAX_DIRS = 2_000

/** I7 (F-8): the walk worker's heap cap. A tree past it (~6M folders at ~650 B; the owner's 520 101 take ~340 MB)
 *  kills its own worker (ERR_WORKER_OUT_OF_MEMORY): that root's walk rejects and its start is refused (I3), never an
 *  app-wide out-of-memory abort. */
export const WALK_WORKER_HEAP_MB = 4_096

/** How a walk worker is started (test seam: a worker that dies, errors or never answers). */
export type StartWalkWorker = (root: string, pace?: WalkPace, heapMb?: number) => Promise<Worker>

/** Every walk worker still running (a scan in flight or a resident tree): quit terminates them (teardown below). */
const liveWorkers = new Set<Worker>()

registerTeardown('hardlink walk workers', () => {
  ;[...liveWorkers].forEach(worker => void worker.terminate())
  liveWorkers.clear()
})

let bundledCode: Promise<string | null> | null = null

/** The bundled worker beside this module, once per process; null when there is none (the source tree). */
function bundledWorkerCode(moduleUrl: string): Promise<string | null> {
  bundledCode ??= readFile(path.join(path.dirname(fileURLToPath(moduleUrl)), WALK_WORKER_BUNDLE), 'utf8').catch(
    () => null
  )

  return bundledCode
}

/** The app's way to start a walk worker: the bundled script when present, else the TypeScript source. */
export const startWalkWorker: StartWalkWorker = async (root, pace = 'fast', heapMb = WALK_WORKER_HEAP_MB) => {
  const workerData = { icloneTask: WALK_TASK, root, pace }
  const code = await bundledWorkerCode(import.meta.url)
  const resourceLimits = { maxOldGenerationSizeMb: heapMb }

  // The worker runs only the walk (hardlinks-walk.ts): none of main's environment is handed to it.
  return code === null
    ? new Worker(new URL('./hardlinks-walk.ts', import.meta.url), { workerData, env: {}, resourceLimits })
    : new Worker(code, { eval: true, workerData, env: {}, resourceLimits })
}

/** Main's handle on one root's tree (header). */
export interface TreeResident {
  readonly root: string
  /** Held in this process (a small tree): its updates walk here, bounded by IN_PROCESS_MAX_DIRS; past that bound
   *  an update throws `TreeOutgrown` and the tree is dead (the guard scans the root in a worker). */
  readonly inProcess: boolean
  /** The last standing answer: corrected in place by `apply` and `walk`. */
  readonly scan: TreeScan
  readonly oneVolume: boolean
  /** False once the tree is released or its worker died: every update then rejects. */
  readonly alive: boolean
  /** V-1b: the folders the stream named since the last answer, applied (hardlinks-walk.ts applyDirty). */
  apply(dirty: readonly string[]): Promise<TreeVerdict>
  /** V-1: every folder stat-ed, the changed ones listed again (hardlinks-walk.ts walkIncremental). */
  walk(): Promise<TreeVerdict>
  /** The records (tests only: the guard never asks, hardlinks.async.test.ts proves it structurally). */
  dump(): Promise<TreeRecords>
  /** Stops the worker (or drops the in-process tree). Idempotent. */
  release(): void
}

export interface WalkInWorkerOptions {
  /** The folders reached so far, at most every 100 ms while the count moves, and once at the end. */
  onProgress?: (dirs: number) => void
  /** Aborted before the scan is done: the worker is terminated and the walk rejects. After: the resident is released. */
  signal?: AbortSignal
  /** CF4 (B2-m3): `background` for the periodic refresh (hardlinks-walk.ts WALK_PACE); the first scan stays `fast`. */
  pace?: WalkPace
  start?: StartWalkWorker
  /** Test seam: the hand-over threshold (header). */
  inProcessMaxDirs?: number
  /** Test seam: the worker's heap cap (WALK_WORKER_HEAP_MB). */
  heapMb?: number
}

/** I7 (F-8): the worker's own error, said plainly when it is the heap cap (the tree is too big to hold). */
const workerFailure = (error: Error & { code?: unknown }, heapMb: number) =>
  error.code === 'ERR_WORKER_OUT_OF_MEMORY'
    ? `the walk worker passed its ${heapMb} MB heap cap (the project's folder tree is too large to hold): ${error.message}`
    : `the walk worker failed: ${error.message}`

const isMessage = (value: unknown): value is WalkMessage =>
  typeof value === 'object' &&
  value !== null &&
  ['progress', 'done', 'answer', 'dumped', 'error'].includes(String((value as { type?: unknown }).type))

const isEntry = (entry: unknown): entry is RecordEntry =>
  Array.isArray(entry) &&
  entry.length === 2 &&
  typeof entry[0] === 'string' &&
  (entry[1] === UNSTATABLE || (typeof entry[1] === 'object' && entry[1] !== null))

const isLinked = (inode: unknown): boolean => {
  const fields = inode && typeof inode === 'object' ? (inode as Record<string, unknown>) : null

  return (
    fields !== null &&
    Number.isSafeInteger(fields.dev) &&
    Number.isSafeInteger(fields.ino) &&
    Number.isSafeInteger(fields.nlink) &&
    typeof fields.ctimeMs === 'number' &&
    Array.isArray(fields.paths) &&
    fields.paths.every(item => typeof item === 'string') &&
    Array.isArray(fields.names) &&
    fields.names.every(item => typeof item === 'string')
  )
}

const isScan = (scan: unknown): scan is TreeScan => {
  const fields = scan && typeof scan === 'object' ? (scan as Record<string, unknown>) : null

  return (
    fields !== null &&
    Number.isSafeInteger(fields.files) &&
    Number.isSafeInteger(fields.dirs) &&
    Array.isArray(fields.linked) &&
    fields.linked.every(isLinked) &&
    Array.isArray(fields.unscannable) &&
    fields.unscannable.every(item => typeof item === 'string')
  )
}

const isVerdict = (verdict: unknown, linked: number): verdict is TreeVerdict => {
  const fields = verdict && typeof verdict === 'object' ? (verdict as Record<string, unknown>) : null

  if (!fields || typeof fields.placed !== 'boolean') {
    return false
  }

  if (!fields.placed || fields.stands === false) {
    return true
  }

  return (
    fields.stands === true &&
    typeof fields.cached === 'boolean' &&
    Number.isSafeInteger(fields.files) &&
    Number.isSafeInteger(fields.dirs) &&
    typeof fields.oneVolume === 'boolean' &&
    Array.isArray(fields.ctimes) &&
    fields.ctimes.every(
      item =>
        Array.isArray(item) &&
        item.length === 2 &&
        Number.isSafeInteger(item[0]) &&
        item[0] >= 0 &&
        item[0] < linked &&
        typeof item[1] === 'number'
    )
  )
}

/** The verdict's corrections into main's summary (a verdict that does not stand changes nothing). */
function correct(scan: TreeScan, verdict: TreeVerdict): boolean {
  if (!verdict.placed || !verdict.stands) {
    return false
  }

  scan.files = verdict.files
  scan.dirs = verdict.dirs

  for (const [index, ctimeMs] of verdict.ctimes) {
    scan.linked[index].ctimeMs = ctimeMs
  }

  return verdict.oneVolume
}

/** The same model, in this process: a small tree (bounded by `maxDirs`: B6-M1), or a test's. */
export function residentInProcess(root: string, records: TreeRecords, maxDirs = IN_PROCESS_MAX_DIRS): TreeResident {
  const state = new TreeState(root, records, maxDirs)
  let alive = true

  const update = async (run: () => Promise<TreeVerdict>) => {
    if (!alive) {
      throw new Error('the tree was released')
    }

    try {
      return await run()
    } catch (error) {
      if (error instanceof TreeOutgrown) {
        alive = false
      }

      throw error
    }
  }

  return {
    root,
    inProcess: true,
    get scan() {
      return state.scan()
    },
    get oneVolume() {
      return state.oneVolume()
    },
    get alive() {
      return alive
    },
    apply: dirty => update(() => state.applyDirty(dirty)),
    walk: () => update(() => state.walkIncremental()),
    dump: async () => state.dump(),
    release: () => {
      alive = false
    }
  }
}

/** The resident worker, once its `done` arrived: requests by id, each answered or failed by the worker's end. */
function residentInWorker(
  root: string,
  worker: Worker,
  scan: TreeScan,
  oneVolume: boolean,
  signal: AbortSignal | undefined
): TreeResident {
  type Waiting = { resolve: (message: WalkMessage) => void; reject: (error: Error) => void }

  const waiting = new Map<number, Waiting>()
  let nextId = 1
  let alive = true
  let volume = oneVolume

  const die = (why: string) => {
    if (!alive) {
      return
    }

    alive = false
    liveWorkers.delete(worker)
    signal?.removeEventListener('abort', onAbort)
    void worker.terminate()

    for (const entry of waiting.values()) {
      entry.reject(new Error(why))
    }

    waiting.clear()
  }

  const onAbort = () => die('the tree was released')

  signal?.addEventListener('abort', onAbort, { once: true })
  worker.removeAllListeners('message')
  worker.removeAllListeners('error')
  worker.removeAllListeners('exit')
  worker.on('message', (message: unknown) => {
    if (!isMessage(message) || message.type === 'progress' || message.type === 'done') {
      return die('the resident tree sent an unknown message')
    }

    const id = message.type === 'error' ? message.id : message.id

    if (id === undefined) {
      return die(`the resident tree failed: ${message.type === 'error' ? message.message : 'no request id'}`)
    }

    const entry = waiting.get(id)

    if (!entry) {
      return die('the resident tree answered a request never made')
    }

    waiting.delete(id)

    if (message.type === 'error') {
      entry.reject(new Error(`the tree update failed: ${message.message}`))
    } else {
      entry.resolve(message)
    }
  })
  worker.on('error', error => die(`the resident tree failed: ${error.message}`))
  worker.on('exit', code => die(`the resident tree exited (${code})`))

  type Request = { type: 'apply'; dirty: string[] } | { type: 'walk' | 'dump' }

  const ask = (request: Request): Promise<WalkMessage> =>
    new Promise((resolve, reject) => {
      if (!alive) {
        reject(new Error('the tree was released'))

        return
      }

      const id = nextId

      nextId += 1
      waiting.set(id, { resolve, reject })
      worker.postMessage({ ...request, id } satisfies WalkRequest)
    })

  const update = async (request: Request): Promise<TreeVerdict> => {
    const message = await ask(request)

    if (message.type !== 'answer' || !isVerdict(message.verdict, scan.linked.length)) {
      die('the resident tree sent a malformed verdict')
      throw new Error('the resident tree sent a malformed verdict')
    }

    if (message.verdict.placed && message.verdict.stands) {
      volume = correct(scan, message.verdict)
    }

    return message.verdict
  }

  return {
    root,
    inProcess: false,
    scan,
    get oneVolume() {
      return volume
    },
    get alive() {
      return alive
    },
    apply: dirty => update({ type: 'apply', dirty: [...dirty] }),
    walk: () => update({ type: 'walk' }),
    dump: async () => {
      const message = await ask({ type: 'dump' })

      if (message.type !== 'dumped' || !message.entries.every(isEntry)) {
        die('the resident tree sent a malformed dump')
        throw new Error('the resident tree sent a malformed dump')
      }

      return new Map(message.entries)
    },
    release: () => die('the tree was released')
  }
}

/** The full scan of `root` in a worker thread: the resident tree, or a rejection (fail closed, header). */
export async function walkInWorker(root: string, options: WalkInWorkerOptions = {}): Promise<TreeResident> {
  const { signal } = options
  const inProcessMaxDirs = options.inProcessMaxDirs ?? IN_PROCESS_MAX_DIRS

  if (signal?.aborted) {
    throw new Error('the walk was stopped')
  }

  const heapMb = options.heapMb ?? WALK_WORKER_HEAP_MB
  const worker = await (options.start ?? startWalkWorker)(root, options.pace ?? 'fast', heapMb)

  liveWorkers.add(worker)

  const done = await new Promise<{ scan: TreeScan; oneVolume: boolean }>((resolve, reject) => {
    let settled = false

    const settle = (outcome: { scan: TreeScan; oneVolume: boolean } | { error: Error }) => {
      if (settled) {
        return
      }

      settled = true
      signal?.removeEventListener('abort', onAbort)

      if ('error' in outcome) {
        liveWorkers.delete(worker)
        void worker.terminate()
        reject(outcome.error)
      } else {
        resolve(outcome)
      }
    }

    const fail = (why: string) => settle({ error: new Error(why) })
    const onAbort = () => fail('the walk was stopped')

    signal?.addEventListener('abort', onAbort, { once: true })
    worker.on('message', (message: unknown) => {
      if (!isMessage(message)) {
        fail('the walk worker sent an unknown message')
      } else if (message.type === 'progress') {
        options.onProgress?.(message.dirs)
      } else if (message.type === 'done') {
        if (!Number.isSafeInteger(message.dirs) || !isScan(message.scan) || typeof message.oneVolume !== 'boolean') {
          fail('the walk failed: no summary')
        } else if (message.scan.dirs !== message.dirs) {
          fail(`the walk ended at ${message.scan.dirs} folders, not the ${message.dirs} it said`)
        } else {
          settle({ scan: message.scan, oneVolume: message.oneVolume })
        }
      } else {
        fail(`the walk failed: ${message.type === 'error' ? message.message : 'no summary'}`)
      }
    })
    worker.on('error', error => fail(workerFailure(error, heapMb)))
    worker.on('exit', code => fail(`the walk worker exited (${code}) before its answer`))
  })

  const resident = residentInWorker(root, worker, done.scan, done.oneVolume, signal)

  if (done.scan.dirs > inProcessMaxDirs) {
    return resident
  }

  // A small tree: taken in once (bounded by the constant), then held here; the worker goes.
  try {
    const records = await resident.dump()

    return residentInProcess(root, records, inProcessMaxDirs)
  } finally {
    resident.release()
  }
}

/** Workers not yet finished (leak checks in tests). */
export const liveWalkWorkers = (): number => liveWorkers.size
