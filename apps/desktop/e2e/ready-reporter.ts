/**
 * v0.0.9 e2e harness (G needs it): one machine-readable line at the end of a run, from the per-test annotations
 * test.ts writes (e2e/ready-state.ts):
 *
 *   [e2e-ready] booted N, reached-ready N, unclaimed N, non-ready-by-design N, passed-booted-not-ready N, ran N,
 *   unaccounted N
 *
 * `booted` counts the tests that drove a booted app, `reached-ready` those of them that reached ready, `unclaimed` the
 * launches no test classified (always 0 on a sound run: such a test fails). The last field is the false-pass check:
 * a PASSED booted test that did not reach ready (must be 0). The last result of each test counts (retries).
 * v0.0.9 eng G2-m1: `ran` counts the tests whose body ran (not skipped), and `unaccounted` those of them with neither
 * a booted nor a non-ready claim: booted + non-ready-by-design = ran when it is 0. The hooks once judged one spec
 * file per worker, and this line could not show the rest were missing.
 */
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter'

import { BOOTED_ANNOTATION, NON_READY_ANNOTATION, READY_ANNOTATION, UNCLAIMED_ANNOTATION } from './ready-state'

interface Row {
  ran: boolean
  booted: boolean
  ready: boolean
  unclaimed: boolean
  nonReady: boolean
  passed: boolean
}

export function readySummary(rows: readonly Row[]): string {
  const count = (pick: (row: Row) => boolean) => rows.filter(pick).length

  return (
    `[e2e-ready] booted ${count(r => r.booted)}, reached-ready ${count(r => r.booted && r.ready)}, ` +
    `unclaimed ${count(r => r.unclaimed)}, non-ready-by-design ${count(r => r.nonReady)}, ` +
    `passed-booted-not-ready ${count(r => r.booted && !r.ready && r.passed)}, ` +
    `ran ${count(r => r.ran)}, unaccounted ${count(r => r.ran && !r.booted && !r.nonReady)}`
  )
}

export default class ReadyReporter implements Reporter {
  private readonly rows = new Map<string, Row>()

  onTestEnd(test: TestCase, result: TestResult): void {
    const types = new Set([...test.annotations, ...result.annotations].map(a => a.type))

    this.rows.set(test.id, {
      ran: result.status !== 'skipped',
      booted: types.has(BOOTED_ANNOTATION),
      ready: types.has(READY_ANNOTATION),
      unclaimed: types.has(UNCLAIMED_ANNOTATION),
      nonReady: types.has(NON_READY_ANNOTATION),
      passed: result.status === 'passed'
    })
  }

  onEnd(_result: FullResult): void {
    console.log(readySummary([...this.rows.values()]))
  }

  printsToStdio(): boolean {
    return true
  }
}
