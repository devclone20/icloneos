/**
 * v0.0.7 PERF gates: fixtures, the main-thread block meter and the RESULT_JSON / SUMMARY lines the release gate reads.
 *
 * The gates run only under `npm run test:perf:v007` (vitest.perf-v007.config.ts sets ICLONE_PERF_V007=1); in the
 * default electron run they skip, so a red gate never turns the ordinary suite red and its fixtures are never built.
 *
 * Block meter: perf_hooks.monitorEventLoopDelay at 1 ms resolution, plus the synchronous slice of every measured call
 * (call to return, before any await). A guard that moves its walk off the thread returns a promise at once and both
 * stay small; a guard that walks on the thread shows the walk in both. The reported max is the larger of the two.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'

import type { FsEventsHandle, IcloneFsevents } from '../iclone-confinement/iclone-fsevents'
import type { KeySealer } from '../iclone-permissions/keys'

export const PERF_V007_ENABLED = process.env.ICLONE_PERF_V007 === '1'

const MAKE_FIXTURE = path.resolve(__dirname, '..', '..', 'scripts', 'perf-v007', 'make-fixture.mjs')

/** Must match PERF_SEALER in scripts/perf-v007/make-fixture.mjs: the test seal of a fixture master, never the Keychain. */
export const PERF_SEALER: KeySealer = {
  seal: plain => `perfv007:${Buffer.from(plain, 'utf8').toString('base64')}`,
  unseal: sealed => {
    if (!sealed.startsWith('perfv007:')) {
      throw new Error('not sealed by the perf-v007 sealer')
    }

    return Buffer.from(sealed.slice('perfv007:'.length), 'base64').toString('utf8')
  }
}

export interface Fixture {
  /** The fixture directory make-fixture.mjs created (its marker file inside). */
  root: string
  /** What make-fixture reported (FIXTURE_JSON). */
  info: Record<string, unknown>
  /** Removes exactly this fixture directory and the private parent made for it. */
  remove: () => void
}

/** A fresh fixture in a private folder under the run's TMPDIR, which must be under /private/tmp. */
export function makeFixture(args: readonly string[]): Fixture {
  const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pv7-')))

  if (!parent.startsWith('/private/tmp/')) {
    rmSync(parent, { recursive: true, force: true })
    throw new Error(`perf-v007: TMPDIR resolves to ${parent}, not under /private/tmp: run through iso_env.sh`)
  }

  const root = path.join(parent, 'fx')
  const run = spawnSync(process.execPath, [MAKE_FIXTURE, root, ...args], { encoding: 'utf8', maxBuffer: 1 << 24 })
  const line = run.stdout.split('\n').find(text => text.startsWith('FIXTURE_JSON '))

  if (run.status !== 0 || !line) {
    rmSync(parent, { recursive: true, force: true })
    throw new Error(`perf-v007: make-fixture failed (${run.status}): ${run.stderr}`)
  }

  const info: unknown = JSON.parse(line.slice('FIXTURE_JSON '.length))

  return {
    root,
    info: info && typeof info === 'object' ? { ...info } : {},
    remove: () => rmSync(parent, { recursive: true, force: true })
  }
}

export const yieldToLoop = (ms = 2): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** One measured call: its synchronous slice and its total time to a settled value, sync or Promise-returning alike. */
export async function timed<T>(meter: BlockMeter | null, call: () => T): Promise<{ value: Awaited<T>; ms: number }> {
  const started = performance.now()
  const pending = call()

  meter?.slice(performance.now() - started)

  const value = await pending

  return { value, ms: performance.now() - started }
}

/** One stall of main's loop the meter saw: when it ended (performance.now() ms, and the process hrtime in ms for a
 *  CPU profile's clock) and how long the loop was held. CF7 round 2 (B6-m2): a stall is attributable only with its
 *  time, so every gate reports the stalls over STALL_NOTE_MS beside the histogram. */
export interface LoopStall {
  atMs: number
  hrtimeMs: number
  ms: number
}

const STALL_NOTE_MS = 20

export interface BlockMeter {
  slice: (ms: number) => void
  /** Gives the loop one timer turn first: a block that ended the phase is recorded only when the next timer fires. */
  stop: () => Promise<{
    p99Ms: number
    maxMs: number
    loopMaxMs: number
    sliceMaxMs: number
    samples: number
    stalls: LoopStall[]
  }>
}

export function startBlockMeter(): BlockMeter {
  const histogram = monitorEventLoopDelay({ resolution: 1 })
  const stalls: LoopStall[] = []
  let sliceMax = 0
  let last = performance.now()

  // A 1 ms timer beside the histogram: the histogram keeps the distribution, this keeps WHEN each stall ended.
  const ticker = setInterval(() => {
    const now = performance.now()
    const gap = now - last

    last = now

    if (gap >= STALL_NOTE_MS) {
      stalls.push({
        atMs: now,
        hrtimeMs: Number(process.hrtime.bigint() / 1000n) / 1000,
        ms: Math.round(gap * 100) / 100
      })
    }
  }, 1)

  histogram.enable()

  return {
    slice: ms => {
      sliceMax = Math.max(sliceMax, ms)
    },
    stop: async () => {
      await yieldToLoop(5)
      histogram.disable()
      clearInterval(ticker)

      const loopMax = histogram.max / 1e6

      return {
        p99Ms: histogram.percentile(99) / 1e6,
        maxMs: Math.max(loopMax, sliceMax),
        loopMaxMs: loopMax,
        sliceMaxMs: sliceMax,
        samples: histogram.count,
        stalls
      }
    }
  }
}

/** One synchronous addon call as main saw it: when it began, how long it held the loop, and how many flushes this
 *  wrapper had in flight at the call (M2, critic B6-m2: `currentEventId` waits for a stalled flush of this process). */
export interface AddonCall {
  fn: string
  startMs: number
  ms: number
  flushesPending: number
}

/** M2: the addon with every synchronous call timed into `log`, under the gate's load (never before it). */
export function timedAddon(addon: IcloneFsevents, log: AddonCall[]): IcloneFsevents {
  let flushesPending = 0

  const time = <T>(fn: string, call: () => T): T => {
    const pendingAtCall = flushesPending
    const startMs = performance.now()

    try {
      return call()
    } finally {
      log.push({ fn, startMs, ms: performance.now() - startMs, flushesPending: pendingAtCall })
    }
  }

  return {
    currentEventId: () => time('currentEventId', () => addon.currentEventId()),
    start: (paths, onEvents) => time('start', () => addon.start(paths, onEvents)),
    flush: (handle: FsEventsHandle) => {
      const flushed = time('flush', () => addon.flush(handle))

      flushesPending += 1

      return flushed.finally(() => {
        flushesPending -= 1
      })
    },
    latestEventId: handle => time('latestEventId', () => addon.latestEventId(handle)),
    stop: handle => time('stop', () => addon.stop(handle)),
    activeCount: () => time('activeCount', () => addon.activeCount()),
    volume: dir => addon.volume(dir)
  }
}

/** The addon calls that began inside [fromMs, toMs]. */
export const callsWithin = (log: readonly AddonCall[], fromMs: number, toMs: number): AddonCall[] =>
  log.filter(call => call.startMs >= fromMs && call.startMs <= toMs)

/** Each stall with the longest synchronous addon call that overlaps it AND held at least half of it, or `unattributed`
 *  (still red, never exempt): a 0 ms call that merely ran during someone else's stall is not its cause. */
export function attributeStalls(
  stalls: readonly LoopStall[],
  log: readonly AddonCall[]
): Array<LoopStall & { cause: string }> {
  return stalls.map(stall => {
    const overlapping = log
      .filter(
        call => call.ms >= stall.ms / 2 && call.startMs < stall.atMs && call.startMs + call.ms > stall.atMs - stall.ms
      )
      .sort((a, b) => b.ms - a.ms)[0]

    return {
      ...stall,
      cause: overlapping
        ? `${overlapping.fn} ${Math.round(overlapping.ms * 100) / 100} ms (${overlapping.flushesPending} flushes in flight)`
        : 'unattributed'
    }
  })
}

/** The largest synchronous addon call; NaN when none was made (a gate with no addon call proves nothing). */
export const addonSyncMax = (calls: readonly AddonCall[]): number =>
  calls.length === 0 ? Number.NaN : Math.max(...calls.map(call => call.ms))

/** M2, structural: no `currentEventId` while a flush is in flight, and at least one read (else vacuous). */
export function idReadsWithFlushPending(id: string, calls: readonly AddonCall[]): GateItem {
  const reads = calls.filter(call => call.fn === 'currentEventId')
  const pending = reads.filter(call => call.flushesPending > 0).length

  return {
    id,
    value: `${pending} of ${reads.length} id reads`,
    target: '0 of > 0 id reads',
    pass: reads.length > 0 && pending === 0
  }
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return Number.NaN
  }

  const sorted = [...values].sort((a, b) => a - b)

  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

export interface GateItem {
  id: string
  value: number | string
  target: string
  pass: boolean
}

export const below = (id: string, value: number, limit: number, unit = 'ms'): GateItem => ({
  id,
  value: Math.round(value * 100) / 100,
  target: `< ${limit} ${unit}`,
  pass: Number.isFinite(value) && value < limit
})

/** Prints the two lines the release gate reads and returns whether every item passed. */
export function report(gate: string, items: readonly GateItem[], info: Record<string, unknown> = {}): boolean {
  const pass = items.length > 0 && items.every(item => item.pass)
  const passed = items.filter(item => item.pass).length

  console.log(`INFO_JSON ${JSON.stringify({ gate, ...info })}`)
  console.log(`RESULT_JSON ${JSON.stringify({ gate, pass, items })}`)
  console.log(`SUMMARY ${passed}/${items.length} PASS (${gate})`)

  return pass
}
