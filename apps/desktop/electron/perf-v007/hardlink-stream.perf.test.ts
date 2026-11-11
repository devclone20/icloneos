/**
 * v0.0.7 PERF.cmd.overhead.stream (declared 2026-11-10; the recalibration note is at the top of
 * hardlink-guard.perf.test.ts). Owner's project (V1b, read-only): first full scan 36.6 s, main-thread block max
 * 35.7 ms, warm stream-backed check 139 ms on the napi module. CF1 re-tightened it on our own addon: the same-stream
 * canary barrier measures ~9.6 ms p50 / ~10.9 ms p95 per check (A-m2, B-m4; the declared < 5 ms is not met).
 *
 * Fixture: 150 000 directories / 150 000 files. The guard takes the FSEvents stream path deterministically: until it
 * has timed a walk of a root it estimates the walk at 0.004 ms per directory (600 ms here), far above the barrier
 * (~10 ms), and a stream-backed root answers without walking, so no measured walk ever replaces the estimate.
 *
 *   PERF.cmd.overhead.stream.p95             per stream-backed check (pre or post) p95 < 15 ms
 *   PERF.cmd.overhead.stream.dir_lstat_warm  directory lstats over the 100 no-change warm checks = 0 (spy below)
 *   PERF.cmd.overhead.stream.path            every warm check measured `events-cached`
 *
 * Mutant: ICLONE_PERF_V007_MUTANT=stream-off (the guard without FSEvents, V-1 walk) must turn dir_lstat_warm red.
 * The spy wraps every lstat of this file's process, so this gate lives alone: it never sits in another gate's timing.
 */
import type * as FsPromises from 'node:fs/promises'
import path from 'node:path'

import { afterAll, describe, expect, it, vi } from 'vitest'

import { createHardlinkGuard, type HardlinkMeasure } from '../iclone-confinement/hardlinks'
import { defaultFsEventsSource } from '../iclone-confinement/hardlinks-fsevents'

import { below, makeFixture, percentile, PERF_V007_ENABLED, report, timed, yieldToLoop } from './gate-helpers'

/** Directory `lstat`s: the guard's walk and relist stat folders with `bigint` (and nothing else in it does). */
const counts = vi.hoisted(() => ({ dirLstat: 0 }))

vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof FsPromises>()

  const lstat = ((file: Parameters<typeof real.lstat>[0], options?: { bigint?: boolean }) => {
    if (options?.bigint) {
      counts.dirLstat += 1
    }

    return real.lstat(file, options as never)
  }) as typeof real.lstat

  return { ...real, default: { ...real, lstat }, lstat }
})

const COMMANDS = 50
const STREAM_FIXTURE = ['--files', '150000', '--dirs', '150000']
const STREAM_OFF = process.env.ICLONE_PERF_V007_MUTANT === 'stream-off'

describe.skipIf(!PERF_V007_ENABLED)('v0.0.7 PERF: hard-link guard on its FSEvents stream', () => {
  const guards: Array<{ close(): void }> = []

  afterAll(async () => {
    guards.splice(0).forEach(guard => guard.close())
    await defaultFsEventsSource()?.close()
  })

  it('PERF.cmd.overhead.stream: 50 commands on a stream-backed root, 0 directory lstat when nothing changed', async () => {
    const big = makeFixture(STREAM_FIXTURE)

    try {
      const measures: HardlinkMeasure[] = []

      const guard = createHardlinkGuard({
        ackFile: path.join(path.dirname(big.root), 'userdata-stream', 'confinement', 'acks.json'),
        ...(STREAM_OFF ? { fsEvents: null } : {}),
        onMeasure: (_root, how) => measures.push(how)
      })

      guards.push(guard)
      await guard.prewarm(big.root)
      expect(await guard.check(big.root, 'build')).toMatchObject({ ok: true })
      await yieldToLoop(20)
      measures.length = 0
      counts.dirLstat = 0

      const perCheck: number[] = []
      const refusals: string[] = []

      for (let command = 0; command < COMMANDS; command += 1) {
        for (const phase of ['pre', 'post']) {
          const { value, ms } = await timed(null, () => guard.check(big.root, 'build'))

          perCheck.push(ms)

          if (!value.ok) {
            refusals.push(`${phase}: ${JSON.stringify(value)}`)
          }

          await yieldToLoop(2)
        }
      }

      const dirLstat = counts.dirLstat
      const cachedAll = measures.length === perCheck.length && measures.every(how => how === 'events-cached')
      const byHow = Object.fromEntries([...new Set(measures)].map(how => [how, measures.filter(m => m === how).length]))

      const ok = report(
        'PERF.cmd.overhead.stream',
        [
          below('PERF.cmd.overhead.stream.p95', percentile(perCheck, 95), 15),
          { id: 'PERF.cmd.overhead.stream.dir_lstat_warm', value: dirLstat, target: '= 0', pass: dirLstat === 0 },
          {
            id: 'PERF.cmd.overhead.stream.path',
            value: JSON.stringify(byHow),
            target: `events-cached x ${perCheck.length}`,
            pass: cachedAll
          },
          {
            id: 'PERF.cmd.overhead.stream.answers',
            value: refusals.length === 0 ? 'ok' : refusals[0],
            target: 'ok',
            pass: refusals.length === 0
          }
        ],
        {
          fixture: big.info,
          checks: perCheck.length,
          mutant: STREAM_OFF ? 'stream-off' : null,
          p50Ms: percentile(perCheck, 50),
          maxMs: Math.max(...perCheck)
        }
      )

      expect(ok).toBe(true)
    } finally {
      big.remove()
    }
  }, 600_000)
})
