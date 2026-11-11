/**
 * v0.0.7 CF6 (critic B4-M1) — PERF.scan.install: a full scan's records reach main without stopping it, on a tree the
 * owner's size (520 000 folders, 600 000 files: scripts/perf-v007/make-fixture.mjs, under the run's /private/tmp).
 *
 * Before CF6 the walk worker posted every record in one message; main decoded all of it, then folded the scan and the
 * one-volume test over the whole Map, in one turn: ~0.42 s on this tree, at the end of every first scan, background
 * refresh and after-sleep scan. The 300 000-file fixture of hardlink-guard.perf.test.ts has 30 001 folders, so its
 * gates never saw it. Now the records come in pages, one per turn (hardlinks-walker.ts), folded as they land.
 *
 *   PERF.scan.install.first_scan.block_max   main's longest stall over the whole first scan, completion included
 *   PERF.scan.install.refresh_check.block_max  over the check (answered from the stream) that starts the refresh
 *   PERF.scan.install.refresh.block_max      over that paced background refresh, from there to its install
 *   PERF.scan.install.after_sleep.block_max  over the command answered past the bound (61 min of sleep)
 *   PERF.scan.install.*_ms                   the hand-over: the walk's last progress to the records in main's hands
 *
 * Every limit < 50 ms. CF7: the records now stay in the worker (hardlinks-walker.ts TreeResident); the hand-over
 * measured here is the summary alone. Mutant (the worker posts the records with `done`): the block items go red.
 */
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  BACKGROUND_SLOWDOWN,
  checkBeforeStart,
  createHardlinkGuard,
  refreshCadence
} from '../iclone-confinement/hardlinks'
import { defaultFsEventsSource } from '../iclone-confinement/hardlinks-fsevents'
import { walkInWorker, type WalkInWorkerOptions } from '../iclone-confinement/hardlinks-walker'

import {
  below,
  type Fixture,
  makeFixture,
  PERF_V007_ENABLED,
  report,
  startBlockMeter,
  yieldToLoop
} from './gate-helpers'

const DIRS = 520_000
const FILES = 600_000
const BLOCK_LIMIT_MS = 50
const SLEEP_MS = 61 * 60_000

describe.skipIf(!PERF_V007_ENABLED)('v0.0.7 PERF: a full scan installs without stopping main (520 000 folders)', () => {
  let tree: Fixture

  beforeAll(() => {
    tree = makeFixture(['--files', String(FILES), '--dirs', String(DIRS)])
  }, 600_000)

  afterAll(async () => {
    await defaultFsEventsSource()?.close()
    tree?.remove()
  })

  it('PERF.scan.install: first scan, background refresh and after-sleep scan never block main > 50 ms', async () => {
    let offset = 0
    let refreshStarted: (() => void) | null = null
    let refreshInstalled: (() => void) | null = null
    const started = new Promise<void>(resolve => (refreshStarted = resolve))
    const installed = new Promise<void>(resolve => (refreshInstalled = resolve))
    const phases: string[] = []
    const handOvers: Array<{ pace: string; ms: number; dirs: number }> = []

    const walkFull = async (root: string, options: WalkInWorkerOptions) => {
      let lastProgress = performance.now()
      let dirs = 0

      const resident = await walkInWorker(root, {
        ...options,
        onProgress: reached => {
          lastProgress = performance.now()
          dirs = reached
          options.onProgress?.(reached)
        }
      })

      handOvers.push({ pace: options.pace ?? 'fast', ms: performance.now() - lastProgress, dirs })

      return resident
    }

    const guard = createHardlinkGuard({
      ackFile: path.join(path.dirname(tree.root), 'userdata-install', 'confinement', 'acks.json'),
      now: () => new Date(Date.now() + offset),
      walkFull,
      onRefresh: (_root, phase) => {
        phases.push(phase)

        if (phase === 'started') {
          refreshStarted?.()
        } else if (phase === 'installed') {
          refreshInstalled?.()
        }
      }
    })

    try {
      await yieldToLoop(20)

      // 1. The first scan, completion and install included.
      const firstMeter = startBlockMeter()
      const firstAt = performance.now()

      await guard.prewarm(tree.root)

      const firstMs = performance.now() - firstAt
      const first = await firstMeter.stop()

      expect(await checkBeforeStart(guard, tree.root, 'build')).toMatchObject({ ok: true })

      // 2. A paced background refresh, started by a check past the interval and still inside the bound. On this tree
      // the window is ~190 s wide (interval 10 x scan, bound + 2 x scan); the middle of it leaves room for the guard
      // timing its scan a little differently from this clock.
      const cadence = refreshCadence(firstMs * BACKGROUND_SLOWDOWN)

      offset = Math.round((cadence.intervalMs + cadence.boundMs) / 2)

      // The check that starts the refresh answers from the stream; its own stall is kept apart from the refresh's.
      const checkMeter = startBlockMeter()

      expect(await checkBeforeStart(guard, tree.root, 'build')).toMatchObject({ ok: true })

      const refreshCheck = await checkMeter.stop()
      const refreshMeter = startBlockMeter()
      const refreshSeen = await Promise.race([started.then(() => true), yieldToLoop(10_000).then(() => false)])

      const refreshDone =
        refreshSeen && (await Promise.race([installed.then(() => true), yieldToLoop(400_000).then(() => false)]))

      const refresh = await refreshMeter.stop()

      expect(refreshDone ? 'refresh installed' : 'no background refresh installed').toBe('refresh installed')

      // 3. Past the bound (a Mac sleep): the command's own fast scan answers.
      offset += SLEEP_MS

      const sleepMeter = startBlockMeter()
      const answer = await checkBeforeStart(guard, tree.root, 'build')
      const afterSleep = await sleepMeter.stop()

      const byPace = (pace: string) => handOvers.filter(entry => entry.pace === pace)
      const [firstHandOver, ...fastLater] = byPace('fast')
      const refreshHandOver = byPace('background').at(-1)
      const sleepHandOver = fastLater.at(-1)

      const pass = report(
        'PERF.scan.install',
        [
          below('PERF.scan.install.first_scan.block_max', first.maxMs, BLOCK_LIMIT_MS),
          below('PERF.scan.install.refresh_check.block_max', refreshCheck.maxMs, BLOCK_LIMIT_MS),
          below('PERF.scan.install.refresh.block_max', refresh.maxMs, BLOCK_LIMIT_MS),
          below('PERF.scan.install.after_sleep.block_max', afterSleep.maxMs, BLOCK_LIMIT_MS),
          {
            id: 'PERF.scan.install.after_sleep.answered',
            value: answer.ok ? 'ok' : JSON.stringify(answer),
            target: 'ok',
            pass: answer.ok === true
          },
          {
            id: 'PERF.scan.install.walks_seen',
            value: `first ${firstHandOver?.dirs ?? 0}, refresh ${refreshHandOver?.dirs ?? 0}, after-sleep ${sleepHandOver?.dirs ?? 0} folders`,
            target: `all three walks of >= ${DIRS} folders`,
            pass: [firstHandOver, refreshHandOver, sleepHandOver].every(walk => (walk?.dirs ?? 0) >= DIRS)
          }
        ],
        {
          fixture: tree.info,
          firstScanMs: Math.round(firstMs),
          refreshOffsetMs: offset - SLEEP_MS,
          phases,
          walks: handOvers.map(walk => ({ ...walk, ms: Math.round(walk.ms) })),
          handOverMs: {
            first: Math.round(firstHandOver?.ms ?? -1),
            refresh: Math.round(refreshHandOver?.ms ?? -1),
            afterSleep: Math.round(sleepHandOver?.ms ?? -1)
          },
          blockP99Ms: { first: first.p99Ms, refresh: refresh.p99Ms, afterSleep: afterSleep.p99Ms }
        }
      )

      expect(pass).toBe(true)
    } finally {
      guard.close()
    }
  }, 900_000)
})
