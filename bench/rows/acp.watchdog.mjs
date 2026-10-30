import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { newResultFile, readResult } from '../lib/child_result.mjs'
import { median, percentile } from '../lib/stats.mjs'

const CHILD = fileURLToPath(new URL('./_acp.watchdog.child.mjs', import.meta.url))
const SPIN_MS = 20

async function runChild(ctx, args) {
  const root = fs.mkdtempSync(path.join(ctx.scratch, 'run-'))
  const result = newResultFile(ctx.scratch)
  const r = await ctx.sh(process.execPath, ['--expose-gc', CHILD, JSON.stringify({ scratch: root, result, ...args })], {
    cwd: ctx.app
  })
  return readResult(result, r, 'watchdog child')
}
// Least-squares slope of y over x.
const slope = (xs, ys) => {
  const n = xs.length
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  const num = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0)
  const den = xs.reduce((s, x) => s + (x - mx) ** 2, 0)
  return den ? num / den : 0
}

export default {
  id: 'acp.watchdog',
  part: 'ACP work watchdog loop',
  what:
    'cycle-time drift per poll in ms: when the setInterval that drives watchdog.poll fired minus (previous fire + period); ' +
    '0 or slightly negative is a valid sample (libuv loop time vs performance.now()). ACCELERATED: real timer at 50 ms, ' +
    'virtual clock +30 s per poll, so a 10 min soak = 12 000 polls = 100 production hours; cold = first poll of a fresh ' +
    'process, warm = every later poll of the soak; extra: poll cycle time, cumulative drift and heap growth per ' +
    'production (virtual) hour',
  hot_path:
    'apps/desktop/electron/iclone-acp-work/watchdog.ts createWatchdog().poll -> fold -> ledger.ts createLedger (append/read)',
  unit: 'ms',
  lang: 'TypeScript',
  miss_class: 'cpu',
  allow_nonpositive: {
    reason: 'drift is a deviation: a timer that fires on time measures 0 or a hair below it'
  },
  budget: {
    value: 300,
    op: '<=',
    stat: 'warm.p95',
    reason:
      'the watchdog polls every 30 s (ipc.ts:48) and a poll that fires more than 1 % of that period late (300 ms) ' +
      'delays stall detection the user waits on; the drift is event-loop lateness, which does not depend on the ' +
      'period, so the 50 ms test timer sees the lateness the 30 s timer would'
  },
  risk: 'a loop that runs for days in main: any per-poll growth (ledger re-read, snapshots) compounds',
  failure_mode:
    'a failed read keeps the last snapshot and raises one Fix entry per failure run (watchdog.ts:325-331); the CLI here is the repo test double fake-cli.ts (no network, no acp)',
  async measure(ctx) {
    const full = ctx.mode === 'full'
    const cold = []
    for (let i = 0; i < (full ? 5 : 2); i += 1) {
      const short = await runChild(ctx, { durationS: 2 })
      cold.push(short.lateness[0])
    }
    // full: 12 000 polls, a heap sample every 200 (60 samples); quick: 400 polls, one every 40 (10 samples)
    const soak = await runChild(ctx, { durationS: full ? 600 : 20, memEvery: full ? 200 : 40 })
    const warm = soak.lateness.slice(1)
    // setInterval re-arms from the start of each callback, so lateness accumulates: drift per hour = sum over its polls.
    const pollsPerHour = 3_600_000 / soak.prodPollMs
    const meanLate = warm.reduce((a, b) => a + b, 0) / warm.length
    const mem = soak.memory.slice(2) // the first two samples are warm-up
    const heapPerHour =
      mem.length > 2
        ? slope(
            mem.map(m => m.hours),
            mem.map(m => m.heapMB)
          )
        : null
    if (heapPerHour === null) {
      throw new Error(`heap growth needs >= 3 post-warm-up heap samples, got ${mem.length}`)
    }
    const hours = soak.ticks / (3_600_000 / soak.prodPollMs)
    const half = Math.floor(soak.cycles.length / 2)
    return {
      cold,
      warm,
      extra: {
        acceleration: `${soak.prodPollMs / soak.tickMs}x (timer ${soak.tickMs} ms, virtual ${soak.prodPollMs} ms per poll)`,
        polls: soak.ticks,
        production_hours_simulated: +hours.toFixed(1),
        offers: soak.offers,
        drift_ms_per_poll: {
          p50: +percentile(warm, 50).toFixed(3),
          p95: +percentile(warm, 95).toFixed(3),
          max: +Math.max(...warm).toFixed(3),
          min: +Math.min(...warm).toFixed(3)
        },
        cumulative_drift_ms_per_production_hour: +(meanLate * pollsPerHour).toFixed(1),
        cycle_ms: {
          p50: +percentile(soak.cycles, 50).toFixed(3),
          p95: +percentile(soak.cycles, 95).toFixed(3),
          first_half_p50: +percentile(soak.cycles.slice(0, half), 50).toFixed(3),
          second_half_p50: +percentile(soak.cycles.slice(half), 50).toFixed(3)
        },
        heap_mb_per_production_hour: +heapPerHour.toFixed(4),
        heap_samples: mem.length,
        heap_mb: mem.length ? { first: +mem[0].heapMB.toFixed(2), last: +mem.at(-1).heapMB.toFixed(2) } : null,
        ledger_bytes: soak.ledgerBytes,
        secondary: [
          {
            name: 'heap growth per production hour',
            value: +heapPerHour.toFixed(4),
            unit: 'MB/h',
            budget: 1,
            op: '<=',
            ok: +heapPerHour.toFixed(4) <= 1,
            reason:
              'the loop runs for days in the main process: more than 1 MB of heap per hour grows without bound; ' +
              'least-squares slope over post-GC samples, per virtual hour'
          }
        ]
      }
    }
  },
  async control(ctx) {
    const base = await runChild(ctx, { durationS: 4 })
    // setInterval anchors the next fire at the start of the tick, so work shorter than the period is absorbed:
    // the injected block outlasts the 50 ms period by SPIN_MS, and exactly that overrun must show up as lateness.
    const slow = await runChild(ctx, { durationS: 4, spinMs: base.tickMs + SPIN_MS })
    const value = median(slow.lateness) - median(base.lateness)
    return {
      name: `event loop blocked (period + ${SPIN_MS} ms) per poll`,
      expected: `median drift per poll grows by >= ${0.8 * SPIN_MS} ms`,
      observed: `+${value.toFixed(2)} ms (n=${base.lateness.length} vs ${slow.lateness.length} polls)`,
      value,
      threshold: 0.8 * SPIN_MS,
      op: '>=',
      ok: value >= 0.8 * SPIN_MS,
      base: base.lateness,
      variant: slow.lateness
    }
  }
}
