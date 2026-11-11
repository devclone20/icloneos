/**
 * RE-TIGHTENED 2026-11-10 (v0.0.7 CF1, critics A-m2 and B-m4). The guard runs on our own FSEvents addon: a warm
 * stream-backed check is the same-stream canary barrier, measured ~9.6 ms p50 / ~10.9 ms p95 per check (the canary
 * is delivered by the 10 ms flush nudge, hardlinks-fsevents.ts FLUSH_NUDGE_MS), and the scratch root is walked
 * (< 1 ms). The 250 ms of gatefix (sized for the old ~135 ms barrier of the napi module) is gone:
 *   PERF.cmd.overhead.check.p95   per check (pre or post, either root) p95 < 15 ms
 *   PERF.cmd.overhead.p95         per command (pre + post, both roots) p95 < 30 ms
 * Owner's project, measured read-only (V1b): first full scan 36.6 s; it now runs in a worker thread (CF1, B-M1).
 *
 * v0.0.7 PERF gates on the F7 hard-link guard, through the API backend-seatbelt.ts uses: `createHardlinkGuard(deps)
 * .check(root, cls)` once per root before a confined command and once per root after it exits (the project and the
 * run's scratch). The fixture is a clean 300 000-file / 30 000-directory tree (scripts/perf-v007/make-fixture.mjs), so
 * every check must answer ok.
 *
 * `check` may stay synchronous or return a Promise (a walk moved off the main thread): every call is awaited. A result
 * that says it is still measuring (`pending`/`scanning` true, or a block of kind `pending`/`scanning`) is asked again
 * every 50 ms until it settles; that is how a first scan that runs in the background is timed to its end.
 *
 *   PERF.main.block    50 commands (pre + post, both roots) on a warm guard: loop delay p99 < 16 ms, max < 50 ms
 *   PERF.cmd.overhead  the same commands: per check p95 < 15 ms, per command (pre + post, both roots) p95 < 30 ms
 *   PERF.cmd.overhead.stream  in hardlink-stream.perf.test.ts (its lstat spy must not sit in these timings)
 *   PERF.root.open     a fresh guard's first check of the tree: main blocked < 50 ms, settled < 10 s
 *   PERF.idle.main     CF1 (B-M1): main's event-loop utilization (perf_hooks eventLoopUtilization) while the full scan
 *                      of the 300k tree runs, < 10 %: the first scan (prewarm), and a background refresh forced by
 *                      moving the guard's clock past the refresh interval (CF4: refreshCadence). Red before CF1: 0.965 (the walk on main).
 *   PERF.idle.cpu      CF4 (B2-m3): the PROCESS CPU (process.cpuUsage: main, the walk worker and the thread pool) of
 *                      one background-paced full scan of the 300k tree, projected to the owner's 520 101-folder
 *                      project linearly per folder (this fixture holds 10 files per folder, so per folder it costs at
 *                      least what his does), and divided by the interval the cadence then gives (hardlinks.ts
 *                      refreshCadence of the projected scan length): the average share of one core the refresh costs
 *                      an idle app, < 5 %. Also held: the paced walk is at most BACKGROUND_SLOWDOWN times slower
 *                      than the fast one (the estimate the cadence uses before a first background scan), and the
 *                      first scan stays fast (the fast walk is the one the first scan uses). Red before CF4: the
 *                      refresh ran flat out every 4 min (critic B2: ~31 s CPU per 520k pass, ~13 % of a core); red
 *                      on CF4's paced async walk (9.33 %: its thread-pool hand-offs); CF4b's synchronous worker walk
 *                      (hardlinks-walk.ts walkTreeSync) makes it green.
 *   PERF.after_sleep   CF5 (B3-M1): the guard's clock moved 61 min (past any bound, the 30-min ceiling included: a
 *                      Mac that slept with the lid closed, the scheduled refresh never ran), twice: once while a paced
 *                      background refresh runs (it must be promoted to full speed, never waited on), once with none
 *                      running. Each `checkBeforeStart` answers ok < 10 s (the start's refusal is at 30 s), main's
 *                      loop delay max < 50 ms meanwhile, and both answers come from a full-speed walk. Red before
 *                      CF5: the check waited on the paced walk (critic B3: refused at 30 s on a 520k-folder tree).
 *   PERF.main.block.contended  CF1 (B-m1): the 50 commands again while a read-only `find … -exec stat` walks the
 *                      same tree in a loop (disk metadata contention): the raw loop delay max < 50 ms (the
 *                      verdict; every stall is printed with the addon call that overlaps it, or `unattributed`,
 *                      and none is exempt). M2 (B6-m2, M2_stall_trace.md): every synchronous addon call the guard
 *                      makes DURING the 50 commands is timed (addon_sync_max < 5 ms), and no
 *                      FSEventsGetCurrentEventId is made while a flush is in flight (structural: it waits ~1 s for a
 *                      stalled flush, so it is red at the base even on a pass where no flush stalls). The old item
 *                      timed 2 000 calls BEFORE the load, with no flush in flight: it could never see the stall.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  BACKGROUND_SLOWDOWN,
  checkBeforeStart,
  createHardlinkGuard,
  HARDLINK_CHECK_DEADLINE_MS,
  refreshCadence
} from '../iclone-confinement/hardlinks'
import { createFsEventsSource, defaultFsEventsSource } from '../iclone-confinement/hardlinks-fsevents'
import { walkInWorker } from '../iclone-confinement/hardlinks-walker'
import { loadIcloneFsevents } from '../iclone-confinement/iclone-fsevents'

import {
  type AddonCall,
  addonSyncMax,
  attributeStalls,
  below,
  type BlockMeter,
  callsWithin,
  type Fixture,
  type GateItem,
  idReadsWithFlushPending,
  makeFixture,
  percentile,
  PERF_V007_ENABLED,
  report,
  startBlockMeter,
  timed,
  timedAddon,
  yieldToLoop
} from './gate-helpers'

const COMMANDS = 50
const ROOT_OPEN_LIMIT_MS = 10_000
const PENDING_KINDS = new Set(['pending', 'scanning'])

type Settled = { ok: true } | { ok: false; why: string }

function settledOf(result: unknown): Settled | null {
  if (!result || typeof result !== 'object') {
    return { ok: false, why: `not a check result: ${String(result)}` }
  }

  const fields = result as Record<string, unknown>
  const block = fields.block && typeof fields.block === 'object' ? (fields.block as Record<string, unknown>) : null

  if (fields.pending === true || fields.scanning === true || PENDING_KINDS.has(String(block?.kind ?? ''))) {
    return null
  }

  return fields.ok === true ? { ok: true } : { ok: false, why: `refused: ${JSON.stringify(block ?? fields)}` }
}

describe.skipIf(!PERF_V007_ENABLED)('v0.0.7 PERF: hard-link guard', () => {
  let tree: Fixture
  let scratch: string

  const guards: Array<{ close(): void }> = []

  const newGuard = (name: string, extra: Partial<Parameters<typeof createHardlinkGuard>[0]> = {}) => {
    const guard = createHardlinkGuard({
      ackFile: path.join(path.dirname(tree.root), `userdata-${name}`, 'confinement', 'acks.json'),
      ...extra
    })

    guards.push(guard)

    return guard
  }

  /** One check as the backend makes it, to a settled answer. */
  const check = async (guard: ReturnType<typeof newGuard>, root: string, meter: BlockMeter | null) => {
    const started = performance.now()

    for (;;) {
      const { value } = await timed(meter, () => guard.check(root, 'build'))
      const settled = settledOf(value)

      if (settled) {
        return { settled, ms: performance.now() - started }
      }

      if (performance.now() - started > ROOT_OPEN_LIMIT_MS * 3) {
        return { settled: { ok: false, why: 'still pending after 30 s' } as Settled, ms: performance.now() - started }
      }

      await yieldToLoop(50)
    }
  }

  beforeAll(() => {
    tree = makeFixture(['--files', '300000', '--dirs', '30000'])
    scratch = path.join(path.dirname(tree.root), 'scratch')
    mkdirSync(path.join(scratch, 'tmp'), { recursive: true, mode: 0o700 })
  }, 600_000)

  afterAll(async () => {
    guards.splice(0).forEach(guard => guard.close())
    await defaultFsEventsSource()?.close()
    tree?.remove()
  })

  it('PERF.root.open: the first scan never blocks main > 50 ms and settles < 10 s', async () => {
    const guard = newGuard('open')

    await yieldToLoop(20)

    const meter = startBlockMeter()
    const { settled, ms } = await check(guard, tree.root, meter)
    const block = await meter.stop()

    const items: GateItem[] = [
      below('PERF.root.open.block_max', block.maxMs, 50),
      below('PERF.root.open.settled', ms, ROOT_OPEN_LIMIT_MS),
      { id: 'PERF.root.open.answer', value: settled.ok ? 'ok' : settled.why, target: 'ok', pass: settled.ok }
    ]

    expect(report('PERF.root.open', items, { fixture: tree.info, block })).toBe(true)
  }, 600_000)

  /** 50 confined commands on a warm guard: every check's time, every command's (pre + post, both roots), the loop. */
  const commands = async (name: string, extra: Partial<Parameters<typeof createHardlinkGuard>[0]> = {}) => {
    // CF4b: how each measured check of the big tree answered. Without the FSEvents addon every check walks the tree
    // (~110 ms) and the times alone only say "slow": this names the cause.
    const treeMeasures: string[] = []
    let measuring = false

    const guard = newGuard(name, {
      ...extra,
      onMeasure: (root, how) => {
        if (measuring && root === tree.root) {
          treeMeasures.push(how)
        }
      }
    })

    const roots = [tree.root, scratch]

    // Warm: the cold scan is PERF.root.open's; these commands are the ones that follow it. CF4b: through `prewarm`,
    // as the app does at the Hermes spawn (it starts the stream with the first scan, so no command walks the tree).
    for (const root of roots) {
      await guard.prewarm(root)

      const warm = await check(guard, root, null)

      expect(warm.settled).toEqual({ ok: true })
    }

    await yieldToLoop(20)

    const perCommand: number[] = []
    const perCheck: number[] = []
    const refusals: string[] = []
    const meter = startBlockMeter()
    const fromMs = performance.now()

    measuring = true

    for (let command = 0; command < COMMANDS; command += 1) {
      let spent = 0

      for (const phase of ['pre', 'post']) {
        for (const root of roots) {
          const { settled, ms } = await check(guard, root, meter)

          spent += ms
          perCheck.push(ms)

          if (!settled.ok) {
            refusals.push(`${phase} ${root}: ${settled.why}`)
          }
        }

        // The command runs between pre and post; the next one is a later IPC.
        await yieldToLoop(2)
      }

      perCommand.push(spent)
    }

    const toMs = performance.now()
    const block = await meter.stop()

    measuring = false

    const answers: GateItem = {
      id: 'PERF.cmd.answers',
      value: refusals.length === 0 ? 'ok' : refusals[0],
      target: 'ok',
      pass: refusals.length === 0
    }

    const streamed = treeMeasures.filter(how => how === 'events-cached' || how === 'events').length

    const streamPath: GateItem = {
      id: 'PERF.cmd.overhead.path',
      value: `stream ${streamed}/${treeMeasures.length} (${[...new Set(treeMeasures)].join(',') || 'none'})`,
      target: `stream ${2 * COMMANDS}/${2 * COMMANDS}`,
      pass: treeMeasures.length === 2 * COMMANDS && streamed === treeMeasures.length
    }

    return { block, perCommand, perCheck, answers, streamPath, window: { fromMs, toMs } }
  }

  it('PERF.main.block + PERF.cmd.overhead: 50 confined commands on a warm guard', async () => {
    const { block, perCommand, perCheck, answers, streamPath } = await commands('cmds')

    const mainOk = report(
      'PERF.main.block',
      [below('PERF.main.block.p99', block.p99Ms, 16), below('PERF.main.block.max', block.maxMs, 50), answers],
      { commands: COMMANDS, block }
    )

    const overheadOk = report(
      'PERF.cmd.overhead',
      [
        below('PERF.cmd.overhead.check.p95', percentile(perCheck, 95), 15),
        below('PERF.cmd.overhead.p95', percentile(perCommand, 95), 30),
        streamPath
      ],
      {
        commands: COMMANDS,
        checkP50Ms: percentile(perCheck, 50),
        checkMaxMs: Math.max(...perCheck),
        p50Ms: percentile(perCommand, 50),
        maxMs: Math.max(...perCommand)
      }
    )

    expect({ mainOk, overheadOk }).toEqual({ mainOk: true, overheadOk: true })
  }, 600_000)

  it('PERF.idle.main: main stays < 10 % busy while the full scan runs (first scan, and a forced background refresh)', async () => {
    let offset = 0
    let refreshed: (() => void) | null = null
    const installed = new Promise<void>(resolve => (refreshed = resolve))
    let refreshStarted = 0
    let refreshElu: ReturnType<typeof performance.eventLoopUtilization> | null = null

    const guard = newGuard('idle', {
      now: () => new Date(Date.now() + offset),
      onRefresh: (_root, phase) => {
        if (phase === 'started') {
          refreshStarted = performance.now()
          refreshElu = performance.eventLoopUtilization()
        } else if (phase === 'installed') {
          refreshed?.()
        }
      }
    })

    await yieldToLoop(20)

    const firstBefore = performance.eventLoopUtilization()
    const firstStarted = performance.now()

    await guard.prewarm(tree.root)

    const first = performance.eventLoopUtilization(firstBefore)
    const firstMs = performance.now() - firstStarted

    expect((await check(guard, tree.root, null)).settled).toEqual({ ok: true })

    // Past the refresh interval since the scan began (CF4: the cadence from the estimated background scan length,
    // hardlinks.ts refreshCadence): this check answers from the stream and starts the refresh.
    // A 20 % margin on the scan length (the guard times it on its own clock), and never past the bound (a check
    // there would wait for the refresh instead of only starting it).
    offset = Math.min(
      refreshCadence(firstMs * BACKGROUND_SLOWDOWN * 1.2).intervalMs + 1_000,
      refreshCadence(firstMs * BACKGROUND_SLOWDOWN).boundMs - 1_000
    )
    expect((await check(guard, tree.root, null)).settled).toEqual({ ok: true })

    // CF4b: a refresh that never starts (no stream: the FSEvents addon missing) fails here by name, not by a hang.
    const refreshDone = await Promise.race([installed.then(() => true), yieldToLoop(300_000).then(() => false)])

    expect(refreshDone ? 'refresh installed' : 'no background refresh within 300 s').toBe('refresh installed')

    const refresh = performance.eventLoopUtilization(refreshElu ?? undefined)
    const refreshMs = performance.now() - refreshStarted

    const pass = report(
      'PERF.idle.main',
      [
        below('PERF.idle.main.first_scan_elu', first.utilization * 100, 10, '%'),
        below('PERF.idle.main.refresh_elu', refresh.utilization * 100, 10, '%'),
        {
          id: 'PERF.idle.main.refresh_seen',
          value: refreshElu ? 'yes' : 'no',
          target: 'yes',
          pass: refreshElu !== null
        }
      ],
      { fixture: tree.info, firstScanMs: Math.round(firstMs), refreshMs: Math.round(refreshMs) }
    )

    expect(pass).toBe(true)
  }, 600_000)

  it('PERF.idle.cpu: the background refresh, projected to 520 101 folders, costs < 5 % of one core over its interval', async () => {
    const OWNER_DIRS = 520_101

    const measureWalk = async (pace: 'background' | 'fast') => {
      const cpuBefore = process.cpuUsage()
      const started = performance.now()
      const resident = await walkInWorker(tree.root, { pace })
      const wallMs = performance.now() - started
      const cpu = process.cpuUsage(cpuBefore)

      resident.release()

      return { dirs: resident.scan.dirs, wallMs, cpuMs: (cpu.user + cpu.system) / 1_000 }
    }

    // Warm the cache the way the owner's refresh finds it (the first scan read the tree minutes before).
    await measureWalk('fast')

    const fast = await measureWalk('fast')
    const background = await measureWalk('background')
    const scale = OWNER_DIRS / background.dirs
    const projectedWallMs = background.wallMs * scale
    const projectedCpuMs = background.cpuMs * scale
    const { intervalMs, boundMs } = refreshCadence(projectedWallMs)
    const idleCpuPct = (projectedCpuMs / intervalMs) * 100
    const fastCpuPctAt4Min = ((fast.cpuMs * scale) / (4 * 60_000)) * 100
    const slowdown = background.wallMs / fast.wallMs

    const pass = report(
      'PERF.idle.cpu',
      [
        below('PERF.idle.cpu.refresh_avg_core', idleCpuPct, 5, '%'),
        below('PERF.idle.cpu.background_slowdown', slowdown, BACKGROUND_SLOWDOWN, 'x'),
        {
          id: 'PERF.idle.cpu.same_tree',
          value: `${background.dirs}/${fast.dirs}`,
          target: 'equal',
          pass: background.dirs === fast.dirs && fast.dirs > 0
        }
      ],
      {
        fixture: tree.info,
        fast: { wallMs: Math.round(fast.wallMs), cpuMs: Math.round(fast.cpuMs) },
        background: { wallMs: Math.round(background.wallMs), cpuMs: Math.round(background.cpuMs) },
        projection: {
          dirs: OWNER_DIRS,
          wallMs: Math.round(projectedWallMs),
          cpuMs: Math.round(projectedCpuMs),
          intervalMs: Math.round(intervalMs),
          boundMs: Math.round(boundMs),
          // What the pre-CF4 cadence cost: the fast walk every 4 min.
          beforeCf4Pct: Math.round(fastCpuPctAt4Min * 10) / 10
        }
      }
    )

    expect(pass).toBe(true)
  }, 600_000)

  it('PERF.after_sleep.check: past the bound (a Mac sleep), the next command is answered at full speed < 10 s', async () => {
    const SLEEP_MS = 61 * 60_000
    let offset = 0
    const phases: string[] = []
    const paces: string[] = []

    const guard = newGuard('sleep', {
      now: () => new Date(Date.now() + offset),
      onRefresh: (_root, phase) => phases.push(phase),
      walkFull: (root, options) => {
        paces.push(options.pace ?? 'fast')

        return walkInWorker(root, options)
      }
    })

    await yieldToLoop(20)

    const prewarmStarted = performance.now()

    await guard.prewarm(tree.root)

    const firstMs = performance.now() - prewarmStarted

    expect((await check(guard, tree.root, null)).settled).toEqual({ ok: true })

    const afterSleep = async () => {
      const meter = startBlockMeter()
      const started = performance.now()
      const answer = await checkBeforeStart(guard, tree.root, 'build')
      const ms = performance.now() - started

      return { answer, ms, block: await meter.stop() }
    }

    // 1. A paced background refresh is running (a check past the interval started it) when the lid closes.
    offset = Math.min(
      refreshCadence(firstMs * BACKGROUND_SLOWDOWN * 1.2).intervalMs + 1_000,
      refreshCadence(firstMs * BACKGROUND_SLOWDOWN).boundMs - 1_000
    )
    expect((await check(guard, tree.root, null)).settled).toEqual({ ok: true })
    await yieldToLoop(500)
    offset += SLEEP_MS

    const promoted = await afterSleep()

    // 2. No refresh running: the timer never ran during the sleep.
    offset += SLEEP_MS

    const idle = await afterSleep()
    const answered = [promoted, idle].every(run => run.answer.ok === true)
    const worst = Math.max(promoted.ms, idle.ms)

    const pass = report(
      'PERF.after_sleep',
      [
        below('PERF.after_sleep.check', worst, 10_000),
        {
          id: 'PERF.after_sleep.answered',
          value: answered ? 'ok' : JSON.stringify([promoted.answer, idle.answer]),
          target: `ok, never the ${HARDLINK_CHECK_DEADLINE_MS / 1000} s refusal`,
          pass: answered && worst < HARDLINK_CHECK_DEADLINE_MS
        },
        below('PERF.after_sleep.block_max', Math.max(promoted.block.maxMs, idle.block.maxMs), 50),
        {
          id: 'PERF.after_sleep.full_speed',
          value: `phases ${phases.join(',')}; paces ${paces.join(',')}`,
          target: 'promoted; the last two walks fast',
          pass: phases.includes('promoted') && paces.slice(-2).every(pace => pace === 'fast')
        }
      ],
      {
        fixture: tree.info,
        firstScanMs: Math.round(firstMs),
        promotedMs: Math.round(promoted.ms),
        idleMs: Math.round(idle.ms)
      }
    )

    expect(pass).toBe(true)
  }, 600_000)

  it('PERF.main.block.contended: the same 50 commands while a `find … -exec stat` walks the tree in a loop', async () => {
    const addon = loadIcloneFsevents()
    const addonLog: AddonCall[] = []
    const fsEvents = addon ? createFsEventsSource(timedAddon(addon, addonLog)) : null
    let walker: ChildProcess | null = null

    try {
      walker = spawn(
        '/bin/sh',
        ['-c', 'while :; do /usr/bin/find "$0" -type f -exec /usr/bin/stat -f %i {} + >/dev/null; done', tree.root],
        { stdio: 'ignore', detached: true }
      )
      await yieldToLoop(500)

      const { block, perCommand, perCheck, answers, window } = await commands('contended', fsEvents ? { fsEvents } : {})
      const calls = callsWithin(addonLog, window.fromMs, window.toMs)
      const slowest = [...calls].sort((a, b) => b.ms - a.ms).slice(0, 5)

      const pass = report(
        'PERF.main.block.contended',
        [
          below('PERF.main.block.contended.max', block.maxMs, 50),
          below('PERF.main.block.contended.addon_sync_max', addonSyncMax(calls), 5),
          idReadsWithFlushPending('PERF.main.block.contended.id_reads_with_flush_pending', calls),
          answers
        ],
        {
          commands: COMMANDS,
          block: { ...block, stalls: attributeStalls(block.stalls, addonLog) },
          checkP95Ms: percentile(perCheck, 95),
          commandP95Ms: percentile(perCommand, 95),
          addonCalls: calls.length,
          addonSlowest: slowest.map(call => ({ ...call, ms: Math.round(call.ms * 100) / 100 }))
        }
      )

      expect(pass).toBe(true)
    } finally {
      if (walker?.pid) {
        process.kill(-walker.pid, 'SIGTERM')
      }

      fsEvents?.close()
    }
  }, 600_000)
})
