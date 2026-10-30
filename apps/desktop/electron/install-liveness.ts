// Ruling 42 (amended, r2 — owner report: a first launch stopped as "not responding" while uv was silently installing
// the Python packages). An install stage is alive while its PROCESS TREE makes real progress: a line of output, CPU
// time, or bytes written under its target. Only INSTALL_STALL_MS of none of these is "stuck"; INSTALL_CEILING_MS bounds
// a first launch that keeps progressing forever. Constants: no option or env changes them.

import { execFile } from 'node:child_process'
import type fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/** Tag of every install-watchdog verdict; the diagnosis (src/iclone-shared/install-diagnosis.ts) reads it. */
export const INSTALL_WATCHDOG_TAG = '[iclone-install-watchdog]'
/** No output, no CPU time and no bytes written by the stage's process tree for this long = stuck. */
export const INSTALL_STALL_MS = 120_000
/** Hard ceiling of one install stage, and of a first launch that installs (main and renderer). */
export const INSTALL_CEILING_MS = 900_000
/** How often the process tree is sampled. */
export const INSTALL_SAMPLE_MS = 5_000
/** How often main tells the renderer the stage is still being watched (the renderer's own 45 s is for main itself). */
export const INSTALL_HEARTBEAT_MS = 10_000
/** A bytes walk never reads more entries than this (a huge tree is sampled, not crawled). */
export const INSTALL_BYTES_WALK_CAP = 40_000

/** CPU milliseconds per live pid of a process tree. */
export type TreeCpu = Map<number, number>

/** macOS / BSD `ps -o time=`: `[dd-][hh:]mm:ss[.ss]` → milliseconds. */
export function parsePsTime(text: string): number {
  const trimmed = text.trim()
  const [days, rest] = trimmed.includes('-') ? trimmed.split('-', 2) : ['0', trimmed]
  const parts = rest.split(':').map(Number)

  if (parts.some(part => !Number.isFinite(part))) {
    return 0
  }

  const seconds = parts.reduce((total, part) => total * 60 + part, 0)

  return Math.round((Number(days) * 86_400 + seconds) * 1000)
}

/** From `ps -A -o pid=,ppid=,time=` output: the CPU time of `root` and every descendant. */
export function treeCpuFromPs(output: string, root: number): TreeCpu {
  const children = new Map<number, number[]>()
  const cpu = new Map<number, number>()

  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line)

    if (!match) {
      continue
    }

    const pid = Number(match[1])
    const ppid = Number(match[2])
    cpu.set(pid, parsePsTime(match[3]))
    children.set(ppid, [...(children.get(ppid) ?? []), pid])
  }

  const tree: TreeCpu = new Map()
  const queue = cpu.has(root) ? [root] : []

  while (queue.length > 0) {
    const pid = queue.shift()!

    if (tree.has(pid)) {
      continue
    }

    tree.set(pid, cpu.get(pid) ?? 0)
    queue.push(...(children.get(pid) ?? []))
  }

  return tree
}

/** Did the tree burn CPU between two samples? Per pid (an exiting child must not hide its siblings' work); a new
 * pid is progress too (the stage started a new step). */
export function cpuProgressed(previous: TreeCpu, next: TreeCpu): boolean {
  for (const [pid, ms] of next) {
    const before = previous.get(pid)

    if (before === undefined || ms > before) {
      return true
    }
  }

  return false
}

/** One `ps` of the whole table (no shell, absolute path), reduced to the tree under `root`. Never throws. A failed or
 * timed-out `ps` answers null — "unknown", never an empty known tree (critic r2c3 I: an empty tree followed by a good
 * sample made every pid look new, i.e. false progress, and a frozen stage got the 900 s ceiling instead of 120 s). */
export function sampleTreeCpu(root: number): Promise<null | TreeCpu> {
  return new Promise(resolve => {
    execFile(
      '/bin/ps',
      ['-A', '-o', 'pid=,ppid=,time='],
      { timeout: 4_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => resolve(error ? null : treeCpuFromPs(String(stdout), root))
    )
  })
}

/** Longest stretch the bytes walk may hold main's event loop before it yields (r2c: the owner wants a smooth launch). */
export const INSTALL_BYTES_SLICE_MS = 8
/** A bytes walk that has not finished in this long reports "unknown" (it never blocks, it only gives up). */
export const INSTALL_BYTES_WALK_BUDGET_MS = 4_000
/** stat calls in flight at once during the walk. */
const STAT_BATCH = 64

/** One macrotask turn of the event loop (exported for its test: a microtask would let nothing else run). */
export const yieldToLoop = () => new Promise<void>(resolve => setImmediate(resolve))

/**
 * Total bytes of the regular files under `root`, bounded by INSTALL_BYTES_WALK_CAP entries, ASYNC and time-sliced
 * (critic r2b: the synchronous walk held main 0.4–1.6 s under load): directory reads and stats go to libuv's pool, the
 * loop is handed back at least every INSTALL_BYTES_SLICE_MS, and a walk that needs more than
 * INSTALL_BYTES_WALK_BUDGET_MS answers null (unknown). Never throws.
 */
/** Test seams of the walk: a clock and a yield observer (the production defaults are Date.now and nothing). */
export interface TreeBytesLimits {
  budgetMs?: number
  sliceMs?: number
  now?: () => number
  /** Called at every yield, with where the walk yielded. */
  onYield?: (where: 'dir' | 'entries' | 'files') => void
}

export async function treeBytes(root: string, limits: TreeBytesLimits = {}): Promise<null | number> {
  const budgetMs = limits.budgetMs ?? INSTALL_BYTES_WALK_BUDGET_MS
  const sliceMs = limits.sliceMs ?? INSTALL_BYTES_SLICE_MS
  const now = limits.now ?? Date.now
  const startedAt = now()
  let sliceStart = now()
  let total = 0
  let seen = 0
  const stack = [root]

  const yieldNow = async (where: 'dir' | 'entries' | 'files') => {
    limits.onYield?.(where)
    await yieldToLoop()
    sliceStart = now()
  }

  try {
    await fsp.access(root)
  } catch {
    return null
  }

  while (stack.length > 0 && seen < INSTALL_BYTES_WALK_CAP) {
    if (now() - startedAt > budgetMs) {
      return null
    }

    if (now() - sliceStart >= sliceMs) {
      await yieldNow('dir')
    }

    const dir = stack.pop()!
    let entries: fs.Dirent[]

    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }

    const files: string[] = []

    // One directory can hold tens of thousands of entries: the cap, the time slice and the budget apply inside it too
    // (critic r2c minor C, r2c2 C2).
    for (const entry of entries) {
      if (seen >= INSTALL_BYTES_WALK_CAP) {
        break
      }

      seen += 1
      const full = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile()) {
        files.push(full)
      }

      if ((seen & 255) === 0 && now() - sliceStart >= sliceMs) {
        await yieldNow('entries')

        if (now() - startedAt > budgetMs) {
          return null
        }
      }
    }

    for (let i = 0; i < files.length; i += STAT_BATCH) {
      const sizes = await Promise.all(
        files.slice(i, i + STAT_BATCH).map(file =>
          fsp.lstat(file).then(
            stat => stat.size,
            () => 0
          )
        )
      )

      total += sizes.reduce((sum, size) => sum + size, 0)

      if (now() - sliceStart >= sliceMs) {
        await yieldNow('files')
      }
    }
  }

  return total
}

/** Each probe of a sample answers within this long, or the sample counts it as unknown (r2c3 F: a size walk stuck in
 * one fs call must not hold the stall verdict until the 15-minute ceiling). */
export const INSTALL_PROBE_DEADLINE_MS = INSTALL_BYTES_WALK_BUDGET_MS + 1_000

/** `work`, or `fallback` once `ms` passed (the work is not cancelled; its late answer is dropped). Never rejects. */
export function settleWithin<T, F>(work: Promise<T> | T, ms: number, fallback: F): Promise<F | T> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(fallback), ms)

    Promise.resolve(work).then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback)
      }
    )
  })
}

// ── The one first-launch budget (lead r2, critic M2): main owns it. It starts when the install starts (or when a
// starting backend first shows install work), every install stage, the port wait and the readiness wait after it run
// inside it, and it ends when the backend is ready or the user starts over (Retry / Repair / Install again).
let firstLaunchDeadline: null | number = null

/** Start the budget if it is not running; returns its deadline (epoch ms). */
export function beginInstallBudget(now = Date.now()): number {
  if (firstLaunchDeadline === null) {
    firstLaunchDeadline = now + INSTALL_CEILING_MS
  }

  return firstLaunchDeadline
}

/** The running budget's deadline, or null when no install is under way. */
export function installBudgetDeadline(): null | number {
  return firstLaunchDeadline
}

/** The backend is ready, or the user starts over: the next install gets a full budget. */
export function endInstallBudget() {
  firstLaunchDeadline = null
}
