/**
 * v0.0.7 FSEV — macOS FSEvents for the F7 hard-link guard (hardlinks.ts), through our own addon (iclone-fsevents.ts,
 * native/iclone-fsevents). The guard uses it to re-list only the directories that changed since its last walk; this
 * file is the stream per root and its delivery barrier, nothing about links.
 *
 * A stream is ONE FSEventStream on two paths: the root, and this process's private canary folder (mkdtemp, 0700,
 * never inside a watched root). `watch` throws whenever FSEvents did not take it (the addon checks
 * FSEventStreamCreate and FSEventStreamStart: review L1-1, where fsevents 2.3.2 hid a refused stream).
 *
 * The barrier (exact, no sleep): write a fresh canary file after the caller's moment, flush the stream until the
 * canary's own event arrives ON THAT STREAM, and require its id above `FSEventsGetCurrentEventId()` read before the
 * write (with a flush in flight that read is skipped: the stream's order check already keeps every new id above its
 * last delivered one, so that comparison never rejects and is NOT a check; there the canary's exact, single-use path
 * is what keeps a late event for an older canary from vouching (critic A5-M1, B8-M1 below)) and
 * `FSEventStreamGetLatestEventId` at or above it. fseventsd gives ids in the order the kernel queued the
 * changes, and a stream delivers its events in id order (checked here: a stream whose ids go back is voided), so
 * every change to the root made before the canary write has reached the guard when the canary does. Measured on this
 * machine (FSEV_handoff.md): `currentEventId()` + `flush()` alone is NOT a barrier: 300 of 300 writes made just
 * before reading the id got a later id and 293 of them were not delivered by the flush; a canary on ANOTHER stream
 * missed 137 of 300; the same-stream canary missed 0 of 2 000 under a 20-writes-per-ms neighbour, p50 0.9-4.6 ms.
 * A stream that died without a signal never delivers its canary: the barrier rejects within CANARY_TIMEOUT_MS and
 * the guard walks.
 *
 * B6-m2 (M2_stall_trace.md): `FSEventsGetCurrentEventId` is a synchronous request to fseventsd, and while a
 * `FSEventStreamFlushSync` of this process is stalled there (~1 s, in about 1 % of flushes, more when flushes go
 * back to back) it waits for that flush: measured 921-1 003 ms on the JS thread, every time with a flush in flight,
 * never with none. So the id is read only when no flush of this process is in flight, and a stream runs at most
 * one flush at a time.
 *
 * B8-M1 (FLUSH_handoff.md): the barrier never WAITS for a flush either (m2fix waited up to 2 s, so the check after a
 * stalled flush took ~1 s). A stalled flush does not hold delivery: 2 007 canaries written during 29 stalls of over
 * 500 ms arrived through the stream's own latency in at most 8.0 ms, on that stream and on another one. With a flush
 * in flight the barrier skips the id read and bounds the canary by the highest id this stream has delivered instead.
 * The barrier does not depend on that bound: it rests on kernel order (ids follow the order of the changes), the
 * stream's in-order check, and a canary path used once and created after the call, whose event therefore follows
 * every earlier change. The global id is a cross-check, read only when reading it cannot block.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { registerTeardown } from '../teardown-registry'

import { type FsEventRecord, type FsEventsHandle, type IcloneFsevents, loadIcloneFsevents } from './iclone-fsevents'

/** The flags of `FSEventStreamEventFlags` the guard reads. */
export const FSE = {
  MustScanSubDirs: 0x1,
  UserDropped: 0x2,
  KernelDropped: 0x4,
  EventIdsWrapped: 0x8,
  HistoryDone: 0x10,
  RootChanged: 0x20,
  Mount: 0x40,
  Unmount: 0x80,
  ItemIsFile: 0x1_0000,
  ItemIsDir: 0x2_0000
} as const

/** Any of these: events were lost, merged into "look again", or the watched path itself moved. */
export const FSE_LOSS =
  FSE.MustScanSubDirs |
  FSE.UserDropped |
  FSE.KernelDropped |
  FSE.EventIdsWrapped |
  FSE.RootChanged |
  FSE.Mount |
  FSE.Unmount

/** The stream latency compiled into the addon (0.001 s, NoDefer). */
export const FSEVENTS_LATENCY_MS = 1
/** A canary not delivered within this: the barrier fails, and the guard walks (a dead stream ends here). */
const CANARY_TIMEOUT_MS = 2_000
/** Not delivered by then: one FSEventStreamFlushSync, raced with delivery, and again every FLUSH_NUDGE_MS while the
 *  canary is late (never two at once on a stream). Natural delivery at 1 ms latency is p95 1.9 ms, max 7.5 ms idle.
 *  B8-M1: about 1 canary in 300 is neither delivered nor in fseventsd when the first flush runs (that flush returns
 *  without it); the old 100 ms re-nudge then cost the check 110 ms. A flush that stalls (~1 s) no longer costs the
 *  barrier anything (header), so the re-nudge follows at the nudge's pace: idle max 111 -> 21 ms over 3 000. */
const FLUSH_NUDGE_MS = 10

/** Every flush of this process still running in fseventsd, whatever its stream or source: the id read waits on any
 *  of them (one fseventsd client per process), not only on its own stream's. */
const flushesInFlight = new Set<Promise<void>>()

export type FsEventHandler = (eventPath: string, flags: number, id: number) => void

export interface FsWatch {
  stop(): void
  /** Resolves once every change to the watched path made before the call has reached `onEvent`; rejects when that
   *  cannot be shown (stream stopped or dead, ids out of order, timeout). */
  barrier(): Promise<{ id: number; ms: number }>
}

/** Streams from now on one path each, plus the shared canary; `watch` throws when the stream was not taken. */
export interface FsEventsSource {
  watch(watchedPath: string, onEvent: FsEventHandler, onError: (error: unknown) => void): Promise<FsWatch>
  /** Whether the volume holding `dir` reports every change through FSEvents: APFS or HFS+ by NAME, and MNT_LOCAL. */
  trustedVolume(dir: string): Promise<boolean>
  close(): void
}

/** Volume types FSEvents reports every change on (by f_fstypename: type numbers are assigned at registration). */
const TRUSTED_FSTYPES = new Set(['apfs', 'hfs'])

const within = (child: string, parent: string) => child === parent || child.startsWith(`${parent}${path.sep}`)

let shared: FsEventsSource | null | undefined

/** Every source not yet closed: quit stops their streams (per-root and canary alike), fails their pending barriers
 *  and removes their canary folders. A guard also stops the streams it opened (hardlinks.ts). */
const liveSources = new Set<FsEventsSource>()

registerTeardown('fsevents canary streams', () => {
  ;[...liveSources].forEach(source => source.close())
})

/** The one source of this process (one canary folder for every stream); null when the addon cannot load. */
export function defaultFsEventsSource(): FsEventsSource | null {
  if (shared === undefined) {
    shared = createFsEventsSource()
  }

  return shared
}

/** The real source over the addon; null when it cannot load. `tmpdir` is where the canary folder is made. */
export function createFsEventsSource(
  addon: IcloneFsevents | null = loadIcloneFsevents(),
  { tmpdir = os.tmpdir }: { tmpdir?: () => string } = {}
): FsEventsSource | null {
  if (!addon) {
    return null
  }

  let canaryDir: string | null = null
  let sequence = 0
  let closed = false
  const live = new Set<(reason?: Error) => void>()

  const canary = (): string =>
    // One mkdtemp per process, on the first stream (not per check): random name, mode 0700.
    (canaryDir ??= realpathSync(mkdtempSync(path.join(tmpdir(), 'iclone-fse-'))))

  const source: FsEventsSource = {
    async watch(watchedPath, onEvent, onError) {
      if (closed) {
        throw new Error('the fsevents source was closed')
      }

      const dir = canary()

      if (within(dir, watchedPath) || within(watchedPath, dir)) {
        throw new Error('the canary folder and the watched root overlap')
      }

      const arrivals = new Map<string, (id: bigint) => void>()
      let lastId = 0n
      let failed: Error | null = null
      const failures = new Set<(error: Error) => void>()

      const fail = (error: Error) => {
        if (failed) {
          return
        }

        failed = error
        failures.forEach(reject => reject(error))
        failures.clear()
        onError(error)
      }

      const handle: FsEventsHandle = addon.start([watchedPath, dir], (events: FsEventRecord[]) => {
        for (const event of events) {
          if (failed) {
            return
          }

          // Loss flags first: some of them (RootChanged, Mount) carry id 0 by design.
          if (event.flags & FSE_LOSS) {
            onEvent(event.path, event.flags, Number(event.id))

            continue
          }

          const id = BigInt(event.id)

          if (id <= lastId) {
            fail(new Error('the stream delivered an event id out of order'))

            return
          }

          lastId = id

          if (within(event.path, dir)) {
            arrivals.get(event.path)?.(id)

            continue
          }

          onEvent(event.path, event.flags, Number(event.id))
        }
      })

      // One flush at a time on this stream: back-to-back flushes are what stalls fseventsd (FLUSH_NUDGE_MS).
      let streamFlush: Promise<void> | null = null

      /** Throws when the addon refuses the flush at once (the stream is stopped or invalid). */
      const startFlush = () => {
        if (streamFlush) {
          return
        }

        const settled = addon.flush(handle).then(
          () => undefined,
          () => undefined
        )

        const tracked: Promise<void> = settled.finally(() => {
          flushesInFlight.delete(tracked)

          if (streamFlush === tracked) {
            streamFlush = null
          }
        })

        flushesInFlight.add(tracked)
        streamFlush = tracked
      }

      let stopped = false

      const stop = (reason = new Error('the stream is stopped')) => {
        if (stopped) {
          return
        }

        stopped = true
        live.delete(stop)
        addon.stop(handle)
        fail(reason)
      }

      live.add(stop)

      return {
        stop: () => stop(),

        async barrier() {
          const started = performance.now()

          if (failed) {
            throw failed
          }

          // Never the synchronous id read while a flush is in flight (it would hold main until that flush returns), and
          // never a wait for that flush (B8-M1): the stream's own last id bounds the canary then (header).
          const before = flushesInFlight.size === 0 ? BigInt(addon.currentEventId()) : lastId
          const file = path.join(dir, `c${(sequence += 1)}`)
          let deliveredId: bigint | null = null
          let rejectWait: (error: Error) => void = () => undefined

          const delivered = new Promise<bigint>((resolve, reject) => {
            rejectWait = reject
            arrivals.set(file, id => {
              deliveredId = id
              resolve(id)
            })
          })

          failures.add(rejectWait)
          // Observed by the flush loop below; the rejection itself is read through `delivered`.
          delivered.catch(() => undefined)

          try {
            await writeFile(file, '', { mode: 0o600 })

            let timer: ReturnType<typeof setTimeout> | undefined

            const late = new Promise<never>((_resolve, reject) => {
              const nudge = () => {
                if (deliveredId !== null || failed) {
                  return
                }

                if (performance.now() - started > CANARY_TIMEOUT_MS) {
                  reject(new Error('canary not delivered'))

                  return
                }

                // Raced: a stalled flush never holds the barrier past the canary's own delivery. A flush refused at once
                // (the stream is stopped or invalid) is a stream that cannot vouch: the barrier fails now.
                try {
                  startFlush()
                } catch (error) {
                  reject(error instanceof Error ? error : new Error(String(error)))

                  return
                }

                timer = setTimeout(nudge, FLUSH_NUDGE_MS)
              }

              timer = setTimeout(nudge, FLUSH_NUDGE_MS)
            })

            late.catch(() => undefined)

            try {
              await Promise.race([delivered, late])
            } finally {
              clearTimeout(timer)
            }

            const id = await delivered
            const latest = addon.latestEventId(handle)

            if (id <= before || latest === null || BigInt(latest) < id) {
              throw new Error('the stream cannot vouch for the canary')
            }

            return { id: Number(id), ms: performance.now() - started }
          } finally {
            arrivals.delete(file)
            failures.delete(rejectWait)
            void unlink(file).catch(() => undefined)
          }
        }
      }
    },

    async trustedVolume(dir) {
      const volume = await addon.volume(dir)

      return volume.local && TRUSTED_FSTYPES.has(volume.fstypename)
    },

    close() {
      closed = true
      liveSources.delete(source)
      ;[...live].forEach(stop => stop(new Error('the fsevents source was closed')))

      if (canaryDir) {
        rmSync(canaryDir, { recursive: true, force: true })
        canaryDir = null
      }
    }
  }

  liveSources.add(source)

  return source
}
