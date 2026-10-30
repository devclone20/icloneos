import { readFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  armStageWatchdog,
  type BootstrapEvent,
  INSTALL_STAGE_CEILING_MS,
  INSTALL_STAGE_STALL_MS,
  INSTALL_WATCHDOG_TAG
} from './bootstrap-runner'
import { INSTALL_PROBE_DEADLINE_MS, INSTALL_SAMPLE_MS } from './install-liveness'
import type { TreeCpu } from './install-liveness'

/** A stage whose process tree the test drives: CPU per pid and bytes under its target. */
function stage() {
  const cpu: TreeCpu = new Map([[100, 0]])
  let bytes = 1_000

  return {
    burnCpu: (ms = 50) => cpu.set(100, (cpu.get(100) ?? 0) + ms),
    probes: {
      sampleBytes: () => bytes,
      sampleCpu: async () => new Map(cpu)
    },
    write: (n = 4096) => (bytes += n)
  }
}

describe('install stage watchdog — real progress, not output (ruling 42 r2: 120 s stall, 15 min ceiling)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps one named constant per budget', () => {
    expect(INSTALL_STAGE_STALL_MS).toBe(120_000)
    expect(INSTALL_STAGE_CEILING_MS).toBe(900_000)
  })

  it('the owner case: uv installs the Python packages for 5 minutes printing nothing, burning CPU — never stopped', async () => {
    const s = stage()
    const events: BootstrapEvent[] = []
    const watchdog = armStageWatchdog(ev => events.push(ev), undefined, 'python-deps', s.probes)
    watchdog.attach(100)

    for (let t = 0; t < 300_000; t += 5_000) {
      s.burnCpu()
      await vi.advanceTimersByTimeAsync(5_000)
    }

    expect(watchdog.signal.aborted).toBe(false)
    // The renderer is told every 10 s that main still watches a live stage.
    expect(events.filter(ev => ev.type === 'stage-alive').length).toBeGreaterThanOrEqual(29)
    watchdog.stop()
  })

  it('a silent download (no output, bytes landing under the target) is progress too', async () => {
    const s = stage()
    const watchdog = armStageWatchdog(() => undefined, undefined, 'venv', s.probes)

    for (let t = 0; t < 400_000; t += 5_000) {
      s.write()
      await vi.advanceTimersByTimeAsync(5_000)
    }

    expect(watchdog.signal.aborted).toBe(false)
    watchdog.stop()
  })

  it('a stopped stage (no output, no CPU, no bytes — e.g. SIGSTOP) is stuck after 120 s, not before', async () => {
    const s = stage()
    const watchdog = armStageWatchdog(() => undefined, undefined, 'python-deps', s.probes)
    watchdog.attach(100)
    s.burnCpu()
    await vi.advanceTimersByTimeAsync(5_000)
    // Last progress at 5 s; nothing after.
    await vi.advanceTimersByTimeAsync(INSTALL_STAGE_STALL_MS - 5_000)
    expect(watchdog.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(watchdog.signal.aborted).toBe(true)
    expect(watchdog.reason()).toBe(`${INSTALL_WATCHDOG_TAG} no progress (output, CPU or bytes written) for 120 s`)
    watchdog.stop()
  })

  it('r2b (critic X4): main keeps sending stage-alive while the stage is stuck, until its own verdict', async () => {
    const s = stage()
    const alive: number[] = []

    const watchdog = armStageWatchdog(
      ev => ev.type === 'stage-alive' && alive.push(ev.idleMs),
      undefined,
      'python-deps',
      s.probes
    )

    watchdog.attach(100)
    // No progress at all from the start: the renderer must still hear main every 10 s until the 120 s verdict.
    await vi.advanceTimersByTimeAsync(115_000)
    expect(watchdog.signal.aborted).toBe(false)
    expect(alive.length).toBeGreaterThanOrEqual(10)
    expect(alive.at(-1)).toBeGreaterThanOrEqual(100_000)
    watchdog.stop()
  })

  it('r2c2 (minor E): "unknown" sizes are never progress — a walk that always answers null still ends in the 120 s verdict', async () => {
    const watchdog = armStageWatchdog(() => undefined, undefined, 'python-deps', {
      sampleBytes: async () => null,
      sampleCpu: async () => new Map()
    })

    watchdog.attach(100)
    await vi.advanceTimersByTimeAsync(INSTALL_STAGE_STALL_MS - 5_000)
    expect(watchdog.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(watchdog.signal.aborted).toBe(true)
    watchdog.stop()
  })

  it('r2c2 (minor E): a walk alternating unknown / the same size is not progress either', async () => {
    let flip = false

    const watchdog = armStageWatchdog(() => undefined, undefined, 'python-deps', {
      sampleBytes: async () => {
        flip = !flip

        return flip ? null : 777
      },
      sampleCpu: async () => new Map()
    })

    watchdog.attach(100)
    await vi.advanceTimersByTimeAsync(INSTALL_STAGE_STALL_MS + 15_000)
    expect(watchdog.signal.aborted).toBe(true)
    watchdog.stop()
  })

  it('r2c2 (minor D): probes that throw count as unknown — the stall verdict still comes', async () => {
    const watchdog = armStageWatchdog(() => undefined, undefined, 'python-deps', {
      sampleBytes: async () => {
        throw new Error('walk failed')
      },
      sampleCpu: async () => {
        throw new Error('ps failed')
      }
    })

    watchdog.attach(100)
    await vi.advanceTimersByTimeAsync(INSTALL_STAGE_STALL_MS + 15_000)
    expect(watchdog.signal.aborted).toBe(true)
    expect(watchdog.reason()).toMatch(/no progress/)
    watchdog.stop()
  })

  it('r2c2: no heartbeat after stop(), even from a sample that was still in flight', async () => {
    let release!: (value: number) => void
    const events: string[] = []

    const watchdog = armStageWatchdog(ev => events.push(ev.type), undefined, 'python-deps', {
      sampleBytes: () => new Promise<number>(resolve => (release = resolve)),
      sampleCpu: async () => new Map()
    })

    // The first sample (5 s) is waiting on the walk (its deadline is 5 s later); stop() lands while it is in flight.
    await vi.advanceTimersByTimeAsync(7_000)
    watchdog.stop()
    release(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(events.filter(type => type === 'stage-alive')).toEqual([])
  })

  it('r2c3 E2 (critic X6): an unknown size never wipes the last known one — growth across an unknown is progress', async () => {
    let size = 1_000
    let flip = false

    const watchdog = armStageWatchdog(() => undefined, undefined, 'python-deps', {
      sampleBytes: async () => {
        flip = !flip

        if (flip) {
          return null
        }

        size += 4_096

        return size
      },
      sampleCpu: async () => new Map()
    })

    watchdog.attach(100)
    await vi.advanceTimersByTimeAsync(400_000)
    expect(watchdog.signal.aborted).toBe(false)
    watchdog.stop()
  })

  // The real bound of a verdict when probes hang: the stall window (120 s), plus one probe deadline (the walk's 4 s
  // budget + 1 s), plus one sample period (5 s), plus 1 s — written out, not derived from the constants under test.
  const VERDICT_BOUND_MS = 120_000 + 5_000 + 5_000 + 1_000

  it('r2c4: the probe deadline and the sample period are the ruling values', () => {
    expect(INSTALL_PROBE_DEADLINE_MS).toBe(5_000)
    expect(INSTALL_SAMPLE_MS).toBe(5_000)
  })

  it('r2c4 F3: a size walk that answers only after 100 s costs one deadline per sample, never 100 s — verdict within the bound', async () => {
    const watchdog = armStageWatchdog(() => undefined, undefined, 'python-deps', {
      sampleBytes: () => new Promise<number>(resolve => setTimeout(() => resolve(1_000), 100_000)),
      sampleCpu: async () => new Map()
    })

    watchdog.attach(100)
    await vi.advanceTimersByTimeAsync(INSTALL_STAGE_STALL_MS - 1_000)
    expect(watchdog.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(VERDICT_BOUND_MS - INSTALL_STAGE_STALL_MS + 1_000)
    expect(watchdog.signal.aborted).toBe(true)
    watchdog.stop()
  })

  it('r2c4 F2: a size walk that never settles is never started twice, and the verdict still comes at 120 s', async () => {
    let walks = 0

    const watchdog = armStageWatchdog(() => undefined, undefined, 'python-deps', {
      sampleBytes: () => {
        walks += 1

        return new Promise<number>(() => undefined)
      },
      sampleCpu: async () => new Map()
    })

    watchdog.attach(100)
    await vi.advanceTimersByTimeAsync(INSTALL_STAGE_STALL_MS - 1_000)
    expect(watchdog.signal.aborted).toBe(false)
    expect(walks).toBe(1)
    await vi.advanceTimersByTimeAsync(VERDICT_BOUND_MS - INSTALL_STAGE_STALL_MS + 1_000)
    expect(watchdog.signal.aborted).toBe(true)
    expect(watchdog.reason()).toMatch(/no progress/)
    expect(walks).toBe(1)
    watchdog.stop()
  })

  it('r2c4 F3: probes that never settle cost one deadline per sample — the verdict lands within stall + deadline + one sample', async () => {
    const watchdog = armStageWatchdog(() => undefined, undefined, 'python-deps', {
      sampleCpu: () => new Promise<TreeCpu>(() => undefined)
    })

    watchdog.attach(100)
    await vi.advanceTimersByTimeAsync(INSTALL_STAGE_STALL_MS - 1_000)
    expect(watchdog.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(VERDICT_BOUND_MS - INSTALL_STAGE_STALL_MS + 1_000)
    expect(watchdog.signal.aborted).toBe(true)
    watchdog.stop()
  })

  it('r2c4 I: a ps that fails is unknown, never an empty tree — a frozen stage whose ps fails every other sample gets the 120 s verdict', async () => {
    let fail = false

    const frozen: TreeCpu = new Map([
      [100, 5_000],
      [101, 7_000]
    ])

    const watchdog = armStageWatchdog(() => undefined, undefined, 'python-deps', {
      sampleCpu: async () => {
        fail = !fail

        return fail ? null : new Map(frozen)
      }
    })

    watchdog.attach(100)
    await vi.advanceTimersByTimeAsync(VERDICT_BOUND_MS)
    expect(watchdog.signal.aborted).toBe(true)
    expect(watchdog.reason()).toMatch(/no progress/)
    watchdog.stop()
  })

  it('r2c3 D2: a size probe that throws synchronously when the watchdog is armed is caught', async () => {
    const arm = () =>
      armStageWatchdog(() => undefined, undefined, 'python-deps', {
        sampleBytes: () => {
          throw new Error('sync throw')
        },
        sampleCpu: async () => new Map()
      })

    expect(arm).not.toThrow()
    const watchdog = arm()
    await vi.advanceTimersByTimeAsync(INSTALL_STAGE_STALL_MS + 15_000)
    expect(watchdog.signal.aborted).toBe(true)
    watchdog.stop()
  })

  it('a line of output is progress', async () => {
    const watchdog = armStageWatchdog(() => undefined, undefined, 'python-deps', { sampleCpu: async () => new Map() })

    for (let t = 0; t < 300_000; t += 30_000) {
      watchdog.emit({ type: 'log', stage: 'python-deps', line: `tick ${t}` })
      await vi.advanceTimersByTimeAsync(30_000)
    }

    expect(watchdog.signal.aborted).toBe(false)
    watchdog.stop()
  })

  it('a stage that keeps progressing is stopped at the first-launch deadline (15 min), naming it', async () => {
    const s = stage()

    const watchdog = armStageWatchdog(() => undefined, undefined, 'python-deps', {
      ...s.probes,
      deadlineAt: Date.now() + INSTALL_STAGE_CEILING_MS
    })

    watchdog.attach(100)

    for (let t = 0; t < INSTALL_STAGE_CEILING_MS - 5_000; t += 5_000) {
      s.burnCpu()
      await vi.advanceTimersByTimeAsync(5_000)
    }

    expect(watchdog.signal.aborted).toBe(false)
    s.burnCpu()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(watchdog.signal.aborted).toBe(true)
    expect(watchdog.reason()).toBe(`${INSTALL_WATCHDOG_TAG} ceiling 900 s reached`)
    watchdog.stop()
  })

  it("the user's Cancel still aborts it, with no watchdog reason (stays 'cancelled by user')", () => {
    const cancel = new AbortController()
    const watchdog = armStageWatchdog(() => undefined, cancel.signal)
    cancel.abort()
    expect(watchdog.signal.aborted).toBe(true)
    expect(watchdog.reason()).toBeNull()
    watchdog.stop()
  })

  it('stop() disarms the sampler and the ceiling', async () => {
    const watchdog = armStageWatchdog(() => undefined, undefined)
    watchdog.stop()
    await vi.advanceTimersByTimeAsync(INSTALL_STAGE_CEILING_MS * 2)
    expect(watchdog.signal.aborted).toBe(false)
  })

  it('runStage runs every installer stage under the watchdog, gives it the process and the target, and reports why', () => {
    const source = readFileSync(path.join(import.meta.dirname, 'bootstrap-runner.ts'), 'utf8')
    const runStage = source.slice(source.indexOf('async function runStage('), source.indexOf('// Per-run log file'))

    expect(runStage).toContain('armStageWatchdog(emit, abortSignal, stage.name, {')
    expect(runStage).toContain('deadlineAt: beginInstallBudget(),')
    expect(runStage).toContain('sampleBytes: () => treeBytes(target)')
    expect(runStage).toContain('onChild: watchdog.attach,')
    expect(runStage).toContain('abortSignal: watchdog.signal')
    expect(runStage).toContain('emit: watchdog.emit')
    expect(runStage).toContain("watchdog.reason() ?? 'cancelled by user'")
    expect(source.match(/ {4}onChild\?\.\(child\.pid\)/g)?.length).toBe(2)
  })
})
