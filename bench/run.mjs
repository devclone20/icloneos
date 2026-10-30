#!/usr/bin/env node
// The one bench command: `npm run bench -- [--only <id>[,<id>]] [--quick|--full] [--control-only] [--out <dir>] [--keep]
// [--cooldown-max <s>]`.
// Exit codes (EXIT): 0 every control fired; 3 a control did not fire (run invalid); 2 harness error, including an --out
// or BENCH_OUT_ROOT inside the repository checkout.
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { abortRun, EXIT, runBench } from './lib/runner.mjs'
import { HarnessError } from './lib/stats.mjs'

const here = dirname(fileURLToPath(import.meta.url))

const USAGE = `usage: node bench/run.mjs [--only <id>[,<id>]] [--quick|--full] [--control-only] [--out <dir>] [--keep]
                          [--cooldown-max <s>]
  --quick         iteration run (n >= 2 per phase)          --full   final measure (n >= 5 per phase)
  --control-only  run only the negative controls            --keep   keep each row's scratch directory
  --cooldown-max <s>  before each row, wait (poll 10 s) for a 1-minute load under 4.0, at most <s> s (default 600)
  --out <dir>     results directory (default: $BENCH_OUT_ROOT/<stamp>-<sha>, else <tmp>/iclone-bench/...);
                  refused (exit 2) when it, or BENCH_OUT_ROOT, resolves inside the repository checkout
  --rows <dir>    TESTS ONLY: run fixture rows from <dir> instead of bench/rows (the harness self-tests use it)
env: BENCH_PYTHON (interpreter), BENCH_GPU_LOCK (path to the exclusive-window tool: one window per row), BENCH_OUT_ROOT`

export function parseArgs(argv) {
  const opts = {
    mode: 'quick',
    only: null,
    controlOnly: false,
    out: null,
    keep: false,
    cooldownMax: 600,
    rowsDir: join(here, 'rows')
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      if (i + 1 >= argv.length) {
        throw new HarnessError(`${arg} needs a value`)
      }
      return argv[++i]
    }
    if (arg === '--quick' || arg === '--full') {
      opts.mode = arg.slice(2)
    } else if (arg === '--only') {
      opts.only = value()
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    } else if (arg === '--control-only') {
      opts.controlOnly = true
    } else if (arg === '--out') {
      opts.out = resolve(value())
    } else if (arg === '--cooldown-max') {
      const raw = value()
      opts.cooldownMax = Number(raw)
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(opts.cooldownMax)) {
        throw new HarnessError(`--cooldown-max needs a whole number of seconds, got ${raw}`)
      }
    } else if (arg === '--keep') {
      opts.keep = true
    } else if (arg === '--rows') {
      // Test seam (tests only): run fixture rows from another directory.
      opts.rowsDir = resolve(value())
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true
    } else {
      throw new HarnessError(`unknown argument ${arg}\n${USAGE}`)
    }
  }
  return opts
}

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`${err.message}\n`)
    return EXIT.HARNESS
  }
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`)
    return EXIT.OK
  }
  try {
    const checkout = resolve(here, '..')
    const { doc, exitCode, outDir } = await runBench({ ...opts, app: checkout, checkout })
    for (const row of doc.rows) {
      const c = row.control ?? []
      const measured = row.verdict === 'ERROR' && row.measured !== null ? '(unjudged)' : (row.measured ?? '—')
      process.stdout.write(
        `${row.verdict.padEnd(12)} ${row.id}  measured=${measured} ${row.unit}` +
          `  control=${c.length ? c.map(x => (x.skipped ? 'skipped' : x.ok ? 'fired' : 'DID NOT FIRE')).join(',') : '—'}` +
          `${row.unclean ? '  [unclean]' : ''}${row.error ? `  error: ${row.error}` : ''}\n`
      )
    }
    process.stdout.write(
      `status=${doc.status} exit=${exitCode} clean=${doc.clean_rows}/${doc.rows_total} out=${outDir}\n`
    )
    return exitCode
  } catch (err) {
    process.stderr.write(`bench harness error: ${err.message}\n`)
    return EXIT.HARNESS
  }
}

// An interrupted run must not leave the window held, a process tree running, or scratch clones on disk.
let aborting = false
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143]
]) {
  process.on(signal, () => {
    if (aborting) {
      return
    }
    aborting = true
    process.stderr.write(`[bench] ${signal}: killing child process groups, releasing the window, removing scratch\n`)
    abortRun().finally(() => process.exit(code))
  })
}

process.exitCode = await main()
