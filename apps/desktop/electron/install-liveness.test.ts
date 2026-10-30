import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  beginInstallBudget,
  cpuProgressed,
  endInstallBudget,
  INSTALL_BYTES_WALK_CAP,
  INSTALL_CEILING_MS,
  installBudgetDeadline,
  parsePsTime,
  sampleTreeCpu,
  settleWithin,
  treeBytes,
  treeCpuFromPs,
  yieldToLoop
} from './install-liveness'

// r2c3 H: every temp tree is removed even when its test fails (a failing walk used to leak a 40,500-file folder).
const temps: string[] = []

function tempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temps.push(dir)

  return dir
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

describe('install liveness probes (ruling 42 r2)', () => {
  it('reads ps cumulative CPU time in every macOS shape', () => {
    expect(parsePsTime('0:00.12')).toBe(120)
    expect(parsePsTime('12:03.50')).toBe(723_500)
    expect(parsePsTime('1:02:03')).toBe(3_723_000)
    expect(parsePsTime('2-01:00:00')).toBe(176_400_000)
  })

  it('collects the CPU of a process and every descendant, nothing else', () => {
    const ps = ['  10     1   0:01.00', '  11    10   0:02.00', '  12    11   0:00.50', '  13     1   9:00.00'].join(
      '\n'
    )

    expect([...treeCpuFromPs(ps, 10)].sort()).toEqual([
      [10, 1000],
      [11, 2000],
      [12, 500]
    ])
    expect(treeCpuFromPs(ps, 99).size).toBe(0)
  })

  it('progress is per pid: a child that exits never hides a sibling working, a new child counts', () => {
    const before = new Map([
      [10, 100],
      [11, 5000]
    ])

    expect(cpuProgressed(before, new Map([[10, 100]]))).toBe(false)
    expect(cpuProgressed(before, new Map([[10, 150]]))).toBe(true)
    expect(cpuProgressed(before, new Map([[12, 0]]))).toBe(true)
  })

  it('samples a real busy child through /bin/ps', async () => {
    const child = spawn(process.execPath, ['-e', 'const t=Date.now(); while (Date.now()-t < 1500) {}'], {
      stdio: 'ignore'
    })

    await new Promise(resolve => setTimeout(resolve, 300))
    const first = await sampleTreeCpu(child.pid!)
    await new Promise(resolve => setTimeout(resolve, 600))
    const second = await sampleTreeCpu(child.pid!)
    child.kill()
    expect(first?.has(child.pid!)).toBe(true)
    expect(cpuProgressed(first!, second!)).toBe(true)
  })

  it('counts bytes under a target and sees a write', async () => {
    const dir = tempDir('rtb-bytes-')
    fs.mkdirSync(path.join(dir, 'a'))
    fs.writeFileSync(path.join(dir, 'a', 'x'), 'hello')
    const before = await treeBytes(dir)
    fs.writeFileSync(path.join(dir, 'a', 'y'), 'world!')
    expect(before).toBe(5)
    expect(await treeBytes(dir)).toBe(11)
    expect(await treeBytes(path.join(dir, 'missing'))).toBeNull()
    fs.rmSync(dir, { force: true, recursive: true })
  })

  it('r2b (critic X13): ONE budget for the whole first launch — later calls never restart it', () => {
    endInstallBudget()
    const first = beginInstallBudget(1_000)
    expect(first).toBe(1_000 + INSTALL_CEILING_MS)
    expect(beginInstallBudget(500_000)).toBe(first)
    expect(beginInstallBudget()).toBe(first)
    expect(installBudgetDeadline()).toBe(first)
    endInstallBudget()
    expect(installBudgetDeadline()).toBeNull()
  })

  const WIDE_FILES = 6_000

  /** A 26k-entry tree: 200 directories x 100 files, plus ONE directory of 6,000 files (critic r2c5 N2: a walk that stats a
   * whole directory in one batch must show up on the loop test, not only on a 40k-file test that never watches the loop).
   * r2c7 (critic r2c6 H1): built ONCE for the file and removed ONCE; the walks only read it. Deleting it after every test
   * ran in the 10 s afterEach and outlived it under disk churn. Its removal has its own explicit timeout. */
  let sharedTree = ''

  beforeAll(() => {
    sharedTree = fs.mkdtempSync(path.join(os.tmpdir(), 'rtb-tree-'))

    for (let d = 0; d < 200; d += 1) {
      const sub = path.join(sharedTree, `d${d}`, 'nested')
      fs.mkdirSync(sub, { recursive: true })

      for (let f = 0; f < 100; f += 1) {
        fs.writeFileSync(path.join(sub, `f${f}.py`), 'x'.repeat(f))
      }
    }

    const wide = path.join(sharedTree, 'wide')
    fs.mkdirSync(wide)

    for (let f = 0; f < WIDE_FILES; f += 1) {
      fs.writeFileSync(path.join(wide, `w${f}.py`), 'x'.repeat(f % 100))
    }
  }, 120_000)

  afterAll(() => {
    if (sharedTree) {
      fs.rmSync(sharedTree, { force: true, recursive: true })
    }
  }, 120_000)

  function bigTree() {
    return sharedTree
  }

  const BIG_TREE_BYTES = 200 * ((99 * 100) / 2) + (WIDE_FILES / 100) * ((99 * 100) / 2)

  it('r2c6 CPU detector: no walk holds the event loop 50 ms of its own thread CPU (6 walks, real fs)', async () => {
    const dir = bigTree()

    // Lead r2c6 (critic r2c5 M1e): the COMPUTE class of blocks. A gap between two turns of main's loop counts only for
    // the CPU time main's own thread spent in it, min(wall gap, thread CPU gap). A loaded machine that does not schedule
    // main lengthens the wall gap but adds no thread CPU, so load cannot turn this red; a walk that computes or makes
    // syscalls on main for 50 ms can. The WAIT class (Atomics.wait, sync child, sync I/O) burns no CPU: the tripwire
    // below owns it. The gap after the last tick of a walk counts, and the ticks must have run while it walked.
    expect(typeof process.threadCpuUsage).toBe('function')

    const threadCpuMs = () => {
      const usage = process.threadCpuUsage()

      return (usage.user + usage.system) / 1000
    }

    let lastWall = performance.now()
    let lastCpu = threadCpuMs()
    let worst = 0
    let ticks = 0

    const account = () => {
      const wall = performance.now()
      const cpu = threadCpuMs()
      worst = Math.max(worst, Math.min(wall - lastWall, cpu - lastCpu))
      lastWall = wall
      lastCpu = cpu
    }

    const tick = setInterval(() => {
      account()
      ticks += 1
    }, 2)

    const totals: Array<null | number> = []

    try {
      for (let walk = 0; walk < 6; walk += 1) {
        totals.push(await treeBytes(dir, { budgetMs: 60_000 }))
        account()
      }
    } finally {
      clearInterval(tick)
    }

    expect(totals).toEqual(Array(6).fill(BIG_TREE_BYTES))
    expect(worst).toBeLessThan(50)
    expect(ticks).toBeGreaterThanOrEqual(3)
  }, 120_000)

  it('r2c6 wait detector: a walk makes no synchronous fs, child-process or Atomics.wait call (event loop tripwire)', async () => {
    const dir = bigTree()
    const fsSync = fs as unknown as Record<string, unknown>
    const childProcess = (await import('node:child_process')).default as unknown as Record<string, unknown>
    const { syncBuiltinESMExports } = await import('node:module')
    const calls: string[] = []
    const stacks: string[] = []
    const restore: Array<() => void> = []
    let open = false

    // Lead r2c6: the WAIT class of blocks (no CPU, so the CPU detector cannot see them). No timing at all: during the
    // walks, any call to a blocking API fails the test. Calls are attributed by the walk's time window, not by the stack
    // (critic r2c5 T1: a native callback such as setImmediate(fs.lstatSync, p) leaves no frame of the walk's module).
    // The window is the test's own: it opens before the first walk and closes after one more macrotask turn.
    const spy = (target: Record<string, unknown>, name: string, label: string) => {
      const original = target[name]

      if (typeof original !== 'function') {
        return
      }

      target[name] = function (this: unknown, ...args: unknown[]) {
        if (open) {
          calls.push(label)
          stacks.push(new Error().stack ?? '')
        }

        return (original as (...a: unknown[]) => unknown).apply(this, args)
      }

      restore.push(() => {
        target[name] = original
      })
    }

    for (const name of Object.keys(fsSync).filter(key => key.endsWith('Sync'))) {
      spy(fsSync, name, `fs.${name}`)
    }

    // A Dir handle from the async fs.opendir still reads synchronously (critic r2c5 T1).
    const dirProto = (fs.Dir as unknown as { prototype: Record<string, unknown> }).prototype
    spy(dirProto, 'readSync', 'fs.Dir.readSync')
    spy(dirProto, 'closeSync', 'fs.Dir.closeSync')

    for (const name of ['execSync', 'execFileSync', 'spawnSync']) {
      spy(childProcess, name, `child_process.${name}`)
    }

    spy(Atomics as unknown as Record<string, unknown>, 'wait', 'Atomics.wait')

    // The raw bindings behind the sync APIs (critic r2c5 T1: process.binding('spawn_sync') runs a child with no spy).
    const proc = process as unknown as Record<string, unknown>
    const binding = proc.binding as (name: string) => unknown

    proc.binding = function (this: unknown, name: string) {
      if (open) {
        calls.push(`process.binding.${name}`)
        stacks.push(new Error().stack ?? '')
      }

      return binding.call(this, name)
    }

    restore.push(() => {
      proc.binding = binding
    })

    // ESM namespaces of builtins see the patched functions only after this (a mutant may `await import('node:fs')`).
    syncBuiltinESMExports()

    let total: null | number = null

    try {
      open = true
      total = await treeBytes(dir, { budgetMs: 60_000 })
      total = await treeBytes(dir, { budgetMs: 60_000 })
      await new Promise(resolve => setImmediate(resolve))
    } finally {
      open = false

      for (const undo of restore) {
        undo()
      }

      syncBuiltinESMExports()
    }

    expect(total).toBe(BIG_TREE_BYTES)

    if (calls.length > 0) {
      // Where the first blocking calls came from (the assertion below names them).
      console.error(stacks.slice(0, 2).join('\n'))
    }

    expect(calls).toEqual([])
  }, 120_000)

  it('r2c5: the walk yields to the event loop itself (a macrotask turn), never only a microtask', async () => {
    let ran = false
    setImmediate(() => {
      ran = true
    })
    await yieldToLoop()
    expect(ran).toBe(true)
  })

  it('r2c6 N2: a walk keeps a bounded number of stats in flight, even in a 6,000-file directory', async () => {
    const dir = bigTree()
    const promises = fsp as unknown as Record<string, unknown>
    const lstat = promises.lstat as (...args: unknown[]) => Promise<unknown>
    let inFlight = 0
    let most = 0

    // Critic r2c5 N2: stat'ing a whole directory at once costs main ~3.5 ms of CPU per 1,000 entries when the answers
    // land; that is only ~20 ms here, under the CPU detector's 50 ms. The bound itself is checked instead, with no timing.
    promises.lstat = function (this: unknown, ...args: unknown[]) {
      inFlight += 1
      most = Math.max(most, inFlight)

      return lstat.apply(this, args).finally(() => {
        inFlight -= 1
      })
    }

    let total: null | number = null

    try {
      total = await treeBytes(dir, { budgetMs: 60_000 })
    } finally {
      promises.lstat = lstat
    }

    expect(total).toBe(BIG_TREE_BYTES)
    expect(most).toBeGreaterThan(0)
    expect(most).toBeLessThanOrEqual(256)
  }, 120_000)

  it('r2c: a walk over its time budget answers unknown instead of blocking', async () => {
    const dir = tempDir('rtb-walk-budget-')

    for (let d = 0; d < 50; d += 1) {
      fs.mkdirSync(path.join(dir, `d${d}`))
      fs.writeFileSync(path.join(dir, `d${d}`, 'f'), 'x')
    }

    expect(await treeBytes(dir, { budgetMs: -1 })).toBeNull()
    fs.rmSync(dir, { force: true, recursive: true })
  })

  it('r2c2 (minor C): the 40k cap holds inside ONE directory too', async () => {
    const dir = tempDir('rtb-flat-')

    for (let f = 0; f < INSTALL_BYTES_WALK_CAP + 500; f += 1) {
      fs.writeFileSync(path.join(dir, `f${f}`), 'x')
    }

    const total = await treeBytes(dir, { budgetMs: 60_000 })
    fs.rmSync(dir, { force: true, recursive: true })

    expect(total).toBe(INSTALL_BYTES_WALK_CAP)
  }, 120_000)

  it('r2c3 C2 (critic X1): inside one directory the walk yields while it reads the entries', async () => {
    const dir = tempDir('rtb-entries-')

    for (let f = 0; f < 2_000; f += 1) {
      fs.writeFileSync(path.join(dir, `f${f}`), 'x')
    }

    const yields: string[] = []
    const total = await treeBytes(dir, { budgetMs: 60_000, onYield: where => yields.push(where), sliceMs: 0 })

    expect(total).toBe(2_000)
    // Every 256 entries, inside the directory's own entry loop (not only between directories and stat batches).
    expect(yields.filter(where => where === 'entries').length).toBe(Math.floor(2_000 / 256))
  })

  it('r2c3 C2 (critic X2): the time budget is checked inside one directory too', async () => {
    const dir = tempDir('rtb-entries-budget-')

    for (let f = 0; f < 1_000; f += 1) {
      fs.writeFileSync(path.join(dir, `f${f}`), 'x')
    }

    // A clock that jumps past the budget the first time the walk yields inside the directory's entries.
    let clock = 0

    const total = await treeBytes(dir, {
      budgetMs: 4_000,
      now: () => clock,
      onYield: where => {
        if (where === 'entries') {
          clock += 10_000
        }
      },
      sliceMs: 0
    })

    expect(total).toBeNull()
  })

  it('r2c3 F: settleWithin answers the fallback when the work never settles, and never rejects', async () => {
    expect(await settleWithin(new Promise(() => undefined), 20, 'unknown')).toBe('unknown')
    expect(await settleWithin(Promise.reject(new Error('x')), 1_000, 'unknown')).toBe('unknown')
    expect(await settleWithin(Promise.resolve(7), 1_000, 'unknown')).toBe(7)
  })
})
