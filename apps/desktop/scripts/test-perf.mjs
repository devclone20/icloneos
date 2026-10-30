// K127 (V3-K fix critic r2 m6) + G3-5: `npm run test:perf`, with a verdict on what actually RAN.
//
// The perf project (vitest.config.ts, K105) runs the tests named `… @perf` with their wall-clock budgets, and a
// machine too busy to measure skips them (SKIP(load), electron/perf-gate.test-helpers.ts). Plain vitest exits 0 when
// every test skips, so "ok" could mean "measured nothing": the r2 gate reported ok on 0 of 104. Here:
//   - ok (exit 0) only when EVERY @perf test in the report ran and none failed;
//   - NOT-RUN (exit 3, PERF_NOT_RUN_EXIT) when some ran and the rest skipped for load: a partial measurement is never
//     ok, and the gate reports it as `"ok": null` with this count;
//   - FAIL (exit 1) otherwise: a failure, a file that did not load, no report, a non-zero vitest exit, nothing ran at
//     all (K127), or a @perf test skipped without a load reason.
// The last line is the count (a gate's `tail -1` detail):
//
//   test:perf ok: 5 @perf ran (5 passed, 0 failed), 99 skipped (0 for load)
//   test:perf NOT-RUN: 1 of 5 @perf ran (1 passed, 0 failed), 4 @perf skipped (4 for load): SKIP(load) …
//   test:perf FAIL: 0 @perf ran (0 passed, 0 failed), 104 skipped (5 for load): nothing was measured
//
// Extra arguments go to vitest (e.g. a file filter).
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { isMain } from './utils.mjs'

/** The exit code of a partial run under load: not ok, not a failure (the gate prints `"ok": null`, NOT-RUN). */
export const PERF_NOT_RUN_EXIT = 3

/** The verdict on a vitest JSON report: ok only when every @perf test ran and none failed (see the header). */
export function perfVerdict(report, { exitCode = 0, loadSkips = 0 } = {}) {
  const tests = (report?.testResults ?? []).flatMap(file => file.assertionResults ?? [])
  const passed = tests.filter(test => test.status === 'passed').length
  const failed = tests.filter(test => test.status === 'failed').length
  const skipped = tests.length - passed - failed
  const ran = passed + failed
  // The @perf tests the run selected (the rest are skipped by the -t filter, and say nothing about the budgets).
  const perfName = new RegExp(PERF_NAME_FILTER)
  const perfTests = tests.filter(test => perfName.test(test.fullName ?? test.title ?? '')).length
  const unmeasured = Math.max(perfTests - ran, 0)
  const brokenFiles = (report?.testResults ?? []).filter(
    file => file.status === 'failed' && (file.assertionResults ?? []).length === 0
  ).length

  let why = null
  let notRun = null

  if (!report) {
    why = 'no vitest report'
  } else if (failed > 0 || brokenFiles > 0) {
    why = `${failed} failed, ${brokenFiles} file(s) did not load`
  } else if (ran === 0) {
    why = 'nothing was measured (a loaded machine skips every @perf test; re-run when idle)'
  } else if (exitCode !== 0) {
    why = `vitest exited ${exitCode}`
  } else if (unmeasured > 0 && loadSkips >= unmeasured) {
    notRun = `partial measurement: SKIP(load) on a busy machine; re-run when idle`
  } else if (unmeasured > 0) {
    why = `${unmeasured} @perf test(s) skipped without a load reason (${loadSkips} SKIP(load))`
  }

  const counts = `${ran} @perf ran (${passed} passed, ${failed} failed), ${skipped} skipped (${loadSkips} for load)`
  const partial = `${ran} of ${perfTests} @perf ran (${passed} passed, ${failed} failed), ${unmeasured} @perf skipped (${loadSkips} for load)`

  let line = `test:perf ok: ${counts}`

  if (why) {
    line = `test:perf FAIL: ${counts}: ${why}`
  } else if (notRun) {
    line = `test:perf NOT-RUN: ${partial}: ${notRun}`
  }

  return {
    exitCode: why ? 1 : notRun ? PERF_NOT_RUN_EXIT : 0,
    failed,
    line,
    notRun: notRun !== null,
    ok: why === null && notRun === null,
    passed,
    perfTests,
    ran,
    skipped
  }
}

/** The perf filter: the tests named `… @perf` (electron/perf-gate.test-helpers.ts PERF_TAG), and nothing else. */
export const PERF_NAME_FILTER = '@perf$'

/** The vitest argv `npm run test:perf` runs (ICLONE_PERF=1 is set on the child, which adds the perf project). */
export function perfVitestArgs(reportFile, extra = []) {
  return [
    'run',
    '--project',
    'perf',
    '-t',
    PERF_NAME_FILTER,
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${reportFile}`,
    ...extra
  ]
}

/** The workspace hoists vitest to the repo root, so resolve it the way node does instead of guessing a .bin path. */
function vitestBin() {
  const vitestPkg = createRequire(import.meta.url).resolve('vitest/package.json')

  return path.join(path.dirname(vitestPkg), JSON.parse(readFileSync(vitestPkg, 'utf8')).bin.vitest)
}

/** Runs vitest (or, in the runner's own test, a stub at `options.vitest`) and sets this process's exit code to the
 *  verdict's: 0 ok, PERF_NOT_RUN_EXIT, 1 FAIL — the code is what a gate reads. */
export function run(args, options = {}) {
  const desktopRoot = path.resolve(import.meta.dirname, '..')
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'iclone-test-perf-'))
  const reportFile = path.join(scratch, 'report.json')
  const vitest = options.vitest ?? vitestBin()

  const argv = perfVitestArgs(reportFile, args)

  const child = spawn(process.execPath, [vitest, ...argv], {
    cwd: desktopRoot,
    env: { ...process.env, ICLONE_PERF: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let loadSkips = 0

  const relay = (stream, sink) => {
    let tail = ''

    stream.on('data', chunk => {
      const text = tail + String(chunk)
      const lines = text.split('\n')

      tail = lines.pop() ?? ''

      for (const line of lines) {
        if (/^SKIP\(load /.test(line.trim())) {
          loadSkips += 1
        }
      }

      sink.write(chunk)
    })
  }

  relay(child.stdout, process.stdout)
  relay(child.stderr, process.stderr)

  let settled = false

  const finish = (code, report) => {
    if (settled) {
      return
    }

    settled = true
    rmSync(scratch, { force: true, recursive: true })

    const verdict = perfVerdict(report, { exitCode: code, loadSkips })

    console.log(verdict.line)
    // exitCode, not exit(): the verdict line is flushed before the process ends, even into a pipe (macOS).
    process.exitCode = verdict.exitCode
  }

  child.on('error', error => {
    console.error(`test:perf: vitest did not start: ${error.message}`)
    finish(1, null)
  })

  child.on('close', code => {
    let report = null

    try {
      report = JSON.parse(readFileSync(reportFile, 'utf8'))
    } catch {
      report = null
    }

    finish(code ?? 1, report)
  })
}

if (isMain(import.meta.url)) {
  run(process.argv.slice(2))
}
