/**
 * v0.0.7 CF1 (critic A-M2) — the two safety checks of the FSEvents barrier (hardlinks-fsevents.ts), pinned on a fake
 * addon so each one is the only thing between the input and a wrong "delivered":
 *   (a) a stream whose event ids go back is voided: onError fires, every later barrier rejects, and the guard walks;
 *   (b) the canary vouches only with an id above `currentEventId()` read before its write and a `latestEventId` at
 *       or above it: a canary id at or below that, or a latest id that is null or lower, rejects.
 * Mutants: `if (id <= lastId)` -> `if (false)` turns (a) red; the vouch condition -> `if (false)` turns (b) red.
 */
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createHardlinkGuard, type HardlinkMeasure } from './hardlinks'
import { createFsEventsSource, type FsEventsSource } from './hardlinks-fsevents'
import { walkInWorker } from './hardlinks-walker'
import type { FsEventRecord, FsEventsHandle, IcloneFsevents } from './iclone-fsevents'

const dirs: string[] = []
const closers: Array<() => void> = []

afterEach(() => {
  closers.splice(0).forEach(close => close())
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }))
})

const temp = (prefix: string) => {
  const made = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)))

  dirs.push(made)

  return made
}

interface FakeOptions {
  /** The id the canary's event gets, from the current id read before its write. */
  canaryId?: (before: bigint) => bigint
  /** What latestEventId answers, from the canary's id. */
  latest?: (canary: bigint | null) => string | null
}

/** One fake stream: `emit` delivers a batch; a flush delivers every new canary file with `canaryId`. */
function fakeAddon(options: FakeOptions = {}) {
  let current = 1_000n
  let canaryDir = ''
  let deliver: ((events: FsEventRecord[]) => void) | null = null
  let lastCanary: bigint | null = null
  const delivered = new Set<string>()

  const addon: IcloneFsevents = {
    currentEventId: () => String(current),
    start: (paths, onEvents) => {
      canaryDir = (paths as readonly string[])[1]
      deliver = onEvents

      return {} as FsEventsHandle
    },
    flush: async () => {
      for (const name of readdirSync(canaryDir)) {
        const file = path.join(canaryDir, name)

        if (!delivered.has(file)) {
          delivered.add(file)

          const id = options.canaryId?.(current) ?? (current += 1n)

          lastCanary = id
          deliver?.([{ path: file, flags: 0x1_0000, id: String(id) }])
        }
      }
    },
    latestEventId: () => (options.latest ? options.latest(lastCanary) : String(current)),
    stop: () => undefined,
    activeCount: () => 0,
    volume: async () => ({ fstypename: 'apfs', local: true })
  }

  return {
    addon,
    emit: (events: Array<{ path: string; id: bigint; flags?: number }>) => {
      for (const event of events) {
        current = event.id > current ? event.id : current
      }

      deliver?.(events.map(event => ({ path: event.path, flags: event.flags ?? 0x1_0000, id: String(event.id) })))
    }
  }
}

function source(fake: ReturnType<typeof fakeAddon>) {
  const made = createFsEventsSource(fake.addon, { tmpdir: () => temp('cf1-canary-') })

  if (!made) {
    throw new Error('no source')
  }

  closers.push(() => made.close())

  return made
}

describe('CF1 (A-M2 a): a stream whose event ids go back is voided', () => {
  it('ids 2000 then 1999: onError fires with the out-of-order reason, and the barrier rejects from then on', async () => {
    const fake = fakeAddon()
    const root = temp('cf1-root-')
    const errors: Error[] = []
    const seen: number[] = []

    const watch = await source(fake).watch(
      root,
      (_path, _flags, id) => seen.push(id),
      error => errors.push(error as Error)
    )

    expect(await watch.barrier()).toMatchObject({ id: expect.any(Number) })

    fake.emit([{ path: path.join(root, 'a'), id: 2_000n }])
    fake.emit([{ path: path.join(root, 'b'), id: 1_999n }])

    expect(seen).toEqual([2_000])
    expect(errors.map(error => error.message)).toEqual(['the stream delivered an event id out of order'])
    await expect(watch.barrier()).rejects.toThrow('the stream delivered an event id out of order')
  })

  it('an equal id is out of order too (a stream delivers each id once)', async () => {
    const fake = fakeAddon()
    const root = temp('cf1-root-')
    const errors: Error[] = []

    const watch = await source(fake).watch(
      root,
      () => undefined,
      error => errors.push(error as Error)
    )

    fake.emit([
      { path: path.join(root, 'a'), id: 3_000n },
      { path: path.join(root, 'b'), id: 3_000n }
    ])

    expect(errors).toHaveLength(1)
    await expect(watch.barrier()).rejects.toThrow('out of order')
  })

  it('through the guard: after ids go back the stream is forgotten and the next check walks (never events-cached)', async () => {
    const fake = fakeAddon()
    const top = temp('cf1-guard-')
    const project = path.join(top, 'project')

    mkdirSync(path.join(project, 'src'), { recursive: true })
    writeFileSync(path.join(project, 'src', 'a'), 'x')

    const measured: HardlinkMeasure[] = []

    const guard = createHardlinkGuard({
      ackFile: path.join(top, 'userdata', 'acks.json'),
      fsEvents: source(fake),
      fsEventsChoice: 'always',
      onMeasure: (_root, how) => measured.push(how)
    })

    closers.push(() => guard.close())
    expect((await guard.check(project)).ok).toBe(true)
    expect((await guard.check(project)).ok).toBe(true)
    expect(measured.at(-1)).toBe('events-cached')

    fake.emit([{ path: path.join(project, 'src', 'a'), id: 5_000n }])
    fake.emit([{ path: path.join(project, 'src', 'a'), id: 4_000n }])

    expect((await guard.check(project)).ok).toBe(true)
    expect(measured.at(-1)).not.toMatch(/^events/)
  })
})

describe('CF1 (A-M2 b): the canary vouches only with an id above the one read before it, and latest at or above it', () => {
  it('control: a canary above `before` with latest at its id vouches', async () => {
    const fake = fakeAddon({ canaryId: before => before + 1n, latest: canary => String(canary) })

    const watch = await source(fake).watch(
      temp('cf1-root-'),
      () => undefined,
      () => undefined
    )

    expect(await watch.barrier()).toMatchObject({ id: 1_001 })
  })

  it('a canary id equal to `before` (an event fseventsd had before the write) cannot vouch', async () => {
    const fake = fakeAddon({ canaryId: before => before })

    const watch = await source(fake).watch(
      temp('cf1-root-'),
      () => undefined,
      () => undefined
    )

    await expect(watch.barrier()).rejects.toThrow('the stream cannot vouch for the canary')
  })

  it('a canary id below `before` cannot vouch', async () => {
    const fake = fakeAddon({ canaryId: before => before - 10n })

    const watch = await source(fake).watch(
      temp('cf1-root-'),
      () => undefined,
      () => undefined
    )

    await expect(watch.barrier()).rejects.toThrow('the stream cannot vouch for the canary')
  })

  it('latestEventId null (the stream is gone) cannot vouch', async () => {
    const fake = fakeAddon({ canaryId: before => before + 1n, latest: () => null })

    const watch = await source(fake).watch(
      temp('cf1-root-'),
      () => undefined,
      () => undefined
    )

    await expect(watch.barrier()).rejects.toThrow('the stream cannot vouch for the canary')
  })

  it('latestEventId below the canary id cannot vouch', async () => {
    const fake = fakeAddon({ canaryId: before => before + 5n, latest: canary => String((canary ?? 0n) - 1n) })

    const watch = await source(fake).watch(
      temp('cf1-root-'),
      () => undefined,
      () => undefined
    )

    await expect(watch.barrier()).rejects.toThrow('the stream cannot vouch for the canary')
  })
})

/**
 * v0.0.7 M2 (critic B6-m2, M2_stall_trace.md) and B8-M1 (FLUSH_handoff.md): `currentEventId()` is a synchronous
 * request to fseventsd that waits for any flush of this process still in fseventsd (~1 s on main when that flush is
 * stalled), and a barrier that waits for such a flush instead costs its check that second. Pinned on a fake addon
 * whose flushes settle only on `release()`:
 *   (c) the id is never read while a flush is in flight;
 *   (d) one stream never has two flushes in flight;
 *   (e) a barrier behind a stalled flush never waits for it: it passes as soon as its canary is delivered, and with no
 *       canary it rejects at the canary budget (the guard walks), never passes;
 *   (f) behind a stalled flush the stream's order still vouches: a change with an id above the canary voids it.
 * Mutants: reading the id unconditionally turns (c) red; dropping the `streamFlush` guard in `startFlush` turns (d)
 * red; restoring m2fix's wait for in-flight flushes (9e7af3bf68) turns (e) red here and in the guard test below; the
 * old 100 ms re-nudge turns the B8-M1 late-canary test red.
 */
function gatedAddon() {
  let current = 1_000n
  let canaryDir = ''
  let deliver: ((events: FsEventRecord[]) => void) | null = null
  const delivered = new Set<string>()
  const pending: Array<() => void> = []
  const counts = { idReads: 0, idReadsWithFlushPending: 0, maxFlushesPending: 0 }

  const addon: IcloneFsevents = {
    currentEventId: () => {
      counts.idReads += 1

      if (pending.length > 0) {
        counts.idReadsWithFlushPending += 1
      }

      return String(current)
    },
    start: (paths, onEvents) => {
      canaryDir = (paths as readonly string[])[1]
      deliver = onEvents

      return {} as FsEventsHandle
    },
    flush: () =>
      new Promise<void>(resolve => {
        pending.push(resolve)
        counts.maxFlushesPending = Math.max(counts.maxFlushesPending, pending.length)
      }),
    latestEventId: () => String(current),
    stop: () => undefined,
    activeCount: () => 0,
    volume: async () => ({ fstypename: 'apfs', local: true })
  }

  return {
    addon,
    counts,
    flushesPending: () => pending.length,
    release: () => pending.splice(0).forEach(resolve => resolve()),
    /** `ordered: false` leaves fseventsd's current id behind the event (the next canary gets a lower id). */
    emit: (events: Array<{ path: string; id: bigint }>, { ordered = true } = {}) => {
      for (const event of events) {
        current = ordered && event.id > current ? event.id : current
      }

      deliver?.(events.map(event => ({ path: event.path, flags: 0x1_0000, id: String(event.id) })))
    },
    currentId: () => current,
    /** Natural delivery (no flush): every canary written since the last call gets the next id. */
    deliverCanaries: () => {
      for (const name of readdirSync(canaryDir)) {
        const file = path.join(canaryDir, name)

        if (!delivered.has(file)) {
          delivered.add(file)
          current += 1n
          deliver?.([{ path: file, flags: 0x1_0000, id: String(current) }])
        }
      }
    }
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** A source over the gated fake, closed after the test; `watch` on a fresh root. */
async function gatedWatch(fake: ReturnType<typeof gatedAddon>, onError: (error: unknown) => void = () => undefined) {
  const made = createFsEventsSource(fake.addon, { tmpdir: () => temp('m2-canary-') })

  if (!made) {
    throw new Error('no source')
  }

  closers.push(() => made.close())

  const root = temp('m2-root-')

  return { root, watch: await made.watch(root, () => undefined, onError) }
}

/** A barrier whose 10 ms nudge flush stays stalled: its canary is delivered only after that flush started. */
async function stallAFlush(fake: ReturnType<typeof gatedAddon>, barrier: Promise<unknown>) {
  await until(() => fake.flushesPending() > 0)
  fake.deliverCanaries()
  await barrier
  expect(fake.flushesPending()).toBe(1)
}

describe('M2 (B6-m2) + B8-M1: no id read while a flush is in flight, and no wait for that flush', () => {
  it('(c, d, e) behind a stalled flush the next barrier passes on natural delivery, in ms, without reading the id', async () => {
    const fake = gatedAddon()

    try {
      const { watch } = await gatedWatch(fake)

      await stallAFlush(fake, watch.barrier())
      expect(fake.counts.idReads).toBe(1)

      const started = performance.now()
      const second = watch.barrier()

      await sleep(5)
      fake.deliverCanaries()

      const outcome = await within(second, 500)

      expect(outcome).toMatchObject({ settled: 'resolved', value: { id: 1_002 } })
      expect(performance.now() - started).toBeLessThan(100)
      expect(fake.flushesPending()).toBe(1)
      expect(fake.counts.idReads).toBe(1)
      expect(fake.counts.idReadsWithFlushPending).toBe(0)
      expect(fake.counts.maxFlushesPending).toBe(1)

      // The stall ends: the next barrier reads the global id again.
      fake.release()
      // The process-wide in-flight set drops a flush a few microtasks after it settles.
      await sleep(5)

      const third = watch.barrier()

      await sleep(5)
      fake.deliverCanaries()
      expect(await within(third, 500)).toMatchObject({ settled: 'resolved', value: { id: 1_003 } })
      expect(fake.counts.idReads).toBe(2)
      expect(fake.counts.idReadsWithFlushPending).toBe(0)
    } finally {
      // The in-flight set is process-wide: a flush left pending here would change every later barrier in this file.
      fake.release()
      await sleep(0)
    }
  })

  it('(e) a stalled flush and no canary: the barrier rejects at the canary budget, never passes, id unread', async () => {
    const fake = gatedAddon()

    try {
      const { watch } = await gatedWatch(fake)

      await stallAFlush(fake, watch.barrier())

      const started = performance.now()
      const outcome = await within(watch.barrier(), 3_000)
      const ms = performance.now() - started

      expect(outcome).toMatchObject({
        settled: 'rejected',
        error: expect.objectContaining({ message: 'canary not delivered' })
      })
      expect(ms).toBeGreaterThan(1_900)
      expect(ms).toBeLessThan(2_600)
      expect(fake.counts.idReads).toBe(1)
      expect(fake.counts.maxFlushesPending).toBe(1)
    } finally {
      fake.release()
      await sleep(0)
    }
  })

  it('(f) behind a stalled flush, a change with an id above the canary voids the stream: the barrier rejects', async () => {
    const fake = gatedAddon()
    const errors: Error[] = []

    try {
      const { root, watch } = await gatedWatch(fake, error => errors.push(error as Error))

      await stallAFlush(fake, watch.barrier())

      const second = watch.barrier()

      await sleep(5)
      // A change fseventsd ordered after the canary, delivered first: the canary (lower id) is out of order.
      fake.emit([{ path: path.join(root, 'late'), id: fake.currentId() + 10n }], { ordered: false })
      fake.deliverCanaries()

      expect(await within(second, 500)).toMatchObject({ settled: 'rejected' })
      expect(errors.map(error => error.message)).toEqual(['the stream delivered an event id out of order'])
      expect(fake.counts.idReads).toBe(1)
    } finally {
      fake.release()
      await sleep(0)
    }
  })

  it('(e) through the guard: behind a stalled flush a check answers from the stream in ms, and still sees a change made before it', async () => {
    const fake = gatedAddon()
    const made = createFsEventsSource(fake.addon, { tmpdir: () => temp('m2-canary-') })

    if (!made) {
      throw new Error('no source')
    }

    closers.push(() => made.close())

    const top = temp('m2-guard-')
    const project = path.join(top, 'project')

    mkdirSync(path.join(project, 'src'), { recursive: true })
    writeFileSync(path.join(project, 'src', 'a'), 'x')

    const measured: HardlinkMeasure[] = []

    const guard = createHardlinkGuard({
      ackFile: path.join(top, 'userdata', 'acks.json'),
      fsEvents: made,
      fsEventsChoice: 'always',
      onMeasure: (_root, how) => measured.push(how)
    })

    closers.push(() => guard.close())

    /** Runs a check while the test delivers canaries the way the stream's latency would (every 2 ms). */
    const checkDelivering = async () => {
      let done = false
      const check = guard.check(project).finally(() => (done = true))

      while (!done) {
        await sleep(2)
        fake.deliverCanaries()
      }

      return check
    }

    try {
      expect((await guard.check(project)).ok).toBe(true)

      await stallAFlush(fake, guard.check(project))
      expect(measured.at(-1)).toBe('events-cached')

      const reads = fake.counts.idReads
      let started = performance.now()

      expect((await checkDelivering()).ok).toBe(true)
      expect(performance.now() - started).toBeLessThan(300)
      expect(measured.at(-1)).toBe('events-cached')

      // A change before the check, ordered before its canary: the check re-lists it (never the cached answer).
      writeFileSync(path.join(project, 'src', 'b'), 'y')
      fake.emit([{ path: path.join(project, 'src', 'b'), id: fake.currentId() + 1n }])
      started = performance.now()
      expect((await checkDelivering()).ok).toBe(true)
      expect(performance.now() - started).toBeLessThan(300)
      expect(measured.at(-1)).toBe('events')

      expect(fake.flushesPending()).toBe(1)
      expect(fake.counts.idReads).toBe(reads)
      expect(fake.counts.idReadsWithFlushPending).toBe(0)
    } finally {
      fake.release()
      await sleep(0)
    }
  }, 30_000)
})

describe('B8-M1: a canary the first flush missed is flushed again at the nudge pace, not after 100 ms', () => {
  it('flush 1 returns without the canary (not yet in fseventsd), flush 2 delivers it: the barrier passes in < 50 ms', async () => {
    let canaryDir = ''
    let deliver: ((events: FsEventRecord[]) => void) | null = null
    let current = 1_000n
    const flushAt: number[] = []
    let started = 0

    const addon: IcloneFsevents = {
      currentEventId: () => String(current),
      start: (paths, onEvents) => {
        canaryDir = (paths as readonly string[])[1]
        deliver = onEvents

        return {} as FsEventsHandle
      },
      flush: async () => {
        flushAt.push(performance.now() - started)

        if (flushAt.length < 2) {
          return
        }

        for (const name of readdirSync(canaryDir)) {
          current += 1n
          deliver?.([{ path: path.join(canaryDir, name), flags: 0x1_0000, id: String(current) }])
        }
      },
      latestEventId: () => String(current),
      stop: () => undefined,
      activeCount: () => 0,
      volume: async () => ({ fstypename: 'apfs', local: true })
    }

    const made = createFsEventsSource(addon, { tmpdir: () => temp('b8-canary-') })

    if (!made) {
      throw new Error('no source')
    }

    closers.push(() => made.close())

    const watch = await made.watch(
      temp('b8-root-'),
      () => undefined,
      () => undefined
    )

    started = performance.now()

    const outcome = await within(watch.barrier(), 1_000)

    expect(outcome).toMatchObject({ settled: 'resolved', value: { id: 1_001 } })
    expect(flushAt).toHaveLength(2)
    expect(flushAt[1] - flushAt[0]).toBeLessThan(40)
    expect(performance.now() - started).toBeLessThan(50)
  })
})

/** Polls `ready` every 2 ms; throws past `withinMs` (a test precondition that never came, not a pass). */
async function until(ready: () => boolean, withinMs = 2_000) {
  const deadline = performance.now() + withinMs

  while (!ready()) {
    if (performance.now() > deadline) {
      throw new Error('precondition not reached')
    }

    await sleep(2)
  }
}

/** Settles `promise` within `ms`, else 'hung' (a barrier that never settles must turn the test red, not time it out). */
const within = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([
    promise.then(
      value => ({ settled: 'resolved' as const, value }),
      (error: unknown) => ({ settled: 'rejected' as const, error })
    ),
    sleep(ms).then(() => ({ settled: 'hung' as const }))
  ])

/**
 * v0.0.7 A4-m1 (mutant MA4-9): the stream stopped while a barrier is held behind an earlier, stalled flush. Since
 * B8-M1 the barrier no longer waits for that flush; it writes its canary at once, and the stop must still fail it at
 * once: its nudge returns on `failed` without rejecting, so only the `failures` registration settles it (else it is
 * refused only at HARDLINK_CHECK_DEADLINE_MS, and the root's queue is stuck behind it). Mutant: dropping
 * `failures.add(rejectWait)` turns both tests red ('hung').
 */
describe('A4-m1 (MA4-9): a stream stopped behind a stalled flush fails the barrier at once', () => {
  it('the source: stop() while the barrier is held: the barrier rejects with the stop reason, well under 30 s, id unread', async () => {
    const fake = gatedAddon()
    const made = createFsEventsSource(fake.addon, { tmpdir: () => temp('a4m1-canary-') })

    if (!made) {
      throw new Error('no source')
    }

    closers.push(() => made.close())

    try {
      const watch = await made.watch(
        temp('a4m1-root-'),
        () => undefined,
        () => undefined
      )

      const first = watch.barrier()

      await until(() => fake.flushesPending() > 0)
      fake.deliverCanaries()
      await first
      expect(fake.counts.idReads).toBe(1)

      const started = performance.now()
      const second = watch.barrier()

      await sleep(20)
      expect(fake.counts.idReads).toBe(1)
      watch.stop()
      fake.release()

      const outcome = await within(second, 1_000)

      expect(outcome).toMatchObject({
        settled: 'rejected',
        error: expect.objectContaining({ message: 'the stream is stopped' })
      })
      expect(performance.now() - started).toBeLessThan(1_000)
      expect(fake.counts.idReads).toBe(1)
    } finally {
      fake.release()
      await sleep(0)
    }
  })

  it('the guard: the stream voided behind a stalled flush: that check walks at once (ok), and the next check answers from a fresh stream', async () => {
    const fake = gatedAddon()
    const made = createFsEventsSource(fake.addon, { tmpdir: () => temp('a4m1-canary-') })

    if (!made) {
      throw new Error('no source')
    }

    closers.push(() => made.close())

    let barriers = 0
    let streams = 0

    // Counts barrier calls, so the stream is voided only once the check's barrier is held behind the stalled flush.
    const counted: FsEventsSource = {
      trustedVolume: dir => made.trustedVolume(dir),
      close: () => made.close(),
      watch: async (watched, onEvent, onError) => {
        const stream = await made.watch(watched, onEvent, onError)

        streams += 1

        return {
          stop: () => stream.stop(),
          barrier: () => {
            barriers += 1

            return stream.barrier()
          }
        }
      }
    }

    const top = temp('a4m1-guard-')
    const project = path.join(top, 'project')

    mkdirSync(path.join(project, 'src'), { recursive: true })
    writeFileSync(path.join(project, 'src', 'a'), 'x')

    const measured: HardlinkMeasure[] = []

    const guard = createHardlinkGuard({
      ackFile: path.join(top, 'userdata', 'acks.json'),
      fsEvents: counted,
      fsEventsChoice: 'always',
      onMeasure: (_root, how) => measured.push(how)
    })

    closers.push(() => guard.close())

    try {
      expect((await guard.check(project)).ok).toBe(true)
      expect(streams).toBe(1)

      // A barrier whose nudge flush stalls: delivered after the flush started, so that flush stays in flight.
      const warm = guard.check(project)

      await until(() => fake.flushesPending() > 0)
      fake.deliverCanaries()
      expect((await warm).ok).toBe(true)
      expect(measured.at(-1)).toBe('events-cached')
      expect(barriers).toBe(1)

      const reads = fake.counts.idReads
      const started = performance.now()
      const held = guard.check(project)

      await until(() => barriers === 2)
      await sleep(20)
      expect(fake.counts.idReads).toBe(reads)

      // Ids go back: the stream fails, and the guard forgets (stops) it; then the stalled flush settles.
      fake.emit([{ path: path.join(project, 'src', 'a'), id: 1n }])
      fake.release()

      const outcome = await within(held, 5_000)

      expect(outcome).toMatchObject({ settled: 'resolved', value: expect.objectContaining({ ok: true }) })
      expect(performance.now() - started).toBeLessThan(5_000)
      expect(measured.at(-1)).not.toMatch(/^events/)
      expect(fake.counts.idReads).toBe(reads)

      // Not stuck refused: the root's queue is free, and a fresh stream answers the next check.
      expect(streams).toBe(2)

      const next = guard.check(project)

      await until(() => fake.flushesPending() > 0)
      fake.deliverCanaries()
      expect(await within(next, 5_000)).toMatchObject({
        settled: 'resolved',
        value: expect.objectContaining({ ok: true })
      })
      expect(measured.at(-1)).toBe('events-cached')
    } finally {
      fake.release()
      await sleep(0)
    }
  }, 30_000)
})

/**
 * v0.0.7 A4-m2 (mutant MA4-5): measure's "released while waiting" test also catches the tree the events path itself
 * dropped. An in-process tree outgrows its bound on the dirty update: `updated` drops it (counted once) and the events
 * path answers null. Without `if (fresh && cache.get(root) !== fresh) fresh = null`, the dropped tree is walked again,
 * rejects as released, and is counted dropped a second time ('dead'). MA4-4 (the same test in measureByEvents) has no
 * reachable race: see the comment above it in hardlinks.ts.
 */
describe('A4-m2 (MA4-5): a tree dropped by the events path is never walked again by the same check', () => {
  it('outgrown on the dirty update: one drop, then a full scan (never the dropped tree)', async () => {
    const fake = fakeAddon()
    const top = temp('a4m2-guard-')
    const project = path.join(top, 'project')

    mkdirSync(path.join(project, 'src'), { recursive: true })
    writeFileSync(path.join(project, 'src', 'a'), 'x')

    const measured: HardlinkMeasure[] = []
    const drops: Array<{ why: string; count: number }> = []

    const guard = createHardlinkGuard({
      ackFile: path.join(top, 'userdata', 'acks.json'),
      fsEvents: source(fake),
      fsEventsChoice: 'always',
      onMeasure: (_root, how) => measured.push(how),
      onTreeDropped: event => drops.push({ why: event.why, count: event.count }),
      walkFull: (scanned, options) => walkInWorker(scanned, { ...options, inProcessMaxDirs: 60 })
    })

    closers.push(() => guard.close())
    expect((await guard.check(project)).ok).toBe(true)
    expect((await guard.check(project)).ok).toBe(true)
    expect(measured.at(-1)).toBe('events-cached')

    for (let index = 0; index < 300; index += 1) {
      mkdirSync(path.join(project, `c${index}`))
    }

    fake.emit([{ path: path.join(project, 'c0'), id: 5_000n }])

    expect(await guard.check(project)).toMatchObject({ ok: true, cached: false })
    expect(drops).toEqual([{ why: 'outgrown', count: 1 }])
    expect(measured.at(-1)).toBe('full')
  }, 60_000)
})

describe('critA5: behind a stalled flush, a late event for an OLD canary path never vouches for a new barrier', () => {
  it('stale canary event (id below an undelivered root change) is ignored; the barrier waits for its own canary and sees the change', async () => {
    const fake = gatedAddon()
    const seen: string[] = []
    const canaryPaths: string[] = []
    const start = fake.addon.start
    fake.addon.start = (paths, onEvents) =>
      start(paths, events => {
        for (const event of events) {
          if (event.path.startsWith((paths as readonly string[])[1])) {
            canaryPaths.push(event.path)
          }
        }

        onEvents(events)
      })
    const made = createFsEventsSource(fake.addon, { tmpdir: () => temp('a5-canary-') })

    if (!made) {
      throw new Error('no source')
    }

    closers.push(() => made.close())
    const root = temp('a5-root-')

    const watch = await made.watch(
      root,
      eventPath => seen.push(eventPath),
      () => undefined
    )

    await stallAFlush(fake, watch.barrier())
    const old = canaryPaths[0]
    expect(old).toBeDefined()

    let resolved = false
    let seenAtResolve: string[] = []

    const b2 = watch.barrier().then(() => {
      resolved = true
      seenAtResolve = [...seen]
    })

    await sleep(20)
    // A late event for the previous canary's path (e.g. its unlink), with an id BELOW a root change made before b2.
    const staleId = fake.currentId() + 1n
    fake.emit([{ path: old, id: staleId }])
    await sleep(30)
    expect(resolved).toBe(false)
    const change = path.join(root, 'made-before')
    fake.emit([{ path: change, id: staleId + 1n }])
    fake.deliverCanaries()
    await b2
    expect(seenAtResolve).toContain(change)
    fake.release()
  })
})
