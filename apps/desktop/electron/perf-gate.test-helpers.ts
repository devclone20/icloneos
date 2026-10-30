/**
 * K105 — wall-clock budgets live in the `perf` vitest project, never in the default suite. A red that is always
 * "load" teaches everyone to ignore red. The default run keeps each test's correctness checks (fewer iterations, no
 * budget); `npm run test:perf` runs the same tests whose names end in `@perf`, full size, with their budgets, and a
 * machine too busy to measure reports SKIP(load), never a pass.
 */
import os from 'node:os'

/** True only in the perf project (vitest.config.ts adds it, and sets this, when ICLONE_PERF=1). */
export const PERF = process.env.ICLONE_PERF === '1'

/** The name suffix the perf project selects on (`npm run test:perf` filters with -t "@perf$"); empty by default. */
export const PERF_TAG = PERF ? ' @perf' : ''

/** The load guard: above cores / 2 (1-minute load average) a timing is not a measurement, so the test is skipped. */
export function skipUnderLoad(ctx: { skip: (note?: string) => void }): void {
  const load = os.loadavg()[0]
  const limit = os.cpus().length / 2

  if (load > limit) {
    const note = `SKIP(load ${load.toFixed(1)} > ${limit})`

    console.info(note)
    ctx.skip(note)
  }
}
