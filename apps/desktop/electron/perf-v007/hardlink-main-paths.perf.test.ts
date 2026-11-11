/**
 * v0.0.7 CF7 — PERF.main.paths: every path of the F7 guard that main's thread runs, on a tree the owner's size
 * (520 000 folders / 600 000 files, scripts/perf-v007/make-fixture.mjs under the run's /private/tmp), through the
 * guard's public API alone (createHardlinkGuard: prewarm, check, acknowledgeGroup, groupPaths), so the same file
 * measures the base commit and this one.
 *
 * Why: five critic rounds each found a new cost the size of the tree on main (the walk, the idle refresh, the
 * after-sleep wait, the 0.42 s install, the 77-87 ms dirty check) because the gates ran on 30 001 folders and their
 * commands changed nothing. Here the commands WRITE (a file in a different folder each), the post-exit (T3) check
 * follows every one, a group of 1 500 planted links is refused, acknowledged and paged, the clock jumps past the
 * bound, and main's heap is read after the first scan (a tree held on main costs hundreds of MB; a summary does not).
 *
 *   PERF.main.paths.cmd.dirty.check.p95      pre-check after a write in a new folder, p95 < 30 ms (20 commands)
 *   PERF.main.paths.cmd.dirty.block_max      main's longest stall over those 20 commands (pre + post) < 50 ms
 *   PERF.main.paths.cmd.dirty.loop_p99       loop delay p99 over them < 16 ms
 *   PERF.main.paths.t3.check.p95             the post-exit check (exitedAt given) after the write, p95 < 30 ms
 *   PERF.main.paths.ack.refusal.block_max    the check that finds the 1 500 planted links (a full scan) < 50 ms
 *   PERF.main.paths.ack.allow.block_max      acknowledgeGroup over that group < 50 ms
 *   PERF.main.paths.ack.page.block_max       groupPaths (one page past the first 1 000) < 16 ms
 *   PERF.main.paths.ack.answered             the check after the gesture answers ok
 *   PERF.main.paths.after_sleep.block_max    the command answered past the bound (61 min) < 50 ms, and answered ok
 *   PERF.main.paths.heap.first_scan_mb       main's heap growth across the first scan < 96 MB
 *
 * Red on f37b72f747 (the records on main): cmd.dirty 77-87 ms stalls (critic B5-M1), ack.* the same copy and fold,
 * heap ~ +400 MB. Green with the tree resident in the worker (hardlinks-walk.ts, hardlinks-walker.ts).
 */
import { linkSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import v8 from 'node:v8'
import vm from 'node:vm'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { checkBeforeStart, createHardlinkGuard } from '../iclone-confinement/hardlinks'
import { defaultFsEventsSource } from '../iclone-confinement/hardlinks-fsevents'

import {
  below,
  type Fixture,
  type GateItem,
  makeFixture,
  percentile,
  PERF_V007_ENABLED,
  report,
  startBlockMeter,
  timed,
  yieldToLoop
} from './gate-helpers'

const DIRS = 520_000
const FILES = 600_000
const COMMANDS = 20
const GROUP_LINKS = 1_500
const BLOCK_LIMIT_MS = 50
const PAGE_LIMIT_MS = 16
const CHECK_LIMIT_MS = 30
const LOOP_P99_LIMIT_MS = 16
const HEAP_LIMIT_MB = 96
const SLEEP_MS = 61 * 60_000

/** `count` folders at least `depth` deep, spread over the tree (a bounded breadth-first read: test-side only). */
function sampleFolders(root: string, count: number, depth: number): string[] {
  const found: string[] = []
  let level = [root]

  for (let at = 0; at < depth + 1 && level.length > 0; at += 1) {
    const next: string[] = []

    for (const dir of level) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          next.push(path.join(dir, entry.name))
        }
      }

      if (next.length > 4_096) {
        break
      }
    }

    level = next
  }

  const step = Math.max(1, Math.floor(level.length / count))

  for (let index = 0; index < level.length && found.length < count; index += step) {
    found.push(level[index])
  }

  return found
}

/** A forced major GC, so the heap reading is what is retained, not what is pending. */
const collectGarbage = (): (() => void) => {
  v8.setFlagsFromString('--expose-gc')

  return vm.runInNewContext('gc') as () => void
}

describe.skipIf(!PERF_V007_ENABLED)('v0.0.7 PERF: every main-thread path of the guard, 520 000 folders', () => {
  let tree: Fixture

  beforeAll(() => {
    tree = makeFixture(['--files', String(FILES), '--dirs', String(DIRS)])
  }, 600_000)

  afterAll(async () => {
    await defaultFsEventsSource()?.close()
    tree?.remove()
  })

  it('PERF.main.paths: dirty commands, T3, a large acknowledgement, paging, after-sleep and the heap', async () => {
    let offset = 0
    const gc = collectGarbage()

    const guard = createHardlinkGuard({
      ackFile: path.join(path.dirname(tree.root), 'userdata-paths', 'confinement', 'acks.json'),
      now: () => new Date(Date.now() + offset)
    })

    const items: GateItem[] = []
    const info: Record<string, unknown> = { fixture: tree.info }

    try {
      await yieldToLoop(20)

      // 1. The first scan, and what main retains of it.
      gc()

      const heapBefore = process.memoryUsage().heapUsed

      await guard.prewarm(tree.root)
      expect(await checkBeforeStart(guard, tree.root, 'build')).toMatchObject({ ok: true })
      gc()

      const heapMb = (process.memoryUsage().heapUsed - heapBefore) / 1_048_576

      items.push(below('PERF.main.paths.heap.first_scan_mb', heapMb, HEAP_LIMIT_MB, 'MB'))

      // 2. Twenty commands, each writing a file in a different folder, with its post-exit (T3) check.
      const folders = sampleFolders(tree.root, COMMANDS, 3)

      expect(folders.length).toBe(COMMANDS)

      const preMs: number[] = []
      const postMs: number[] = []
      const dirtyMeter = startBlockMeter()

      for (const [index, folder] of folders.entries()) {
        writeFileSync(path.join(folder, `written-${index}`), 'x')

        const pre = await timed(dirtyMeter, () => checkBeforeStart(guard, tree.root, 'build'))

        expect(pre.value).toMatchObject({ ok: true })
        preMs.push(pre.ms)
        mkdirSync(path.join(folder, `made-${index}`))
        writeFileSync(path.join(folder, `made-${index}`, 'inside'), 'y')

        const post = await timed(dirtyMeter, () => guard.check(tree.root, 'build', Date.now()))

        expect(post.value).toMatchObject({ ok: true })
        postMs.push(post.ms)
      }

      const dirty = await dirtyMeter.stop()

      items.push(
        below('PERF.main.paths.cmd.dirty.check.p95', percentile(preMs, 95), CHECK_LIMIT_MS),
        below('PERF.main.paths.cmd.dirty.block_max', dirty.maxMs, BLOCK_LIMIT_MS),
        below('PERF.main.paths.cmd.dirty.loop_p99', dirty.p99Ms, LOOP_P99_LIMIT_MS),
        below('PERF.main.paths.t3.check.p95', percentile(postMs, 95), CHECK_LIMIT_MS)
      )
      info.dirty = { preMs: preMs.map(Math.round), postMs: postMs.map(Math.round), loopMaxMs: dirty.loopMaxMs }

      // 3. A group of planted links: refused by a full scan, acknowledged in one gesture, paged past 1 000.
      const outside = path.join(path.dirname(tree.root), 'outside')
      const group = path.join(folders[COMMANDS - 1], 'vendored')

      mkdirSync(outside, { recursive: true })
      mkdirSync(group)

      for (let index = 0; index < GROUP_LINKS; index += 1) {
        writeFileSync(path.join(outside, `o${index}`), 'o')
        linkSync(path.join(outside, `o${index}`), path.join(group, `l${index}`))
      }

      const refusalMeter = startBlockMeter()
      const refusal = await timed(refusalMeter, () => checkBeforeStart(guard, tree.root, 'build'))
      const refusalBlock = await refusalMeter.stop()
      const block = 'block' in refusal.value ? refusal.value.block : null
      const view = block?.kind === 'hard-links' ? block.groups.find(item => item.dir === group) : undefined

      expect(view, JSON.stringify(refusal.value).slice(0, 300)).toBeDefined()
      expect(view?.count).toBe(GROUP_LINKS)

      // The pane pages the refused group past its first 1 000 names, then the gesture allows it.
      const pageMeter = startBlockMeter()
      const page = await timed(pageMeter, () => guard.groupPaths(tree.root, group, view?.digest ?? '', 1_000))
      const pageBlock = await pageMeter.stop()

      expect(page.value).toMatchObject({ ok: true, count: GROUP_LINKS })

      const allowMeter = startBlockMeter()
      const allowed = await timed(allowMeter, () => guard.acknowledgeGroup(tree.root, group, view?.digest ?? ''))
      const allowBlock = await allowMeter.stop()

      expect(allowed.value).toMatchObject({ ok: true, count: GROUP_LINKS })

      const afterAllow = await checkBeforeStart(guard, tree.root, 'build')

      items.push(
        below('PERF.main.paths.ack.refusal.block_max', refusalBlock.maxMs, BLOCK_LIMIT_MS),
        below('PERF.main.paths.ack.allow.block_max', allowBlock.maxMs, BLOCK_LIMIT_MS),
        below('PERF.main.paths.ack.page.block_max', pageBlock.maxMs, PAGE_LIMIT_MS),
        {
          id: 'PERF.main.paths.ack.answered',
          value: afterAllow.ok ? 'ok' : JSON.stringify(afterAllow).slice(0, 200),
          target: 'ok',
          pass: afterAllow.ok === true
        }
      )
      info.ack = {
        refusalMs: Math.round(refusal.ms),
        allowMs: Math.round(allowed.ms),
        pageMs: Math.round(page.ms),
        paged: page.value.ok ? page.value.paths.length : page.value.reason
      }

      // 4. Past the bound (a Mac sleep): the command's own fast scan answers, main free meanwhile.
      offset += SLEEP_MS

      const sleepMeter = startBlockMeter()
      const sleep = await timed(sleepMeter, () => checkBeforeStart(guard, tree.root, 'build'))
      const sleepBlock = await sleepMeter.stop()

      items.push(below('PERF.main.paths.after_sleep.block_max', sleepBlock.maxMs, BLOCK_LIMIT_MS), {
        id: 'PERF.main.paths.after_sleep.answered',
        value: sleep.value.ok ? 'ok' : JSON.stringify(sleep.value).slice(0, 200),
        target: 'ok',
        pass: sleep.value.ok === true
      })
      info.afterSleepMs = Math.round(sleep.ms)
      info.heapMb = Math.round(heapMb * 10) / 10

      expect(report('PERF.main.paths', items, info)).toBe(true)
    } finally {
      guard.close()
    }
  }, 1_500_000)
})
