/**
 * v0.0.7 CF7 round 2 (critic B6-M1) — PERF.main.grow: a root first scanned small (300 folders, held in process) that
 * then GROWS past 100 000 folders (a new project plus a clone or an install) never has main walk it. The bound on
 * an in-process tree holds as it grows (hardlinks-walker.ts: `TreeOutgrown`, the root moves to a worker), so every
 * check after a growth costs main a bounded update, and the tree's records never sit on main's heap.
 *
 *   PERF.main.grow.check.block_max   main's longest stall over the checks after each growth (15k, +85k, +25k) < 50 ms
 *   PERF.main.grow.loop_p99          loop delay p99 over them < 16 ms
 *   PERF.main.grow.heap_mb           main's heap growth from the small root to 125k folders < 48 MB
 *   PERF.main.grow.answered          every check answers ok
 *   PERF.main.grow.in_worker         the tree ends in a worker (liveWalkWorkers 1), after exactly one 'outgrown' drop
 *
 * Red on 1143b442e4: the in-process tree walked 97k-122k folders on main at ~98 % busy, 0.66-0.9 s per check, +60 MB.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import v8 from 'node:v8'
import vm from 'node:vm'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { checkBeforeStart, createHardlinkGuard } from '../iclone-confinement/hardlinks'
import { defaultFsEventsSource } from '../iclone-confinement/hardlinks-fsevents'
import { liveWalkWorkers } from '../iclone-confinement/hardlinks-walker'

import { below, type GateItem, PERF_V007_ENABLED, report, startBlockMeter, yieldToLoop } from './gate-helpers'

const MAKE_FIXTURE = path.resolve(__dirname, '..', '..', 'scripts', 'perf-v007', 'make-fixture.mjs')
const SMALL_DIRS = 300
const GROWTHS = [15_000, 85_000, 25_000]
const BLOCK_LIMIT_MS = 50
const LOOP_P99_LIMIT_MS = 16
const HEAP_LIMIT_MB = 8 // real ~0.25 MB; 48 let the TreeOutgrown mutant pass on heap (45.96 MB, critic B7-n3)

/** A subtree of `dirs` folders (and as many files) at `dir`, made by the fixture script (fanout 16). */
function growAt(dir: string, dirs: number): void {
  const run = spawnSync(process.execPath, [MAKE_FIXTURE, dir, '--dirs', String(dirs), '--files', String(dirs)], {
    encoding: 'utf8',
    maxBuffer: 1 << 24
  })

  if (run.status !== 0) {
    throw new Error(`perf-v007: make-fixture failed (${run.status}): ${run.stderr}`)
  }
}

const collectGarbage = (): (() => void) => {
  v8.setFlagsFromString('--expose-gc')

  return vm.runInNewContext('gc') as () => void
}

describe.skipIf(!PERF_V007_ENABLED)(
  'v0.0.7 PERF: a small root that grows past 100 000 folders never walks on main',
  () => {
    let parent: string
    let root: string

    beforeAll(() => {
      parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pv7-grow-')))

      if (!parent.startsWith('/private/tmp/')) {
        throw new Error(`perf-v007: TMPDIR resolves to ${parent}, not under /private/tmp: run through iso_env.sh`)
      }

      root = path.join(parent, 'project')

      for (let index = 0; index < SMALL_DIRS; index += 1) {
        const dir = path.join(root, `s${index % 20}`, `t${index}`)

        mkdirSync(dir, { recursive: true })
        writeFileSync(path.join(dir, 'f'), 'x')
      }
    }, 120_000)

    afterAll(async () => {
      await defaultFsEventsSource()?.close()

      if (parent) {
        rmSync(parent, { recursive: true, force: true })
      }
    })

    it('PERF.main.grow: 300 folders, then +15k, +85k, +25k: main stays free and the tree moves to a worker', async () => {
      const gc = collectGarbage()
      const drops: string[] = []
      const measured: string[] = []

      const guard = createHardlinkGuard({
        ackFile: path.join(parent, 'userdata-grow', 'confinement', 'acks.json'),
        onMeasure: (_root, how) => measured.push(how),
        onTreeDropped: event => drops.push(event.why)
      })

      const items: GateItem[] = []
      const info: Record<string, unknown> = { smallDirs: SMALL_DIRS, growths: GROWTHS }

      try {
        await yieldToLoop(20)
        await guard.prewarm(root)
        expect(await checkBeforeStart(guard, root, 'build')).toMatchObject({ ok: true })
        expect(liveWalkWorkers()).toBe(0)
        gc()

        const heapBefore = process.memoryUsage().heapUsed
        const checks: Array<{ ms: number; ok: boolean; maxMs: number; p99Ms: number }> = []

        for (const [index, dirs] of GROWTHS.entries()) {
          growAt(path.join(root, `grown-${index}`), dirs)
          await yieldToLoop(200)

          const meter = startBlockMeter()
          const started = performance.now()
          const answer = await checkBeforeStart(guard, root, 'build')
          const ms = performance.now() - started
          const block = await meter.stop()

          checks.push({ ms, ok: answer.ok, maxMs: block.maxMs, p99Ms: block.p99Ms })
        }

        gc()

        const heapMb = (process.memoryUsage().heapUsed - heapBefore) / 1_048_576

        items.push(
          below('PERF.main.grow.check.block_max', Math.max(...checks.map(check => check.maxMs)), BLOCK_LIMIT_MS),
          below('PERF.main.grow.loop_p99', Math.max(...checks.map(check => check.p99Ms)), LOOP_P99_LIMIT_MS),
          below('PERF.main.grow.heap_mb', heapMb, HEAP_LIMIT_MB, 'MB'),
          {
            id: 'PERF.main.grow.answered',
            value: checks.every(check => check.ok) ? 'ok' : JSON.stringify(checks),
            target: 'ok',
            pass: checks.every(check => check.ok)
          },
          {
            id: 'PERF.main.grow.in_worker',
            value: `workers ${liveWalkWorkers()}, drops ${JSON.stringify(drops)}`,
            target: 'workers 1, drops ["outgrown"]',
            pass: liveWalkWorkers() === 1 && drops.length === 1 && drops[0] === 'outgrown'
          }
        )
        info.checks = checks.map(check => ({ ...check, ms: Math.round(check.ms) }))
        info.measured = measured
        info.heapMb = Math.round(heapMb * 10) / 10

        expect(report('PERF.main.grow', items, info)).toBe(true)
      } finally {
        guard.close()
      }
    }, 900_000)
  }
)
