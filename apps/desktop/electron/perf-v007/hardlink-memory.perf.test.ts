/**
 * v0.0.7 CF7 round 2 (critic B6-m3, B6-n1) — PERF.mem: worker trees stay inside the resident budget, a released root
 * rescans at full speed, and released roots cost no idle CPU. Three roots of 520 000 folders (the owner's 520 101),
 * made by scripts/perf-v007/make-fixture.mjs under the run's /private/tmp, real FSEvents, the default worker walk.
 *   PERF.mem.bytes_per_dir        process RSS growth for the first root / its folders < 800 B (declared 650 + 10 MB)
 *   PERF.mem.no_growth_mb         open the three roots, release them all, settle (3 s + gc): four cycles; cycle 1 is a
 *                                 warm-up (not judged), cycle 2 the baseline; cycles 3 and 4 each <= baseline + 64 MB,
 *                                 on the RSS high-water while the roots are held (settled RSS/footprint printed only)
 *   PERF.mem.peak_mb              RSS growth high-water over the three scans < budget + one tree (declared peak)
 *   PERF.mem.workers              resident workers after the three roots = what the budget holds (1)
 *   PERF.mem.reentry_ms           the first released root, asked again through checkBeforeStart: ok, `full`, < 10 s
 *   PERF.mem.idle_release         IDLE_RELEASE_MS later, one check of a small root releases every big root: workers 0
 *   PERF.mem.idle_cpu_ms          process CPU over 20 s with the three released roots minus 20 s with none < 200 ms
 *                                 (1 % of a core: a released root keeps no stream, timer or worker)
 * Why no "settled RSS < budget" item (lead, DECISOES_LEAD): macOS keeps the pages a released worker freed (malloc
 * zones, the isolate's heap) counted in RSS and phys_footprint until the system is under memory pressure, so RSS
 * right after a release measures the allocator, not a leak (measured: 586 MB with 0 workers). What a leak would show
 * is growth from one cycle to the next; the freed pages are reused, so a bounded guard stays flat. The peak item is
 * the declared high-water mark. Why cycle 1 is not judged (critic B7, v0.0.7): its settle sometimes lands before
 * macOS has handed the freed pages back, sometimes after (measured: RSS 585 then 584 MB in one pass, 72 then 587 MB in
 * the next; phys_footprint ~110 MB after cycle 1, then a flat ~650 MB), so a cycle-1 baseline flips the item with no
 * leak either way. From cycle 2 on the allocator's pages are resident and reused: growth past that is the guard's.
 * The gated figure is the RSS high-water while the three roots are held (pages just touched are resident): the settled
 * phys_footprint also drops back at any cycle (653 -> 120 MB seen), so it is printed, not judged. A leak raises the held
 * peak by about one tree per cycle (the leak mutant: +900 MB per cycle).
 * Run only through iso_env.sh (HOME, TMPDIR disposable).
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import v8 from 'node:v8'
import vm from 'node:vm'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  checkBeforeStart,
  createHardlinkGuard,
  type HardlinkMeasure,
  RESIDENT_BYTES_PER_DIR,
  WORKER_BASE_DIRS
} from '../iclone-confinement/hardlinks'
import { defaultFsEventsSource } from '../iclone-confinement/hardlinks-fsevents'
import { liveWalkWorkers } from '../iclone-confinement/hardlinks-walker'

// Helpers inline (gate-helpers.ts is being changed by another front): the same fixture script and report lines.
const PERF_V007_ENABLED = process.env.ICLONE_PERF_V007 === '1'
const MAKE_FIXTURE = path.resolve(__dirname, '..', '..', 'scripts', 'perf-v007', 'make-fixture.mjs')

interface Fixture {
  root: string
  remove: () => void
}

interface GateItem {
  id: string
  value: number | string
  target: string
  pass: boolean
}

/** A fresh fixture in a private folder under the run's TMPDIR, which must be under /private/tmp. */
function makeFixture(args: readonly string[]): Fixture {
  const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pv7-mem-')))

  if (!parent.startsWith('/private/tmp/')) {
    rmSync(parent, { recursive: true, force: true })
    throw new Error(`perf-v007: TMPDIR resolves to ${parent}, not under /private/tmp: run through iso_env.sh`)
  }

  const root = path.join(parent, 'fx')
  const run = spawnSync(process.execPath, [MAKE_FIXTURE, root, ...args], { encoding: 'utf8', maxBuffer: 1 << 24 })

  if (run.status !== 0 || !run.stdout.split('\n').some(text => text.startsWith('FIXTURE_JSON '))) {
    rmSync(parent, { recursive: true, force: true })
    throw new Error(`perf-v007: make-fixture failed (${run.status}): ${run.stderr}`)
  }

  return { root, remove: () => rmSync(parent, { recursive: true, force: true }) }
}

const yieldToLoop = (ms = 2): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const below = (id: string, value: number, limit: number, unit = 'ms'): GateItem => ({
  id,
  value: Math.round(value * 100) / 100,
  target: `< ${limit} ${unit}`,
  pass: Number.isFinite(value) && value < limit
})

/** The two lines the release gate reads; true when every item passed. */
function report(gate: string, items: readonly GateItem[], info: Record<string, unknown>): boolean {
  const pass = items.length > 0 && items.every(item => item.pass)

  console.log(`INFO_JSON ${JSON.stringify({ gate, ...info })}`)
  console.log(`RESULT_JSON ${JSON.stringify({ gate, pass, items })}`)
  console.log(`SUMMARY ${items.filter(item => item.pass).length}/${items.length} PASS (${gate})`)

  return pass
}

const DIRS = 520_000
const FILES = 52_000
const ROOTS = 3
const BYTES_PER_DIR_LIMIT = 800
const REENTRY_LIMIT_MS = 10_000
const IDLE_RELEASE_MS = 30 * 60_000
const CPU_WINDOW_MS = 20_000
const IDLE_CPU_LIMIT_MS = 200
const MB = 1_048_576
const CYCLES = 4
const GROWTH_LIMIT_MB = 64
const FOOTPRINT_UNITS: Record<string, number> = { B: 1, KB: 1_024, MB: MB, GB: 1_024 * MB }

/** This process's phys_footprint in MB through /usr/bin/footprint (~10 ms), or null when it cannot be read. */
function physFootprintMb(): number | null {
  const run = spawnSync('/usr/bin/footprint', ['-p', String(process.pid)], { encoding: 'utf8', timeout: 10_000 })
  const found = /Footprint:\s*([\d.]+)\s*(B|KB|MB|GB)/.exec(run.stdout ?? '')

  return found ? Math.round((Number(found[1]) * FOOTPRINT_UNITS[found[2]]) / MB) : null
}

const collectGarbage = (): (() => void) => {
  v8.setFlagsFromString('--expose-gc')

  return vm.runInNewContext('gc') as () => void
}

/** Process CPU (every thread, workers included) over `ms` of idle. */
async function cpuOver(ms: number): Promise<number> {
  const before = process.cpuUsage()

  await yieldToLoop(ms)

  const used = process.cpuUsage(before)

  return (used.user + used.system) / 1_000
}

/** RSS sampled every 100 ms until stopped: its high-water mark. */
function rssPeak(): { stop: () => number } {
  let peak = process.memoryUsage().rss

  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss)
  }, 100)

  return {
    stop: () => {
      clearInterval(timer)

      return Math.max(peak, process.memoryUsage().rss)
    }
  }
}

describe.skipIf(!PERF_V007_ENABLED)(
  'v0.0.7 PERF: resident trees stay inside the budget; released roots cost nothing',
  () => {
    const trees: Fixture[] = []
    let small: Fixture

    beforeAll(() => {
      for (let index = 0; index < ROOTS; index += 1) {
        trees.push(makeFixture(['--files', String(FILES), '--dirs', String(DIRS)]))
      }

      small = makeFixture(['--files', '200', '--dirs', '200'])
    }, 1_800_000)

    afterAll(async () => {
      await defaultFsEventsSource()?.close()
      trees.forEach(tree => tree.remove())
      small?.remove()
    })

    it('PERF.mem: three 520 000-folder roots, a one-tree budget, a released root rescanned, then all idle-released', async () => {
      const gc = collectGarbage()
      let shiftMs = 0
      const measured: Array<[string, HardlinkMeasure]> = []
      const released: string[] = []
      const budgetDirs = Math.ceil(1.2 * (DIRS + WORKER_BASE_DIRS))
      const budgetMb = (budgetDirs * RESIDENT_BYTES_PER_DIR) / MB

      const guard = createHardlinkGuard({
        ackFile: path.join(os.tmpdir(), `pv7-mem-${process.pid}`, 'confinement', 'acks.json'),
        now: () => new Date(Date.now() + shiftMs),
        residentDirsBudget: budgetDirs,
        idleReleaseMs: IDLE_RELEASE_MS,
        onMeasure: (root, how) => measured.push([root, how]),
        onRefresh: (root, phase) => {
          if (phase === 'released') {
            released.push(root)
          }
        }
      })

      const items: GateItem[] = []
      const info: Record<string, unknown> = { dirs: DIRS, files: FILES, roots: ROOTS, budgetDirs, budgetMb }

      try {
        await yieldToLoop(500)
        gc()

        const cpuNone = await cpuOver(CPU_WINDOW_MS)
        const base = process.memoryUsage().rss
        const peak = rssPeak()

        const first = await guard.check(trees[0].root)

        await yieldToLoop(3_000)

        const firstDirs = first.ok ? first.dirs : Number.NaN
        const bytesPerDir = (process.memoryUsage().rss - base) / firstDirs

        for (const tree of trees.slice(1)) {
          expect((await guard.check(tree.root)).ok).toBe(true)
        }

        await yieldToLoop(3_000)
        gc()

        const settledMb = (process.memoryUsage().rss - base) / MB
        const peakMb = (peak.stop() - base) / MB
        const workersAfter = liveWalkWorkers()
        const treeMb = (firstDirs * RESIDENT_BYTES_PER_DIR) / MB

        // The first root was released by the budget: asked again, it is scanned (never answered from what went).
        const startedReentry = performance.now()
        const reentry = await checkBeforeStart(guard, trees[0].root, 'build')
        const reentryMs = performance.now() - startedReentry
        const reentryHow = measured.filter(([root]) => root === trees[0].root).at(-1)?.[1]

        // Past the idle time, one check of a small root releases every big one (the sweep), then nothing runs.
        shiftMs = IDLE_RELEASE_MS + 60_000
        expect((await guard.check(small.root)).ok).toBe(true)
        await yieldToLoop(1_000)

        const workersIdle = liveWalkWorkers()
        const cpuReleased = await cpuOver(CPU_WINDOW_MS)
        const cycles: Array<{ heldPeakMb: number | null; rssMb: number; footprintMb: number | null; workers: number }> = []

        const settleCycle = async (heldPeakMb: number | null) => {
          await yieldToLoop(3_000)
          gc()
          cycles.push({
            heldPeakMb,
            rssMb: Math.round((process.memoryUsage().rss - base) / MB),
            footprintMb: physFootprintMb(),
            workers: liveWalkWorkers()
          })
        }

        // Cycle 1 ended above (three roots opened, all released); cycles 2..CYCLES open and release them again.
        await settleCycle(null)

        for (let cycle = 2; cycle <= CYCLES; cycle += 1) {
          // The judged figure is the RSS high-water WHILE the three roots are held: those pages were just touched, so
          // they are resident whatever macOS did with the freed ones before (critic A4-min risk: the settled
          // phys_footprint also drops back at any cycle, 653 -> 120 MB, so a settled baseline can flip with no leak).
          const held = rssPeak()

          for (const tree of trees) {
            expect((await guard.check(tree.root)).ok).toBe(true)
          }

          const heldPeakMb = Math.round((held.stop() - base) / MB)
          shiftMs += IDLE_RELEASE_MS + 60_000
          expect((await guard.check(small.root)).ok).toBe(true)
          await settleCycle(heldPeakMb)
        }

        cycles.forEach((cycle, index) =>
          console.log(
            `PERF.mem cycle ${index + 1}: held peak ${cycle.heldPeakMb ?? 'n/a'} MB, settled rss +${cycle.rssMb} MB, footprint ${cycle.footprintMb ?? 'n/a'} MB, workers ${cycle.workers}`
          )
        )

        const metric = 'RSS held peak'
        const mbOf = (cycle: (typeof cycles)[number]) => cycle.heldPeakMb ?? 0
        const baselineMb = mbOf(cycles[1])
        const judged = cycles.slice(2).map(mbOf)
        const growthMb = Math.max(...judged) - baselineMb

        items.push(
          below('PERF.mem.bytes_per_dir', bytesPerDir, BYTES_PER_DIR_LIMIT, 'B'),
          {
            id: 'PERF.mem.no_growth_mb',
            value: `${metric}: cycle 2 ${baselineMb} MB, cycles 3..${CYCLES} ${judged.join(', ')} MB (+${growthMb})`,
            target: `cycles 3..${CYCLES} each <= cycle 2 + ${GROWTH_LIMIT_MB} MB (cycle 1 warm-up)`,
            pass: judged.every(mb => mb <= baselineMb + GROWTH_LIMIT_MB)
          },
          below('PERF.mem.peak_mb', peakMb, budgetMb + treeMb * 1.15, 'MB'),
          {
            id: 'PERF.mem.workers',
            value: workersAfter,
            target: '1 (the budget holds one 520 000-folder tree)',
            pass: workersAfter === 1
          },
          {
            id: 'PERF.mem.reentry',
            value: `${reentry.ok ? 'ok' : 'refused'}, ${reentryHow ?? 'none'}, ${Math.round(reentryMs)} ms`,
            target: `ok, full, < ${REENTRY_LIMIT_MS} ms`,
            pass: reentry.ok && reentryHow === 'full' && reentryMs < REENTRY_LIMIT_MS
          },
          {
            id: 'PERF.mem.idle_release',
            value: `workers ${workersIdle}, released ${released.length}`,
            target: 'workers 0, released >= 3',
            pass: workersIdle === 0 && released.length >= ROOTS
          },
          below('PERF.mem.idle_cpu_ms', cpuReleased - cpuNone, IDLE_CPU_LIMIT_MS)
        )
        Object.assign(info, {
          bytesPerDir: Math.round(bytesPerDir),
          settledMb: Math.round(settledMb),
          peakMb: Math.round(peakMb),
          treeMb: Math.round(treeMb),
          cpuNoneMs: Math.round(cpuNone),
          cpuReleasedMs: Math.round(cpuReleased),
          cycles,
          rssAfterReleaseMb: Math.round((process.memoryUsage().rss - base) / MB),
          measured: measured.map(([root, how]) => `${path.basename(path.dirname(root))}:${how}`)
        })

        expect(report('PERF.mem', items, info)).toBe(true)
      } finally {
        guard.close()
      }
    }, 1_800_000)
  }
)
